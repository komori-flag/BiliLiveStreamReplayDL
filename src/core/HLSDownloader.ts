// src/core/HLSDownloader.ts
import fs from 'fs/promises';
import path from 'path';
import { Fetcher } from './Fetcher.js';
import { delay, exponentialDelay } from '../utils/delay.js';
import { is_dirExist } from '../utils/is_dirExist.js';
import { createDir } from '../utils/createDir.js';
import { is_fileExist } from '../utils/is_fileExist.js';
import { handleError } from '../utils/handleError.js';
import { SegmentValidatorPool } from './SegmentValidatorPool.js';
import { ByterangePlaylistWriter } from './ByterangePlaylistWriter.js';
import { detectInitMap, parseM3U } from './m3u8Parser.js';
import { describeSignature, parseStreamSignature } from './mp4BoxUtil.js';
import { combinedNameFromPlaylist, groupFileName, matchGroupPlaylist } from './outputGroupNaming.js';
import { parseSegmentTimeline, diffSegmentTimeline } from './SegmentTimeline.js';
import { computeTfdtOffsets, parseTailTimeline } from './TfdtRewriter.js';
import { parseTrackInfo } from './partDataFix/mp4FragmentParser.js';
import { formatBytes, formatDuration } from '../utils/recordingHealth.js';
import type { HLSDownloaderConfig, SegmentAttemptResult, SegmentDownloadResult, SegmentInfo } from '../model/hls.js';
import type { ContinuityIssue, SegmentTimeline } from '../model/mp4.js';

/** 一个输出组：一对 (playlist, combined) 文件 + 该组已合并分片 + 流签名 */
interface OutputGroup {
    playlistName: string;
    combinedName: string;
    /** 组序号：1 = 基础名本身，之后每次流签名变化或达到单文件限制 +1 */
    order: number;
    /**
     * 流签名 key（编码 / 分辨率 / 编码参数 / 音频参数）
     * 未知为 null（首个带签名的分片会"学习"进这个字段）
     */
    signatureKey: string | null;
    /** 签名的人类可读描述，用于日志 */
    signatureLabel: string | null;
    /** 该组已合并的分片文件名 */
    appended: Set<string>;
    /** 该组合并文件当前字节数（含 init）；文件大小上限按它判断 */
    bytes: number;
    /** 该组已合并分片的总时长（秒）；文件时长上限按它判断 */
    durationSec: number;
}

/**
 * HLSDownloader
 * 改进点：
 * - 更健壮的 m3u8 解析（支持 BYTERANGE、EXTINF 容错）
 * - worker 池式并发下载（避免递归 + new Promise）
 * - 安全写入 combined file（临时文件 + 重命名）
 * - 更明确的日志与错误处理
 */
export class HLSDownloader {
    private fetcher: Fetcher;
    private config: Required<HLSDownloaderConfig>;
    /** 分片保存的实际目录（绝对路径） */
    private segmentsDir: string;
    /** 分片目录的相对引用（用于 simple m3u8 中的路径） */
    private segmentsRel?: string;
    /** 已合并并记录到本地 BYTERANGE M3U8 的分片文件名（跨输出组的并集，用于 keepSegments=false 时跳过重复下载） */
    private appendedSegments: Set<string> = new Set();

    /** 输出组注册表：key = 该组的播放列表文件名 */
    private groups: Map<string, OutputGroup> = new Map();

    /** 当前正在写入的组（playlist 名）；首个批次写入前为 null */
    private activeGroupName: string | null = null;

    /** 分片文件名 → 视频分辨率 key（下载/补解析时记录，供同一批内拆分与滞后分片使用） */
    private signatureByFilename: Map<string, string> = new Map();
    /** 分片文件名 → 签名描述（日志/分组名用） */
    private signatureLabelByFilename: Map<string, string> = new Map();
    /** 分片文件名 → 字节数（合并前用于预测是否会超出文件大小上限） */
    private segmentSizeByFilename: Map<string, number> = new Map();

    /** 组 1 的基础名（首次 append/prime 时记住，用于推导新组名） */
    private basePlaylistName: string | null = null;
    private baseCombinedName: string | null = null;


    /** 分片文件名 → 时间轴摘要（下载时解析；null = 无法解析） */
    private timelineByFilename: Map<string, SegmentTimeline | null> = new Map();

    /** 未通过校验的分片首次被看到的时间（严格顺序追加的放弃判定） */
    private pendingSince: Map<string, number> = new Map();
    /** 超过 strictAppendTimeoutMs 仍未就绪、已放弃追加的分片 */
    private abandonedSegments: Set<string> = new Set();

    /** 每个输出组上一分片的时间轴（跨批次保持，用于缺口/回退检测） */
    private continuityState: Map<string, { timeline: SegmentTimeline; filename: string }> = new Map();

    /** 每个输出组累计的 tfdt 平移量（trackId → timescale 单位） */
    private tfdtCumulative: Map<string, Map<number, number>> = new Map();
    /** 分片文件名 → 合并前要应用的 tfdt 平移量（仅包含发生回退的轨道） */
    private tfdtOffsetsByFilename: Map<string, Map<number, number>> = new Map();

    /** 已告警过的校验项，避免同一类问题每个分片刷屏 */
    private warnedSegmentWarnings: Set<string> = new Set();
    private warnedContinuity: Set<string> = new Set();

    // private lostSegments: Set<string> = new Set();

    private lastInitMap?: { uri: string; byterange?: { len: number; offset: number } };

    private validatorPool: SegmentValidatorPool;

    /** 播放列表写出（独立模块，见 ByterangePlaylistWriter） */
    private playlistWriter: ByterangePlaylistWriter;

    /** 已通过本地结构校验、可以合并的分片（下载失败/校验失败的分片不在其中） */
    private verifiedSegments: Set<string> = new Set();

    constructor(config: HLSDownloaderConfig) {
        const {
            enableMoovIntegrityCheck = true,
            enableMoofMdatCheck = true,
            enableBoxSizeCheck = true,
            enableTfdtContinuity = true,
            enableContinuityCheck = true,
            validateSegments = true,
            splitByResolution = true,
            ...restConfig
        } = config;

        this.config = {
            concurrency: 8,
            timeout: 5000,
            maxRetry: 3,
            stallTimeout: 15000,
            strictAppendTimeoutMs: 5 * 60 * 1000,
            keepSegments: false,
            segmentsSubdir: './fragments',
            validateSegments,
            splitByResolution,
            maxFileSizeBytes: 0,
            maxFileDurationSec: 0,
            enableMoovIntegrityCheck,
            enableMoofMdatCheck,
            enableBoxSizeCheck,
            enableTfdtContinuity,
            enableContinuityCheck,
            ...restConfig,
        };

        this.fetcher = new Fetcher(this.config.maxRetry, 1000, 5000, this.config.stallTimeout);

        // 初始化校验 worker 线程池（将 CPU 密集的 box 结构校验移至后台线程）
        this.validatorPool = new SegmentValidatorPool();

        // 计算分片保存目录
        this.segmentsRel = this.config.segmentsSubdir;
        this.segmentsDir = this.segmentsRel
            ? path.join(this.config.outputDir, this.segmentsRel)
            : this.config.outputDir;

        // 播放列表写出交给独立模块：只把需要的东西传进去，不暴露整个下载器状态
        this.playlistWriter = new ByterangePlaylistWriter({
            outputDir: this.config.outputDir,
            segmentsDir: this.segmentsDir,
            segmentsRel: this.segmentsRel,
            keepSegments: this.config.keepSegments,
            getInitMap: () => this.lastInitMap,
            markAppended: (filename, playlistName) => { this.noteAppended(filename, playlistName); },
            appendedCount: (playlistName) => this.groups.get(playlistName)?.appended.size ?? 0,
            getTfdtOffsets: (filename) => this.tfdtOffsetsByFilename.get(filename),
            fetchInit: async (url) => {
                const res = await this.fetcher.httpErrRepeat<ArrayBuffer>(
                    url,
                    { timeout: this.config.timeout },
                    'arrayBuffer'
                );
                return res.data;
            },
        });
    }

    // ── 播放列表写出：转交 ByterangePlaylistWriter（保持原有公共方法签名） ──

    async writeLocalM3U8(
        segments: SegmentInfo[],
        filename = 'index.m3u8',
        options?: { initFile?: string; targetDuration?: number; mediaSequence?: number; endList?: boolean }
    ): Promise<string> {
        return this.playlistWriter.writeLocalM3U8(segments, filename, options);
    }

    async writeLocalM3U8Byterange(
        segments: SegmentInfo[],
        playlistName = 'index-br.m3u8',
        combinedName = 'combined.m4s',
        options?: {
            targetDuration?: number;
            mediaSequence?: number;
            initMap?: { uri: string; byterange?: { len: number; offset: number } };
            finalize?: boolean;
        }
    ): Promise<{ playlistPath: string; combinedPath: string; initBytes: number }> {
        // 直接写出的就是组 1 的名字，记住它们供后续 append/prime 推导分组
        this.basePlaylistName ??= playlistName;
        this.baseCombinedName ??= combinedName;
        return this.playlistWriter.writeLocalM3U8Byterange(segments, playlistName, combinedName, options);
    }

    /**
     * 追加新分片到当前输出组，并在检测到视频分辨率变化时新开输出组
     *
     * - 组 1 即传入的 playlistName / combinedName（保持现状命名，向后兼容）
     * - 之后每次切换新开一组：基础名插 `_p{N}_{宽}x{高}`（切回原分辨率同样新开）
     * - 同一批内跨切换也能精确拆分：按流签名把分片切成 run，每个 run 写入各自的组
     */
    async appendLocalM3U8Byterange(
        segments: SegmentInfo[],
        playlistName = 'index-br.m3u8',
        combinedName = 'combined.m4s'
    ): Promise<{ added: number; playlistPath: string; combinedPath: string; pendingDurationSec: number; blocked: boolean }> {
        await this.ensureActiveGroup(playlistName, combinedName);
        const current = this.groups.get(this.activeGroupName!)!;

        // 严格顺序追加：按播放列表顺序取"连续且已校验"的前缀。
        // 合并文件只能追加，某个分片没就绪时若先写它后面的分片，等它补到时只能落在末尾，
        // 播放列表就会出现时间倒序。这里宁可先压着，也不破坏顺序。
        const strictTimeout = this.config.strictAppendTimeoutMs;
        const candidates: SegmentInfo[] = [];
        let blocked = false;

        for (const seg of segments) {
            if (this.appendedSegments.has(seg.filename)) continue;
            if (this.abandonedSegments.has(seg.filename)) continue;

            if (this.verifiedSegments.has(seg.filename)) {
                this.pendingSince.delete(seg.filename);
                candidates.push(seg);
                continue;
            }

            // 非严格模式：未就绪的不进候选，但也不挡住后面的分片
            if (strictTimeout <= 0) continue;

            // 未验证：记录首次等待时间；超过阈值就放弃该分片，让后续继续
            const now = Date.now();
            const since = this.pendingSince.get(seg.filename) ?? now;
            if (!this.pendingSince.has(seg.filename)) this.pendingSince.set(seg.filename, since);

            if (now - since >= strictTimeout) {
                this.abandonedSegments.add(seg.filename);
                this.pendingSince.delete(seg.filename);
                global.logger.error(
                    `[HLSDownloader] 分片 ${seg.filename} 等待超过 ${Math.round(strictTimeout / 1000)}s 仍未就绪，` +
                    `放弃追加（播放列表会留下约 ${Number(seg.duration).toFixed(2)}s 的真实缺口）`
                );
                continue;
            }

            // 严格顺序：从这里开始的后续分片本轮都不追加
            blocked = true;
            break;
        }

        const pendingCount = blocked
            ? segments.filter(s => !this.appendedSegments.has(s.filename) && !this.verifiedSegments.has(s.filename)).length
            : 0;
        if (blocked) {
            global.logger.info(
                `[HLSDownloader] 有分片未就绪，暂停追加后续内容以保持播放顺序（共 ${pendingCount} 个待补校验）`
            );
        }

        if (!candidates.length) {
            // 没有可写分片：仍让 writer 读一遍当前组的播放列表，把已有条目补记进"已合并"集合（幂等）。
            // 组文件还没建起来时不能触发 from-scratch（那会清空合并文件）
            if (await this.groupFilesExist(current)) {
                const res = await this.playlistWriter.appendLocalM3U8Byterange([], current.playlistName, current.combinedName);
                // 没有新分片也刷新一次计数：续录/外部追加后以磁盘上的实际大小为准
                current.bytes = res.combinedBytes;
                current.durationSec = res.durationSec;
                return {
                    'added': res.added,
                    'playlistPath': res.playlistPath,
                    'combinedPath': res.combinedPath,
                    'pendingDurationSec': this.pendingDurationSec(segments),
                    'blocked': blocked,
                };
            }
            global.logger.info('[HLSDownloader] 无新增已校验分片需要追加');
            return {
                'added': 0,
                'playlistPath': path.join(this.config.outputDir, current.playlistName),
                'combinedPath': path.join(this.config.outputDir, current.combinedName),
                'pendingDurationSec': this.pendingDurationSec(segments),
                'blocked': blocked,
            };
        }

        const runs = await this.partitionRuns(candidates, current);
        // 新组必须用分片自带的 init；同一批里检测到切换时，组 1 也不能信 gateway 的 EXT-X-MAP
        // （它可能已被刷新成新分辨率的流）——单 run 时保持现状（gateway init 优先）
        const useSegmentInit = runs.length > 1;

        let added = 0;
        let lastResult = {
            'playlistPath': path.join(this.config.outputDir, current.playlistName),
            'combinedPath': path.join(this.config.outputDir, current.combinedName),
        };

        // 在写入前检查跨分片连续性：keepSegments=false 时 writer 合并后会立刻删除分片文件，
        // 之后再补解析时间轴就拿不到数据了（本次下载的分片走内存缓存，不受影响）
        await this.checkSegmentContinuity(runs);

        // run 之间按序串行写入（同一 segmentsDir，不能并发）
        for (const run of runs) {
            const res = await this.playlistWriter.appendLocalM3U8Byterange(
                run.segs,
                run.group.playlistName,
                run.group.combinedName,
                { 'initFromSegment': run.group.order > 1 || useSegmentInit }
            );
            added += res.added;
            // 以 writer 实际写出的字节数/时长为准确计数，供下一批判断大小/时长上限
            run.group.bytes = res.combinedBytes;
            run.group.durationSec = res.durationSec;
            lastResult = { 'playlistPath': res.playlistPath, 'combinedPath': res.combinedPath };
            this.activeGroupName = run.group.playlistName;
        }

        return { added, ...lastResult, 'pendingDurationSec': this.pendingDurationSec(segments), 'blocked': blocked };
    }

    /**
     * 当前播放列表里尚未合并的分片总时长（Σ EXTINF）
     * 用于外层判断"还欠多少内容"：正常追直播接近 0，持续上涨说明下载速度跟不上直播。
     */
    private pendingDurationSec(segments: SegmentInfo[]): number {
        let total = 0;
        for (const seg of segments) {
            if (this.appendedSegments.has(seg.filename)) continue;
            // 已放弃的分片不会再合并，不计入"待合并"，否则会永久虚报追播落后
            if (this.abandonedSegments.has(seg.filename)) continue;
            if (Number.isFinite(seg.duration) && seg.duration > 0) total += seg.duration;
        }
        return total;
    }

    /**
     * 把候选分片按流签名切成 run；遇到新的签名就新开输出组
     * 切回之前的签名同样新开一组（每个文件内部时间连续、init 一致）
     *
     * 同时按「单个输出文件」的大小/时长上限切分（类似 blrec）：
     * 再加入当前分片就会超出上限时，从该分片起新开一组，录制不中断。
     * 同一批里 pending* 按目标组累计，避免一次追播批量写入把限制撑破。
     */
    private async partitionRuns(
        candidates: SegmentInfo[],
        current: OutputGroup
    ): Promise<{ group: OutputGroup; segs: SegmentInfo[] }[]> {
        const runs: { group: OutputGroup; segs: SegmentInfo[] }[] = [];
        let target = current;

        const maxBytes = this.config.maxFileSizeBytes;
        const maxDuration = this.config.maxFileDurationSec;

        const pendingBytes = new Map<string, number>();
        const pendingDuration = new Map<string, number>();
        const hasContent = new Map<string, boolean>();

        const contentOf = (group: OutputGroup): boolean =>
            hasContent.get(group.playlistName) ?? (group.appended.size > 0 || group.bytes > 0);
        const bytesOf = (group: OutputGroup): number =>
            group.bytes + (pendingBytes.get(group.playlistName) ?? 0);
        const durationOf = (group: OutputGroup): number =>
            group.durationSec + (pendingDuration.get(group.playlistName) ?? 0);

        for (const seg of candidates) {
            const key = seg.signatureKey ?? this.signatureByFilename.get(seg.filename) ?? null;

            if (this.config.splitByResolution && key) {
                if (target.signatureKey === null) {
                    // 学习：当前组签名未知（旧现场/解析失败），以首个带签名的分片为准，不轮转
                    target.signatureKey = key;
                    target.signatureLabel = this.labelOf(seg.filename);
                } else if (key !== target.signatureKey) {
                    const order = this.maxGroupOrder() + 1;
                    const from = target.signatureLabel ?? target.signatureKey;
                    target = this.registerGroup(
                        groupFileName(this.basePlaylistName!, order, null),
                        groupFileName(this.baseCombinedName!, order, null),
                        order,
                        key,
                        this.labelOf(seg.filename)
                    );
                    global.logger.info(
                        `[HLSDownloader] 检测到流变化 ${from} → ${target.signatureLabel}，新开输出组: ${target.playlistName}`
                    );
                }
            }

            // 大小/时长上限：空组不切（否则单片超过上限时会无限切空组）
            const segBytes = await this.segmentSize(seg.filename);
            const segDuration = Number.isFinite(seg.duration) && seg.duration > 0 ? seg.duration : 0;
            const overBytes = maxBytes > 0 && bytesOf(target) + segBytes >= maxBytes;
            const overDuration = maxDuration > 0 && durationOf(target) + segDuration >= maxDuration;

            if ((overBytes || overDuration) && contentOf(target)) {
                const order = this.maxGroupOrder() + 1;
                const reason = overBytes
                    ? `大小 ${formatBytes(bytesOf(target) + segBytes)} ≥ ${formatBytes(maxBytes)}`
                    : `时长 ${formatDuration(durationOf(target) + segDuration)} ≥ ${formatDuration(maxDuration)}`;
                target = this.registerGroup(
                    groupFileName(this.basePlaylistName!, order, null),
                    groupFileName(this.baseCombinedName!, order, null),
                    order,
                    key ?? target.signatureKey,
                    this.labelOf(seg.filename) ?? target.signatureLabel
                );
                global.logger.info(
                    `[HLSDownloader] 输出文件达到${reason}，新开输出组: ${target.playlistName}`
                );
            }

            pendingBytes.set(target.playlistName, (pendingBytes.get(target.playlistName) ?? 0) + segBytes);
            pendingDuration.set(target.playlistName, (pendingDuration.get(target.playlistName) ?? 0) + segDuration);
            hasContent.set(target.playlistName, true);

            const last = runs[runs.length - 1];
            if (last && last.group === target) last.segs.push(seg);
            else runs.push({ 'group': target, 'segs': [seg] });
        }

        return runs;
    }

    /** 取分片字节数（下载时已记录；续录的存量分片按需 stat 一次） */
    private async segmentSize(filename: string): Promise<number> {
        const known = this.segmentSizeByFilename.get(filename);
        if (known !== undefined) return known;

        try {
            const stat = await fs.stat(path.join(this.segmentsDir, filename));
            this.segmentSizeByFilename.set(filename, stat.size);
            return stat.size;
        } catch {
            // 读不到大小不影响切分：按 0 计，最坏情况是文件略超上限
            this.segmentSizeByFilename.set(filename, 0);
            return 0;
        }
    }

    /** 从文件名查签名描述（日志用）；查不到返回 null */
    private labelOf(filename: string): string | null {
        return this.signatureLabelByFilename.get(filename) ?? null;
    }

    /**
     * 用输出目录里已有的播放列表播种"已合并"集合（每场次录制开始时调用一次）
     * 详见 ByterangePlaylistWriter.primeAppendedFromPlaylist 的说明
     *
     * 支持多输出组：扫描本场次的组 1 与所有 `_p{N}_{宽}x{高}` 组，逐组校验并播种；
     * activeGroup 取序号最大的一组（新分片默认继续写它）
     */
    async primeAppendedFromPlaylist(playlistName: string, combinedName: string): Promise<number> {
        this.basePlaylistName ??= playlistName;
        this.baseCombinedName ??= combinedName;

        let files: string[];
        try {
            files = await fs.readdir(this.config.outputDir);
        } catch {
            return 0;
        }

        const found: { playlistName: string; combinedName: string; order: number }[] = [];
        for (const name of files) {
            const info = matchGroupPlaylist(name, playlistName);
            if (!info) continue;
            if (!this.config.splitByResolution && info.order !== 1) continue;
            found.push({
                'playlistName': name,
                // 旧式组名带分辨率后缀，直接用同名 stem 推导合并文件
                'combinedName': combinedNameFromPlaylist(name, combinedName),
                'order': info.order,
            });
        }
        if (!found.length) return 0;
        found.sort((a, b) => a.order - b.order);

        let total = 0;
        for (const f of found) {
            const seed = await this.playlistWriter.primeAppendedFromPlaylist(f.playlistName, f.combinedName);
            total += seed.count;

            // 组名里没有签名信息，从合并文件头部解析（解不出则交给"学习"规则）
            const signature = await this.readCombinedSignature(path.join(this.config.outputDir, f.combinedName));
            // 即使播种失败（如合并文件缺失）也注册：序号占用着，之后新开组不会撞名
            this.registerGroup(f.playlistName, f.combinedName, f.order, signature?.key ?? null, signature?.label ?? null);
            // 续录时恢复该组已写入的大小/时长，大小/时长限制才能接着上次的进度算
            const group = this.groups.get(f.playlistName);
            if (group) {
                group.bytes = seed.sizeBytes;
                group.durationSec = seed.durationSec;
            }
            // 最新的一组作为活动组；与单组时代语义一致，后续写入继续落在它上面
            this.activeGroupName = f.playlistName;

            // 从合并文件尾部恢复时间轴基线：续录时第一个新分片若刚好是回退点，
            // 没有基线就会漏掉这一次纠正
            await this.seedContinuityFromCombined(f.playlistName, f.combinedName);
        }

        global.logger.info(
            `[HLSDownloader] 已扫描到 ${found.length} 个输出组（active=${this.activeGroupName}），共播种 ${total} 个分片`
        );
        return total;
    }

    /**
     * 从合并文件尾部恢复时间轴基线（续录场景）
     *
     * 合并文件里最后一个 moof 的 tfdt 就是「上一分片结束在哪」。
     * 没有这条基线时，重启续录后的第一个新分片如果正好落在回退点，
     * 要等到第二个分片才能发现，中间那一段仍会被压扁。
     */
    private async seedContinuityFromCombined(groupName: string, combinedName: string): Promise<void> {
        if (!this.config.enableContinuityCheck) return;
        if (this.continuityState.has(groupName)) return;

        const combinedPath = path.join(this.config.outputDir, combinedName);
        try {
            const stat = await fs.stat(combinedPath);
            const tailSize = Math.min(4 * 1024 * 1024, stat.size);
            if (tailSize <= 0) return;

            const fh = await fs.open(combinedPath, 'r');
            let tail: Buffer;
            let head: Buffer;
            try {
                tail = Buffer.alloc(tailSize);
                await fh.read(tail, 0, tailSize, stat.size - tailSize);
                const headSize = Math.min(64 * 1024, stat.size);
                head = Buffer.alloc(headSize);
                await fh.read(head, 0, headSize, 0);
            } finally {
                await fh.close();
            }

            // 轨道信息（timescale / handler）来自文件头部的 moov
            const trackInfo = new Map<number, { timescale: number; handler: string }>();
            for (const info of parseTrackInfo(head)) {
                trackInfo.set(info.trackId, { 'timescale': info.timescale, 'handler': info.handler });
            }
            if (!trackInfo.size) return;

            const tailTimeline = parseTailTimeline(tail, trackInfo);
            if (!tailTimeline) return;

            this.continuityState.set(groupName, { 'timeline': tailTimeline, 'filename': `${combinedName}#tail` });
            const summary = tailTimeline.tracks
                .map(t => {
                    const sec = t.timescale > 0 ? t.lastTfdt / t.timescale : 0;
                    return `track ${t.trackId}@${sec.toFixed(1)}s`;
                })
                .join(', ');
            global.logger.info(`[HLSDownloader] 已从合并文件尾部恢复时间轴基线（${groupName}: ${summary}）`);
        } catch (err) {
            // 基线恢复失败只影响首个分片的回退检测，不影响录制
            global.logger.debug(`[HLSDownloader] 恢复时间轴基线失败（${combinedName}）: ${handleError(err).msg}`);
        }
    }

    /** 确保存在活动组；没有历史现场时以传入的名字注册组 1 */
    private async ensureActiveGroup(playlistName: string, combinedName: string): Promise<void> {
        this.basePlaylistName ??= playlistName;
        this.baseCombinedName ??= combinedName;
        if (this.activeGroupName) return;

        const signature = await this.readCombinedSignature(path.join(this.config.outputDir, combinedName));
        this.registerGroup(playlistName, combinedName, 1, signature?.key ?? null, signature?.label ?? null);
        this.activeGroupName = playlistName;
    }

    /** 注册输出组；已存在时只补全缺失信息（不覆盖已知签名，combinedName 以最新传入为准） */
    private registerGroup(
        playlistName: string,
        combinedName: string,
        order: number,
        signatureKey: string | null,
        signatureLabel: string | null
    ): OutputGroup {
        const existing = this.groups.get(playlistName);
        if (existing) {
            if (existing.signatureKey === null && signatureKey !== null) {
                existing.signatureKey = signatureKey;
                existing.signatureLabel = signatureLabel;
            }
            // 惰性建组可能用猜出来的 combined 名（如从 .m3u8 换扩展名），后续拿到权威名字要纠正
            if (existing.combinedName !== combinedName) existing.combinedName = combinedName;
            return existing;
        }
        const group: OutputGroup = {
            playlistName,
            combinedName,
            order,
            signatureKey,
            signatureLabel,
            'appended': new Set(),
            'bytes': 0,
            'durationSec': 0,
        };
        this.groups.set(playlistName, group);
        return group;
    }

    private maxGroupOrder(): number {
        let max = 1;
        for (const group of this.groups.values()) {
            if (group.order > max) max = group.order;
        }
        return max;
    }

    /** writer 的记账回调：文件名进并集，同时进对应组 */
    private noteAppended(filename: string, playlistName: string): void {
        this.appendedSegments.add(filename);

        let group = this.groups.get(playlistName);
        if (!group) {
            // 兜底：writer 在组注册之前被直接调用（如 downloadPlaylist 的 generate 分支）
            const info = matchGroupPlaylist(playlistName, this.basePlaylistName ?? playlistName);
            const combinedName = this.baseCombinedName
                ? combinedNameFromPlaylist(playlistName, this.baseCombinedName)
                : playlistName.replace(/\.m3u8$/i, '.m4s');
            group = this.registerGroup(playlistName, combinedName, info?.order ?? 1, null, null);
        }
        group.appended.add(filename);
    }

    /** 一对组文件是否都已存在 */
    private async groupFilesExist(group: OutputGroup): Promise<boolean> {
        return await is_fileExist(path.join(this.config.outputDir, group.playlistName))
            && await is_fileExist(path.join(this.config.outputDir, group.combinedName));
    }

    /** 从合并文件头部（init 区间）解析流签名；文件不存在/解析失败返回 null */
    private async readCombinedSignature(combinedPath: string): Promise<{ key: string; label: string } | null> {
        if (!this.config.splitByResolution) return null;
        try {
            const fh = await fs.open(combinedPath, 'r');
            try {
                const head = Buffer.alloc(64 * 1024);
                const { bytesRead } = await fh.read(head, 0, head.length, 0);
                const signature = parseStreamSignature(head.subarray(0, bytesRead));
                return signature ? { 'key': signature.key, 'label': describeSignature(signature) } : null;
            } finally {
                await fh.close();
            }
        } catch {
            return null;
        }
    }

    /** 记录分片流签名（编码/分辨率/音频任一变化都会换 key；解析失败静默跳过） */
    private recordSignature(seg: SegmentInfo, buf: Buffer): void {
        if (!this.config.splitByResolution) return;
        const signature = parseStreamSignature(buf);
        if (!signature) return;
        this.signatureByFilename.set(seg.filename, signature.key);
        this.signatureLabelByFilename.set(seg.filename, describeSignature(signature));
        seg.signatureKey = signature.key;
    }

    /** 从已存在的分片文件头部补解析签名（解析结果进 signatureByFilename，后续批次复用） */
    private async recordDimsFromFile(seg: SegmentInfo, filePath: string): Promise<void> {
        if (!this.config.splitByResolution) return;
        if (seg.signatureKey || this.signatureByFilename.has(seg.filename)) return;
        try {
            const fh = await fs.open(filePath, 'r');
            try {
                const head = Buffer.alloc(64 * 1024);
                const { bytesRead } = await fh.read(head, 0, head.length, 0);
                this.recordSignature(seg, head.subarray(0, bytesRead));
            } finally {
                await fh.close();
            }
        } catch {
            // 补解析失败不影响下载流程：该分片按"签名未知"处理（并入当前组）
        }
    }

    /** 记录分片时间轴摘要（下载完成后立即解析，buffer 随后会转移给校验 worker） */
    private recordTimeline(seg: SegmentInfo, buf: Buffer): void {
        if (!this.config.enableContinuityCheck) return;
        try {
            this.timelineByFilename.set(seg.filename, parseSegmentTimeline(buf));
        } catch {
            // 时间轴解析异常不影响下载/校验，按"无法解析"处理
            this.timelineByFilename.set(seg.filename, null);
        }
    }

    /** 取分片时间轴摘要；本次进程没解析过的（重启续录的存量分片）从文件补解析一次 */
    private async getTimeline(seg: SegmentInfo): Promise<SegmentTimeline | null> {
        if (this.timelineByFilename.has(seg.filename))
            return this.timelineByFilename.get(seg.filename)!;
        let timeline: SegmentTimeline | null = null;
        try {
            const buf = await fs.readFile(path.join(this.segmentsDir, seg.filename));
            timeline = parseSegmentTimeline(buf);
        } catch (err) {
            global.logger.debug(`[HLSDownloader] 读取分片时间轴失败: ${seg.filename}: ${handleError(err).errMsg}`);
        }
        this.timelineByFilename.set(seg.filename, timeline);
        return timeline;
    }

    /** 输出结构校验告警（同类告警只打一次 warn，其余降到 debug） */
    private logValidationWarnings(seg: SegmentInfo, warnings?: string[]): void {
        for (const warning of warnings ?? []) {
            // 抹掉数字，避免 offset/size 差异导致同一类问题重复告警
            const key = warning.replace(/\d+/g, '#');
            if (this.warnedSegmentWarnings.has(key)) {
                global.logger.debug(`[HLSDownloader] 分片 ${seg.filename} 校验告警: ${warning}`);
                continue;
            }
            this.warnedSegmentWarnings.add(key);
            global.logger.warn(`[HLSDownloader] 分片 ${seg.filename} 校验告警: ${warning}`);
        }
    }

    /**
     * 跨分片时间轴连续性检查（按输出组分别维护状态）
     *
     * 除告警外，这里还负责**纠正时间轴回退**：上游切片器偶尔会在直播中途
     * 把 tfdt 从头重启（音视频同时回退、幅度一致），而合并文件只能按下载顺序追加。
     * 不平移的话，新一段内容全都会挤在回退点那一刻，播放时表现为「突然快进/卡住」。
     *
     * 平移量按「输出组 + 轨道」累计：同一段内容里的后续分片沿用同一个偏移，
     * 基线也用纠正后的时间轴，避免第二次误判。
     */
    private async checkSegmentContinuity(runs: { group: OutputGroup; segs: SegmentInfo[] }[]): Promise<void> {
        if (!this.config.enableContinuityCheck) return;

        for (const run of runs) {
            const groupName = run.group.playlistName;
            let state = this.continuityState.get(groupName);
            const cumulative = this.tfdtCumulative.get(groupName) ?? new Map<number, number>();

            for (const seg of run.segs) {
                const timeline = await this.getTimeline(seg);
                if (!timeline) {
                    // 无法解析时间轴（如 init-only 分片）：中断本组基线，避免下一次误报缺口
                    state = undefined;
                    this.continuityState.delete(groupName);
                    this.tfdtCumulative.delete(groupName);
                    cumulative.clear();
                    continue;
                }

                if (state) {
                    if (state.filename === seg.filename) continue;

                    // 1) 回退 → 计算本分片需要追加的平移量（按轨道累计）
                    const curFirst = new Map<number, { first: number; timescale: number }>();
                    for (const track of timeline.tracks) {
                        curFirst.set(track.trackId, {
                            'first': track.firstTfdt + (cumulative.get(track.trackId) ?? 0),
                            'timescale': track.timescale,
                        });
                    }
                    const prevEnd = new Map<number, { end: number; timescale: number }>();
                    for (const track of state.timeline.tracks) {
                        const duration = track.lastFragmentDuration > 0 ? track.lastFragmentDuration : 0;
                        prevEnd.set(track.trackId, {
                            'end': track.lastTfdt + duration,
                            'timescale': track.timescale,
                        });
                    }
                    const deltas = computeTfdtOffsets(prevEnd, curFirst);
                    for (const [trackId, delta] of deltas) {
                        cumulative.set(trackId, (cumulative.get(trackId) ?? 0) + delta);

                        const track = timeline.tracks.find(t => t.trackId === trackId);
                        const seconds = track && track.timescale > 0 ? delta / track.timescale : delta;
                        global.logger.warn(
                            `[HLSDownloader] 时间轴回退，已平移 ${seconds.toFixed(3)}s 使内容连续` +
                            `（${groupName}, ${seg.filename}, track ${trackId}）`
                        );
                    }

                    // 2) 记录本分片实际要应用的偏移（仅非零轨道）
                    const applied = new Map<number, number>();
                    for (const track of timeline.tracks) {
                        const offset = cumulative.get(track.trackId);
                        if (offset) applied.set(track.trackId, offset);
                    }
                    if (applied.size) this.tfdtOffsetsByFilename.set(seg.filename, applied);
                    else this.tfdtOffsetsByFilename.delete(seg.filename);

                    // 3) 用纠正后的时间轴做缺口/回退判定与下一轮基线
                    //    注意不能就地改 timeline：它来自 timelineByFilename 缓存，
                    //    同一分片被再次取用时会重复叠加偏移
                    const adjusted: SegmentTimeline = {
                        ...timeline,
                        'tracks': timeline.tracks.map(track => {
                            const offset = cumulative.get(track.trackId) ?? 0;
                            return {
                                ...track,
                                'firstTfdt': track.firstTfdt + offset,
                                'lastTfdt': track.lastTfdt + offset,
                            };
                        }),
                    };
                    for (const issue of diffSegmentTimeline(state.timeline, adjusted))
                        this.logContinuityIssue(groupName, seg.filename, issue);
                    state = { 'timeline': adjusted, 'filename': seg.filename };
                    continue;
                } else {
                    global.logger.debug(`[HLSDownloader] 连续性基线: ${groupName} <- ${seg.filename}`);
                }
                state = { timeline, filename: seg.filename };
            }

            if (state) this.continuityState.set(groupName, state);
            if (cumulative.size) this.tfdtCumulative.set(groupName, cumulative);
        }
    }

    private logContinuityIssue(groupName: string, filename: string, issue: ContinuityIssue): void {
        const message = `[HLSDownloader] 分片连续性异常（${groupName}, ${filename}）: ${issue.detail}`;
        const key = `${groupName}:${issue.kind}`;
        if (this.warnedContinuity.has(key)) {
            global.logger.debug(message);
            return;
        }
        this.warnedContinuity.add(key);
        // mfhd 序号是否全局连续依赖上游切片器实现，先降级为 debug
        if (issue.kind === 'sequence_gap') global.logger.debug(message);
        else global.logger.warn(message);
    }

    /**
     * 下载入口：拉取 m3u8、解析、确保目录、并发下载分片
     */
    async downloadPlaylist(
        m3u8Url: string,
        generate?: {
            type?: 'simple' | 'byterange';
            filename?: string;
            combinedName?: string;
            initFile?: string;
            targetDuration?: number;
            mediaSequence?: number;
        }
    ): Promise<SegmentInfo[]> {
        global.logger.info(`[HLSDownloader] 获取播放列表: ${m3u8Url}`);

        const response = await this.fetcher.httpErrRepeat<string>(
            m3u8Url,
            { timeout: this.config.timeout },
            'text'
        );

        const segments = parseM3U(response.data, m3u8Url);

        this.lastInitMap = detectInitMap(response.data, m3u8Url);
        global.logger.info(`[HLSDownloader] 解析到 ${segments.length} 个分片`);

        // 确保目录存在
        if (!(await is_dirExist(this.config.outputDir, { throwError: true })).is_dir)
            await createDir(this.config.outputDir);

        // 若设置了分片子目录，确保其存在
        if (
            this.segmentsDir !== this.config.outputDir &&
            !(await is_dirExist(this.segmentsDir, { throwError: true })).is_dir
        )
            await createDir(this.segmentsDir);

        // 下载并返回
        await this.downloadSegments(segments);
        global.logger.info('[HLSDownloader] 分片下载流程结束');


        // 生成本地播放列表（可选）
        if (generate?.type === 'simple') {

            const filename = generate.filename ?? 'index.m3u8';
            await this.writeLocalM3U8(segments, filename, {
                'targetDuration': generate.targetDuration,
                'mediaSequence': generate.mediaSequence,
                'initFile': generate.initFile,
            });
        } else if (generate?.type === 'byterange') {
            const filename = generate.filename ?? 'index-br.m3u8';
            const combinedName = generate.combinedName ?? 'combined.m4s';
            await this.writeLocalM3U8Byterange(segments, filename, combinedName, {
                'targetDuration': generate.targetDuration,
                'mediaSequence': generate.mediaSequence,
                'initMap': this.lastInitMap,
            });
        }

        return segments;
    }

    /**
     * 解析 m3u8（兼容相对/绝对 URL、BYTERANGE 行、容错的 EXTINF 格式）
     */

    /**
     * 检测并解析 #EXT-X-MAP（返回绝对 URI + 可选 byterange）
     */

    /**
     * 下载所有分片：基于 worker 池的并发实现，避免递归与复杂 promise 控制
     */
    private async downloadSegments(segments: SegmentInfo[]): Promise<void> {
        if (!segments.length)
            return;

        const queue = segments.slice(); // FIFO
        const concurrency = Math.max(1, Math.min(64, this.config.concurrency));
        let downloaded = 0;
        let skippedMerged = 0;
        let skippedExists = 0;
        const errors: Error[] = [];
        // const nowSegments: Map<SegmentInfo['filename'], SegmentInfo> = new Map();

        const workers: Promise<void>[] = [];

        const getNext = () => {
            // safe shift
            return queue.length ? queue.shift()! : undefined;
        };

        const worker = async () => {
            while (true) {
                const seg = getNext();
                if (!seg)
                    break;
                try {
                    const result = await this.downloadSegmentWithRetry(seg);
                    if (result === 'merged')
                        skippedMerged++;
                    else if (result === 'exists')
                        skippedExists++;
                    else
                        downloaded++;
                } catch (err) {
                    const { errObj, errMsg } = handleError(err);
                    // 记录错误但继续其他任务，避免单个分片卡住整个队列
                    global.logger.error(`[HLSDownloader] 下载分片失败（略过）: ${seg.filename} -> ${errMsg}`);
                    // 清理可能残留的临时文件或部分文件
                    const failedDest = path.join(this.segmentsDir, seg.filename);
                    const failedTmp = failedDest + '.temp';
                    try { await fs.unlink(failedTmp); } catch { /* 文件不存在或已清理 */ }
                    if (errObj instanceof Error)
                        errors.push(errObj);
                    else {
                        global.logger.error(`[HLSDownloader] 未知错误类型: ${errMsg}`);
                        errors.push(new Error(errMsg));
                    }
                }
            }
        };

        for (let i = 0; i < concurrency; i++) {
            workers.push(worker());
        }

        await Promise.all(workers);

        if (errors.length) {
            global.logger.warn(`[HLSDownloader] 下载完成，但存在 ${errors.length} 个失败分片（已记录并跳过）`);
        } else if (downloaded > 0) {
            global.logger.info(`[HLSDownloader] 全部 ${downloaded} 个分片下载成功`);
        }

        // 每轮都会重新拉取整个播放列表，已处理过的分片不再逐条打日志，只汇总一行
        const skipped = skippedMerged + skippedExists;
        if (skipped > 0) {
            global.logger.info(`[HLSDownloader] 跳过 ${skipped} 个已合并/已存在的分片（已合并 ${skippedMerged} / 已存在 ${skippedExists}）`);
        }
    }

    /**
     * 释放资源（销毁校验 worker 池）
     *
     * 每个 HLSDownloader 实例会拉起 4 个 worker 线程；RecorderManager 每场次都会新建一个
     * SegmentFetcher（→ 新实例），不销毁就会按场次累积线程。
     */
    dispose(): void {
        try {
            this.validatorPool.destroy();
        } catch (err) {
            global.logger?.warn?.(`[HLSDownloader] 销毁校验 worker 池失败: ${handleError(err).msg}`);
        }
    }

    /**
     * 取出可安全转移给 worker 的 ArrayBuffer
     * - 下载得到的 Buffer 通常就是整块 ArrayBuffer 的视图（byteOffset=0 且长度相等），
     *   此时直接返回它：postMessage 转移所有权，零拷贝
     * - 否则（视图 / 池化缓冲）拷一份出来，避免转移时把整块底层内存一起 detach
     */
    private toTransferableArrayBuffer(buf: Buffer): ArrayBuffer {
        if (buf.byteOffset === 0 && buf.byteLength === buf.buffer.byteLength) {
            return buf.buffer as ArrayBuffer;
        }
        return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
    }

    /**
     * 单分片下载封装：使用 fetcher（带重试），并做本地结构校验
     * @returns 本次对分片的处理结果（新下载 / 已合并跳过 / 本地已存在跳过）
     */
    private async downloadSegmentWithRetry(seg: SegmentInfo): Promise<SegmentDownloadResult> {
        const destPath = path.join(this.segmentsDir, seg.filename);
        const tmpPath = destPath + '.temp';
        // 上限写死 3（即最多尝试 4 次），不读 config.maxRetry
        const maxRetry = 3;

        // 分片对象每批都从 m3u8 重新解析（dims 会丢），这里把已记录的分辨率补回来
        const knownSignature = this.signatureByFilename.get(seg.filename);
        if (knownSignature) seg.signatureKey = knownSignature;

        // 重试循环：本次校验不合格就返回 retry，由这里统一计数、统一抛错
        for (let retry = 0; ; retry++) {
            if (retry > maxRetry) {
                throw new Error(`分片 ${seg.filename} 下载失败，超过最大重试次数 ${maxRetry}`);
            }

            const result = await this.downloadAndCheck(seg, destPath, tmpPath);
            if (result.kind === 'retry') continue;

            return result.kind;
        }
    }

    /**
     * 校验一份刚下载的分片数据并写入 tmpPath
     *
     * 主下载路径与"重试兜底路径"共用：两条路径的校验语义必须一致，否则兜底成功的分片
     * 不会进 verified 集合，会被 append 的候选过滤跳过，等到下一轮才合并 ——
     * 期间后续分片已经写入合并文件，播放列表里就出现时间倒序。
     *
     * @returns verified = 校验通过；retry = 本次下载不合格需重下
     */
    private async validateAndWriteSegment(
        seg: SegmentInfo,
        data: Buffer,
        tmpPath: string
    ): Promise<'verified' | 'retry'> {
        // 先记录分辨率/时间轴/大小：buffer 下面会转移给校验 worker（detach），之后再解析就拿不到了
        this.recordSignature(seg, data);
        this.recordTimeline(seg, data);
        this.segmentSizeByFilename.set(seg.filename, data.length);

        if (!this.config.validateSegments) {
            await fs.writeFile(tmpPath, data);
            return 'verified';
        }

        const validation = await this.validatorPool.validate({
            buffer: this.toTransferableArrayBuffer(data),
            segmentName: seg.filename,
            checks: {
                moovIntegrity: this.config.enableMoovIntegrityCheck,
                moofMdat: this.config.enableMoofMdatCheck,
                boxSize: this.config.enableBoxSizeCheck,
                tfdtContinuity: this.config.enableTfdtContinuity,
            },
        });

        this.logValidationWarnings(seg, validation.warnings);

        global.logger.debug(
            `[HLSDownloader] 分片 ${seg.filename} 校验结果: ` +
            `size=${validation.size}, moov=${validation.moovValid}, ` +
            `moofMdatIssue=${validation.anyMoofMdatIssue}, ` +
            `boxIssue=${validation.anyBoxIssue}, ` +
            `tfdtIssue=${validation.anyTfdtIssue}`
        );

        if (this.config.enableMoovIntegrityCheck && !validation.moovValid) {
            global.logger.error(`[HLSDownloader] 分片 ${seg.filename} 的 moov box 缺失或不完整 (${validation.moovReason})，重新下载`);
            return 'retry';
        }

        if (this.config.enableMoofMdatCheck && validation.anyMoofMdatIssue) {
            global.logger.error(`[HLSDownloader] 分片 ${seg.filename} 的 moof/mdat 片段缺失或不完整，重新下载`);
            return 'retry';
        }

        if (this.config.enableBoxSizeCheck && validation.anyBoxIssue) {
            global.logger.error(`[HLSDownloader] 分片 ${seg.filename} 的 FMP4 box 尺寸或偏移异常，重新下载`);
            return 'retry';
        }

        if (this.config.enableTfdtContinuity && validation.anyTfdtIssue) {
            global.logger.error(`[HLSDownloader] 分片 ${seg.filename} 的 tfdt 时间戳不连续，重新下载`);
            return 'retry';
        }

        // data 的底层 ArrayBuffer 已转移给 worker，用带回来的那份落盘
        await fs.writeFile(tmpPath, Buffer.from(validation.buffer!));
        return 'verified';
    }

    /**
     * 下载 → 本地校验 → 落盘；校验不过时返回 { kind: 'retry' } 交给上层重试
     */
    private async downloadAndCheck(seg: SegmentInfo, destPath: string, tmpPath: string): Promise<SegmentAttemptResult> {
        // 文件已合并，则跳过下载（跳过情况只做计数，由 downloadSegments 汇总输出）
        if (this.appendedSegments.has(seg.filename)) {
            return { kind: 'merged' };
        }

        // 已下载到 dest 的情况：首次下载时已通过本地校验，直接信任
        if (await is_fileExist(destPath)) {
            this.verifiedSegments.add(seg.filename);
            // 大小限制切分需要字节数：存量分片按需 stat
            try {
                this.segmentSizeByFilename.set(seg.filename, (await fs.stat(destPath)).size);
            } catch {
                // stat 失败不影响下载流程，后续按需再取
            }
            // 补解析分辨率（只读一次）：这些"已存在但还没合并"的分片可能是切换前后的残留
            await this.recordDimsFromFile(seg, destPath);
            return { kind: 'exists' };
        }


        try {
            const response = await this.fetcher.httpErrRepeat<ArrayBuffer>(
                seg.url,
                { timeout: this.config.timeout },
                'arrayBuffer'
            );

            const verdict = await this.validateAndWriteSegment(seg, Buffer.from(response.data), tmpPath);
            if (verdict === 'retry') return { kind: 'retry' };

            // 原子替换目标文件
            await fs.rename(tmpPath, destPath);
            this.verifiedSegments.add(seg.filename);

            global.logger.info(`[HLSDownloader] 下载完成 -> ${seg.filename}`);

            await delay(20);
            return { kind: 'downloaded' };
        } catch (err) {
            // 再尝试一次指数退避后重试（作为额外保险）
            const backoff = exponentialDelay(500, 2, 1, 3000);
            global.logger.warn(`[HLSDownloader] 下载 ${seg.filename} 出错，稍后再试 ${backoff}ms: ${handleError(err).errMsg}`);
            await delay(backoff);
            // 最后一次尝试（若仍失败则抛出）
            const response = await this.fetcher.httpErrRepeat<ArrayBuffer>(
                seg.url,
                { timeout: this.config.timeout },
                'arrayBuffer'
            );

            // 兜底路径同样要过校验，通过后才能进 verified 集合
            const verdict = await this.validateAndWriteSegment(seg, Buffer.from(response.data), tmpPath);
            if (verdict === 'retry') {
                // 交给上层重试循环计数，与主路径语义一致
                return { kind: 'retry' };
            }

            // 原子替换目标文件
            await fs.rename(tmpPath, destPath);
            this.verifiedSegments.add(seg.filename);

            global.logger.info(`[HLSDownloader] 重试成功 -> ${seg.filename}`);
            return { kind: 'downloaded' };
        }
    }

    /**
     * 生成标准 simple m3u8（相对引用分片），可选包含 initFile 与 ENDLIST（VOD）
     */

    /**
     * 生成 BYTERANGE 播放列表与合并文件（更健壮实现）
     * - 会创建临时 combined file（combined.tmp），写入 init (来自 initMap 或从首段提取 ftyp+moov）
     * - 追加所有分片数据（仅 moof+mdat），计算 len@offset，并生成 playlist（带 MAP）
     */

    /**
     * 追加分片到已存在的 combined.m4s + 更新 playlist（安全追加）
     * - 会读取当前 combined 文件大小作为 offset
     * - 追加分片二进制并计算 len@offset，然后在 playlist 末尾追加条目
     */

    /**
     * 用输出目录里已有的播放列表播种"已合并"集合（每场次录制开始时调用一次）
     *
     * 为什么需要：已合并的分片文件会被删除（keepSegments=false），而 appendedSegments 只在内存里。
     * 重启后两者皆空 → 老分片会被当成新分片**整段重新下载**，下载完又被播放列表的 seen 过滤掉、
     * 白下载一遍还占着磁盘。播种之后直接走"已合并"分支跳过。
     *
     * 播种前必须确认合并文件真的覆盖到了播放列表记录的范围 —— 判错会导致漏录，
     * 所以任何看不懂的地方（条目指向别的文件、BYTERANGE 缺偏移、疑似截断、大小不够）都不播种。
     *
     * @returns 播种的分片数量（0 表示没有可用的现场）
     */

    /**
     * 解析一个 m4s/mp4 缓冲区：
     * - 如果开头是 ftyp + moov，则作为 init 返回；
     * - 其后部分作为 media 返回；
     * - 如果没有完整的 ftyp + moov，则 init=null，整块作为 media。
     */
}
