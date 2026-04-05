// src/utils/delay.ts

/**
 * 延迟（异步 sleep）工具函数模块
 * 用于在请求重试、任务调度、请求队列间隔等场景中控制执行节奏
 */

/**
 * 延迟指定的毫秒数
 * @param ms 延迟时间（毫秒）
 * @returns Promise<void>
 */
export function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 在给定区间内随机延迟（用于模拟随机的请求间隔）
 * @param minMs 最小毫秒数
 * @param maxMs 最大毫秒数
 * @returns Promise<void>
 */
export async function randomDelay(minMs: number, maxMs: number): Promise<void> {
    const randomMs = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
    await delay(randomMs);
}

/**
 * 带重试次数的延迟执行器（用于网络重试）
 * @param fn 要执行的异步函数
 * @param retries 重试次数
 * @param minDelayMs 每次最小延迟（毫秒）
 * @param maxDelayMs 每次最大延迟（毫秒）
 * @returns Promise<函数返回值>
 */
export async function retryWithDelay<T>(
    fn: () => Promise<T>,
    retries: number,
    minDelayMs = 1000,
    maxDelayMs = 6000
): Promise<T> {
    let attempt = 0;
    while (true) {
        try {
            return await fn();
        } catch (err) {
            attempt++;
            if (attempt > retries) throw err;
            const delayMs = Math.floor(Math.random() * (maxDelayMs - minDelayMs + 1)) + minDelayMs;
            console.warn(`[retryWithDelay] 第 ${attempt} 次重试将在 ${delayMs}ms 后进行...`);
            await delay(delayMs);
        }
    }
}

/**
 * 指数退避延迟计算（用于请求队列指数上升的等待时间）
 * @param base 基础时间（毫秒）
 * @param factor 增长倍率（例如 2）
 * @param attempt 当前重试次数
 * @param max 最大上限（毫秒）
 * @returns 实际延迟时间（毫秒）
 */
export function exponentialDelay(base: number, factor: number, attempt: number, max: number): number {
    const delayTime = Math.min(base * Math.pow(factor, attempt), max);
    return Math.floor(delayTime);
}

export default {
    delay,
    randomDelay,
    retryWithDelay,
    exponentialDelay,
};
