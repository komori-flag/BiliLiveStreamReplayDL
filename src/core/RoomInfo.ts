// src/core/RoomInfo.ts
import { Cookies } from "../type/Cookies.js";
import { handleError } from "../utils/handleError.js";
import { httpErrRepeat } from "../utils/http.js";
import { queryConvert_URI_toStr } from "../utils/queryConvert/toString.js";
import BiliLiveResHeadersBase from "./BiliLiveResHeadersBase.js";

/**
 * RoomInfoFetcher 用于获取房间的基础信息。
 * 负责解析出 roomid 对应的 uid（live_uid）、
 * 标题、分区、开播时间等信息。
 */
export class RoomInfoFetcher {
    private readonly roomBaseUrl = "https://api.live.bilibili.com/room/v1/Room/get_status_info_by_uids";

    private biliLiveResHeaders: BiliLiveResHeadersBase;

    constructor(cookies: Cookies){
        this.biliLiveResHeaders = new BiliLiveResHeadersBase(cookies);
    }

    /**
     * 获取房间基础信息。
     * 主要用途：解析 live_uid、title、area 等。
     */
    async getRoomBaseInfo(roomid: number): Promise<RoomBaseInfo> {
        const url = `${this.roomBaseUrl}?${queryConvert_URI_toStr({
            'req_biz': 'web_room_componet',
            'room_ids': roomid
        })}`;

        try {
            const res = await httpErrRepeat({
                url,
                'method': "GET",
                'headers': this.biliLiveResHeaders.createHeaders()
            }, 3, "json");
            const data = res?.data?.by_room_ids?.[String(roomid)];

            if (!data) {
                global.logger.warn(`房间 ${roomid} 返回数据为空或结构异常`);
                throw new Error("无效房间信息（返回为 null）");
            }

            const liveUid = data.uid;
            if (!liveUid) {
                global.logger.error(`无法从房间信息中解析出 UID（roomid=${roomid}）`);
                throw new Error("无有效合成场次");
            }

            const info: RoomBaseInfo = {
                roomid,
                live_uid: liveUid,
                title: data.title ?? "未知标题",
                user_name: data.uname ?? "未知主播",
                area: data.area_name ?? "未知分区",
                parent_area: data.parent_area_name ?? "未知主分区",
                live_status: data.live_status ?? 0,
                live_start_time: data.live_start_time ?? 0,
                live_key: data.live_id_str ?? "",
            };

            global.logger.info(`房间信息获取成功：${info.title} (${info.user_name}) [UID=${info.live_uid}, liveKey=${info.live_key}]`);
            return info;
        } catch (err) {
            global.logger.error(`获取房间信息失败: ${handleError(err).msg}`);
            throw err;
        }
    }
}

/**
 * 房间基础信息类型声明
 */
export interface RoomBaseInfo {
    roomid: number;
    live_uid: number;
    title: string;
    user_name: string;
    area: string;
    parent_area: string;
    live_status: number;
    live_start_time: number;
    live_key: string
}
