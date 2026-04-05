// src/core/Fetcher.ts
import { delay, exponentialDelay } from '../utils/delay.js';
import { handleError } from '../utils/handleError.js';
import { parseResponse } from './parseResponse.js';

export type ResponseType = 'json' | 'text' | 'arrayBuffer' | 'blob';

export interface FetcherOptions extends RequestInit {
    /** 超时时间（ms），默认 10000ms */
    timeout?: number;
    /** 是否在最终失败时返回最后一次响应体（部分容错用） */
    returnLastResponse?: boolean;
}

/**
 * Fetcher 请求封装类
 * 支持自动重试、延迟重试、超时、统一错误处理、业务层错误识别
 */
export class Fetcher {
    private maxRetry: number;
    private baseDelay: number;
    private maxDelay: number;

    constructor(maxRetry = 3, baseDelay = 1000, maxDelay = 5000) {
        this.maxRetry = maxRetry;
        this.baseDelay = baseDelay;
        this.maxDelay = maxDelay;
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
                    data = await parseResponse<T>(res, responseType);
                } catch (parseErr: any) {
                    throw new Error(`响应体解析失败: ${parseErr.message}`);
                }

                // 业务逻辑层错误检测
                if (data?.code && data.code !== 0) {
                    if (data.code === -101 || String(data?.message).includes('账号未登录'))
                        throw new Error('账号未登录');
                    if (data.code === 10121188 || String(data?.message).includes('权限不足'))
                        throw new Error('权限不足');
                    if (data.code === 202 || String(data?.message).includes('无有效合成场次'))
                        throw new Error('无有效合成场次');

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

    /**
     * 仅获取请求头（仅限 GET 请求）
     * @param url 请求地址
     * @param options fetch 选项
     */
    async getRequestHeadersOnly(
        url: string,
        options: FetcherOptions = {},
    ): Promise<Response> {
        let attempt = 0;
        let lastError: Error | null = null;
        let lastResponse: Response | undefined;

        while (attempt <= this.maxRetry) {
            const controller = new AbortController();
            const timeout = options.timeout ?? 10000; // 默认超时 10s
            const timer = setTimeout(() => controller.abort(), timeout);

            try {
                global.logger.info(`[Fetcher] ${attempt === 0 ? '' : `(${attempt + 1}/${this.maxRetry})`} 请求中: ${url}`);

                const params = {
                    ...options,
                    'method': options?.method ?? 'HEAD',
                    signal: controller.signal,
                };

                global.logger.debug(`[Fetcher] 请求选项: ${JSON.stringify(params)}`);

                const res = await fetch(url, params);

                global.logger.debug(`[Fetcher] 响应头: ${JSON.stringify(res.headers)}`);

                clearTimeout(timer);

                if (!res.ok) {
                    let methodKey = '';
                    for (const key of res.headers.keys()) {
                        if (key.includes('ethods')) {
                            methodKey = res.headers.get(key) ?? '';
                        }
                    }

                    if (methodKey && !methodKey.includes('HEAD')) {
                        global.logger.warn(`[Fetcher] 响应 ${res.status} ，OPTIONS 中不包含 HEAD 方法，尝试使用 GET 请求头重试`);
                        attempt++;
                        if (attempt > this.maxRetry) {
                            global.logger.error(
                                `[Fetcher] 请求失败已达最大重试次数 (${this.maxRetry})`
                            );
                            if (options.returnLastResponse && lastResponse) {
                                global.logger.warn('[Fetcher] 返回最后一次响应体（容错）');
                                return lastResponse;
                            }
                            throw new Error(`HTTP状态码异常: ${res.status} ${res.statusText}`);
                        }

                        options.method = 'GET';

                        const wait = exponentialDelay(this.baseDelay, 2, attempt, this.maxDelay);
                        global.logger.warn(
                            `[Fetcher] 第 ${attempt} 次请求失败 (${res.status} ${res.statusText})，将在 ${wait}ms 后重试...`
                        );
                        await delay(wait);
                        continue;
                    }

                    throw new Error(`HTTP状态码异常: ${res.status} ${res.statusText}`);
                }

                global.logger.info(`[Fetcher] 请求成功: ${url}`);
                return res;
            } catch (err) {
                clearTimeout(timer);
                const { msg, errObj, name, errMsg } = handleError(err);
                lastError = errObj;

                const errorType = name === 'AbortError' ? '超时或中止' : msg;

                attempt++;
                if (attempt > this.maxRetry) {
                    global.logger.error(
                        `[Fetcher] 请求失败已达最大重试次数 (${this.maxRetry})：${errMsg}`
                    );
                    if (options.returnLastResponse && lastResponse) {
                        global.logger.warn('[Fetcher] 返回最后一次响应体（容错）');
                        return lastResponse;
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
