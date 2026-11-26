let exiting = false;

/**
 * 统一退出流程：先关日志（把内存里缓存的那批日志落盘），再退出
 *
 * - 只执行一次，退出码以先到者为准（catch 里调 shutdown(1) 之后，finally 的 shutdown(0) 是空操作）
 * - 带超时兜底：万一 close 的回调没触发（例如卡在写文件），也必须退出。
 *   否则会出现"日志已关、应用还在跑、什么都不记"的僵尸状态。
 * - 用 global.logger 而非模块内变量：异常可能发生在 logger 赋值之前，那时不能连日志都记不了
 */
export function shutdown(code: number, reason?: string) {
    if (exiting) return;
    exiting = true;

    if (reason) console.error(`[shutdown] ${reason}`);

    const force = setTimeout(() => process.exit(code), 3000);
    force.unref?.();

    try {
        global.logger?.close?.(() => {
            clearTimeout(force);
            process.exit(code);
        });
    } catch {
        process.exit(code);
    }
}

/** 是否已进入退出流程（测试用） */
export function isShuttingDown(): boolean {
    return exiting;
}
