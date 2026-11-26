// 录制健康检查：磁盘空间、追播进度
//
// 纯逻辑 + 一次 statfs，不依赖 HLSDownloader，便于单测。

import fs from 'fs/promises';

export interface DiskSpaceInfo {
    freeBytes: number;
    totalBytes: number;
}

/** 查询目录所在磁盘的可用空间；失败返回 null（不影响录制） */
export async function getDiskFreeSpace(dirPath: string): Promise<DiskSpaceInfo | null> {
    try {
        const stats = await fs.statfs(dirPath);
        const blockSize = Number(stats.bsize);
        const freeBytes = blockSize * Number(stats.bavail);
        const totalBytes = blockSize * Number(stats.blocks);
        if (!Number.isFinite(freeBytes) || !Number.isFinite(totalBytes)) return null;
        return { freeBytes, totalBytes };
    } catch {
        return null;
    }
}

export function formatBytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes < 0) return '未知';
    const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit++;
    }
    return `${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]}`;
}

export function formatDuration(seconds: number): string {
    if (!Number.isFinite(seconds) || seconds < 0) return '未知';
    const total = Math.round(seconds);
    if (total < 60) return `${total}s`;
    const minutes = Math.floor(total / 60);
    const restSeconds = total % 60;
    if (minutes < 60) return restSeconds ? `${minutes}m${restSeconds}s` : `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    const restMinutes = minutes % 60;
    return restMinutes ? `${hours}h${restMinutes}m` : `${hours}h`;
}

/**
 * 追播进度跟踪
 *
 * 指标：当前播放列表里"尚未合并"的分片总时长（Σ EXTINF）。
 * - 正常追直播时，每轮合并完应接近 0
 * - 从会话中途重启时，它等于还没补完的历史内容，会单调下降
 * - 只有下载速度持续低于直播速度时才会连续上涨 → 这才是真正的"录不过来"
 *
 * 用"连续 N 轮上涨"而不是绝对值做判定，避免把正常的追播/抖动误报成落后。
 */
export class RecordingProgressTracker {
    private prev: number | null = null;
    private growthStreak = 0;
    /** 上次告警时间；-Infinity 保证首次满足条件时一定告警 */
    private lastWarnAt = Number.NEGATIVE_INFINITY;

    constructor(
        /** 待处理时长达到多少秒才可能告警 */
        private readonly warnThresholdSec: number,
        /** 连续多少轮上涨才判定为落后 */
        private readonly growthRounds = 3,
        /** 同类告警的重复提醒间隔 */
        private readonly remindIntervalMs = 10 * 60 * 1000,
    ) { }

    update(pendingDurationSec: number, nowMs = Date.now()): {
        warning: boolean;
        recovered: boolean;
        growthStreak: number;
    } {
        const prev = this.prev;
        this.prev = pendingDurationSec;

        // 1s 容差：分片时长本身有小数，避免同一水平线上的舍入误差触发"上涨"
        if (prev !== null && pendingDurationSec > prev + 1) this.growthStreak++;
        else this.growthStreak = 0;

        const lagging =
            pendingDurationSec >= this.warnThresholdSec &&
            this.growthStreak >= this.growthRounds;

        let warning = false;
        if (lagging && nowMs - this.lastWarnAt >= this.remindIntervalMs) {
            this.lastWarnAt = nowMs;
            warning = true;
        }

        const recovered =
            prev !== null &&
            prev >= this.warnThresholdSec &&
            pendingDurationSec < this.warnThresholdSec;

        return { warning, recovered, growthStreak: this.growthStreak };
    }
}
