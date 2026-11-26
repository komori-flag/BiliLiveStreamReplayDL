import type { ResponseType } from '../model/fetcher.js';

export interface ParseResponseOptions {
    /**
     * 响应体停滞阈值（ms）：连续这么久没有收到新数据就中止。
     * <= 0 表示关闭。
     */
    stallTimeout?: number;
    /** 停滞时调用的中止函数（用于真正断开底层连接，避免 socket 继续挂着） */
    abort?: () => void;
}

/** 逐块读取响应体，并在两次收到数据之间做停滞检测 */
async function readBodyWithStall(
    res: Response,
    stallTimeout: number,
    abort?: () => void
): Promise<Buffer> {
    if (!res.body) return Buffer.from(await res.arrayBuffer());

    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let timer: NodeJS.Timeout | undefined;
    let stalled = false;

    const arm = () => {
        if (!(stallTimeout > 0)) return;
        clearTimeout(timer);
        timer = setTimeout(() => {
            stalled = true;
            // 先取消读取再中止连接：只 abort 时部分运行时不会立刻让 read() 返回
            reader.cancel().catch(() => { });
            abort?.();
        }, stallTimeout);
    };

    try {
        arm();
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) chunks.push(value);
            arm();
        }
    } catch (err) {
        if (stalled) throw new Error(`响应体停滞超过 ${stallTimeout}ms`);
        throw err;
    } finally {
        clearTimeout(timer);
    }

    if (stalled) throw new Error(`响应体停滞超过 ${stallTimeout}ms`);
    return Buffer.concat(chunks);
}

export const parseResponse = async <T>(
    res: Response,
    responseType: ResponseType,
    options: ParseResponseOptions = {}
): Promise<T> => {
    const stallTimeout = options.stallTimeout ?? 0;

    // 小响应体（json/text）通常一次就能读完，走原生解析更快；
    // 二进制分片必须逐块读，否则中途卡住没法察觉。
    if (stallTimeout <= 0 && responseType === 'json') return await res.json() as T;
    if (stallTimeout <= 0 && responseType === 'text') return await res.text() as T;
    if (stallTimeout <= 0 && responseType === 'arrayBuffer') return await res.arrayBuffer() as T;
    if (stallTimeout <= 0 && responseType === 'blob') return await res.blob() as T;

    const buf = await readBodyWithStall(res, stallTimeout, options.abort);

    switch (responseType) {
        case 'json':
            return JSON.parse(buf.toString('utf8')) as T;
        case 'text':
            return buf.toString('utf8') as T;
        case 'arrayBuffer':
            // 返回精确尺寸的 ArrayBuffer：Buffer 的底层可能是共享的池化内存
            return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as T;
        case 'blob':
            return new Blob([new Uint8Array(buf)]) as T;
        default:
            throw new Error(`未知的 responseType: ${responseType}`);
    }
}
