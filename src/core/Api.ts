import BiliLiveResHeadersBase from "./BiliLiveResHeadersBase.js";
import { Cookies } from "../type/Cookies.js";
import { httpErrRepeat } from "../utils/http.js";
import { queryConvert_URI_toStr } from "../utils/queryConvert/toString.js";

export type StreamItem = {
    start_time: number;
    end_time: number;
    stream: string;
};

export type StreamResponse = {
    code: number;
    message: string;
    ttl: number;
    data?: {
        code: number;
        msg: string;
        click_time: number;
        list: StreamItem[] | null;
        extra_list: StreamItem[] | null;
        ban_ec: boolean;
    } | null;
};

/**
 * BiliLiveApi
 * 封装与 B 站直播相关的 API 请求与状态（roomId、liveKey、liveUid、headers）。
 * 供上层业务类（如 SegmentFetcher）继承复用。
 */
export class BiliLiveApi {
    protected roomId: number;
    protected liveUid: number = 0;
    protected liveKey: string = "";
    protected liveTime: string = "0000-00-00 00:00:00";
    protected biliLiveResHeaders: BiliLiveResHeadersBase;
    protected cookies: Cookies;

    private readonly URL_GET_STREAM = "https://api.live.bilibili.com/xlive/web-room/v1/videoService/UserClickSlice";
    private readonly URL_GET_ROOM_BASE_INFO = "https://api.live.bilibili.com/xlive/web-room/v1/index/getRoomBaseInfo";

    constructor(cookies: Cookies, roomId: number) {
        this.roomId = roomId;
        this.cookies = cookies;
        this.biliLiveResHeaders = new BiliLiveResHeadersBase(this.cookies);
    }

    /**
     * 请求API获取最新stream数据
     */
    protected async getStreamApi(): Promise<StreamResponse> {
        const apiUrl = `${this.URL_GET_STREAM}?${queryConvert_URI_toStr({
            room_id: this.roomId,
            live_key: this.liveKey,
            live_uid: this.liveUid,
            web_location: 444.8,
        })}`;
        return await httpErrRepeat(
            {
                url: apiUrl,
                method: "GET",
                headers: this.biliLiveResHeaders.createHeaders(),
                body: undefined,
            },
            3,
            "json"
        );
    }

    /**
     * 尝试重新获取 live_id 与 live_uid
     */
    protected async updateLiveId(): Promise<void> {
        const infoUrl = `${this.URL_GET_ROOM_BASE_INFO}?${queryConvert_URI_toStr({
            req_biz: "web_room_componet",
            room_ids: this.roomId,
        })}`;
        const res = await httpErrRepeat(
            {
                url: infoUrl,
                method: "GET",
                headers: this.biliLiveResHeaders.createHeaders(),
            },
            3,
            "json"
        );
        const data = res.data?.by_room_ids?.[String(this.roomId)];

        if (!data || !data?.uid || isNaN(Number(data.uid))) {
            throw new Error("数据错误：无法获取 live_uid");
        }

        if (typeof data.live_id_str !== "string") {
            throw new Error("数据错误：无法获取 live_id_str");
        }

        if (typeof data.live_time !== "string") {
            throw new Error("数据错误：无法获取 live_time");
        }

        this.liveTime = data.live_time;

        this.liveKey = String(data.live_id_str);
        this.liveUid = Number(data.uid);
    }

    public async getLiveKey(): Promise<string> {
        await this.updateLiveId();
        return this.liveKey;
    }

    public async getLiveUid(): Promise<number> {
        await this.updateLiveId();
        return this.liveUid;
    }

    public async getLiveTime(): Promise<string> {
        await this.updateLiveId();
        return this.liveTime;
    }
}