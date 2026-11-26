// src/core/Fetcher.ts
import { delay, exponentialDelay } from '../utils/delay.js';
import { handleError } from '../utils/handleError.js';
import { parseResponse } from './parseResponse.js';
import type { FetcherOptions, ResponseType } from '../model/fetcher.js';

/**
 * Fetcher 请求封装类
 * 支持自动重试、延迟重试、超时、统一错误处理、业务层错误识别
 */
export class Fetcher {
    private maxRetry: number;
    private baseDelay: number;
    private maxDelay: number;
    /** 响应体停滞阈值（ms）；0 = 关闭。只覆盖"连上并收到响应头之后"的阶段 */
    private stallTimeout: number;

    constructor(maxRetry = 3, baseDelay = 1000, maxDelay = 5000, stallTimeout = 15000) {
        this.maxRetry = maxRetry;
        this.baseDelay = baseDelay;
        this.maxDelay = maxDelay;
        this.stallTimeout = stallTimeout;
    }

    /**
     * 带自动错误重试的请求方法
     * @param url 请求地址
     * @param options fetch 选项
     * @param responseType 返回数据类型
     */
    async httpErrRepeat<T>(
        url: string,
        options: FetcherOptions = {},
        responseType: ResponseType = 'json'
    ): Promise<{ headers: Headers, data: T }> {
        let attempt = 0;
        let lastError: Error | null = null;
        let lastResponse: Response | undefined;

        while (attempt <= this.maxRetry) {
            const controller = new AbortController();
            const timeout = options.timeout ?? 10000; // 默认超时 10s
            const timer = setTimeout(() => controller.abort(), timeout);

            try {
                global.logger.info(`[Fetcher] ${attempt === 0 ? '' : `(${attempt + 1}/${this.maxRetry})`} 请求中: ${url}`);

                global.logger.debug(`[Fetcher] 请求选项: ${JSON.stringify(options)}`);

                const res = await fetch(url, {
                    ...options,
                    signal: controller.signal,
                });

                global.logger.debug(`[Fetcher] 响应头: ${JSON.stringify(res.headers)}`);

                clearTimeout(timer);

                if (!res.ok) {
                    throw new Error(`HTTP状态码异常: ${res.status} ${res.statusText}`);
                }

                let data: any;
                let headers: Headers;
                try {
                    headers = res.headers;
                    data = await parseResponse<T>(res, responseType, {
                        'stallTimeout': options.stallTimeout ?? this.stallTimeout,
                        'abort': () => controller.abort(),
                    });
                } catch (parseErr: any) {
                    // 停滞是主动中止，不是解析失败：保留原文案，方便日志里区分
                    if (String(parseErr?.message).includes('响应体停滞')) throw parseErr;
                    throw new Error(`响应体解析失败: ${parseErr.message}`);
                }

                // 业务逻辑层错误检测
                if (data?.code && data.code !== 0) {
                    if (data.code === -101 || String(data?.message).includes('账号未登录'))
                        throw new Error('账号未登录');
                    if (data.code === 10121188 || String(data?.message).includes('权限不足'))
                        throw new Error('[实时直播剪辑视频流] 权限不足');
                    if (data.code === 301 || String(data?.message).includes('没有剪辑权限'))
                        throw new Error('[直播回放切片视频流] 权限不足');
                    if (data.code === 202 || String(data?.message).includes('无有效合成场次'))
                        throw new Error('[实时直播剪辑视频流] 无有效合成场次');

                    throw new Error(`接口业务异常 code=${data.code}, message=${data.message}`);
                }

                logger.info(`[Fetcher] 请求成功: ${url}`);
                return {
                    headers,
                    data,
                };
            } catch (err) {
                clearTimeout(timer);
                const { msg, errObj, name } = handleError(err);
                lastError = errObj;

                const errorType = name === 'AbortError' ? '超时或中止' : msg;

                attempt++;
                if (attempt > this.maxRetry) {
                    global.logger.error(
                        `[Fetcher] 请求失败已达最大重试次数 (${this.maxRetry})，错误: ${errorType}`
                    );
                    if (
                        options.returnLastResponse &&
                        lastResponse &&
                        'data' in lastResponse &&
                        lastResponse.data
                    ) {
                        global.logger.warn('[Fetcher] 返回最后一次响应体（容错）');
                        return {
                            headers: lastResponse.headers,
                            data: await parseResponse<T>(lastResponse, responseType),
                        }
                    }
                    throw err;
                }

                const wait = exponentialDelay(this.baseDelay, 2, attempt, this.maxDelay);
                global.logger.warn(
                    `[Fetcher] 第 ${attempt} 次请求失败 (${errorType})，将在 ${wait}ms 后重试...`
                );
                await delay(wait);
            }
        }

        throw lastError ?? new Error(`[Fetcher] 未知错误: ${url}`);
    }

}
