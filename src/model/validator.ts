// 分片校验（worker 池）相关的协议与数据类型
//
// 只做本地结构校验（moov / moof+mdat / box / tfdt）。
// 远端 MD5/CRC64/Content-Length 比对链路已移除：B 站分片走 HTTPS，
// 且本地结构校验能覆盖截断、缺片、box 偏移等实际会遇到的损坏。
import type { Worker } from 'node:worker_threads';

export interface ValidationInput {
    buffer: ArrayBuffer;
    segmentName: string;
    /** 按需控制各校验项（未指定时默认全部启用） */
    checks?: {
        moovIntegrity?: boolean;
        moofMdat?: boolean;
        boxSize?: boolean;
        /** tfdt 时间戳连续性检测（默认开启；init-only 分片自动跳过） */
        tfdtContinuity?: boolean;
    };
}

export interface ValidationResult {
    size: number;
    moovValid: boolean;
    moovReason?: string;
    anyMoofMdatIssue: boolean;
    anyBoxIssue: boolean;
    /** tfdt 时间戳不连续（仅在启用且有 moof 时可能为 true） */
    anyTfdtIssue: boolean;
    /** 不参与判定的结构告警 */
    warnings?: string[];
    /**
     * 原样带回的校验数据（worker 零拷贝转移回来）。
     * 调用方传进来的 ArrayBuffer 会被转移走（detach），校验通过后请用这里的 buffer 落盘。
     */
    buffer?: ArrayBuffer;
}

export interface WorkerMessage {
    taskId: number;
    input: ValidationInput;
}

export interface WorkerResponse {
    taskId: number;
    /** 校验过程抛错时的信息（此时 result 不存在，但数据 buffer 会一并带回） */
    error?: string;
    result?: ValidationResult;
}

export interface PendingTask {
    resolve: (result: ValidationResult) => void;
    reject: (err: Error) => void;
    input: ValidationInput;
}

export interface WorkerSlot {
    worker: Worker;
    /** 当前正在处理的任务 ID（null = 空闲） */
    currentTaskId: number | null;
    /** 此 worker 的待处理任务队列 */
    queue: Array<{ taskId: number; input: ValidationInput }>;
}