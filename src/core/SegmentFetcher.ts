import { delay } from "../utils/delay.js";
import { handleError } from "../utils/handleError.js";
import { AuthExpiredError, HttpError, LiveNotLiveError, PermissionDeniedError } from "../utils/errors.js";
import { HLSDownloader } from "./HLSDownloader.js";
import { BiliLiveApi } from "./Api.js";

import type { Cookies } from "../type/Cookies.js";

/**
 * SegmentFetcher
 * 负责从 B 站 API 拉取直播流 m3u8 地址，处理网络错误、登录态、重试与队列。
 */
export class SegmentFetcher extends BiliLiveApi {
    private isFetching = false;

    private requestQueue: (() => Promise<void>)[] = [];
    private maxQueueSize = 5;
    private isQueueRunning = false;

    private hlsDownloader: HLSDownloader;
    /** 生成的本地 m3u8 文件名（与 RecorderManager 一致：`${roomId}.m3u8`） */
    private playlistFilename: string;
    /** 合并后的单一 m4s 文件名（与 RecorderManager 一致：`${roomId}.m4s`） */
    private combinedFilename: string;

    private liveCheckCount: number = 0;

    constructor(cookies: Cookies, roomId: number, outputDir: string, segmentsSubdir: string = './fragments', playlistFilename: string, combinedFilename: string) {
        super(cookies, roomId);
        this.hlsDownloader = new HLSDownloader({ outputDir, segmentsSubdir });
        // 与 RecorderManager.ts 中的路径定义保持一致（文件名由下载器在 outputDir 下创建）
        this.playlistFilename = playlistFilename;
        this.combinedFilename = combinedFilename;
    }

    /**
     * 启动主循环，每隔指定时间请求一次 API
     */
    public async startLoop(intervalMs = 60000): Promise<void> {
        if (this.isFetching) {
            global.logger.warn(`[SegmentFetcher] 当前主循环已启动，roomid=${this.roomId}`);
            return;
        }

        global.logger.info(`[SegmentFetcher] 开始主循环，roomId=${this.roomId}`);
        this.isFetching = true;

        // 开播状态请求计数器
        while (true) {
            try {
                if (!this.liveKey) {
                    await this.updateLiveId();
                    global.logger.info(`[SegmentFetcher] 更新 live_key=${this.liveKey}, live_uid=${this.liveUid}, live_time=${this.liveTime}`);
                }

                const streamUrl = await this.fetchStreamUrl();
                if (streamUrl) {
                    global.logger.info(`[SegmentFetcher] 成功获取 stream URL: ${streamUrl}`);
                    // 1) 仅下载新分片（已存在的会跳过）
                    const segments = await this.hlsDownloader.downloadPlaylist(streamUrl);
                    // 2) 将新分片追加到单一 m4s，并更新 BYTERANGE 播放列表
                    await this.hlsDownloader.appendLocalM3U8Byterange(
                        segments,
                        this.playlistFilename,
                        this.combinedFilename
                    );
                }
            } catch (err) {
                const { errMsg, name } = handleError(err);
                if (name === 'LiveNotLiveError') {
                    this.isFetching = false;
                    throw err;
                }
                global.logger.error(`[SegmentFetcher] 主循环错误:${errMsg}`);
            }

            const wait = intervalMs + Math.floor(Math.random() * 15000); // 60-75秒
            await delay(wait);
        }
    }

    /**
     * 请求接口获取 stream 地址，自动进行短期重试和失败入队
     */
    private async fetchStreamUrl(str: string = ''): Promise<string | null> {
        /** 重试次数 */
        let retry = 0;
        /** 短期重试次数 */
        const maxShortRetries = 6;

        while (retry < maxShortRetries) {
            if (this.liveCheckCount > 10 && this.liveKey !== "0" && str !== 'LiveNotLiveRequest') {
                await this.updateLiveId();
                global.logger.info(`[SegmentFetcher] 检测录制直播状态为：${this.liveKey === "0" ? "未开播" : "直播中"}`);
                if (this.liveKey === "0") {
                    throw new LiveNotLiveError("数据错误：live_id_str 为 0，当前主播未开播");
                }
                this.liveCheckCount = 0;
            }

            try {
                const res = await this.getStreamApi();
                const data = res.data;

                global.logger.debug(`[SegmentFetcher] API返回数据: ${JSON.stringify(data)}`);

                // 登录失效
                if (String(res?.message).includes('未登录')) {
                    throw new AuthExpiredError(JSON.stringify(res), res?.code);
                } else if (String(res?.message).includes('权限不足')) {
                    throw new PermissionDeniedError(JSON.stringify(res), res?.code);
                }
                // 处理无有效合成场次，尝试重新获取 live_id
                else if (res.code === 202 || res.message.includes('无有效合成场次')) {
                    global.logger.warn("[SegmentFetcher] 无有效合成场次，尝试重新获取 live_id...");
                    await this.updateLiveId();
                    global.logger.info(`[SegmentFetcher] 更新 live_key=${this.liveKey}, live_uid=${this.liveUid}, live_time=${this.liveTime}`);
                    retry++;
                    await delay(1000 + Math.random() * 4000);
                    continue;
                } else if (res?.code !== 0 || String(res?.message).includes('请求错误')) {
                    throw new HttpError(JSON.stringify(res), res?.code);
                }

                if (!data)
                    throw new Error("API返回无data");


                if (data.list && data.list.length > 0) {
                    // 当出现两个及以上时需要判断它们的时段，输出 endTime 最大的 streamURL
                    for (const [index, item] of data.list.entries()) {
                        if (data.list.length > 1) {
                            return item.end_time > data.list[index - 1].end_time ?
                                item.stream :
                                data.list[index - 1].stream;
                        } else {
                            return item.stream;
                        }
                    }
                }
                this.liveCheckCount++;

                global.logger.warn(`[SegmentFetcher] list为空，${retry + 1}/${maxShortRetries} 重试中...`);
                retry++;
                await delay(1000 + Math.random() * 4000);
            } catch (err) {
                const { errMsg, name } = handleError(err);

                if (name === 'PermissionDeniedError' ||
                    name === 'AuthExpiredError' ||
                    name === 'HttpError') {
                    throw err;
                }

                global.logger.error(`[SegmentFetcher] 请求错误 (${retry + 1}/${maxShortRetries})：${errMsg}`);
                retry++;
                await delay(2000 + Math.random() * 4000);
            }
            this.liveCheckCount++;
        }

        if (str === 'queueRetry') {
            throw new Error("多次重试失败，仍未获取到有效 stream URL。");
        }

        global.logger.warn("[SegmentFetcher] 多次重试失败，加入请求队列进行延迟重试。");
        this.enqueueRetryTask();

        return null;
    }

    /**
     * 请求API获取最新stream数据
     */
    // getStreamApi / updateLiveId 由基类 BiliLiveApi 提供

    /**
     * 加入请求队列（指数退避机制）
     */
    private enqueueRetryTask() {
        if (this.requestQueue.length >= this.maxQueueSize) {
            throw new Error("[SegmentFetcher] 请求队列已满，无法加入新任务！");
        }

        const task = async () => {
            let attempt = 0;
            let delayTime = 10000;

            while (attempt < 10) {
                try {
                    global.logger.info(`[SegmentFetcher] 队列重试中 (第${attempt + 1}次, 延迟${delayTime / 1000}s)...`);
                    const res = await this.fetchStreamUrl('queueRetry');
                    if (res) {
                        global.logger.info("[SegmentFetcher] 队列任务成功！");
                        return;
                    }
                } catch (err) {
                    const { errMsg, name } = handleError(err);
                    if (name === 'LiveNotLiveError')
                        throw err;
                    global.logger.error("[SegmentFetcher] 队列任务错误:" + errMsg);
                }

                attempt++;
                delayTime = Math.min(delayTime * 1.5, 5 * 60 * 1000); // 最大5分钟
                await delay(delayTime);
            }

            throw new Error("[SegmentFetcher] 队列任务超过5分钟仍未成功，抛出错误。");
        };

        this.requestQueue.push(task);
        this.runQueue();
    }

    /**
     * 启动队列执行器
     */
    private async runQueue() {
        if (this.isQueueRunning) return;
        this.isQueueRunning = true;

        while (this.requestQueue.length > 0) {
            const task = this.requestQueue.shift();
            if (task) await task();
        }

        this.isQueueRunning = false;
    }
}
