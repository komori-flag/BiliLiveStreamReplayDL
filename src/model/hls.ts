// HLS 下载管线的配置与数据类型
// 单独成文件，便于 m3u8 解析、播放列表写出等模块复用而不引入循环依赖

/**
 * HLS 下载器配置
 */
export interface HLSDownloaderConfig {
    /** 目标下载目录 */
    outputDir: string;
    /** 最大并发下载数（默认为 3） */
    concurrency?: number;
    /** 请求超时时间（ms） */
    timeout?: number;
    /** 最大重试次数 */
    maxRetry?: number;
    /**
     * 响应体停滞阈值（ms）：收到响应头之后，连续这么久没有新数据就中止并重试。
     * 默认 15000；设 0 关闭。与 timeout（响应头超时）独立。
     */
    stallTimeout?: number;
    /**
     * 严格顺序追加的放弃阈值（ms）
     *
     * 合并文件只能追加，无法插入。为保证播放列表时间单调，某个分片未通过校验时，
     * 它之后的分片会先压着不追加；该分片超过这个时长仍拿不到就放弃并继续，
     * 代价是播放列表留下一个真实缺口（会打 ERROR 日志）。
     *
     * 默认 5 分钟；设 0 关闭严格顺序（退回"能写就写"的旧行为）。
     */
    strictAppendTimeoutMs?: number;
    /** 是否保留中间的 .m4s 分片 */
    keepSegments?: boolean;
    /**
     * 是否对下载的分片做本地结构校验（默认 true）
     *
     * 关闭后下载即落盘，只用于测试/排障；生产必须保持开启，
     * 否则损坏的分片会被直接合并进录像。
     */
    validateSegments?: boolean;
    /** 是否启用 moov box 完整性检测（默认 true） */
    enableMoovIntegrityCheck?: boolean;
    /** 是否启用 moof/mdat 片段完整性检测（默认 true） */
    enableMoofMdatCheck?: boolean;
    /** 是否启用 box 尺寸/偏移异常检测（默认 true） */
    enableBoxSizeCheck?: boolean;
    /** 是否启用 tfdt 时间戳连续性检测（默认 true） */
    enableTfdtContinuity?: boolean;
    /**
     * 是否启用跨分片时间轴/序号连续性检查（默认 true）
     * 仅记录告警，不参与分片校验判定
     */
    enableContinuityCheck?: boolean;
    /** 分片保存的子目录（相对 outputDir），便于调试归档 */
    segmentsSubdir?: string;
    /**
     * 检测到视频分辨率变化时是否拆分输出组（默认 true）
     * 每次切换新开一组 `{基础名}_p{N}`，切回原分辨率也算新组
     */
    splitByResolution?: boolean;
    /**
     * 单个输出文件大小上限（字节）；0 = 不限制
     * 再加入下一分片会超出时新开输出组，录制不中断
     */
    maxFileSizeBytes?: number;
    /**
     * 单个输出文件时长上限（秒）；0 = 不限制
     * 按该组已合并分片的 EXTINF 总时长计算
     */
    maxFileDurationSec?: number;
}

/**
 * 每个分片的元信息
 */
export interface SegmentInfo {
    index: number;
    duration: number;
    url: string;
    filename: string;
    byterange?: { len: number; offset: number };
    /** 视频分辨率 key（`宽x高`，下载时从分片自带的 moov/tkhd 解析） */
    dimsKey?: string;
    /**
     * 流签名 key（编码 / 分辨率 / 编码参数 / 音频参数）
     * 任一变化都会新开输出组
     */
    signatureKey?: string;
}

/**
 * 单分片处理结果
 * - downloaded：本次真正下载并落盘
 * - merged：该分片已在合并产物中，跳过
 * - exists：本地已存在该分片文件，跳过
 */
export type SegmentDownloadResult = 'downloaded' | 'merged' | 'exists';

/**
 * 单次尝试的结果（HLSDownloader 内部用）
 * - retry：本次校验没过，应该重下（日志已由触发它的那一步按原级别记录）
 */
export type SegmentAttemptResult =
    | { kind: 'downloaded' }
    | { kind: 'merged' }
    | { kind: 'exists' }
    | { kind: 'retry' };

/** 一条已写入合并文件的区间 */
export interface ByterangeRange {
    filename: string;
    len: number;
    offset: number;
    duration: number;
}

/** 播放列表中一条分片索引 */
export interface PlaylistEntry {
    filename: string;
    /** 该条目指向的文件（应等于合并文件名） */
    uri: string;
    offset: number;
    len: number;
    /** #EXTINF 声明的时长（秒）；缺失或非法为 0 */
    duration: number;
}

export interface PlaylistIndex {
    /** 已被收录的分片（出现在播放列表里 = 其字节已在合并文件中） */
    seen: Set<string>;
    /** 条目明细，便于排查 */
    entries: PlaylistEntry[];
    /** 所有条目（含 init 区间）`offset + len` 的最大值，用来校验合并文件是否覆盖完整 */
    maxEnd: number;
    /** 所有条目的 EXTINF 总时长（秒），用于续录时恢复输出组的时长计数 */
    totalDuration: number;
    /** 是否存在无法解析/不自洽的内容（有此标记就不应据此播种） */
    suspicious: boolean;
    /** suspicious 的原因，便于记录日志 */
    reason?: string;
}

/** 写出播放列表所需的外部依赖（由 HLSDownloader 提供） */
export interface ByterangeWriterDeps {
    outputDir: string;
    segmentsDir: string;
    /** 分片子目录相对 outputDir 的路径（写 simple m3u8 时用于生成相对引用） */
    segmentsRel?: string;
    keepSegments: boolean;
    /** 取 #EXT-X-MAP 的 init 信息 */
    getInitMap: () => { uri: string; byterange?: { len: number; offset: number } } | undefined;
    /** 记录某分片已合并进某个输出组 */
    markAppended: (filename: string, playlistName: string) => void;
    /** 某个输出组已合并分片数量（用于拒绝有损重建的守卫，按组计数） */
    appendedCount: (playlistName: string) => number;
    /**
     * 取某分片合并前要应用的 tfdt 平移量（trackId → timescale 单位）
     * 上游切片器中途重启时间轴时，靠它把新一段内容接在上一段结束处
     */
    getTfdtOffsets?: (filename: string) => Map<number, number> | undefined;
    /** 拉取 init 分片（由下载器带超时/重试实现） */
    fetchInit: (url: string) => Promise<ArrayBuffer>;
}
