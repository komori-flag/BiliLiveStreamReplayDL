// FFmpeg 外部进程管理（无第三方依赖）
//
// 借鉴 private-melorRec-tasksProcess/modules/FFmpeg 的做法：
// - 可执行文件路径优先级：配置 > 项目 bin/ 目录 > PATH
// - 用「停滞超时」而不是总时长：大文件合法耗时差几个数量级，只有长时间无任何输出才判挂死
// - 从 `-progress pipe:2` 的输出解析进度，按百分比节流写日志（避免刷屏）
// - 中止/停滞统一走 kill，Promise 只 settle 一次
import { spawn } from 'child_process';
import type { ChildProcess } from 'child_process';
import { existsSync, statSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { formatDuration } from './recordingHealth.js';

/** 连续多久没有任何 stderr 输出就判定卡死（与参考项目一致：5 分钟） */
export const DEFAULT_STALL_TIMEOUT_MS = 5 * 60 * 1000;
/** 出错时最多回带的 stderr 行数 */
const MAX_ERROR_LINES = 20;
/** 观察输出文件是否仍在增长时的轮询间隔（ms） */
const STALL_FILE_POLL_MS = 10_000;
/** 不是进度行的 stderr 行才留下来用于报错 */
const PROGRESS_LINE_RE = /^(frame|fps|stream_\d+_\d+_q|bitrate|total_size|out_time_us|out_time_ms|out_time|dup_frames|drop_frames|speed|progress)=/;

/**
 * 判定 ffmpeg 输出「有错误」的关键词
 * ffmpeg 有时退出码为 0、但输出里已经报了 error/invalid/corrupt 之类的问题，不能只看退出码。
 */
const FFMPEG_ERROR_PATTERN = /\b(error|missing|invalid|corrupt|illegal|overflow|out of range)\b/i;

/**
 * 时间戳非单调：ffmpeg 会强行改写 DTS，退出码仍可能是 0，但产物时间轴已经不可信。
 * 合并文件有真实缺口（放弃的未就绪分片）时可能触发。
 */
const FFMPEG_DTS_WARNING = 'Non-monotonous DTS in output stream';

/** ffmpeg 一次执行的结果（退出码非 0 / 启动失败 / 停滞 / 中止时仍 reject） */
export interface FfmpegRunResult {
    /** 输出中出现过错误关键词 */
    hasErrors: boolean;
    /** 输出中出现过 Non-monotonous DTS（时间轴被 ffmpeg 修正过） */
    timestampsIncorrect: boolean;
    /** 非进度 stderr 行样本（最多 MAX_ERROR_LINES 行），用于排查 */
    output: string;
}

export class FfmpegStallError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'FfmpegStallError';
    }
}

/** 当前平台的 ffmpeg 可执行文件名 */
function ffmpegBinName(): string {
    return process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
}

/**
 * 解析 ffmpeg 可执行文件路径
 *
 * 优先级：显式配置 > 运行目录/项目根目录下的 `bin/` > `ffmpeg`（交给 PATH）。
 * 找不到也不抛错：真正执行时由 spawn 的 error 事件给出明确的失败原因。
 */
export function resolveFfmpegPath(configuredPath?: string): string {
    const configured = configuredPath?.trim();
    if (configured) return configured;

    const binName = ffmpegBinName();
    const moduleDir = path.dirname(fileURLToPath(import.meta.url)); // 编译后位于 dist/utils
    const candidates = [
        // pm2 / docker 通常以项目根目录为 cwd
        path.join(process.cwd(), 'bin', binName),
        // cwd 不是项目根目录时（如测试脚本在别的目录启动），按模块位置回推
        path.resolve(moduleDir, '..', '..', 'bin', binName),
    ];

    for (const candidate of candidates) {
        try {
            if (existsSync(candidate)) return candidate;
        } catch {
            // 权限/文件系统异常时继续尝试下一个候选
        }
    }

    return 'ffmpeg';
}

/**
 * 探测 ffmpeg 是否可用，返回版本行（不可用返回 null）
 *
 * 只用于启动时提前告警；探测失败不影响录制主链路。
 */
export function probeFfmpeg(binPath: string, timeoutMs = 5000): Promise<string | null> {
    return new Promise(resolve => {
        let settled = false;
        let stdout = '';

        let child: ChildProcess;
        try {
            child = spawn(binPath, ['-hide_banner', '-version'], {
                'windowsHide': true,
                'stdio': ['ignore', 'pipe', 'ignore'],
            });
        } catch {
            resolve(null);
            return;
        }

        const finish = (value: string | null) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(value);
        };

        const timer = setTimeout(() => {
            try { child.kill('SIGKILL'); } catch { /* 进程可能已退出 */ }
            finish(null);
        }, timeoutMs);
        timer.unref?.();

        child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
        child.on('error', () => finish(null));
        child.on('close', code => {
            if (code !== 0) return finish(null);
            const firstLine = stdout.split(/\r?\n/).find(line => line.trim())?.trim();
            finish(firstLine || 'ffmpeg');
        });
    });
}

export interface FfmpegRunOptions {
    /** 进度/错误日志前缀（通常是文件名） */
    label?: string;
    /** 媒体总时长（秒）；> 0 时才输出百分比进度 */
    durationSec?: number;
    /** 每跨越多少个百分点输出一次进度（默认 5） */
    progressStep?: number;
    /** 停滞超时（ms），默认 5 分钟；<= 0 关闭 */
    stallTimeoutMs?: number;
    /** 中止信号：触发后强杀 ffmpeg 进程 */
    signal?: AbortSignal;
    /**
     * 输出文件路径：停滞检测会一并观察它的体积增长
     *
     * `-movflags +faststart` 在封装全部写完后还有一遍整文件重写（把 moov 移到头部），
     * 这一阶段 ffmpeg **完全不输出任何内容**；几十 GB 的文件要写几百秒，
     * 只看输出会把正常收尾误判成卡死。
     */
    watchFile?: string;
}

/** HH:MM:SS（进度里的 time= 部分） */
function formatHms(seconds: number): string {
    const total = Math.max(0, Math.floor(seconds));
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return [h, m, s].map(n => String(n).padStart(2, '0')).join(':');
}

/**
 * 执行 ffmpeg 并等待退出
 *
 * - 进程正常退出（code = 0）→ resolve，并带回输出判定结果
 * - 退出码非 0 / 启动失败 / 停滞超时 / 被 signal 中止 → reject
 * - 出错时会把最近的 stderr 非进度行带进 Error message，便于排查
 */
export function runFfmpeg(binPath: string, args: string[], options: FfmpegRunOptions = {}): Promise<FfmpegRunResult> {
    const label = options.label ?? '';
    const durationSec = options.durationSec ?? 0;
    const progressStep = options.progressStep ?? 5;
    const stallTimeoutMs = options.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS;
    const signal = options.signal;
    const watchFile = options.watchFile;

    if (signal?.aborted)
        return Promise.reject(new Error('ffmpeg 已被中断（启动前即已中止）'));

    return new Promise<FfmpegRunResult>((resolve, reject) => {
        let settled = false;
        let aborting = false;
        let abortError: Error | null = null;
        let lastPercent = 0;
        let lastSpeed = 0;
        let lineBuf = '';
        let stderrTail = '';
        let hasErrors = false;
        let timestampsIncorrect = false;
        const errorLines: string[] = [];

        let child: ChildProcess;
        try {
            child = spawn(binPath, args, {
                'windowsHide': true,
                'stdio': ['ignore', 'ignore', 'pipe'],
            });
        } catch (err) {
            reject(err instanceof Error ? err : new Error(String(err)));
            return;
        }

        let stallTimer: ReturnType<typeof setTimeout> | null = null;
        const clearStall = () => {
            if (stallTimer) {
                clearTimeout(stallTimer);
                stallTimer = null;
            }
        };

        const finish = (fn: () => void) => {
            if (settled) return;
            settled = true;
            clearStall();
            signal?.removeEventListener('abort', onAbort);
            fn();
        };

        const kill = (reason: Error) => {
            if (aborting) return;
            aborting = true;
            abortError = reason;
            global.logger?.error?.(`[ffmpeg] ${reason.message}`);
            try {
                child.kill('SIGKILL');
            } catch {
                finish(() => reject(reason));
            }
        };

        function onAbort() {
            kill(new Error(`ffmpeg 已被中断${label ? `: ${label}` : ''}`));
        }
        signal?.addEventListener('abort', onAbort, { once: true });

        /**
         * 输出文件的「进度指纹」= 体积 + 修改时间
         * faststart 收尾阶段 ffmpeg 不打印任何内容，但会持续写文件，指纹会变；
         * 真挂死时两者都不动。只看体积会漏判（重写阶段体积可能长时间不变）。
         */
        const fileStamp = (): string => {
            if (!watchFile) return '';
            try {
                const s = statSync(watchFile);
                return `${s.size}:${Math.floor(s.mtimeMs)}`;
            } catch {
                return '';
            }
        };

        const armStall = () => {
            clearStall();
            if (!(stallTimeoutMs > 0)) return;
            const stampWhenArmed = fileStamp();
            stallTimer = setTimeout(function check() {
                // 输出文件还在被写入 → 没卡死，只是这一阶段不打印任何内容
                // （faststart 的整文件重写阶段就是这样）
                if (watchFile && fileStamp() !== stampWhenArmed) {
                    stallTimer = setTimeout(check, STALL_FILE_POLL_MS);
                    stallTimer.unref?.();
                    return;
                }
                kill(new FfmpegStallError(
                    `ffmpeg 停滞超时（${Math.round(stallTimeoutMs / 1000)} 秒无输出）${label ? `: ${label}` : ''}`
                ));
            }, stallTimeoutMs);
            stallTimer.unref?.();
        };
        // 从启动那一刻就开始计时：ffmpeg 在读出第一帧前也可能卡死
        armStall();

        const handleLine = (rawLine: string) => {
            const line = rawLine.trim();
            if (!line) return;

            const outTime = /^out_time_us=(\d+)$/.exec(line);
            if (outTime) {
                // 收到进度行说明 ffmpeg 仍在推进（可能是 faststart 收尾的整文件搬移），
                // 停滞计时器必须跟着复位 —— 只靠 stderr 输出复位会把正常收尾误判成卡死
                armStall();
                if (durationSec > 0) {
                    const seconds = Number(outTime[1]) / 1_000_000;
                    const percent = Math.min(100, (seconds / durationSec) * 100);
                    if (percent >= 100 || percent - lastPercent >= progressStep) {
                        const eta = lastSpeed > 0
                            ? `, 速度 ${lastSpeed.toFixed(2)}x, 剩余 ~${formatDuration(Math.max(0, (durationSec - seconds) / lastSpeed))}`
                            : '';
                        global.logger?.info?.(
                            `[ffmpeg:progress] ${label ? `${label} ` : ''}${percent.toFixed(1)}% ` +
                            `(time=${formatHms(seconds)}, 总 ${formatDuration(durationSec)}${eta})`
                        );
                        lastPercent = percent;
                    }
                }
                return;
            }

            const speed = /^speed=([\d.]+)x$/.exec(line);
            if (speed) {
                lastSpeed = Number(speed[1]);
                return;
            }

            if (PROGRESS_LINE_RE.test(line)) return;

            // 逐行判定，而不是只看采样下来的最后 20 行：
            // 合并文件每个分片都带一份 moov，正常转换也会打出成百上千条
            // "Found duplicated MOOV Atom" 警告，真正的错误可能被挤出采样窗口。
            if (FFMPEG_ERROR_PATTERN.test(line)) hasErrors = true;
            if (line.includes(FFMPEG_DTS_WARNING)) timestampsIncorrect = true;

            errorLines.push(line);
            if (errorLines.length > MAX_ERROR_LINES) errorLines.shift();
        };

        child.stderr?.on('data', (chunk: Buffer) => {
            // 任何输出都算「还活着」：进度行正常每 <1 秒一条
            armStall();
            const text = chunk.toString('utf8');
            stderrTail = (stderrTail + text).slice(-4000);
            lineBuf += text;

            let idx: number;
            while ((idx = lineBuf.indexOf('\n')) >= 0) {
                const line = lineBuf.slice(0, idx);
                lineBuf = lineBuf.slice(idx + 1);
                handleLine(line);
            }
            // 极端情况下（持续输出不带换行的内容）避免缓冲区无限增长
            if (lineBuf.length > 64 * 1024) lineBuf = lineBuf.slice(-4096);
        });

        child.on('error', err => {
            finish(() => reject(new Error(`无法启动 ffmpeg（${binPath}）：${err.message}`)));
        });

        child.on('close', code => {
            if (aborting) {
                finish(() => reject(abortError ?? new Error('ffmpeg 已中止')));
                return;
            }
            if (code === 0) {
                finish(() => resolve({
                    hasErrors,
                    timestampsIncorrect,
                    'output': errorLines.join('\n') || stderrTail.trim(),
                }));
                return;
            }

            const detail = errorLines.length ? errorLines.join('\n') : stderrTail.trim();
            finish(() => reject(new Error(
                `ffmpeg 退出码 ${code}${detail ? `\n--- stderr ---\n${detail.slice(-2000)}` : ''}`
            )));
        });
    });
}
