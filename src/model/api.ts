// B 站直播相关接口的响应数据类型

export type StreamItem = {
    start_time: number;
    end_time: number;
    stream: string;
};

/** 回放列表（GetOtherSliceList）中的单个场次信息 */
export type ReplayInfoItem = {
    live_key: string;
    start_time: number;
    end_time: number;
};

/** 回放场次对应的时间范围（用于请求该场次的回放分片） */
export type ReplayTimeRange = {
    start_time: number;
    end_time: number;
};

/** B 站接口响应的公共外层结构 */
export type ApiFox = {
    code: number;
    message: string;
    ttl: number;
};

export type StreamResponse = ApiFox & {
    data?: {
        code: number;
        msg: string;
        click_time: number;
        list: StreamItem[] | null;
        extra_list: StreamItem[] | null;
        ban_ec: boolean;
    } | null;
};

export type GetUserSliceStreamResponse = ApiFox & {
    data?: {
        list: StreamItem[] | null;
        extra_list: StreamItem[] | null;
    }
}

export type GetOtherSliceListResponse = ApiFox & {
    data?: {
        replay_info: ReplayInfoItem[] | null;
        pagination?: {
            total?: number;
        } | null;
    } | null;
}
