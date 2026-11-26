// 弹幕 WebSocket 协议编解码与 XML 序列化
// 这里都是纯函数（除 zlib 解压外无副作用），便于离线测试

import { brotliDecompressSync, inflateSync } from "zlib";
import type { DanmakuEvent, DanmakuItem, GiftItem, GuardBuyItem, SuperChatItem } from "../model/danmaku.js";

/** 操作码：心跳 */
export const DANMAKU_OP_HEARTBEAT = 2;
/** 操作码：心跳回复（人气值） */
export const DANMAKU_OP_HEARTBEAT_REPLY = 3;
/** 操作码：业务消息（DANMU_MSG 等） */
export const DANMAKU_OP_MESSAGE = 5;
/** 操作码：认证 */
export const DANMAKU_OP_AUTH = 7;
/** 操作码：认证回复 */
export const DANMAKU_OP_AUTH_REPLY = 8;

/** 包体协议版本：brotli 压缩 */
export const DANMAKU_PROTO_BROTLI = 3;

const HEADER_LEN = 16;

export type DanmakuFrame = {
    op: number;
    ver: number;
    body: Buffer;
};

/** 编码一个弹幕协议包（4 字节总长 + 2 字节头长 + 2 字节协议版本 + 4 字节操作码 + 4 字节序号） */
export function encodeDanmakuFrame(op: number, body = ""): Buffer {
    const payload = Buffer.from(body, "utf8");
    const header = Buffer.alloc(HEADER_LEN);
    header.writeUInt32BE(HEADER_LEN + payload.length, 0);
    header.writeUInt16BE(HEADER_LEN, 4);
    header.writeUInt16BE(1, 6);
    header.writeUInt32BE(op, 8);
    header.writeUInt32BE(1, 12);
    return Buffer.concat([header, payload]);
}

/**
 * 解码弹幕协议包
 * op=5 且 protover=2/3 时包体是压缩的「多个包拼接」，解压后递归解析
 */
export function decodeDanmakuFrames(data: Buffer): DanmakuFrame[] {
    const frames: DanmakuFrame[] = [];
    let offset = 0;

    while (offset + HEADER_LEN <= data.length) {
        const packetLen = data.readUInt32BE(offset);
        const headerLen = data.readUInt16BE(offset + 4);
        const ver = data.readUInt16BE(offset + 6);
        const op = data.readUInt32BE(offset + 8);

        // 包长异常或数据不完整（WS 分片边界），丢弃剩余数据
        if (packetLen < headerLen || headerLen < HEADER_LEN || offset + packetLen > data.length) break;

        let body = data.subarray(offset + headerLen, offset + packetLen);
        if (op === DANMAKU_OP_MESSAGE && (ver === 2 || ver === 3)) {
            try {
                body = ver === DANMAKU_PROTO_BROTLI ? brotliDecompressSync(body) : inflateSync(body);
                frames.push(...decodeDanmakuFrames(body));
            } catch {
                // 单个压缩包损坏不影响后续包
            }
        } else {
            frames.push({ op, ver, body });
        }

        offset += packetLen;
    }

    return frames;
}

/** 把业务 JSON 解析成可写入 XML 的事件；无关消息返回 null */
export function parseDanmakuEvent(msg: any): DanmakuEvent | null {
    const cmd = String(msg?.cmd ?? "");
    if (cmd.startsWith("DANMU_MSG")) return parseDanmuMsg(msg);
    if (cmd === "SUPER_CHAT_MESSAGE") return parseSuperChat(msg);
    if (cmd === "GUARD_BUY") return parseGuardBuy(msg);
    if (cmd === "SEND_GIFT") return parseGift(msg);
    return null;
}

function parseDanmuMsg(msg: any): DanmakuItem | null {
    const info = msg?.info;
    if (!Array.isArray(info) || typeof info[1] !== "string") return null;

    // 新版协议会在 info[0] 末尾继续追加字段，这里只取稳定的前几位，新增参数直接忽略
    const head = info[0] ?? [];
    const timestampMs = Number(head[4]);
    if (!Number.isFinite(timestampMs) || timestampMs <= 0) return null;

    const color = Number(head[3]);

    return {
        kind: "danmaku",
        timestampMs,
        mode: Number(head[1]) || 1,
        fontSize: Number(head[2]) || 25,
        // 0 是合法的黑色，不能用 || 兜底
        color: Number.isFinite(color) ? color : 16777215,
        pool: Number(head[6]) || 0,
        uidHash: String(head[7] ?? "0"),
        uid: Number(info[2]?.[0]) || 0,
        uname: String(info[2]?.[1] ?? ""),
        // info[9].ct 是十六进制弹幕 ID；XML 的 rowid 用十进制
        dmid: hexToDecimal(String(info[9]?.ct ?? "")),
        text: info[1],
    };
}

function parseSuperChat(msg: any): SuperChatItem | null {
    const data = msg?.data;
    const timestampMs = toTimestampMs(data?.ts ?? data?.start_time);
    if (!data || timestampMs === null || typeof data.message !== "string") return null;

    return {
        kind: "superchat",
        timestampMs,
        uid: Number(data.uid) || 0,
        uname: String(data.user_info?.uname ?? ""),
        price: Number(data.price) || 0,
        durationSec: Number(data.time) || 0,
        message: data.message,
    };
}

function parseGuardBuy(msg: any): GuardBuyItem | null {
    const data = msg?.data;
    const timestampMs = toTimestampMs(data?.start_time);
    if (!data || timestampMs === null) return null;

    return {
        kind: "guard",
        timestampMs,
        uid: Number(data.uid) || 0,
        uname: String(data.username ?? data.uname ?? ""),
        giftName: String(data.gift_name ?? ""),
        count: Number(data.num) || 1,
        price: Number(data.price) || 0,
        guardLevel: Number(data.guard_level) || 0,
    };
}

function parseGift(msg: any): GiftItem | null {
    const data = msg?.data;
    const timestampMs = toTimestampMs(data?.timestamp);
    if (!data || timestampMs === null) return null;

    return {
        kind: "gift",
        timestampMs,
        uid: Number(data.uid) || 0,
        uname: String(data.uname ?? ""),
        giftName: String(data.giftName ?? ""),
        count: Number(data.num) || 1,
        price: Number(data.price) || 0,
        coinType: String(data.coin_type ?? ""),
    };
}

/** 服务端时间戳 -> 毫秒；兼容秒和毫秒两种字段（无效返回 null） */
function toTimestampMs(value: unknown): number | null {
    const time = Number(value);
    if (!Number.isFinite(time) || time <= 0) return null;
    return time > 1e12 ? time : time * 1000;
}

/** 十六进制 ID 转十进制字符串（XML rowid 兼容性更好）；非法返回 "0" */
function hexToDecimal(hex: string): string {
    const value = hex.replace(/^0x/i, "");
    if (!/^[0-9a-f]+$/i.test(value)) return "0";
    try {
        return BigInt(`0x${value}`).toString(10);
    } catch {
        return "0";
    }
}

/** B 站标准弹幕 XML 头 */
export function danmakuXmlHead(chatId: number): string {
    return `<?xml version="1.0" encoding="UTF-8"?>
<i>
    <chatserver>chat.bilibili.com</chatserver>
    <chatid>${chatId}</chatid>
    <mission>0</mission>
    <maxlimit>0</maxlimit>
    <state>0</state>
    <real_name>0</real_name>
    <source>k-v</source>
`;
}

/**
 * 序列化一条事件为 XML 行
 * @param stimeSec 相对录制内容起点的秒数
 */
export function serializeDanmakuEvent(event: DanmakuEvent, stimeSec: number): string {
    const ts = stimeSec.toFixed(3);
    switch (event.kind) {
        case "danmaku": {
            const p = [
                ts,
                event.mode,
                event.fontSize,
                event.color,
                Math.floor(event.timestampMs / 1000),
                event.pool,
                event.uidHash,
                event.dmid,
            ].join(",");
            return `    <d p="${escapeXml(p)}" uid="${event.uid}" user="${escapeXml(event.uname)}">${escapeXml(event.text)}</d>\n`;
        }
        case "superchat":
            return `    <sc ts="${ts}" uid="${event.uid}" user="${escapeXml(event.uname)}" price="${event.price}" time="${event.durationSec}">${escapeXml(event.message)}</sc>\n`;
        case "guard":
            return `    <guard ts="${ts}" uid="${event.uid}" user="${escapeXml(event.uname)}" giftname="${escapeXml(event.giftName)}" count="${event.count}" price="${event.price}" level="${event.guardLevel}"/>\n`;
        case "gift":
            return `    <gift ts="${ts}" uid="${event.uid}" user="${escapeXml(event.uname)}" giftname="${escapeXml(event.giftName)}" count="${event.count}" price="${event.price}" cointype="${escapeXml(event.coinType)}"/>\n`;
    }
}

/** XML 特殊字符转义（同时清掉 XML 1.0 不允许的控制字符） */
export function escapeXml(text: string): string {
    return text
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
        .replace(/[&<>"']/g, char => {
            switch (char) {
                case "&": return "&amp;";
                case "<": return "&lt;";
                case ">": return "&gt;";
                case "\"": return "&quot;";
                default: return "&apos;";
            }
        });
}
