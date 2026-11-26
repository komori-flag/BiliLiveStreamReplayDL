// Fetcher 请求封装的数据类型

export type ResponseType = 'json' | 'text' | 'arrayBuffer' | 'blob';

export interface FetcherOptions extends RequestInit {
    /** 响应头超时时间（ms），默认 10000ms */
    timeout?: number;
    /**
     * 响应体停滞阈值（ms）：body 读取阶段连续多久没有收到新数据就中止并重试。
     * 默认 15000ms；设为 0 关闭。
     */
    stallTimeout?: number;
    /** 是否在最终失败时返回最后一次响应体（部分容错用） */
    returnLastResponse?: boolean;
}
