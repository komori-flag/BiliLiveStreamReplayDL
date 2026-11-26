// 录制完成后的 MP4 封装转换
//
// 录制产物是「单一合并文件 .m4s（ftyp+moov 后面拼 moof/mdat）+ BYTERANGE 播放列表」，
// 播放器/剪辑软件对 .m4s 的支持参差不齐。场次录制结束后用 ffmpeg 无转码重封装为
// 标准 MP4（-c copy），不改变画面与音质，只重写容器与索引。
//
// 约定：
// - 一个场次可能因流签名变化拆成多个输出组（基础名 + `_pN`），逐组转换
// - 队列串行执行，避免同时读写多个大文件把磁盘打满
// - 源文件删除策略由 config.mp4Convert.deleteSource 决定；转换失败一律保留源文件
// - 转换写到 `.mp4.tmp`，成功后再原子 rename，进程中途被杀不会留下半个 .mp4
// - 合并文件是 duration=0 的分片 fMP4，转换时按不可 seek 输入读取（-seekable 0），
//   否则 ffmpeg 会为确定时长扫描整个文件，大文件会超过停滞阈值
import fs from 'fs/promises';
import type { Stats } from 'fs';
import path from 'path';
import { matchGroupPlaylist } from './outputGroupNaming.js';
import { handleError } from '../utils/handleError.js';
import { formatBytes, formatDuration, getDiskFreeSpace } from '../utils/recordingHealth.js';
import { probeFfmpeg, resolveFfmpegPath, runFfmpeg } from '../utils/ffmpeg.js';
import type { FfmpegRunResult } from '../utils/ffmpeg.js';
import type { DeleteSourceStrategy } from '../model/config.js';

export type { DeleteSourceStrategy };

/** 小于这个尺寸的 .m4s 视为空壳（只有 init 或干脆没写入），不转换 */
const MIN_SOURCE_BYTES = 1024;
/** 转换前要求的额外磁盘余量：临时文件与源文件需要同时存在 */
const DISK_MARGIN_BYTES = 256 * 1024 * 1024;

export interface Mp4ConverterOptions {
    /** 录制输出目录（.m4s / .m3u8 / 目标 .mp4 都在这里） */
    outputDir: string;
    /** 是否启用（默认 true） */
    enable?: boolean;
    /** ffmpeg 路径；留空自动检测 */
    ffmpegPath?: string;
    /** 源文件删除策略（默认 never） */
    deleteSource?: DeleteSourceStrategy;
    /** 是否加 -movflags +faststart（默认 true） */
    faststart?: boolean;
    /** ffmpeg 停滞超时（ms） */
    stallTimeoutMs?: number;
}

interface ConvertJob {
    sourcePath: string;
    playlistPath: string;
}

/**
 * MP4 转换器
 *
 * 只负责「排队 + 转换 + 清理」，不关心录制流程；调用方通过 convertSession()
 * 把一个场次的所有输出组丢进来即可，转换在后台串行进行。
 */
export class Mp4Converter {
    private readonly outputDir: string;
    private readonly enabled: boolean;
    private readonly deleteSource: DeleteSourceStrategy;
    private readonly faststart: boolean;
    private readonly stallTimeoutMs: number;
    private readonly ffmpegBin: string;

    private readonly queue: ConvertJob[] = [];
    /** 已在队列中/正在转换的源文件，避免重复入队 */
    private readonly pending = new Set<string>();
    private running = false;
    /** 等待队列清空的 resolve（测试与需要等待时使用） */
    private idleWaiters: (() => void)[] = [];
    /** ffmpeg 可用性探测结果缓存：null = 尚未探测 */
    private available: boolean | null = null;
    /** 正在写入的临时文件路径（清理陈旧 .mp4.tmp 时必须避开） */
    private activeTempPath: string | null = null;

    constructor(options: Mp4ConverterOptions) {
        this.outputDir = options.outputDir;
        this.enabled = options.enable !== false;
        this.deleteSource = options.deleteSource ?? 'never';
        this.faststart = options.faststart !== false;
        this.stallTimeoutMs = options.stallTimeoutMs ?? 5 * 60 * 1000;
        this.ffmpegBin = resolveFfmpegPath(options.ffmpegPath);
    }

    /**
     * 探测 ffmpeg 是否可用（启动时调用一次）
     * 不可用只告警：录制本身不依赖 ffmpeg
     */
    public async probe(): Promise<boolean> {
        if (!this.enabled) return false;
        if (this.available !== null) return this.available;

        const version = await probeFfmpeg(this.ffmpegBin);
        this.available = version !== null;

        if (version) {
            global.logger.info(`[Mp4Converter] 使用 ffmpeg: ${this.ffmpegBin}（${version}）`);
            // 启动时顺手清掉上次异常退出留下的 .mp4.tmp（可能占几十 GB）
            try {
                await this.cleanupStaleTemp(await fs.readdir(this.outputDir));
            } catch {
                // 目录读不到不影响转换
            }
        } else {
            global.logger.warn(
                `[Mp4Converter] 未找到可用的 ffmpeg（${this.ffmpegBin}），MP4 自动转换将跳过。` +
                `请安装 ffmpeg 或配置 config.ffmpeg.path`
            );
        }
        return this.available;
    }

    /**
     * 把一个场次的所有输出组加入转换队列
     *
     * 输出组命名规则：基础名本身 + `_p{N}`（兼容旧式 `_p{N}_{宽}x{高}`），
     * 直接复用播放列表的分组匹配逻辑（两者 stem 相同，只是扩展名不同）。
     *
     * @param baseCombinedName 基础合并文件名，如 `866466_2026-11-05_20-48-03.m4s`
     */
    public async convertSession(baseCombinedName: string): Promise<void> {
        if (!this.enabled) return;

        let entries: string[];
        try {
            entries = await fs.readdir(this.outputDir);
        } catch (err) {
            global.logger.warn(`[Mp4Converter] 读取输出目录失败，跳过 MP4 转换: ${handleError(err).msg}`);
            return;
        }

        // 上次进程被杀/重启时留下的半成品（.mp4.tmp）：它们不会再被续写，只会白占磁盘
        await this.cleanupStaleTemp(entries);


        const groups: { name: string; order: number }[] = [];
        for (const name of entries) {
            if (!/\.m4s$/i.test(name)) continue;
            const info = matchGroupPlaylist(name, baseCombinedName);
            if (!info) continue;
            groups.push({ name, order: info.order });
        }

        if (!groups.length) {
            global.logger.debug(`[Mp4Converter] 未找到可转换的合并文件: ${baseCombinedName}`);
            return;
        }

        // 组 1 在前，`_pN` 按序号递增
        groups.sort((a, b) => a.order - b.order);

        for (const group of groups) {
            const sourcePath = path.join(this.outputDir, group.name);
            const playlistPath = sourcePath.replace(/\.m4s$/i, '.m3u8');
            this.enqueue({ sourcePath, playlistPath });
        }

        global.logger.info(
            `[Mp4Converter] 场次已加入转换队列：${baseCombinedName}（共 ${groups.length} 个输出组）`
        );

        // 调用方通常不 await（不阻塞下一次开播检测）；测试可 await 等全部完成
        await this.waitIdle();
    }

    /** 等待当前队列全部完成 */
    public waitIdle(): Promise<void> {
        if (!this.running && this.queue.length === 0) return Promise.resolve();
        return new Promise(resolve => { this.idleWaiters.push(resolve); });
    }

    private enqueue(job: ConvertJob): void {
        if (this.pending.has(job.sourcePath)) return;
        this.pending.add(job.sourcePath);
        this.queue.push(job);
        void this.runQueue();
    }

    private async runQueue(): Promise<void> {
        if (this.running) return;
        this.running = true;

        try {
            while (this.queue.length) {
                const job = this.queue.shift()!;
                try {
                    await this.convertOne(job);
                } catch (err) {
                    // convertOne 内部已尽量消化错误；这里兜底，绝不让后台队列抛出未处理拒绝
                    global.logger.error(
                        `[Mp4Converter] 转换 ${path.basename(job.sourcePath)} 时发生未预期错误: ${handleError(err).errMsg}`
                    );
                } finally {
                    this.pending.delete(job.sourcePath);
                }
            }
        } finally {
            this.running = false;
            const waiters = this.idleWaiters;
            this.idleWaiters = [];
            for (const resolve of waiters) resolve();
        }
    }

    private async convertOne(job: ConvertJob): Promise<void> {
        const sourceName = path.basename(job.sourcePath);

        let stat: Stats;
        try {
            stat = await fs.stat(job.sourcePath);
        } catch {
            global.logger.debug(`[Mp4Converter] 源文件不存在，跳过: ${sourceName}`);
            return;
        }

        if (!stat.isFile() || stat.size < MIN_SOURCE_BYTES) {
            global.logger.warn(`[Mp4Converter] 源文件过小，跳过转换: ${sourceName}（${stat.size} 字节）`);
            return;
        }

        const targetPath = job.sourcePath.replace(/\.m4s$/i, '.mp4');

        // 已有比源文件新的 mp4（重复入队/上次已转换成功）→ 跳过
        try {
            const target = await fs.stat(targetPath);
            if (target.mtimeMs >= stat.mtimeMs) {
                global.logger.debug(`[Mp4Converter] 目标 MP4 已是最新，跳过: ${path.basename(targetPath)}`);
                return;
            }
        } catch {
            // 目标不存在，正常转换
        }

        const available = await this.probe();
        if (!available) return;

        // 转换产物与源文件会同时存在，先确认空间够用，避免写到一半 ENOSPC
        const disk = await getDiskFreeSpace(this.outputDir);
        if (disk) {
            const needed = stat.size + DISK_MARGIN_BYTES;
            if (disk.freeBytes < needed) {
                global.logger.error(
                    `[Mp4Converter] 磁盘空间不足，跳过转换 ${sourceName}：` +
                    `需要约 ${formatBytes(needed)}，剩余 ${formatBytes(disk.freeBytes)}`
                );
                return;
            }
        }

        const durationSec = await this.readPlaylistDuration(job.playlistPath);
        const tmpPath = targetPath + '.tmp';
        this.activeTempPath = tmpPath;

        // faststart 分两阶段：先顺序写完整个文件，再把 moov 搬到头部（整文件重写）。
        // 第二阶段 ffmpeg 不打印任何内容且体积不变，只能靠 mtime 判断还在写。
        // 默认先用 faststart，失败则退回普通封装重试一次 —— 宁可 moov 在尾部，也不要没有产物。
        if (this.faststart) {
            const ok = await this.tryConvert(job, stat, durationSec, tmpPath, true, sourceName);
            if (!ok) {
                global.logger.warn(`[Mp4Converter] faststart 封装失败，改为普通封装重试: ${sourceName}`);
            } else {
                return;
            }
        }
        await this.tryConvert(job, stat, durationSec, tmpPath, false, sourceName);
    }

    /**
     * 执行一次转换并落盘
     * @returns 是否成功（失败时已清理临时文件、记录日志）
     */
    private async tryConvert(
        job: ConvertJob,
        stat: Stats,
        durationSec: number,
        tmpPath: string,
        faststart: boolean,
        sourceName: string
    ): Promise<boolean> {
        const targetPath = tmpPath.replace(/\.tmp$/i, '');
        const args = [
            '-hide_banner',
            // warning 而不是 error：需要看到 Non-monotonous DTS 之类的问题，
            // 它们退出码仍为 0，但产物时间轴已不可信，需要单独识别
            '-loglevel', 'warning',
            '-nostdin',
            '-y',
            '-nostats',
            '-progress', 'pipe:2',
            // 输入是开头带 moov、但 mvhd/mdhd duration=0 的分片 fMP4。
            // 若允许 seek，ffmpeg 会为了确定时长/参数一直读整个文件：90GB 级别会
            // 超过 5 分钟停滞阈值，faststart 和普通封装两次尝试都会被杀掉。
            // 按不可 seek 输入处理，ffmpeg 会顺序读包并立即开始封装。
            // 前提：合并文件的 init（ftyp+moov）在最前面——本录制器始终如此。
            '-seekable', '0',
            '-i', job.sourcePath,
            // 保留全部轨道（B 站切片通常只有一条视频 + 一条音频）
            '-map', '0',
            '-c', 'copy',
        ];
        if (faststart) args.push('-movflags', '+faststart');
        // 临时文件扩展名不是 .mp4，必须显式指定封装格式
        args.push('-f', 'mp4', tmpPath);

        global.logger.info(
            `[Mp4Converter] 开始转换: ${sourceName}（${formatBytes(stat.size)}` +
            `${durationSec > 0 ? `，时长 ${formatDuration(durationSec)}` : ''}` +
            `${faststart ? '' : '，普通封装'}）`
        );

        const startedAt = Date.now();
        let result: FfmpegRunResult;
        try {
            result = await runFfmpeg(this.ffmpegBin, args, {
                'label': sourceName,
                'durationSec': durationSec,
                'stallTimeoutMs': this.stallTimeoutMs,
                // 停滞判定同时观察输出文件：faststart 收尾阶段完全静默但持续写文件
                'watchFile': tmpPath,
            });
        } catch (err) {
            await this.removeQuiet(tmpPath);
            this.activeTempPath = null;
            global.logger.error(`[Mp4Converter] 转换失败，已保留源文件 ${sourceName}: ${handleError(err).errMsg}`);
            return false;
        }

        // 退出码为 0 但输出里报了错：产物不可信，按失败处理（保留源文件，删掉半成品）
        if (result.hasErrors) {
            await this.removeQuiet(tmpPath);
            this.activeTempPath = null;
            global.logger.error(
                `[Mp4Converter] 转换输出包含错误，已保留源文件 ${sourceName}:\n` +
                result.output.slice(-2000)
            );
            return false;
        }

        try {
            // 同目录 rename 是原子操作：播放器/扫描器不会看到写了一半的 mp4
            await fs.rename(tmpPath, targetPath);
        } catch (err) {
            await this.removeQuiet(tmpPath);
            this.activeTempPath = null;
            global.logger.error(
                `[Mp4Converter] 无法写入目标文件 ${path.basename(targetPath)}: ${handleError(err).errMsg}`
            );
            return false;
        }
        this.activeTempPath = null;

        let outputSize = 0;
        try { outputSize = (await fs.stat(targetPath)).size; } catch { /* 仅用于日志 */ }
        const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);

        if (result.timestampsIncorrect) {
            // 时间轴被 ffmpeg 强制修正（合并文件存在真实缺口时会这样）：可用但可能有音画偏移
            global.logger.warn(
                `[Mp4Converter] 转换完成但时间戳非单调（已由 ffmpeg 修正）: ${path.basename(targetPath)}` +
                `（${formatBytes(outputSize)}，耗时 ${elapsed}s）`
            );
        } else {
            global.logger.info(
                `[Mp4Converter] 转换完成: ${path.basename(targetPath)}` +
                `（${formatBytes(outputSize)}，耗时 ${elapsed}s）`
            );
        }

        if (this.shouldDeleteSource(result.timestampsIncorrect)) {
            // 安全阀：极少数情况下（接口抖动被误判为下播）同一场次会马上续录，
            // 此时源文件正在被追加，删掉会丢掉续录内容。转换期间源文件变了就不删。
            let current: Stats | null;
            try {
                current = await fs.stat(job.sourcePath);
            } catch {
                current = null;
            }
            if (current && (current.size !== stat.size || current.mtimeMs !== stat.mtimeMs)) {
                global.logger.warn(
                    `[Mp4Converter] 源文件在转换期间发生变化（可能已续录），保留源文件: ${sourceName}`
                );
            } else {
                await this.removeSourceFiles(job.playlistPath, job.sourcePath);
            }
        }
        return true;
    }

    /**
     * 按策略决定是否删除源文件
     *
     * 调用前提：转换未失败（退出码 0、输出无错误关键词、已成功落盘）。
     */
    private shouldDeleteSource(timestampsIncorrect: boolean): boolean {
        switch (this.deleteSource) {
            case 'never':
                return false;
            case 'safe':
                // 时间戳被修正过 → 有警告，保守起见保留源文件
                return !timestampsIncorrect;
            case 'auto':
            default:
                return true;
        }
    }

    /**
     * 清理上次进程被杀/重启时留下的 `.mp4.tmp`
     *
     * 转换是单进程串行进行的，队列里不会有别的进程在写这些文件；
     * 进程重启后它们既不会被续写也不会被 rename，只会白占磁盘（可能几十 GB）。
     */
    private async cleanupStaleTemp(entries: string[]): Promise<void> {
        for (const name of entries) {
            if (!name.toLowerCase().endsWith('.mp4.tmp')) continue;
            const fullPath = path.join(this.outputDir, name);
            // 正在转换的临时文件不能删（它的路径与队列里的源文件不是同一个名字）
            if (this.activeTempPath && path.resolve(fullPath) === path.resolve(this.activeTempPath)) continue;
            try {
                await fs.unlink(fullPath);
                global.logger.warn(`[Mp4Converter] 已清理上次未完成的临时文件: ${name}`);
            } catch {
                // 删除失败不影响后续转换
            }
        }
    }

    /** 读取播放列表里 EXTINF 的总时长；失败返回 0（进度日志退化为无百分比） */
    private async readPlaylistDuration(playlistPath: string): Promise<number> {
        try {
            const content = await fs.readFile(playlistPath, 'utf-8');
            let total = 0;
            for (const match of content.matchAll(/#EXTINF:([\d.]+)/g)) {
                const value = Number(match[1]);
                if (Number.isFinite(value) && value > 0) total += value;
            }
            return total;
        } catch {
            return 0;
        }
    }

    private async removeSourceFiles(playlistPath: string, sourcePath: string): Promise<void> {
        for (const filePath of [sourcePath, playlistPath]) {
            try {
                await fs.unlink(filePath);
            } catch (err) {
                const code = (err as NodeJS.ErrnoException).code;
                if (code !== 'ENOENT') {
                    global.logger.warn(
                        `[Mp4Converter] 删除源文件失败 ${path.basename(filePath)}: ${handleError(err).msg}`
                    );
                }
            }
        }
        global.logger.info(
            `[Mp4Converter] 已删除源文件: ${path.basename(sourcePath)} / ${path.basename(playlistPath)}`
        );
    }

    private async removeQuiet(filePath: string): Promise<void> {
        try {
            await fs.unlink(filePath);
        } catch {
            // 临时文件不存在或已被清理
        }
    }
}
