// B 站直播弹幕（WebSocket）相关类型

/** getDanmuInfo 返回的弹幕服务器信息 */
export type DanmuInfoResponse = {
    code: number;
    message: string;
    data?: {
        token?: string;
        host_list?: DanmakuHost[];
    } | null;
};

/** 弹幕服务器节点 */
export type DanmakuHost = {
    host: string;
    port?: number;
    ws_port?: number;
    wss_port: number;
};

/** room_init 返回（用于把短号转换成真实房间号，弹幕 WS 必须用真实房间号） */
export type RoomInitResponse = {
    code: number;
    message: string;
    data?: {
        room_id?: number;
        short_id?: number;
        live_status?: number;
    } | null;
};

/** 弹幕（DANMU_MSG） */
export type DanmakuItem = {
    kind: 'danmaku';
    /** 服务端时间戳（毫秒，墙钟） */
    timestampMs: number;
    /** 弹幕模式：1/2/3 滚动，4 底部，5 顶部 */
    mode: number;
    fontSize: number;
    /** 十进制 RGB 颜色 */
    color: number;
    /** 弹幕池 */
    pool: number;
    /** 用户 ID 的 8 位 hash（B 站原样） */
    uidHash: string;
    uid: number;
    uname: string;
    /** 弹幕 ID（十进制字符串，用于 XML rowid 与去重） */
    dmid: string;
    text: string;
};

/** 醒目留言（SUPER_CHAT_MESSAGE） */
export type SuperChatItem = {
    kind: 'superchat';
    timestampMs: number;
    uid: number;
    uname: string;
    /** B 站原始 price 字段 */
    price: number;
    /** 醒目留言持续展示时长（秒） */
    durationSec: number;
    message: string;
};

/** 舰长/提督/总督购买（GUARD_BUY） */
export type GuardBuyItem = {
    kind: 'guard';
    timestampMs: number;
    uid: number;
    uname: string;
    giftName: string;
    count: number;
    price: number;
    /** 1 总督，2 提督，3 舰长 */
    guardLevel: number;
};

/** 礼物赠送（SEND_GIFT） */
export type GiftItem = {
    kind: 'gift';
    timestampMs: number;
    uid: number;
    uname: string;
    giftName: string;
    count: number;
    price: number;
    /** gold / silver */
    coinType: string;
};

/** 开播（LIVE）/ 下播（PREPARING）通知消息 */
export type BiliLiveStatusMessage = {
    cmd: string;
    /** 本场次 key（LIVE 时有） */
    live_key?: string;
    /** 开播时间（UNIX 秒，仅在刚开播时下发的那个包里存在） */
    live_time?: number;
    roomid?: number;
    /** PREPARING 时：1 表示正在轮播 */
    round?: number;
};

/** 写入 XML 的一条事件 */
export type DanmakuEvent = DanmakuItem | SuperChatItem | GuardBuyItem | GiftItem;
