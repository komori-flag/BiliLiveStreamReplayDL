import fs from "fs";
import path from "path";
import { createHash } from "crypto";
import BiliLiveResHeadersBase from "./BiliLiveResHeadersBase.js";
import { httpErrRepeat } from "../utils/http.js";
import { handleError } from "../utils/handleError.js";
import { cookiesToString } from "../utils/cookies/toString.js";
import {
    DANMAKU_OP_AUTH,
    DANMAKU_OP_AUTH_REPLY,
    DANMAKU_OP_HEARTBEAT,
    DANMAKU_OP_MESSAGE,
    danmakuXmlHead,
    decodeDanmakuFrames,
    encodeDanmakuFrame,
    parseDanmakuEvent,
    serializeDanmakuEvent,
} from "./danmakuProtocol.js";

import type { Cookies } from "../model/cookies.js";
import type { BiliLiveStatusMessage, DanmakuEvent, DanmakuHost, DanmuInfoResponse, RoomInitResponse } from "../model/danmaku.js";

/** 心跳间隔（B 站要求 30s 一次） */
const HEARTBEAT_INTERVAL_MS = 30_000;
/** 心跳包体：B 站网页端实际发送的内容 */
const HEARTBEAT_BODY = "[object Object]";
/** WebSocket 建连超时 */
const CONNECT_TIMEOUT_MS = 10_000;
/** 认证回复超时 */
const AUTH_TIMEOUT_MS = 10_000;
/** 超过该时间没收到任何包就认为连接已死（服务器约每 60s 发一次人气值包） */
const RECV_TIMEOUT_MS = 90_000;
/** 重连最大退避 */
const RECONNECT_MAX_MS = 30_000;
/** 锚点确定前最多缓存的事件数 */
const BUFFER_MAX = 20000;
/** 锚点早于当前时间超过该秒数时，提示启动前的弹幕无法补采 */
const MISSED_DANMAKU_WARN_SEC = 60;

const URL_ROOM_INIT = "https://api.live.bilibili.com/room/v1/Room/room_init";
const URL_GET_DANMU_INFO = "https://api.live.bilibili.com/xlive/web-room/v1/index/getDanmuInfo";
const URL_NAV = "https://api.bilibili.com/x/web-interface/nav";
const URL_FINGER_SPI = "https://api.bilibili.com/x/frontend/finger/spi";
/** WBI mixinKey 的固定置换表 */
const WBI_MIXIN_KEY_TAB = [
    46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
    27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
    37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
    22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
];
/** WBI 密钥缓存时间（img_key/sub_key 每天轮换） */
const WBI_KEY_TTL_MS = 6 * 60 * 60 * 1000;

/** 弹幕录制选项（连接始终建立，这些选项只影响是否生成 XML 及写入哪些类型） */
export type DanmakuRecordOptions = {
    /** 是否生成弹幕 XML；false 时仍保持连接（用于开播/下播通知） */
    record?: boolean;
    /** 保存醒目留言（SuperChat） */
    superChat?: boolean;
    /** 保存舰长/提督/总督购买 */
    guardBuy?: boolean;
    /** 保存礼物赠送 */
    gift?: boolean;
};

/**
 * 弹幕 XML 写入器
 * 一场直播一个文件；重启续录时截掉上次留下的 </i> 再追加
 */
export class DanmakuXmlWriter {
    private readonly filePath: string;
    private readonly chatId: number;
    private fd: number | null = null;
    /** 下一次写入的文件偏移（r+ 模式没有隐式追加，需显式定位） */
    private position = 0;
    public written = 0;

    constructor(filePath: string, chatId: number) {
        this.filePath = filePath;
        this.chatId = chatId;
    }

    public open(): void {
        if (this.fd !== null) return;

        fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
        const exists = fs.existsSync(this.filePath);
        const fd = fs.openSync(this.filePath, exists ? "r+" : "w+");
        const size = fs.fstatSync(fd).size;

        if (size === 0) {
            const head = danmakuXmlHead(this.chatId);
            fs.writeSync(fd, head, 0);
            this.position = Buffer.byteLength(head, "utf8");
        } else {
            const tailLen = Math.min(64, size);
            const tail = Buffer.alloc(tailLen);
            fs.readSync(fd, tail, 0, tailLen, size - tailLen);
            const footer = tail.lastIndexOf("</i>");
            this.position = footer >= 0 ? size - tailLen + footer : size;
            if (footer >= 0) fs.ftruncateSync(fd, this.position);
        }

        this.fd = fd;
    }

    public write(event: DanmakuEvent, stimeSec: number): void {
        if (this.fd === null) throw new Error("DanmakuXmlWriter 尚未打开");
        const line = serializeDanmakuEvent(event, stimeSec);
        fs.writeSync(this.fd, line, this.position);
        this.position += Buffer.byteLength(line, "utf8");
        this.written++;
    }

    public close(): void {
        if (this.fd === null) return;
        const fd = this.fd;
        this.fd = null;
        try {
            fs.writeSync(fd, "</i>\n", this.position);
        } finally {
            fs.closeSync(fd);
        }
    }
}

type DanmakuSession = {
    stamp: string;
    /** 时间轴锚点（内容起点的墙钟毫秒）；拿到首个分片前为 null */
    anchorMs: number | null;
    writer: DanmakuXmlWriter | null;
    writeErrorLogged: boolean;
};

/**
 * DanmakuRecorder
 * 独立于录制主链路的弹幕采集器：维持直播间 WebSocket 长连接，
 * 按场次把弹幕 / SuperChat / 舰长 / 礼物写入与录像同名的 XML。
 */
export class DanmakuRecorder {
    private readonly roomId: number;
    private readonly outputDir: string;
    private readonly cookies: Cookies;
    private readonly headers: BiliLiveResHeadersBase;
    private readonly options: Required<DanmakuRecordOptions>;

    private realRoomId = 0;
    /** WBI mixinKey 及其过期时间 */
    private wbiMixinKey = "";
    private wbiKeyExpiresAt = 0;
    private ws: WebSocket | null = null;
    private connecting = false;
    private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    private connectTimer: ReturnType<typeof setTimeout> | null = null;
    private authTimer: ReturnType<typeof setTimeout> | null = null;
    private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    private reconnectAttempt = 0;
    private lastRecvAt = 0;
    private disposed = false;

    private session: DanmakuSession | null = null;
    /** 锚点确定前收到的事件；确定后按时间戳过滤再写入 */
    private buffer: DanmakuEvent[] = [];

    private readonly onExit = () => {
        try {
            this.endSession();
        } catch {
            // 进程退出阶段不再抛错
        }
    };

    constructor(cookies: Cookies, roomId: number, outputDir: string, options: DanmakuRecordOptions = {}) {
        this.cookies = cookies;
        this.roomId = roomId;
        this.outputDir = outputDir;
        this.headers = new BiliLiveResHeadersBase(cookies);
        this.options = {
            record: options.record !== false,
            superChat: options.superChat !== false,
            guardBuy: options.guardBuy !== false,
            gift: options.gift !== false,
        };
        // SIGTERM 走 shutdown 时也会触发 exit，保证 XML 有闭合标签
        process.once("exit", this.onExit);
    }

    /** 启动弹幕连接（后台进行，不阻塞录制） */
    public start(): void {
        if (this.disposed) return;
        void this.connect();
    }

    /**
     * 开播/下播通知（来自 WS 的 LIVE / PREPARING）
     * 只在连接期间能收到，重连不会补发；调用方应保留轮询兜底
     */
    public onLiveStatusChange?: (status: "live" | "offline", message: BiliLiveStatusMessage) => void;

    /** 新场次开始：换到新的 XML 文件 */
    public beginSession(sessionStamp: string): void {
        if (this.disposed || !this.options.record) return;
        if (this.session) this.endSession();
        this.session = { stamp: sessionStamp, anchorMs: null, writer: null, writeErrorLogged: false };
        global.logger.info(`[DanmakuRecorder] 弹幕场次开始: ${sessionStamp}`);
    }

    /**
     * 设置时间轴锚点（首个分片的墙钟起始时间，秒）
     * 拿到锚点后才创建文件，并把之前缓存的事件按时间戳补写进去
     */
    public setAnchor(startTimeSec: number): void {
        const session = this.session;
        if (!session || session.anchorMs !== null) return;
        if (!this.options.record) return;
        if (!Number.isFinite(startTimeSec) || startTimeSec <= 0) return;

        session.anchorMs = Math.round(startTimeSec * 1000);

        const filePath = path.join(this.outputDir, `${this.roomId}_${session.stamp}.xml`);
        try {
            session.writer = new DanmakuXmlWriter(filePath, this.roomId);
            session.writer.open();
        } catch (err) {
            session.writer = null;
            global.logger.error(`[DanmakuRecorder] 创建弹幕 XML 失败: ${handleError(err).errMsg}`);
            return;
        }

        global.logger.info(`[DanmakuRecorder] 弹幕写入文件: ${filePath}（时间轴锚点 ${startTimeSec}s）`);

        // 场次已开播一段时间后才启动：视频会从头补，但弹幕 WS 只能收连接之后的消息，
        // 启动前的弹幕无法补采（B 站没有可用的历史弹幕接口），这里显式提示缺口
        const backlogSec = Math.round(Date.now() / 1000 - startTimeSec);
        if (backlogSec > MISSED_DANMAKU_WARN_SEC) {
            global.logger.warn(
                `[DanmakuRecorder] 该场次已开播 ${(backlogSec / 60).toFixed(1)} 分钟，` +
                `启动前的弹幕（约前 ${Math.floor(backlogSec)} 秒）无法补采，XML 将从当前时刻开始有数据`
            );
        }

        const pending = this.buffer;
        this.buffer = [];
        for (const event of pending) this.writeToSession(event);
    }

    /** 结束当前场次：写入 XML 闭合标签 */
    public endSession(): void {
        const session = this.session;
        if (!session) return;
        this.session = null;

        if (session.writer) {
            try {
                session.writer.close();
                global.logger.info(`[DanmakuRecorder] 弹幕场次结束，共写入 ${session.writer.written} 条`);
            } catch (err) {
                global.logger.error(`[DanmakuRecorder] 关闭弹幕 XML 失败: ${handleError(err).errMsg}`);
            }
        }
    }

    /** 停止弹幕录制并释放连接 */
    public dispose(): void {
        if (this.disposed) return;
        this.disposed = true;

        this.endSession();
        this.dropSocket();
        this.clearReconnectTimer();
        process.off("exit", this.onExit);
        global.logger.info("[DanmakuRecorder] 已停止弹幕录制");
    }

    /** 统一的请求头：Cookie 实时从 cookies 生成（BUVID3 可能是启动后才补的） */
    private buildHeaders(extra: Record<string, string> = {}): Record<string, string> {
        const headers = this.headers.createHeaders() as Record<string, string>;
        headers.Cookie = cookiesToString(this.cookies);
        headers.Referer = "https://live.bilibili.com/";
        headers.Origin = "https://live.bilibili.com";
        return { ...headers, ...extra };
    }

    /**
     * 确保 Cookie 里有 BUVID3
     * getDanmuInfo 缺 BUVID3 时很容易被风控（-352）
     */
    private async ensureBuvid(): Promise<void> {
        if (this.cookies.buvid3) return;

        try {
            const res = await httpErrRepeat({
                url: URL_FINGER_SPI,
                method: "GET",
                headers: this.buildHeaders({ Referer: "https://www.bilibili.com/" }),
            }, 2, "json");

            const buvid3 = String(res?.data?.b_3 ?? "");
            const buvid4 = String(res?.data?.b_4 ?? "");
            if (res?.code !== 0 || !buvid3) {
                global.logger.warn(`[DanmakuRecorder] 获取 BUVID3 失败: ${JSON.stringify(res)}`);
                return;
            }

            this.cookies.buvid3 = buvid3;
            if (buvid4) this.cookies.buvid4 = buvid4;
            global.logger.info("[DanmakuRecorder] Cookie 缺少 BUVID3，已自动获取");
        } catch (err) {
            global.logger.warn(`[DanmakuRecorder] 获取 BUVID3 失败: ${handleError(err).msg}`);
        }
    }

    /** 从 nav 接口取 WBI 的 img_key/sub_key 并生成 mixinKey */
    private async fetchWbiMixinKey(): Promise<string> {
        const res = await httpErrRepeat({
            url: URL_NAV,
            method: "GET",
            headers: this.buildHeaders({ Referer: "https://www.bilibili.com/" }),
        }, 2, "json");

        const imgUrl = res?.data?.wbi_img?.img_url;
        const subUrl = res?.data?.wbi_img?.sub_url;
        if (typeof imgUrl !== "string" || typeof subUrl !== "string") {
            throw new Error(`获取 WBI 密钥失败: ${JSON.stringify(res)}`);
        }

        const imgKey = imgUrl.slice(imgUrl.lastIndexOf("/") + 1).split(".")[0];
        const subKey = subUrl.slice(subUrl.lastIndexOf("/") + 1).split(".")[0];
        const raw = `${imgKey}${subKey}`;
        return WBI_MIXIN_KEY_TAB.map(index => raw[index] ?? "").join("").slice(0, 32);
    }

    /** 给参数加上 wts + w_rid 的 WBI 签名 */
    private async signWbi(params: Record<string, string | number>, forceRefresh = false): Promise<Record<string, string | number>> {
        if (forceRefresh || !this.wbiMixinKey || Date.now() >= this.wbiKeyExpiresAt) {
            this.wbiMixinKey = await this.fetchWbiMixinKey();
            this.wbiKeyExpiresAt = Date.now() + WBI_KEY_TTL_MS;
        }

        const signed: Record<string, string | number> = {
            ...params,
            wts: Math.floor(Date.now() / 1000),
        };
        const query = Object.keys(signed)
            .sort()
            .map(key => {
                const value = String(signed[key]).replace(/[!'()*]/g, "");
                return `${encodeURIComponent(key)}=${encodeURIComponent(value)}`;
            })
            .join("&");

        signed.w_rid = createHash("md5").update(query + this.wbiMixinKey).digest("hex");
        return signed;
    }

    /** 解析短号 -> 真实房间号（弹幕 WS 必须用真实房间号） */
    private async resolveRealRoomId(): Promise<number> {
        const res = await httpErrRepeat({
            url: `${URL_ROOM_INIT}?id=${this.roomId}`,
            method: "GET",
            headers: this.buildHeaders(),
        }, 3, "json") as RoomInitResponse;

        const roomId = Number(res?.data?.room_id);
        if (res?.code !== 0 || !Number.isFinite(roomId) || roomId <= 0) {
            throw new Error(`room_init 未返回有效房间号: ${JSON.stringify(res)}`);
        }
        return roomId;
    }

    private async fetchDanmuInfo(): Promise<DanmuInfoResponse["data"]> {
        const headers = this.buildHeaders();

        // getDanmuInfo 对 WBI 校验不严（更多是风控指纹），签名不可用时退化为原始参数
        for (let attempt = 0; attempt < 2; attempt++) {
            let query: string;
            try {
                const params = await this.signWbi({ id: this.realRoomId, type: 0 }, attempt > 0);
                query = Object.entries(params)
                    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
                    .join("&");
            } catch (err) {
                global.logger.warn(`[DanmakuRecorder] WBI 签名不可用，改用未签名请求: ${handleError(err).msg}`);
                query = `id=${this.realRoomId}&type=0`;
            }

            const res = await httpErrRepeat({
                url: `${URL_GET_DANMU_INFO}?${query}`,
                method: "GET",
                headers,
            }, 3, "json") as DanmuInfoResponse;

            const data = res?.data;
            if (res?.code === 0 && data?.token && Array.isArray(data.host_list) && data.host_list.length > 0) {
                return data;
            }

            if (attempt === 0) {
                global.logger.warn(`[DanmakuRecorder] getDanmuInfo 返回异常，刷新 WBI 签名后重试: ${JSON.stringify(res)}`);
                continue;
            }

            throw new Error(`getDanmuInfo 失败: ${JSON.stringify(res)}`);
        }

        throw new Error("getDanmuInfo 失败：重试后仍无可用数据");
    }

    private async connect(): Promise<void> {
        if (this.disposed || this.ws || this.connecting) return;
        this.connecting = true;

        try {
            await this.ensureBuvid();
            if (!this.realRoomId) this.realRoomId = await this.resolveRealRoomId();
            const info = await this.fetchDanmuInfo();
            if (this.disposed) return;

            const host = info?.host_list?.find(item => item?.host && item?.wss_port);
            if (!host) throw new Error("getDanmuInfo 未返回可用的弹幕服务器");

            this.openSocket(host, info?.token ?? "");
        } catch (err) {
            global.logger.warn(`[DanmakuRecorder] 连接弹幕服务器失败: ${handleError(err).msg}`);
            this.scheduleReconnect();
        } finally {
            this.connecting = false;
        }
    }

    private openSocket(host: DanmakuHost, token: string): void {
        // 只走 wss：TCP 端口（port/ws_port）容易被限流，弹幕会缺
        const url = `wss://${host.host}:${host.wss_port}/sub`;
        const ws = new WebSocket(url);
        ws.binaryType = "arraybuffer";
        this.ws = ws;
        this.lastRecvAt = Date.now();

        global.logger.info(`[DanmakuRecorder] 连接弹幕服务器: ${url}`);

        this.connectTimer = setTimeout(() => {
            if (this.ws !== ws) return;
            global.logger.warn("[DanmakuRecorder] 弹幕服务器连接超时，准备重连");
            this.dropSocket(ws);
            this.scheduleReconnect();
        }, CONNECT_TIMEOUT_MS);

        ws.onopen = () => {
            if (this.ws !== ws) return;
            const body = JSON.stringify({
                uid: Number(this.cookies.DedeUserID) || 0,
                roomid: this.realRoomId,
                protover: 3,
                buvid: this.cookies.buvid3 ?? "",
                platform: "web",
                type: 2,
                key: token,
            });
            ws.send(encodeDanmakuFrame(DANMAKU_OP_AUTH, body));

            this.authTimer = setTimeout(() => {
                if (this.ws !== ws) return;
                global.logger.warn("[DanmakuRecorder] 弹幕认证超时，准备重连");
                this.dropSocket(ws);
                this.scheduleReconnect();
            }, AUTH_TIMEOUT_MS);
        };

        ws.onmessage = event => {
            if (this.ws !== ws) return;
            this.handleData(event.data);
        };

        ws.onerror = () => {
            // 错误后浏览器/Node 都会跟一个 close，统一在 onclose 里重连
        };

        ws.onclose = event => {
            if (this.ws !== ws) return;
            global.logger.warn(`[DanmakuRecorder] 弹幕连接断开 code=${event.code}${event.reason ? `, reason=${event.reason}` : ""}`);
            this.dropSocket(ws);
            this.scheduleReconnect();
        };
    }

    private handleData(data: unknown): void {
        this.lastRecvAt = Date.now();

        let frames: ReturnType<typeof decodeDanmakuFrames>;
        try {
            frames = decodeDanmakuFrames(Buffer.from(data as ArrayBuffer));
        } catch (err) {
            global.logger.warn(`[DanmakuRecorder] 解析弹幕数据失败: ${handleError(err).msg}`);
            return;
        }

        for (const frame of frames) {
            if (frame.op === DANMAKU_OP_AUTH_REPLY) {
                this.handleAuthReply(frame.body);
            } else if (frame.op === DANMAKU_OP_MESSAGE) {
                this.handleMessage(frame.body);
            }
        }
    }

    private handleAuthReply(body: Buffer): void {
        const text = body.toString("utf8");
        let code = -1;
        try {
            code = Number(JSON.parse(text)?.code);
        } catch {
            // 保持 code = -1
        }

        if (code !== 0) {
            global.logger.warn(`[DanmakuRecorder] 弹幕认证失败: ${text}`);
            this.dropSocket();
            this.scheduleReconnect();
            return;
        }

        this.clearSocketTimers();
        this.reconnectAttempt = 0;
        this.startHeartbeat();
        global.logger.info("[DanmakuRecorder] 弹幕认证成功");
    }

    private handleMessage(body: Buffer): void {
        let msg: any;
        try {
            msg = JSON.parse(body.toString("utf8"));
        } catch {
            return;
        }

        const kind = String(msg?.cmd ?? "");
        if (kind === "LIVE") {
            this.onLiveStatusChange?.("live", msg as BiliLiveStatusMessage);
            return;
        }
        if (kind === "PREPARING") {
            this.onLiveStatusChange?.("offline", msg as BiliLiveStatusMessage);
            return;
        }
        if (!this.options.record) return;
        if (kind === "SEND_GIFT" && !this.options.gift) return;
        if (kind === "GUARD_BUY" && !this.options.guardBuy) return;
        if (kind === "SUPER_CHAT_MESSAGE" && !this.options.superChat) return;

        const event = parseDanmakuEvent(msg);
        if (!event) return;

        if (this.session?.anchorMs !== null && this.session?.anchorMs !== undefined) {
            this.writeToSession(event);
            return;
        }

        this.buffer.push(event);
        if (this.buffer.length > BUFFER_MAX) this.buffer.splice(0, this.buffer.length - BUFFER_MAX);
    }

    private writeToSession(event: DanmakuEvent): void {
        const session = this.session;
        if (!session || !session.writer || session.anchorMs === null) {
            this.buffer.push(event);
            if (this.buffer.length > BUFFER_MAX) this.buffer.splice(0, this.buffer.length - BUFFER_MAX);
            return;
        }

        // 锚点之前的消息不属于录像内容（例如剪辑流从场次中途开始）
        if (event.timestampMs < session.anchorMs) return;

        try {
            session.writer.write(event, (event.timestampMs - session.anchorMs) / 1000);
        } catch (err) {
            if (!session.writeErrorLogged) {
                session.writeErrorLogged = true;
                global.logger.error(`[DanmakuRecorder] 写入弹幕 XML 失败: ${handleError(err).errMsg}`);
            }
        }
    }

    private startHeartbeat(): void {
        this.clearHeartbeatTimer();
        this.heartbeatTimer = setInterval(() => {
            const ws = this.ws;
            if (!ws || ws.readyState !== WebSocket.OPEN) return;

            if (Date.now() - this.lastRecvAt > RECV_TIMEOUT_MS) {
                global.logger.warn("[DanmakuRecorder] 弹幕连接长时间无数据，准备重连");
                this.dropSocket(ws);
                this.scheduleReconnect();
                return;
            }

            try {
                ws.send(encodeDanmakuFrame(DANMAKU_OP_HEARTBEAT, HEARTBEAT_BODY));
            } catch (err) {
                global.logger.warn(`[DanmakuRecorder] 发送心跳失败: ${handleError(err).msg}`);
                this.dropSocket(ws);
                this.scheduleReconnect();
            }
        }, HEARTBEAT_INTERVAL_MS);
    }

    private scheduleReconnect(): void {
        if (this.disposed || this.reconnectTimer) return;

        const wait = Math.min(1000 * 2 ** this.reconnectAttempt, RECONNECT_MAX_MS);
        this.reconnectAttempt++;
        global.logger.warn(`[DanmakuRecorder] ${Math.round(wait / 1000)}s 后重连弹幕服务器`);

        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            void this.connect();
        }, wait);
    }

    private dropSocket(ws: WebSocket | null = this.ws): void {
        this.clearSocketTimers();
        this.ws = null;

        if (ws && ws.readyState !== WebSocket.CLOSED && ws.readyState !== WebSocket.CLOSING) {
            try {
                ws.close();
            } catch {
                // 已断开时忽略
            }
        }
    }

    private clearSocketTimers(): void {
        this.clearHeartbeatTimer();
        if (this.connectTimer) {
            clearTimeout(this.connectTimer);
            this.connectTimer = null;
        }
        if (this.authTimer) {
            clearTimeout(this.authTimer);
            this.authTimer = null;
        }
    }

    private clearHeartbeatTimer(): void {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
    }

    private clearReconnectTimer(): void {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
    }
}
