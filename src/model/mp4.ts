// fMP4 box 解析/检测相关的数据类型（partDataFix 与 mp4 工具共用）

/** 顶层 box 的最小描述（offset/size/type/头部长度） */
export type Mp4BoxTop = { offset: number; size: number; type: string; headerSize: number };

export interface TfdtEntry {
    /** moof 在文件中偏移 */
    moofOffset: number;
    /** tfdt box 中的 baseMediaDecodeTime */
    baseMediaDecodeTime: number;
    /** 与**同一轨**上一条 tfdt 的差值（跨轨不可比） */
    delta: number;
    /** tfdt version */
    version: number;
    /** 所属轨道（来自 tfhd 的 track_ID）；取不到时为 -1 */
    trackId: number;
}

export interface TfdtContinuityResult {
    /** 是否通过（单调递增，无大幅异常跳变，至少找到一条 tfdt） */
    ok: boolean;
    /** 所有检测到的 tfdt 条目 */
    entries: TfdtEntry[];
    /** 检测到的问题 */
    issues: Array<{
        kind: 'time_rewind' | 'time_gap' | 'missing_tfdt';
        detail: string;
        at?: number;
    }>;
    /** 所有 tfdt 原始值（用于分析） */
    rawTimes: bigint[];
}

/** trex/mvex 中的默认样本参数 */
export interface Mp4TrackDefaults {
    defaultSampleDuration: number;
    defaultSampleSize: number;
    defaultSampleFlags: number;
}

/** moov 中与校验相关的轨道信息 */
export interface Mp4TrackInfo {
    trackId: number;
    /** hdlr 的 handler_type，如 'vide' / 'soun'；解析不到为空串 */
    handler: string;
    /** mdhd timescale；解析不到为 0 */
    timescale: number;
    /** mvex/trex 默认值 */
    trex?: Mp4TrackDefaults;
}

/** 解析后的 trun（只保留校验需要的字段） */
export interface Mp4TrunInfo {
    offset: number;
    size: number;
    flags: number;
    sampleCount: number;
    /** 相对 traf 的 base data offset */
    dataOffset?: number;
    /** trun 或首样本提供的 sample flags */
    firstSampleFlags?: number;
    /** trun 声明了 per-sample size 字段 */
    sampleSizesKnown: boolean;
    sampleSizeSum: number;
    /** trun 声明了 per-sample duration 字段 */
    sampleDurationsKnown: boolean;
    sampleDurationSum: number;
    /** 按 flags + sample_count 计算出的应有大小（含 box 头） */
    tableBytes: number;
    /** tableBytes === box size */
    sizeConsistent: boolean;
    /** 样本表越界/截断（sample_count 与实际字段不匹配） */
    truncated: boolean;
}

/** 解析后的 traf */
export interface Mp4TrafInfo {
    offset: number;
    size: number;
    trackId: number;
    tfhdFlags: number;
    baseDataOffset?: number;
    defaultSampleDuration?: number;
    defaultSampleSize?: number;
    defaultSampleFlags?: number;
    tfdt?: number;
    truns: Mp4TrunInfo[];
    parseError?: string;
}

/** 解析后的 moof */
export interface Mp4MoofInfo {
    offset: number;
    size: number;
    sequenceNumber?: number;
    trafs: Mp4TrafInfo[];
}

/** 单个分片里某条轨道的时间轴摘要（跨分片连续性检查用） */
export interface SegmentTrackTimeline {
    trackId: number;
    handler: string;
    timescale: number;
    firstTfdt: number;
    lastTfdt: number;
    /** 该轨最后一个 fragment 的样本总时长（timescale 单位）；0 = 无法解析 */
    lastFragmentDuration: number;
}

/** 单个分片的时间轴摘要 */
export interface SegmentTimeline {
    tracks: SegmentTrackTimeline[];
    firstSequence?: number;
    lastSequence?: number;
}

/** 跨分片连续性检查发现的问题 */
export interface ContinuityIssue {
    kind: 'tfdt_gap' | 'tfdt_rewind' | 'sequence_gap' | 'track_set_changed' | 'timescale_changed';
    detail: string;
}

/** moof 片段检测结果 */
export interface Mp4FragmentMoof {
    offset: number;
    size: number;
    ok: boolean;
    reason?: string;
    containsMfhd?: boolean;
    trafCount?: number;
    trunSampleCount?: number | undefined;
    trunDeclaredBytes?: number | undefined;
    defaultSampleSize?: number | undefined;
}

/** mdat 片段检测结果 */
export interface Mp4FragmentMdat {
    offset: number;
    size: number;
    ok: boolean;
    reason?: string;
    payloadBytes?: number;
}

/** 一对 moof/mdat 的检测结果 */
export type Mp4Fragment = {
    index: number;
    moof?: Mp4FragmentMoof;
    mdat?: Mp4FragmentMdat;
    status: "ok" | "ok_warn" | "missing_mdat" | "moof_truncated" | "mdat_truncated" | "trun_mismatch" | "trun_table_mismatch" | "mdat_coverage_mismatch" | "unknown";
    /** 不致命、但值得记录的告警（不参与校验判定） */
    warnings?: string[];
}

/** 构建中的片段（moof/mdat 已就位，payloadBytes 已算出） */
export type Mp4FragmentDraft = Mp4Fragment & {
    moof: Mp4FragmentMoof;
    mdat: Mp4FragmentMdat & { payloadBytes: number };
};
