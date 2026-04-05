import { SegmentFetcher } from "./SegmentFetcher.js";
import { httpErrRepeat } from "../utils/http.js";
import fs from "fs/promises";
import path from "path";
import { handleError } from "../utils/handleError.js";
import { is_dirExist } from "../utils/is_dirExist.js";
import { createDir } from "../utils/createDir.js";
import { getFilesList } from "../utils/getFilesList.js";

import type { Cookies } from "../type/Cookies.js";
import { BiliLiveApi } from "./Api.js";

/**
 * RecorderManager
 * 负责组织 SegmentFetcher、下载器、meta.json 文件与任务生命周期管理。
 */
export class RecorderManager {
    public roomId: number;
    public outputDir: string;
    public fetcher: SegmentFetcher;
    public m3u8Path: string;
    public m4sPath: string;
    public metaPath: string;
    public cookies: Cookies;

    private recording = false;
    private recorderInitStatus = false;
    private readonly URL_GET_ROOM_BASE_INFO = 'https://api.live.bilibili.com/xlive/web-room/v1/index/getRoomBaseInfo';

    constructor(cookies: Cookies, roomId: number, outputDir = "./recordings") {
        this.roomId = roomId;
        this.outputDir = path.resolve(outputDir);
        this.cookies = cookies;
        this.m3u8Path = `${roomId}.m3u8`;
        this.m4sPath = `${roomId}.m4s`;
        this.metaPath = path.join(this.outputDir, `meta.json`);
        this.fetcher = new SegmentFetcher(
            cookies,
            roomId,
            outputDir,
            path.join('./fragments', `${roomId}_${Date.now()}`),
            this.m3u8Path,
            this.m4sPath);
    }

    /**
     * 初始化录制环境
     */
    private async initRecorder() {
        if (this.recorderInitStatus)
            return;

        await this.ensureDir();

        this.recorderInitStatus = true;
    }

    /**
     * 确保录制目录存在
     */
    private async ensureDir() {
        const dirExist = await is_dirExist(this.outputDir, {
            throwError: true
        });
        if (!dirExist.is_dir) {
            global.logger.warn(`[RecorderManager] 录制目录不存在，创建目录: ${this.outputDir}`);
            await createDir(this.outputDir);
            global.logger.info(`[RecorderManager] 录制目录创建成功: ${this.outputDir}`);
        }

        // 确保目录中只保留单一文件
        const files = await getFilesList(this.outputDir);
        files.forEach(async file => {
            const ext = path.extname(file.name);
            if ([".m3u8", ".m4s", ".json"].includes(ext) || file.isDirectory)
                return;
            await fs.unlink(path.join(this.outputDir, file.name));
        });
    }

    /**
     * 启动录制流程
     */
    public async start() {
        if (this.recording) {
            global.logger.warn(`[RecorderManager] 录制已在进行中`);
            return;
        }

        try {
            await this.initRecorder();
        } catch (error) {
            global.logger.error(`[RecorderManager] 初始化录制环境失败: ${handleError(error).errMsg}`);
            return;
        }

        try {
            global.logger.info(`[RecorderManager] 启动录制任务 roomId=${this.roomId}`);
            this.recording = true;

            while (true) {
                // 检测是否开播
                const api = new BiliLiveApi(this.cookies, this.roomId);
                const updateLiveId = await api.getLiveKey();
                if (updateLiveId !== "0") {
                    const live_time = await api.getLiveTime();
                    global.logger.info(`[RecorderManager] 直播已开播，live_key=${updateLiveId}, live_uid=${await api.getLiveUid()}, live_time=${live_time}`);

                    this.m3u8Path = `${this.roomId}_${live_time.split(' ')[0]}.m3u8`;
                    this.m4sPath = `${this.roomId}_${live_time.split(' ')[0]}.m4s`;
                    this.fetcher = new SegmentFetcher(
                        this.cookies,
                        this.roomId,
                        this.outputDir,
                        path.join('./fragments', `${this.roomId}_${live_time.split(' ')[0]}`),
                        this.m3u8Path, this.m4sPath
                    );

                    try {
                        await this.fetcher.startLoop(60000); // 每60秒拉一次流地址
                    } catch (error) {
                        const { name } = handleError(error);
                        if (name === 'LiveNotLiveError') {
                            global.logger.warn(`[RecorderManager] 直播未开播，暂停录制`);
                            continue;
                        }
                        throw error;
                    }
                }
                await new Promise(resolve => setTimeout(resolve, 3 * 60 * 1000)); // 每3分钟检测一次开播状态
            }
        } catch (err) {
            const { errMsg } = handleError(err);
            global.logger.error(`[RecorderManager] 启动失败:`, errMsg);
            this.recording = false;
        }
    }

    /**
     * 写入 meta.json 元信息
     * 可在获取到首次有效 stream 时调用
     */
    public async writeMeta(): Promise<void> {
        global.logger.info(`[RecorderManager] 正在生成 meta.json ...`);
        try {
            const infoUrl = `${this.URL_GET_ROOM_BASE_INFO}?req_biz=web_room_componet&room_ids=${this.roomId}`;
            const res = await httpErrRepeat({
                url: infoUrl,
                method: "GET",
                headers: {}
            }, 3, "json");

            const roomData = res.data?.by_room_ids?.[String(this.roomId)];
            if (!roomData) {
                global.logger.warn(`[RecorderManager] meta.json 生成失败：未找到房间信息`);
                return;
            }

            const now = new Date();
            const isoDate = now.toISOString().replace("T", " ").replace("Z", "+00:00");

            const meta = {
                Title: roomData.title,
                Artist: roomData.uname,
                Date: isoDate,
                Comment: `B站直播录像\n主播：${roomData.uname}\n标题：${roomData.title}\n分区：${roomData.parent_area_name} - ${roomData.area_name}\n房间号：${roomData.room_id}\n开播时间：${roomData.live_time}\n录制程序：auto-recorder`,
                description: {
                    UserId: String(roomData.uid),
                    UserName: roomData.uname,
                    RoomId: String(roomData.room_id),
                    RoomTitle: roomData.title,
                    Area: roomData.area_name,
                    ParentArea: roomData.parent_area_name,
                    LiveStartTime: roomData.live_time,
                    RecordStartTime: isoDate,
                    Recorder: "auto-recorder",
                },
            };

            await fs.writeFile(this.metaPath, JSON.stringify(meta, null, 2));
            global.logger.info(`[RecorderManager] meta.json 写入成功`);
        } catch (error) {
            global.logger.error(`[RecorderManager] 写入 meta.json 失败: ${handleError(error).errMsg}`);
        }
    }

    /**
     * 模拟录制下载任务（可接入 HlsDownloader）
     */
    public async downloadStream(m3u8Url: string) {
        global.logger.info(`[RecorderManager] 开始下载: ${m3u8Url}`);
        await fs.writeFile(this.m3u8Path, `#EXTM3U\n#EXT-X-STREAM-INF:...`);
        await fs.writeFile(this.m4sPath, ""); // 此处示意写入数据
    }

    /**
     * 停止录制任务
     */
    public stop() {
        this.recording = false;
        global.logger.info(`[RecorderManager] 已停止录制`);
    }
}
