import BiliLiveResHeadersBase from "./BiliLiveResHeadersBase.js";
import type { Cookies } from "../model/cookies.js";
import type { GetOtherSliceListResponse, GetUserSliceStreamResponse, ReplayTimeRange, StreamResponse } from "../model/api.js";
import { handleError } from "../utils/handleError.js";
import { httpErrRepeat } from "../utils/http.js";
import { queryConvert_URI_toStr } from "../utils/queryConvert/toString.js";

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
    /**
     * 该场次回放对应的精确时间范围
     * 仅在直播已结束（主播下播）时解析：下播后接口不再接受默认的
     * liveTime ~ liveTime + 24h 范围（返回 code=100 非法参数），
     * 需要用回放列表中的 start_time / end_time 才能取到剩余分片
     */
    protected replayTimeRange: ReplayTimeRange | null = null;
    protected biliLiveResHeaders: BiliLiveResHeadersBase;
    protected cookies: Cookies;

    private readonly URL_GET_STREAM = "https://api.live.bilibili.com/xlive/web-room/v1/videoService/UserClickSlice";
    private readonly URL_GET_ROOM_BASE_INFO = "https://api.live.bilibili.com/xlive/web-room/v1/index/getRoomBaseInfo";
    private readonly URL_GET_USER_SLICE_STREAM = "https://api.live.bilibili.com/xlive/web-room/v1/videoService/GetUserSliceStream";
    private readonly URL_GET_OTHER_SLICE_LIST = "https://api.live.bilibili.com/xlive/web-room/v1/videoService/GetOtherSliceList";

    constructor(cookies: Cookies, roomId: number) {
        this.roomId = roomId;
        this.cookies = cookies;
        this.biliLiveResHeaders = new BiliLiveResHeadersBase(this.cookies);
    }

    /**
     * 获取用户点击所在的实时直播回放片段
     */
    protected async getUserClickSliceStream(): Promise<StreamResponse> {
        if (this.liveUid === 0) {
            await this.updateLiveId();
        }
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
     * 请求直播间基础信息（不修改内部状态）
     */
    private async fetchRoomLiveInfo(): Promise<{ liveKey: string, liveUid: number, liveTime: string }> {
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

        return {
            liveKey: String(data.live_id_str),
            liveUid: Number(data.uid),
            liveTime: data.live_time,
        };
    }

    /**
     * 尝试重新获取 live_id 与 live_uid
     */
    protected async updateLiveId(): Promise<void> {
        const { liveKey, liveUid, liveTime } = await this.fetchRoomLiveInfo();

        // 只有切换到另一个新的直播场次时才作废旧的回放时间范围；
        // live_key 变为 "0"（下播）时保留，因为取该场次剩余回放分片仍需要旧的 live_key
        if (this.liveKey && this.liveKey !== liveKey && liveKey !== "0") {
            global.logger.info(`[BiliLiveApi] 直播场次变更：${this.liveKey} -> ${liveKey}，清空旧的回放时间范围`);
            this.replayTimeRange = null;
        }

        this.liveTime = liveTime;

        this.liveKey = liveKey;
        this.liveUid = liveUid;
    }

    /**
     * 查询直播间当前是否处于开播状态
     * - 不修改 liveKey / liveUid / liveTime：下播后 updateLiveId() 会把 liveKey 写成 "0"，
     *   而取该场次回放分片仍要带上旧的 live_key，所以这里只做只读查询
     * - 请求失败时按「开播中」处理，避免因网络抖动误判下播而结束本场录制
     */
    protected async isLiving(): Promise<boolean> {
        try {
            const { liveKey } = await this.fetchRoomLiveInfo();
            return liveKey !== "" && liveKey !== "0";
        } catch (err) {
            global.logger.warn(`[BiliLiveApi] 查询直播状态失败，按开播中处理: ${handleError(err).msg}`);
            return true;
        }
    }

    /**
     * 从回放列表中解析当前 live_key 所属场次的时间范围
     * 主播下播后该场次数据才会出现在回放列表里，其中的 end_time 可用于请求剩余回放分片
     */
    protected async resolveReplayTimeRange(): Promise<ReplayTimeRange | null> {
        if (!this.liveKey || this.liveKey === "0") return null;

        try {
            const res = await this.getOtherSliceList();
            if (res?.code !== 0) {
                global.logger.warn(`[BiliLiveApi] 获取回放列表失败: ${JSON.stringify(res)}`);
                return null;
            }

            const replayInfo = res?.data?.replay_info;
            if (!replayInfo || replayInfo.length === 0) {
                global.logger.warn("[BiliLiveApi] 回放列表为空");
                return null;
            }

            const item = replayInfo.find(r => String(r?.live_key) === this.liveKey);
            if (!item) {
                global.logger.warn(`[BiliLiveApi] 回放列表中未找到 live_key=${this.liveKey} 的场次`);
                return null;
            }

            const start_time = Number(item.start_time);
            const end_time = Number(item.end_time);
            if (!Number.isFinite(start_time) || !Number.isFinite(end_time) || end_time <= start_time) {
                global.logger.warn(`[BiliLiveApi] live_key=${this.liveKey} 的回放时间范围异常: start_time=${item.start_time}, end_time=${item.end_time}`);
                return null;
            }

            this.replayTimeRange = { start_time, end_time };
            return this.replayTimeRange;
        } catch (err) {
            global.logger.error(`[BiliLiveApi] 解析回放时间范围失败: ${handleError(err).errMsg}`);
            return null;
        }
    }

    /**
     * 获取某位主播的切片视频流
     */
    protected async getUserSliceStream(start_time?: number, end_time?: number): Promise<GetUserSliceStreamResponse> {
        if (this.liveUid === 0) {
            await this.updateLiveId();
        }
        const apiUrl = `${this.URL_GET_USER_SLICE_STREAM}?${queryConvert_URI_toStr({
            // liveTime: 2026-07-16 13:58:46 -> 1784181526
            // 直播结束后必须使用回放列表中该场次的精确范围，否则接口返回 code=100 非法参数
            start_time: start_time || this.replayTimeRange?.start_time || Date.parse(this.liveTime) / 1000,
            end_time: end_time || this.replayTimeRange?.end_time || Date.parse(this.liveTime) / 1000 + 24 * 3600, // 24 小时
            live_key: this.liveKey,
            live_uid: this.liveUid,
            web_location: 444.194,
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
     * 获取某位主播的回放列表
     */
    protected async getOtherSliceList(
        time_range: number = 3,
        page: number = 1,
        page_size: number = 20
    ): Promise<GetOtherSliceListResponse> {
        if (this.liveUid === 0) {
            await this.updateLiveId();
        }
        const apiUrl = `${this.URL_GET_OTHER_SLICE_LIST}?${queryConvert_URI_toStr({
            time_range,
            live_uid: this.liveUid,
            // page 为页码（num），page_size 为每页数量（num，最大 30），两者是独立参数
            page,
            page_size,
            web_location: 444.194,
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