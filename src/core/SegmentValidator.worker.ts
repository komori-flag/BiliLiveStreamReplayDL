// src/core/SegmentValidator.worker.ts
// Worker 线程脚本：接收 Buffer + taskId，执行本地结构校验，返回结果 + taskId
// 此文件在 worker_threads 上下文中运行

import { parentPort } from 'node:worker_threads';
import { validateStructure } from './partDataFix/validateStructure.js';
import type { WorkerMessage, WorkerResponse } from '../model/validator.js';

parentPort?.on('message', (msg: WorkerMessage) => {
    const { taskId, input } = msg;
    const buf = Buffer.from(input.buffer);

    try {
        const checks = input.checks ?? {};

        // 结构类校验统一走 validateStructure（与主线程同步回退路径共用同一实现）
        const structure = validateStructure(buf, checks);

        const response: WorkerResponse = {
            taskId,
            result: {
                size: buf.byteLength,
                ...structure,
                buffer: input.buffer,
            },
        };

        // 数据 buffer 原样转移回调用方（零拷贝），调用方校验通过后还要用它落盘
        parentPort!.postMessage(response, [input.buffer]);
    } catch (err) {
        // 出错也必须把 buffer 还回去，否则调用方手里那份数据会永远处于 detach 状态
        parentPort!.postMessage(
            { taskId, error: (err as Error)?.stack || String(err) } as WorkerResponse,
            [input.buffer]
        );
    }
});
