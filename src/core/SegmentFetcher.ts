import { delay } from "../utils/delay.js";
import { handleError } from "../utils/handleError.js";
import { AuthExpiredError, HttpError, LiveNotLiveError, PermissionDeniedError } from "../utils/errors.js";
import { formatBytes, formatDuration, getDiskFreeSpace, RecordingProgressTracker } from "../utils/recordingHealth.js";
import { HLSDownloader } from "./HLSDownloader.js";
import { BiliLiveApi } from "./Api.js";

import type { Cookies } from "../model/cookies.js";
import type { StreamItem } from "../model/api.js";

/** 判定「回放已取完」时允许的 end_time 误差（秒） */
const REPLAY_END_TOLERANCE_SEC = 30;
/** 连续多少次没有新增分片后判定该场次回放已取完（最少轮数） */
const MAX_NO_NEW_SEGMENTS = 5;
/** 「无新增」累计到该时长才判定回放已取完（约 5 分钟，按轮询间隔换算成轮数） */
const REPLAY_FINISH_PATIENCE_MS = 5 * 60 * 1000;
/** 待合并时长达到多少秒才可能告警（约 3 分钟） */
const PROGRESS_WARN_THRESHOLD_SEC = 180;
/**
 * 磁盘剩余低于「总量」的这个比例时告警
 * 用比例而不是绝对值：固定阈值在小磁盘上会一直误报
 */
const DISK_WARN_RATIO = 0.1;

/**
 * 单个输出文件的大小 / 时长限制（0 = 不限制）
 * 达到限制时在分片边界新开输出组继续录制，不会中断本场次
 */
export interface SegmentFetcherLimits {
    maxFileSizeBytes?: number;
    maxFileDurationSec?: number;
}

/**
 * SegmentFetcher
 * 负责从 B 站 API 拉取直播流 m3u8 地址，处理网络错误、登录态、重试与队列。
 */
export class SegmentFetcher extends BiliLiveApi {
    private isFetching = false;

    private requestQueue: (() => Promise<void>)[] = [];
    private maxQueueSize = 5;
    private isQueueRunning = false;

    /** 最近一次选中 stream 的 end_time（用于判断该场次回放是否已取完） */
    private lastStreamEndTime = 0;
    /** 首个成功获取的流分片起始时间（墙钟秒），用于弹幕时间轴锚点 */
    private firstStreamStartTime: number | null = null;
    /** 连续未追加新分片的次数 */
    private noNewSegmentsCount = 0;
    /** 判定「回放已取完」所需的连续无新增轮数（随轮询间隔换算，保持约 5 分钟的耐心） */
    private maxNoNewSegments = MAX_NO_NEW_SEGMENTS;

    /** 输出目录（磁盘空间检查用） */
    private outputDir: string;
    /** 追播进度跟踪（待合并时长连续上涨 → 下载速度跟不上直播） */
    private progressTracker = new RecordingProgressTracker(PROGRESS_WARN_THRESHOLD_SEC);
    /** 最近一次磁盘检查时间（避免每轮都 statfs） */
    private lastDiskCheckAt = 0;
    /** 最近一次磁盘剩余字节（用于落后告警时带上） */
    private lastFreeBytes: number | null = null;

    /**
     * 首个流分片起始时间回调（每场次只触发一次）
     * 录制内容从该时刻开始，弹幕时间轴以此为锚点
     */
    public onFirstStreamStartTime?: (startTime: number) => void;

    private hlsDownloader: HLSDownloader;
    /** 生成的本地 m3u8 文件名（与 RecorderManager 一致：`${roomId}.m3u8`） */
    private playlistFilename: string;
    /** 合并后的单一 m4s 文件名（与 RecorderManager 一致：`${roomId}.m4s`） */
    private combinedFilename: string;

    private liveCheckCount: number = 0;

    /** 
     * 录制来源
     * 0：从直播回放流当中获取
     * 1：从实时直播剪辑流当中获取
     */
    private recordSource = 0;

    /** 单个输出文件的大小/时长限制（透传给下载器） */
    private readonly groupLimits: SegmentFetcherLimits;

    constructor(cookies: Cookies, roomId: number, outputDir: string, segmentsSubdir: string = './fragments', playlistFilename: string, combinedFilename: string, recordSource = 0, limits: SegmentFetcherLimits = {}) {
        super(cookies, roomId);
        this.groupLimits = limits;
        this.hlsDownloader = new HLSDownloader({ outputDir, segmentsSubdir, ...limits });
        this.outputDir = outputDir;
        // 与 RecorderManager.ts 中的路径定义保持一致（文件名由下载器在 outputDir 下创建）
        this.playlistFilename = playlistFilename;
        this.combinedFilename = combinedFilename;
        this.recordSource = recordSource;
    }

    /**
     * 释放资源（销毁下载器持有的校验 worker 池）
     * 换场次重建 SegmentFetcher 前应由调用方调用
     */
    dispose(): void {
        this.isFetching = false;
        this.hlsDownloader.dispose();
    }

    /**
     * 启动主循环，每隔指定时间请求一次 API
     */
    public async startLoop(intervalMs = 15000): Promise<void> {
        if (this.isFetching) {
            global.logger.warn(`[SegmentFetcher] 当前主循环已启动，roomid=${this.roomId}`);
            return;
        }

        // 上游切片约 10s 推进一次；无新增判定的轮数按时间换算，
        // 避免缩短间隔后（如 15s）在下播收尾阶段过早判定「回放已取完」
        this.maxNoNewSegments = Math.max(MAX_NO_NEW_SEGMENTS, Math.ceil(REPLAY_FINISH_PATIENCE_MS / intervalMs));
        global.logger.info(`[SegmentFetcher] 开始主循环，roomId=${this.roomId}，间隔=${intervalMs}ms，无新增判定阈值=${this.maxNoNewSegments} 轮${this.describeLimits()}`);
        this.isFetching = true;

        // 已有录制现场（重启/续录）时先把"已合并"分片播种进来，避免整段重新下载
        await this.hlsDownloader.primeAppendedFromPlaylist(this.playlistFilename, this.combinedFilename);

        // 会话开始时查一次磁盘：录到写满才发现就晚了
        await this.checkDiskSpace(true);

        // 开播状态请求计数器
        while (true) {
            try {
                if (!this.liveKey) {
                    await this.updateLiveId();
                    global.logger.info(`[SegmentFetcher] 更新 live_key=${this.liveKey}, live_uid=${this.liveUid}, live_time=${this.liveTime}`);
                }

                const streamUrl = await this.fetchStreamUrl(); // 获取 stream URL
                if (streamUrl) {
                    global.logger.info(`[SegmentFetcher] 成功获取 stream URL: ${streamUrl}`);
                    // 1) 仅下载新分片（已存在的会跳过）
                    const segments = await this.hlsDownloader.downloadPlaylist(streamUrl);
                    // 2) 将新分片追加到单一 m4s，并更新 BYTERANGE 播放列表
                    //    blocked = 有分片未就绪，后续内容本轮先不写，保证播放列表时间单调
                    const { added, pendingDurationSec, blocked } = await this.hlsDownloader.appendLocalM3U8Byterange(
                        segments,
                        this.playlistFilename,
                        this.combinedFilename
                    );

                    // 3) 录得多快 vs 直播推进多快（磁盘空间在会话启动时查一次，见 checkDiskSpace）
                    this.reportProgress(pendingDurationSec);
                    await this.checkDiskSpace(false);

                    // 4) 该场次已下播且回放分片已取完，结束本场次录制
                    //    blocked 时不能判定"没有新分片"，否则会提前结束场次
                    if (this.isReplayFinished(added, blocked)) {
                        throw new LiveNotLiveError("该场次回放已全部取完，结束本场次录制");
                    }
                }
            } catch (err) {
                const { errMsg, name } = handleError(err);
                if (name === 'LiveNotLiveError') {
                    this.isFetching = false;
                    throw err;
                }
                global.logger.error(`[SegmentFetcher] 主循环错误:${errMsg}`);
            }

            // 0-20% 抖动：避免与上游刷新周期（约 10s）形成固定相位；
            // 实际周期还会叠加本轮下载耗时，因此不会严格按间隔执行
            const wait = intervalMs + Math.floor(Math.random() * Math.floor(intervalMs * 0.2));
            await delay(wait);
        }
    }

    /**
     * 单个输出文件限制的日志描述
     */
    private describeLimits(): string {
        const { maxFileSizeBytes = 0, maxFileDurationSec = 0 } = this.groupLimits;
        if (maxFileSizeBytes <= 0 && maxFileDurationSec <= 0) return '，未启用单文件大小/时长限制';

        const parts: string[] = [];
        if (maxFileSizeBytes > 0) parts.push(`大小 ${formatBytes(maxFileSizeBytes)}`);
        if (maxFileDurationSec > 0) parts.push(`时长 ${formatDuration(maxFileDurationSec)}`);
        return `，单文件上限：${parts.join(' / ')}`;
    }

    /**
     * 上报追播进度
     *
     * 判定依据是"待合并时长连续上涨"，而不是绝对落后值：
     * 会话中途重启时会有大量历史分片待补，那是正常追播，会单调下降。
     */
    private reportProgress(pendingDurationSec: number): void {
        const { warning, recovered, growthStreak } = this.progressTracker.update(pendingDurationSec);

        if (recovered) {
            const lag = this.lagSeconds();
            global.logger.info(
                `[SegmentFetcher] 追播已追上（待合并 ${pendingDurationSec.toFixed(1)}s` +
                `${lag !== null ? `，落后直播 ${formatDuration(lag)}` : ''}）`
            );
            return;
        }

        if (!warning) {
            global.logger.debug(
                `[SegmentFetcher] 追播进度：待合并 ${pendingDurationSec.toFixed(1)}s，连续上涨 ${growthStreak} 轮`
            );
            return;
        }

        const lag = this.lagSeconds();
        const free = this.lastFreeBytes !== null ? `，磁盘剩余 ${formatBytes(this.lastFreeBytes)}` : '';
        global.logger.warn(
            `[SegmentFetcher] 录制落后：待合并 ${formatDuration(pendingDurationSec)}` +
            `，已连续 ${growthStreak} 轮上涨` +
            `${lag !== null ? `，落后直播 ${formatDuration(lag)}` : ''}${free}`
        );
    }

    /** 播放列表 end_time 与当前时间的差（秒）；未知返回 null */
    private lagSeconds(): number | null {
        if (!this.lastStreamEndTime) return null;
        const lag = Date.now() / 1000 - this.lastStreamEndTime;
        return Number.isFinite(lag) && lag >= 0 ? lag : null;
    }

    /**
     * 磁盘空间检查
     * @param force 会话开始时强制检查；之后每 30 分钟最多查一次
     */
    private async checkDiskSpace(force: boolean): Promise<void> {
        const now = Date.now();
        if (!force && now - this.lastDiskCheckAt < 30 * 60 * 1000) return;
        this.lastDiskCheckAt = now;

        const info = await getDiskFreeSpace(this.outputDir);
        if (!info) {
            global.logger.debug(`[SegmentFetcher] 磁盘空间查询失败（${this.outputDir}），跳过本次检查`);
            return;
        }

        this.lastFreeBytes = info.freeBytes;
        const freeRatio = info.totalBytes > 0 ? info.freeBytes / info.totalBytes : 1;
        const summary =
            `[SegmentFetcher] 磁盘空间：剩余 ${formatBytes(info.freeBytes)} / 共 ${formatBytes(info.totalBytes)}` +
            `（${((1 - freeRatio) * 100).toFixed(1)}% 已用）`;

        if (freeRatio < DISK_WARN_RATIO) {
            global.logger.warn(
                `${summary} —— 剩余不足 ${(DISK_WARN_RATIO * 100).toFixed(0)}%，请及时清理`
            );
        } else {
            global.logger.info(summary);
        }
    }


    /**
     * 请求接口获取 stream 地址，自动进行短期重试和失败入队
     * 按 recordSource 分派到对应的子方法
     */
    private async fetchStreamUrl(str: string = ''): Promise<string | null> {
        const isQueueRetry = str === 'queueRetry';
        return this.recordSource === 0
            ? this.fetchReplayStreamUrl(isQueueRetry)
            : this.fetchClipStreamUrl(isQueueRetry);
    }

    /**
     * 实时直播剪辑流：请求接口获取 stream 地址（recordSource = 1）
     */
    private async fetchClipStreamUrl(isQueueRetry: boolean = false): Promise<string | null> {
        let retry = 0;
        const maxShortRetries = 6;

        while (retry < maxShortRetries) {
            if (this.liveCheckCount > 10 && this.liveKey !== "0") {
                await this.updateLiveId();
                global.logger.info(`[SegmentFetcher][Clip] 检测录制直播状态为：${this.liveKey === "0" ? "未开播" : "直播中"}`);
                if (this.liveKey === "0") {
                    throw new LiveNotLiveError("数据错误：live_id_str 为 0，当前主播未开播");
                }
                this.liveCheckCount = 0;
            }

            try {
                const res = await this.getUserClickSliceStream();
                const data = res.data;

                global.logger.debug(`[SegmentFetcher][Clip] API返回数据: ${JSON.stringify(data)}`);

                // 登录失效
                if (String(res?.message).includes('未登录')) {
                    throw new AuthExpiredError(JSON.stringify(res), res?.code);
                }

                // 权限不足
                if (String(res?.message).includes('权限不足')) {
                    throw new PermissionDeniedError(JSON.stringify(res), res?.code);
                }

                // 处理无有效合成场次，尝试重新获取 live_id
                else if (res.code === 202 || res.message.includes('无有效合成场次')) {
                    global.logger.warn("[SegmentFetcher][Clip] 无有效合成场次，尝试重新获取 live_id...");
                    await this.updateLiveId();
                    global.logger.info(`[SegmentFetcher][Clip] 更新 live_key=${this.liveKey}, live_uid=${this.liveUid}, live_time=${this.liveTime}`);
                    retry++;
                    await delay(1000 + Math.random() * 4000);
                    continue;
                } else if (res?.code !== 0 || String(res?.message).includes('请求错误')) {
                    throw new HttpError(JSON.stringify(res), res?.code);
                }

                if (!data)
                    throw new Error("API返回无data");

                const stream = this.pickBestStream(data.list);
                if (stream) {
                    return stream;
                }

                this.liveCheckCount++;

                global.logger.warn(`[SegmentFetcher][Clip] list为空，${retry + 1}/${maxShortRetries} 重试中...`);
                retry++;
                await delay(1000 + Math.random() * 4000);
            } catch (err) {
                const { errMsg, name } = handleError(err);

                if (name === 'PermissionDeniedError' ||
                    name === 'AuthExpiredError' ||
                    name === 'HttpError') {
                    throw err;
                }

                global.logger.error(`[SegmentFetcher][Clip] 请求错误 (${retry + 1}/${maxShortRetries})：${errMsg}`);
                retry++;
                await delay(2000 + Math.random() * 4000);
            }
            this.liveCheckCount++;
        }

        if (isQueueRetry) {
            throw new Error("多次重试失败，仍未获取到有效 stream URL。");
        }

        global.logger.warn("[SegmentFetcher][Clip] 多次重试失败，加入请求队列进行延迟重试。");
        this.enqueueRetryTask();

        return null;
    }

    /**
     * 直播回放流：请求接口获取 stream 地址（recordSource = 0）
     */
    private async fetchReplayStreamUrl(isQueueRetry: boolean = false): Promise<string | null> {
        let retry = 0;
        const maxShortRetries = 6;

        while (retry < maxShortRetries) {
            if (this.liveCheckCount > 10) {
                this.liveCheckCount = 0;

                // 从未获取到有效场次（启动时主播未开播）
                if (this.liveKey === "0") {
                    throw new LiveNotLiveError("数据错误：live_id_str 为 0，当前主播未开播");
                }

                if (await this.isLiving()) {
                    await this.updateLiveId();
                    global.logger.info(`[SegmentFetcher][Replay] 检测录制直播状态为：直播中 live_key=${this.liveKey}`);
                } else if (!this.replayTimeRange && !await this.tryUseReplayTimeRange("检测到主播已下播")) {
                    // 已下播且暂时取不到该场次的回放数据：结束本场次，回到等待下一场开播
                    throw new LiveNotLiveError("主播已下播，且未获取到该场次的回放数据");
                }
            }

            try {
                const res = await this.getUserSliceStream();
                const data = res.data;

                global.logger.debug(`[SegmentFetcher][Replay] API返回数据: ${JSON.stringify(data)}`);

                // 登录失效（通用 ApiFox 基类字段）
                if (String(res?.message).includes('未登录')) {
                    throw new AuthExpiredError(JSON.stringify(res), res?.code);
                }

                // 权限不足
                if (String(res?.message).includes('权限不足') ||
                    String(res?.message).includes('没有剪辑权限')) {
                    throw new PermissionDeniedError(JSON.stringify(res), res?.code);
                }

                // 通用 API 错误
                // 主播下播后，默认的 liveTime ~ liveTime + 24h 范围会被判为非法参数（code=100），
                // 此时改用回放列表中该场次的时间范围重新获取
                if (res?.code !== 0) {
                    if (await this.tryUseReplayTimeRange(`接口返回错误 ${JSON.stringify(res)}`)) {
                        retry++;
                        await delay(1000 + Math.random() * 4000);
                        continue;
                    }
                    // 弱网反复开播下播：旧 live_key 已失效、主播已用新场次重新开播时，
                    // 立即换场次（不用等 liveCheckCount 累积，否则最长有 ~13 分钟盲区）
                    if (await this.refreshLiveIdOnFailure()) {
                        throw new LiveNotLiveError("直播场次已变更，结束本场次换新文件");
                    }
                    throw new HttpError(JSON.stringify(res), res?.code);
                }

                if (!data) {
                    if (await this.tryUseReplayTimeRange("API返回无data")) {
                        retry++;
                        await delay(1000 + Math.random() * 4000);
                        continue;
                    }
                    if (await this.refreshLiveIdOnFailure()) {
                        throw new LiveNotLiveError("直播场次已变更，结束本场次换新文件");
                    }
                    throw new Error("API返回无data");
                }

                const stream = this.pickBestStream(data.list);
                if (stream) {
                    return stream;
                }

                // 下播后回放数据可能尚未就绪，同样尝试改用回放时间范围
                if (await this.tryUseReplayTimeRange("list为空")) {
                    retry++;
                    await delay(1000 + Math.random() * 4000);
                    continue;
                }
                // list 持续为空同样可能是场次已变更（新场次的切片尚未就绪）
                if (await this.refreshLiveIdOnFailure()) {
                    throw new LiveNotLiveError("直播场次已变更，结束本场次换新文件");
                }

                this.liveCheckCount++;
                global.logger.warn(`[SegmentFetcher][Replay] list为空，${retry + 1}/${maxShortRetries} 重试中...`);
                retry++;
                await delay(1000 + Math.random() * 4000);
            } catch (err) {
                const { errMsg, name } = handleError(err);

                if (name === 'PermissionDeniedError' ||
                    name === 'AuthExpiredError' ||
                    name === 'HttpError') {
                    throw err;
                }

                global.logger.error(`[SegmentFetcher][Replay] 请求错误 (${retry + 1}/${maxShortRetries})：${errMsg}`);
                retry++;
                await delay(2000 + Math.random() * 4000);
            }
            this.liveCheckCount++;
        }

        if (isQueueRetry) {
            throw new Error("多次重试失败，仍未获取到有效的回放 stream URL。");
        }

        global.logger.warn("[SegmentFetcher][Replay] 多次重试失败，加入请求队列进行延迟重试。");
        this.enqueueRetryTask();

        return null;
    }

    /**
     * 从 StreamItem 列表中选取 end_time 最大的 stream URL
     * 两个来源（回放 / 剪辑）共用此逻辑
     */
    private pickBestStream(list: StreamItem[] | null): string | null {
        if (!list || list.length === 0) return null;
        let best = list[0];
        for (let i = 1; i < list.length; i++) {
            if (list[i].end_time > best.end_time) {
                best = list[i];
            }
        }
        this.lastStreamEndTime = best.end_time;
        if (this.firstStreamStartTime === null && Number.isFinite(best.start_time) && best.start_time > 0) {
            this.firstStreamStartTime = best.start_time;
            this.onFirstStreamStartTime?.(best.start_time);
        }
        return best.stream;
    }

    /**
     * 请求失败时快速刷新场次并检测变更
     *
     * 弱网反复开播下播场景：旧场次的 live_key 会立刻失效（接口 code=100），
     * 而主播可能已经用新 live_key 重新开播。原有的刷新要等 liveCheckCount 累积
     * 到 10 次失败（约 13 分钟）才发生，期间什么都没录。
     * 这里立即刷新一次：live_key 真的变了就返回 true（调用方结束本场次，
     * 由 RecorderManager 按新场次的开播时刻换新文件）。
     *
     * @returns 是否检测到场次变更
     */
    private async refreshLiveIdOnFailure(): Promise<boolean> {
        if (!this.liveKey || this.liveKey === "0") return false;
        try {
            const before = this.liveKey;
            await this.updateLiveId();
            if (this.liveKey !== before && this.liveKey !== "0") {
                global.logger.info(`[SegmentFetcher][Replay] 检测到直播场次变更 ${before} -> ${this.liveKey}，结束本场次`);
                return true;
            }
        } catch (err) {
            // 刷新失败不改变原有错误处理路径
            global.logger.warn(`[SegmentFetcher][Replay] 刷新直播场次失败: ${handleError(err).msg}`);
        }
        return false;
    }

    /**
     * 尝试改用回放列表中该场次的时间范围
     * - 直播仍在进行时不使用：回放列表中的范围会随直播推进而变化，容易过期
     * - 已在使用某个范围时不重复解析，交给原有的重试/队列机制
     * @returns 是否已解析出可用的回放时间范围
     */
    private async tryUseReplayTimeRange(reason: string): Promise<boolean> {
        if (this.replayTimeRange) return false;

        if (await this.isLiving()) return false;

        global.logger.warn(`[SegmentFetcher][Replay] ${reason}，直播已结束，尝试从回放列表获取该场次的时间范围...`);

        const range = await this.resolveReplayTimeRange();
        if (!range) {
            global.logger.warn(`[SegmentFetcher][Replay] 回放列表暂未生成该场次（live_key=${this.liveKey}）的数据，稍后重试`);
            return false;
        }

        global.logger.info(`[SegmentFetcher][Replay] 已获取该场次回放时间范围 start_time=${range.start_time}, end_time=${range.end_time}，继续获取剩余分片`);
        return true;
    }

    /**
     * 判断该场次回放是否已全部取完
     * 前提是已在使用回放时间范围（即主播已下播），且本次没有新增分片，
     * 再满足以下任一条件即认为取完：
     * - 已取到回放列表中的结束时间（允许少量误差）
     * - 连续约 5 分钟都没有新增分片（轮数按轮询间隔换算）
     */
    private isReplayFinished(added: number, blocked = false): boolean {
        const range = this.replayTimeRange;
        // blocked：本轮是被未就绪分片挡住，不代表"没有新内容"，不能计入"连续无新增"
        if (!range || added > 0 || blocked) {
            this.noNewSegmentsCount = 0;
            return false;
        }

        this.noNewSegmentsCount++;

        if (this.lastStreamEndTime >= range.end_time - REPLAY_END_TOLERANCE_SEC) {
            global.logger.info(`[SegmentFetcher][Replay] 已取到该场次回放结束时间（stream end_time=${this.lastStreamEndTime}, 回放 end_time=${range.end_time}）`);
            return true;
        }

        if (this.noNewSegmentsCount >= this.maxNoNewSegments) {
            global.logger.info(`[SegmentFetcher][Replay] 已连续 ${this.noNewSegmentsCount} 次没有新增分片（阈值 ${this.maxNoNewSegments}），判定回放已取完`);
            return true;
        }

        return false;
    }

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
            if (!task) continue;

            try {
                await task();
            } catch (err) {
                // runQueue 是无 await 的浮动 Promise，任务异常必须在此消化，
                // 否则会触发 unhandledRejection 直接结束进程
                global.logger.error(`[SegmentFetcher] 队列任务失败: ${handleError(err).errMsg}`);
            }
        }

        this.isQueueRunning = false;
    }
}
