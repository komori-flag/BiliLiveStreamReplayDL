import { SegmentFetcher, type SegmentFetcherLimits } from "./SegmentFetcher.js";
import { httpErrRepeat } from "../utils/http.js";
import fs from "fs/promises";
import path from "path";
import { handleError } from "../utils/handleError.js";
import { is_dirExist } from "../utils/is_dirExist.js";
import { createDir } from "../utils/createDir.js";
import { getFilesList } from "../utils/getFilesList.js";

import type { Cookies } from "../model/cookies.js";
import type { DanmakuRecorder } from "./DanmakuRecorder.js";
import { BiliLiveApi } from "./Api.js";
import CheckReplayPermissions from "./CheckReplayPermissions.js";
import { PermissionDeniedError } from "../utils/errors.js";
import { Mp4Converter } from "./Mp4Converter.js";
import { config } from "../config.js";

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
    /** 弹幕录制器（可选；与录制主链路解耦，失败不影响录像） */
    private readonly danmakuRecorder?: DanmakuRecorder;
    /** 等待下一次开播检测的唤醒句柄（收到弹幕 LIVE 时提前唤醒） */
    private wakeNextCheck: (() => void) | null = null;
    /** 最近一次通过弹幕收到开播通知的时间（接口短暂延迟时用于快速重试） */
    private liveSignalAt = 0;
    /** 场次结束后的 MP4 转换器（后台串行执行，不阻塞下一次开播检测） */
    private readonly mp4Converter: Mp4Converter;
    /** 单个输出文件的大小/时长上限（0 = 不限制），由 config.recordLimits 换算 */
    private readonly groupLimits: SegmentFetcherLimits;

    /**
     * 当前使用的账号 ID（DedeUserID）
     * 排权限问题时最先要看的就是"到底用的是哪个号"——cookie 来源可能返回与预期不同的账号
     */
    private get accountId(): string {
        return this.cookies?.DedeUserID || '未知账号';
    }

    private recording = false;
    private recorderInitStatus = false;
    private readonly URL_GET_ROOM_BASE_INFO = 'https://api.live.bilibili.com/xlive/web-room/v1/index/getRoomBaseInfo';

    constructor(cookies: Cookies, roomId: number, outputDir = "./recordings", danmakuRecorder?: DanmakuRecorder) {
        this.roomId = roomId;
        this.outputDir = outputDir;
        this.cookies = cookies;
        this.danmakuRecorder = danmakuRecorder;
        this.m3u8Path = `${roomId}.m3u8`;
        this.m4sPath = `${roomId}.m4s`;
        this.metaPath = path.join(this.outputDir, `meta.json`);
        this.mp4Converter = new Mp4Converter({
            'outputDir': this.outputDir,
            'enable': config.mp4Convert?.enable !== false,
            'ffmpegPath': config.ffmpeg?.path,
            'stallTimeoutMs': config.ffmpeg?.stallTimeoutMs,
            'deleteSource': config.mp4Convert?.deleteSource,
            'faststart': config.mp4Convert?.faststart !== false,
        });
        // 配置用 MB / 分钟（贴近 blrec 的习惯），下载器统一用字节 / 秒
        const maxFileSizeMB = config.recordLimits?.maxFileSizeMB ?? 0;
        const maxDurationMin = config.recordLimits?.maxDurationMin ?? 0;
        this.groupLimits = {
            'maxFileSizeBytes': maxFileSizeMB > 0 ? Math.round(maxFileSizeMB * 1024 * 1024) : 0,
            'maxFileDurationSec': maxDurationMin > 0 ? Math.round(maxDurationMin * 60) : 0,
        };
        this.fetcher = new SegmentFetcher(
            cookies,
            roomId,
            outputDir,
            path.join('./fragments', `${roomId}_${Date.now()}`),
            this.m3u8Path,
            this.m4sPath,
            0,
            this.groupLimits);
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

        // 确保目录中只保留录制产物
        // .xml 是弹幕文件、.mp4 是场次转换后的成品，都不能当临时文件删掉
        const files = await getFilesList(this.outputDir);
        files.forEach(async file => {
            const ext = path.extname(file.name);
            if ([".m3u8", ".m4s", ".json", ".xml", ".mp4"].includes(ext) || file.isDirectory)
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

        // MP4 转换依赖 ffmpeg：启动时探测一次；缺失只告警，不影响录制
        await this.mp4Converter.probe();

        // 弹幕连接后台启动，不阻塞录制；同时用弹幕的 LIVE/PREPARING 提前感知开播/下播
        if (this.danmakuRecorder) {
            this.danmakuRecorder.onLiveStatusChange = (status, message) => {
                global.logger.info(`[RecorderManager] 弹幕通知直播状态: ${status}${message.live_time ? `, live_time=${message.live_time}` : ""}`);
                if (status === "live") {
                    this.liveSignalAt = Date.now();
                    this.wakeNextCheck?.();
                }
            };
            this.danmakuRecorder.start();
        }

        try {
            global.logger.info(`[RecorderManager] 启动录制任务 roomId=${this.roomId}，账号=${this.accountId}`);
            /** 
             * 录制来源
             * 0. 直播回放权限
             * 1. 实时直播剪辑权限
             */
            let recordSource = 0;
            this.recording = true;
            const api = new BiliLiveApi(this.cookies, this.roomId);

            await this.checkReplayPermissions();

            while (true) {
                // 检测是否开播
                const updateLiveId = await api.getLiveKey();
                if (updateLiveId !== "0") {
                    const live_time = await api.getLiveTime();
                    global.logger.info(`[RecorderManager] 直播已开播，live_key=${updateLiveId}, live_uid=${await api.getLiveUid()}, live_time=${live_time}`);

                    const checkReplayPermissionsResult = await this.checkReplayPermissions();
                    if(checkReplayPermissionsResult.is_replay_permission) {
                        recordSource = 0;
                    } else if(checkReplayPermissionsResult.is_realtime_edit_permission) {
                        recordSource = 1;
                    } else {
                        throw new PermissionDeniedError(`账号 ${this.accountId} 对主播 ${this.roomId} 没有录制权限（直播回放、实时剪辑权限均无）`);
                    }

                    // 文件名带上开播时刻（秒级）区分同日多场次：同一场次 live_time 恒定，
                    // 重启后仍算出同一名字，primeAppendedFromPlaylist 才能续录
                    // "2026-10-02 20:30:45" -> "2026-10-02_20-30-45"
                    const sessionStamp =
                        live_time.trim().replace(/[<>"/\\|?*\s]+/g, '_').replace(/:/g, '-') || `t${Date.now()}`;
                    this.m3u8Path = `${this.roomId}_${sessionStamp}.m3u8`;
                    this.m4sPath = `${this.roomId}_${sessionStamp}.m4s`;
                    // 换场次前先把上一个下载器持有的 worker 池销毁，否则每场次都会漏 4 个线程
                    // 同时解除弹幕锚点回调，避免旧下载器的重试队列给新场次设错时间轴
                    if (this.fetcher) this.fetcher.onFirstStreamStartTime = undefined;
                    this.fetcher?.dispose?.();
                    this.fetcher = new SegmentFetcher(
                        this.cookies,
                        this.roomId,
                        this.outputDir,
                        path.join('./fragments', `${this.roomId}_${sessionStamp}`),
                        this.m3u8Path, this.m4sPath, recordSource, this.groupLimits
                    );
                    // 首个分片的起始墙钟时间作为弹幕时间轴锚点
                    this.fetcher.onFirstStreamStartTime =
                        (startTime) => this.danmakuRecorder?.setAnchor(startTime);
                    this.danmakuRecorder?.beginSession(sessionStamp);

                    try {
                        await this.fetcher.startLoop(15000); // 每15秒拉一次流地址（上游切片约10s推进一次；实际周期还会叠加下载耗时）
                    } catch (error) {
                        const { name } = handleError(error);
                        if (name === 'LiveNotLiveError') {
                            // 主播下播 / 换场次属于正常流程，不按警告处理
                            global.logger.info(`[RecorderManager] 直播未开播，暂停录制`);
                            if (this.fetcher) this.fetcher.onFirstStreamStartTime = undefined;
                            this.danmakuRecorder?.endSession();
                            // 本场次录制结束：把该场次的所有输出组转成 MP4
                            // 后台执行（void），转换大文件时不阻塞下一次开播检测
                            void this.finalizeSessionMp4(this.m4sPath);
                            continue;
                        }
                        throw error;
                    }
                }

                // 刚收到弹幕开播通知、但房间接口还没刷新时，短暂快速重试；否则保持 3 分钟轮询
                const recentlySignaled = Date.now() - this.liveSignalAt < 60_000;
                await this.waitNextCheck(recentlySignaled ? 10_000 : 3 * 60 * 1000);
            }
        } catch (err) {
            const { errMsg } = handleError(err);
            global.logger.error(`[RecorderManager] 启动失败:` + errMsg);
            this.danmakuRecorder?.dispose();
            this.recording = false;
        }
    }

    /**
     * 场次结束后把该场次的所有输出组转成 MP4
     *
     * 转换失败只记日志：源 .m4s / .m3u8 始终保留（removeSource 开启时也只在成功后删除）。
     */
    private async finalizeSessionMp4(combinedName: string): Promise<void> {
        try {
            await this.mp4Converter.convertSession(combinedName);
        } catch (err) {
            global.logger.error(`[RecorderManager] 场次 MP4 转换失败: ${handleError(err).errMsg}`);
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
        this.fetcher?.dispose?.();
        this.danmakuRecorder?.dispose();
        global.logger.info(`[RecorderManager] 已停止录制`);
    }

    /**
     * 等待下一次开播检测
     * 收到弹幕开播通知时通过 wakeNextCheck 提前唤醒，避免最多 3 分钟的检测盲区
     */
    private waitNextCheck(ms: number): Promise<void> {
        return new Promise(resolve => {
            const timer = setTimeout(() => {
                this.wakeNextCheck = null;
                resolve();
            }, ms);

            this.wakeNextCheck = () => {
                clearTimeout(timer);
                this.wakeNextCheck = null;
                resolve();
            };
        });
    }

    /**
     * 检查录制权限
     */
    private async checkReplayPermissions() {
        // 检测账号是否对目标主播拥有权限
        const checkReplayPermissions = new CheckReplayPermissions(this.cookies, this.roomId);

        // 1. 直播回放权限
        const is_replay_permission = await checkReplayPermissions.checkReplayPermissions();
        // 2. 实时直播剪辑权限
        const is_realtime_edit_permission = await checkReplayPermissions.checkRealtimeEditingPermissions();

        // 如果两个权限都没有，抛出 PermissionDeniedError
        if (!is_replay_permission && !is_realtime_edit_permission) {
            throw new PermissionDeniedError(`账号 ${this.accountId} 对主播 ${this.roomId} 没有录制权限（直播回放、实时剪辑权限均无）`);
        }

        logger.info(`[RecorderManager] 检查录制权限成功，直播回放权限：${is_replay_permission}, 实时直播剪辑权限：${is_realtime_edit_permission}`);

        return {
            is_replay_permission,
            is_realtime_edit_permission
        }
    }
}
