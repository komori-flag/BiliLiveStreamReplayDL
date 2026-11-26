// src/core/SegmentValidatorPool.ts
// Worker Thread 池管理器：负责 spawn/调度/销毁校验 worker

import { Worker } from 'node:worker_threads';
import os from 'os';
import { validateStructure } from './partDataFix/validateStructure.js';
import type { PendingTask, ValidationInput, ValidationResult, WorkerMessage, WorkerResponse, WorkerSlot } from '../model/validator.js';

/**
 * 同步校验入口（回退路径：当 worker 创建失败时在主线程同步执行）
 *
 * 与 Worker 端共用同一份结构校验实现，避免两条路径判定不一致。
 */
function syncValidate(input: ValidationInput): ValidationResult {
    const buf = Buffer.from(input.buffer);
    const checks = input.checks ?? {};

    const structure = validateStructure(buf, checks);

    return {
        size: buf.byteLength,
        buffer: input.buffer,
        ...structure,
    };
}

let nextTaskId = 0;

/**
 * SegmentValidatorPool - Worker 线程池
 *
 * 预创建 N 个 worker 线程，通过 taskId 精确匹配请求和响应，
 * 避免并发场景下的消息路由错误。
 * 若 worker 创建失败，自动回退到主线程同步执行。
 */
export class SegmentValidatorPool {
    private slots: WorkerSlot[] = [];
    private pendingTasks = new Map<number, PendingTask>();
    private fallbackToSync = false;
    /**
     * 主动终止（destroy / 创建失败回退）时置位。
     * terminate() 的退出码同样是 1，不区分的话每次正常销毁都会误报“异常退出”。
     */
    private terminating = false;

    constructor(poolSize = Math.max(1, Math.min(os.cpus().length - 1, 4))) {
        if (poolSize <= 0) {
            this.fallbackToSync = true;
            global.logger?.warn?.('[SegmentValidatorPool] poolSize<=0，回退到主线程同步校验');
            return;
        }

        for (let i = 0; i < poolSize; i++) {
            try {
                const worker = this.createWorker(i);
                const slot: WorkerSlot = { worker, currentTaskId: null, queue: [] };
                this.slots.push(slot);
            } catch (err) {
                global.logger?.warn?.(
                    `[SegmentValidatorPool] Worker ${i} 创建失败，回退到同步模式: ${(err as Error)?.message}`
                );
                this.fallbackToSync = true;
                this.terminating = true;
                for (const s of this.slots) s.worker.terminate();
                this.slots = [];
                return;
            }
        }

        global.logger?.info?.(`[SegmentValidatorPool] 已创建 ${this.slots.length} 个校验 worker`);
    }

    /**
     * 创建一个新的校验 worker，并注册持久化的 message 监听器
     */
    private createWorker(index: number): Worker {
        const workerUrl = new URL('./SegmentValidator.worker.js', import.meta.url);
        const worker = new Worker(workerUrl);

        // 每个 worker 只有一个持久化的 message 监听器
        // 通过 taskId 将响应路由到正确的 Promise
        worker.on('message', (response: WorkerResponse) => {
            const pending = this.pendingTasks.get(response.taskId);
            if (!pending) {
                global.logger?.warn?.(
                    `[SegmentValidatorPool] 收到未知 taskId=${response.taskId} 的响应，忽略`
                );
                return;
            }
            this.pendingTasks.delete(response.taskId);

            // 找到此 worker 的 slot 并标记为空闲
            const slot = this.slots.find(s => s.currentTaskId === response.taskId);
            if (slot) {
                slot.currentTaskId = null;
                // 处理队列中的下一个任务
                const next = slot.queue.shift();
                if (next) {
                    this.dispatchToSlot(slot, next.taskId, next.input);
                }
            }

            if (response.error) {
                // 数据 buffer 已随响应带回（见 WorkerResponse），调用方走重试路径会重新下载
                pending.reject(new Error(response.error));
                return;
            }

            pending.resolve(response.result!);
        });

        worker.on('error', (err: Error) => {
            global.logger?.warn?.(
                `[SegmentValidatorPool] Worker ${index} 运行时错误: ${err.message}`
            );
        });

        worker.on('exit', (code) => {
            // 主动终止时退出码同样是 1，不是异常
            if (this.terminating) return;
            if (code !== 0) {
                global.logger?.warn?.(
                    `[SegmentValidatorPool] Worker ${index} 异常退出 (code=${code})`
                );
            }
        });

        return worker;
    }

    /**
     * 将校验任务提交到 worker 池
     * 选择队列最短的 worker；若所有 worker 都空闲则轮询选择
     */
    async validate(input: ValidationInput): Promise<ValidationResult> {
        if (this.fallbackToSync || this.slots.length === 0) {
            return syncValidate(input);
        }

        const taskId = nextTaskId++;

        return new Promise((resolve, reject) => {
            this.pendingTasks.set(taskId, { resolve, reject, input });

            // 选择队列最短的 worker
            let bestSlot = this.slots[0];
            for (const slot of this.slots) {
                if (slot.currentTaskId === null && slot.queue.length === 0) {
                    bestSlot = slot;
                    break;
                }
                if (slot.queue.length < bestSlot.queue.length) {
                    bestSlot = slot;
                }
            }

            if (bestSlot.currentTaskId === null) {
                // 直接调度
                this.dispatchToSlot(bestSlot, taskId, input);
            } else {
                // 加入队列
                bestSlot.queue.push({ taskId, input });
            }
        });
    }

    /**
     * 将任务发送到指定 worker（通过 Transferable 转移 buffer 所有权，避免 structured clone 拷贝）
     */
    private dispatchToSlot(slot: WorkerSlot, taskId: number, input: ValidationInput): void {
        slot.currentTaskId = taskId;
        const message: WorkerMessage = { taskId, input };
        slot.worker.postMessage(message, [input.buffer]);
    }

    /**
     * 销毁所有 worker，释放资源
     */
    destroy(): void {
        this.terminating = true;

        // 拒绝所有待处理的 Promise
        for (const pending of this.pendingTasks.values()) {
            pending.reject(new Error('SegmentValidatorPool 已销毁'));
        }
        this.pendingTasks.clear();

        for (const slot of this.slots) {
            try {
                slot.worker.terminate();
            } catch {
                // ignore
            }
        }
        this.slots = [];
        global.logger?.info?.('[SegmentValidatorPool] 所有校验 worker 已销毁');
    }
}
