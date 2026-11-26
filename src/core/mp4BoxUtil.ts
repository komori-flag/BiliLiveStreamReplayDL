// fMP4 box 小工具：纯函数，无状态

export function extractInitAndMedia(buf: Buffer): { init: Buffer | null; media: Buffer } {
    let offset = 0;
    const len = buf.length;

    const readBox = (start: number): { type: string; size: number } | null => {
        if (start + 8 > len)
            return null;
        const size = buf.readUInt32BE(start);
        const type = buf.toString('ascii', start + 4, start + 8);
        if (size < 8 || start + size > len)
            return null;
        return { type, size };
    };

    // 第一个 box 必须是 ftyp
    const box1 = readBox(offset);
    if (!box1 || box1.type !== 'ftyp') {
        return { init: null, media: buf };
    }
    offset += box1.size;

    // 第二个 box 必须是 moov
    const box2 = readBox(offset);
    if (!box2 || box2.type !== 'moov') {
        return { init: null, media: buf };
    }
    offset += box2.size;

    const init = buf.subarray(0, offset);
    const media = buf.subarray(offset);

    return { init, media };
}

// ── 视频分辨率解析（按分辨率切换拆分输出组用） ──

interface BoxRef {
    offset: number;
    size: number;
    type: string;
    /** box 头长度：8 = 普通，16 = 64 位扩展 size */
    headerSize: number;
}

/** 读一个 box 头；size/边界不合法返回 null（调用方按"解析到此为止"处理） */
function readBox(buf: Buffer, offset: number, end: number): BoxRef | null {
    if (offset + 8 > end) return null;
    const size32 = buf.readUInt32BE(offset);
    const type = buf.toString('ascii', offset + 4, offset + 8);
    let size = size32;
    let headerSize = 8;
    if (size32 === 1) {
        if (offset + 16 > end) return null;
        size = Number((BigInt(buf.readUInt32BE(offset + 8)) << 32n) | BigInt(buf.readUInt32BE(offset + 12)));
        headerSize = 16;
    } else if (size32 === 0) {
        size = end - offset; // size==0：延伸到末尾
    }
    if (size < headerSize || offset + size > end) return null;
    return { offset, size, type, headerSize };
}

/** 在 parent 的直接子 box 里找指定类型 */
function findChild(buf: Buffer, parent: BoxRef, type: string): BoxRef | null {
    const end = parent.offset + parent.size;
    for (let off = parent.offset + parent.headerSize; off + 8 <= end;) {
        const box = readBox(buf, off, end);
        if (!box) return null;
        if (box.type === type) return box;
        off += box.size;
    }
    return null;
}

/**
 * 从 fMP4 缓冲区解析视频轨的显示宽高（moov → trak → tkhd）
 *
 * - moov 恒在文件头部（本项目分片都是 ftyp+moov 开头），只需扫头部若干 KB
 * - 宽高取 tkhd box 末尾 8 字节（16.16 定点，v0/v1 布局不同但都在末尾）
 * - 轨道识别优先 hdlr==='vide'；无 hdlr 时退化为"tkhd 宽高非 0"的轨道（音频轨宽高恒为 0）
 * - tkhd 旋转矩阵的 a、d 都为 0（90°/270°）时，有效显示尺寸是交换后的宽高
 * - 任何解析异常/无视频轨都返回 null，绝不抛
 */
export function parseVideoDims(buf: Buffer): { width: number; height: number; key: string } | null {
    try {
        let moov: BoxRef | null = null;
        for (let off = 0; off + 8 <= buf.length;) {
            const box = readBox(buf, off, buf.length);
            if (!box) break;
            if (box.type === 'moov') { moov = box; break; }
            off += box.size;
        }
        if (!moov) return null;

        let fallback: { width: number; height: number } | null = null;
        const moovEnd = moov.offset + moov.size;
        for (let off = moov.offset + moov.headerSize; off + 8 <= moovEnd;) {
            const trak = readBox(buf, off, moovEnd);
            if (!trak) break;
            off += trak.size;
            if (trak.type !== 'trak') continue;

            const tkhd = findChild(buf, trak, 'tkhd');
            if (!tkhd || tkhd.size < tkhd.headerSize + 8) continue;

            const boxEnd = tkhd.offset + tkhd.size;
            let width = buf.readUInt32BE(boxEnd - 8) / 65536;
            let height = buf.readUInt32BE(boxEnd - 4) / 65536;
            if (!(width > 0) || !(height > 0)) continue;

            const version = buf[tkhd.offset + tkhd.headerSize];
            const matrixStart = tkhd.offset + tkhd.headerSize + (version === 1 ? 52 : 40);
            if (matrixStart + 20 <= boxEnd
                && buf.readInt32BE(matrixStart) === 0
                && buf.readInt32BE(matrixStart + 16) === 0) {
                const t = width; width = height; height = t;
            }

            const mdia = findChild(buf, trak, 'mdia');
            const hdlr = mdia ? findChild(buf, mdia, 'hdlr') : null;
            let handler = '';
            if (hdlr && hdlr.size >= hdlr.headerSize + 12)
                handler = buf.toString('ascii', hdlr.offset + hdlr.headerSize + 8, hdlr.offset + hdlr.headerSize + 12);

            if (handler === 'vide')
                return { width: Math.round(width), height: Math.round(height), 'key': `${Math.round(width)}x${Math.round(height)}` };
            if (!fallback) fallback = { width, height };
        }

        if (fallback)
            return { width: Math.round(fallback.width), height: Math.round(fallback.height), 'key': `${Math.round(fallback.width)}x${Math.round(fallback.height)}` };
        return null;
    } catch {
        return null;
    }
}

// ── 流签名解析（编码 / 分辨率 / 音频参数变化时拆分输出组用） ──

/** 音频轨道的关键参数 */
export interface AudioSignature {
    /** sample entry 的 fourcc，如 mp4a */
    codec: string;
    /** mdhd timescale（采样率） */
    timescale: number;
    /** AudioSpecificConfig 的 objectType；解析不到为 null */
    objectType: number | null;
    /** 声道数；解析不到为 null */
    channels: number | null;
    /** 采样率索引（MPEG-4 Audio 表）；解析不到为 null */
    sampleRateIndex: number | null;
    /** AudioSpecificConfig 的稳定指纹 */
    configHash: string;
}

/** 一条轨道的完整签名 */
export interface StreamTrackSignature {
    trackId: number;
    handler: string;
    timescale: number;
    /** 视频：stsd sample entry fourcc（avc1 / hvc1 / hev1 …）；音频：同 */
    codec: string;
    /** 视频编码配置（avcC/hvcC）的稳定指纹；音频为 null */
    videoConfigHash: string | null;
    audio?: AudioSignature;
    width?: number;
    height?: number;
}

/**
 * 流签名：整组分片的"同一路流"判据
 *
 * key 用于分组与日志；任何一项变化（分辨率、视频编码、视频编码参数、
 * 音频编码/采样率/声道）都会产生新的 key。
 */
export interface StreamSignature {
    key: string;
    video: StreamTrackSignature | null;
    audio: StreamTrackSignature | null;
}

/** 简单稳定哈希：djb2，仅用于比较配置是否变化，不做加密用途 */
function hashBytes(buf: Buffer): string {
    let h = 5381;
    for (let i = 0; i < buf.length; i++) h = ((h * 33) ^ buf[i]) >>> 0;
    return h.toString(16).padStart(8, '0');
}

/** 解析 stsd 的第一个 sample entry（返回 fourcc 与配置子 box） */
function parseSampleEntry(buf: Buffer, stsd: BoxRef): { codec: string; config: Buffer | null } | null {
    // stsd: box 头 + version/flags(4) + entry_count(4) → 第一个 entry
    const entriesStart = stsd.offset + stsd.headerSize + 8;
    const stsdEnd = stsd.offset + stsd.size;
    if (entriesStart + 8 > stsdEnd) return null;

    const entrySize = buf.readUInt32BE(entriesStart);
    if (entrySize < 16 || entriesStart + entrySize > stsdEnd) return null;
    const codec = buf.toString('ascii', entriesStart + 4, entriesStart + 8);
    const entryEnd = entriesStart + entrySize;

    // 视觉 sample entry 固定头 78 字节、音频 28 字节，其后才是配置子 box。
    // entriesStart 指向 entry 的 size 字段，所以还要再加 8 字节 entry 头。
    const VISUAL_CODECS = new Set(['avc1', 'avc3', 'hvc1', 'hev1', 'hvc2', 'hev2', 'av01', 'vp09']);
    const fixedHeader = 8 + (VISUAL_CODECS.has(codec) ? 78 : 28);

    const candidates = new Set(['avcC', 'hvcC', 'av1C', 'vpcC', 'esds']);
    for (let off = entriesStart + fixedHeader; off + 8 <= entryEnd;) {
        const box = readBox(buf, off, entryEnd);
        if (!box) break;
        if (candidates.has(box.type) && box.size > box.headerSize)
            return { codec, config: buf.subarray(box.offset + box.headerSize, box.offset + box.size) };
        off += box.size;
    }
    return { codec, config: null };
}

/** 从 AudioSpecificConfig 读 objectType / sampleRateIndex / channels */
function parseAudioSpecificConfig(config: Buffer | null): {
    objectType: number | null;
    sampleRateIndex: number | null;
    channels: number | null;
} {
    if (!config || config.length < 2) return { objectType: null, sampleRateIndex: null, channels: null };
    // esds 里包着 ES_Descriptor(0x03) → DecoderConfigDescriptor(0x04) → DecoderSpecificInfo(0x05)
    let asc = config;

    const findTag = (buf: Buffer, from: number, tag: number): Buffer | null => {
        for (let i = from; i + 2 < buf.length; i++) {
            if (buf[i] !== tag) continue;
            // 展开式长度字段（最长 4 字节）
            let len = 0;
            let used = 0;
            for (let k = 0; k < 4 && i + 1 + k < buf.length; k++) {
                const c = buf[i + 1 + k];
                len = (len << 7) | (c & 0x7f);
                used = k + 1;
                if (!(c & 0x80)) break;
            }
            if (used === 0 || i + 1 + used + len > buf.length) continue;
            return buf.subarray(i + 1 + used, i + 1 + used + len);
        }
        return null;
    };

    const dsi = findTag(config, 0, 0x05);
    if (dsi && dsi.length >= 2) asc = dsi;

    if (asc.length < 2) return { objectType: null, sampleRateIndex: null, channels: null };
    return {
        'objectType': asc[0] >> 3,
        'sampleRateIndex': ((asc[0] & 0x07) << 1) | (asc[1] >> 7),
        'channels': (asc[1] >> 3) & 0x0f,
    };
}

/**
 * 流签名的人类可读描述（日志用）
 * 例：`avc1 1920x1080 / mp4a 48kHz 2ch`
 */
export function describeSignature(signature: StreamSignature): string {
    const parts: string[] = [];
    const video = signature.video;
    if (video && (video.width || video.codec)) {
        parts.push(`${video.codec || '?'} ${video.width ?? 0}x${video.height ?? 0}`);
    }
    const audio = signature.audio?.audio;
    if (audio) {
        const rate = audio.timescale ? `${Math.round(audio.timescale / 1000)}kHz` : '?';
        const ch = audio.channels ?? '?';
        parts.push(`${audio.codec || '?'} ${rate} ${ch}ch`);
    }
    return parts.length ? parts.join(' / ') : signature.key;
}

/**
 * 解析分片的流签名
 *
 * 每个分片自带完整 moov，因此零额外 I/O。任何解析失败都返回 null，
 * 调用方按"签名未知"处理（跟现有分辨率逻辑一致，不做负向判定）。
 */
export function parseStreamSignature(buf: Buffer): StreamSignature | null {
    try {
        let moov: BoxRef | null = null;
        for (let off = 0; off + 8 <= buf.length;) {
            const box = readBox(buf, off, buf.length);
            if (!box) break;
            if (box.type === 'moov') { moov = box; break; }
            off += box.size;
        }
        if (!moov) return null;

        let video: StreamTrackSignature | null = null;
        let audio: StreamTrackSignature | null = null;

        const moovEnd = moov.offset + moov.size;
        for (let off = moov.offset + moov.headerSize; off + 8 <= moovEnd;) {
            const trak = readBox(buf, off, moovEnd);
            if (!trak) break;
            off += trak.size;
            if (trak.type !== 'trak') continue;

            const tkhd = findChild(buf, trak, 'tkhd');
            if (!tkhd || tkhd.size < tkhd.headerSize + 8) continue;
            const tkhdVersion = buf[tkhd.offset + tkhd.headerSize];
            const trackIdOffset = tkhd.offset + tkhd.headerSize + (tkhdVersion === 1 ? 20 : 12);
            const trackId = trackIdOffset + 4 <= tkhd.offset + tkhd.size ? buf.readUInt32BE(trackIdOffset) : -1;

            const mdia = findChild(buf, trak, 'mdia');
            if (!mdia) continue;

            const hdlr = findChild(buf, mdia, 'hdlr');
            const handler = hdlr && hdlr.size >= hdlr.headerSize + 12
                ? buf.toString('ascii', hdlr.offset + hdlr.headerSize + 8, hdlr.offset + hdlr.headerSize + 12)
                : '';

            const mdhd = findChild(buf, mdia, 'mdhd');
            let timescale = 0;
            if (mdhd && mdhd.size >= mdhd.headerSize + 20) {
                const mdhdVersion = buf[mdhd.offset + mdhd.headerSize];
                const tsOffset = mdhd.offset + mdhd.headerSize + (mdhdVersion === 1 ? 20 : 12);
                if (tsOffset + 4 <= mdhd.offset + mdhd.size) timescale = buf.readUInt32BE(tsOffset);
            }

            const minf = findChild(buf, mdia, 'minf');
            const stbl = minf ? findChild(buf, minf, 'stbl') : null;
            const stsd = stbl ? findChild(buf, stbl, 'stsd') : null;
            const entry = stsd ? parseSampleEntry(buf, stsd) : null;

            if (handler === 'vide' && !video) {
                let width = 0;
                let height = 0;
                const boxEnd = tkhd.offset + tkhd.size;
                width = buf.readUInt32BE(boxEnd - 8) / 65536;
                height = buf.readUInt32BE(boxEnd - 4) / 65536;
                const matrixStart = tkhd.offset + tkhd.headerSize + (tkhdVersion === 1 ? 52 : 40);
                if (matrixStart + 20 <= boxEnd
                    && buf.readInt32BE(matrixStart) === 0
                    && buf.readInt32BE(matrixStart + 16) === 0) {
                    const t = width; width = height; height = t;
                }
                video = {
                    trackId,
                    handler,
                    timescale,
                    'codec': entry?.codec ?? '',
                    'videoConfigHash': entry?.config ? hashBytes(entry.config) : null,
                    'width': Math.round(width),
                    'height': Math.round(height),
                };
            } else if (handler === 'soun' && !audio) {
                const asc = parseAudioSpecificConfig(entry?.config ?? null);
                audio = {
                    trackId,
                    handler,
                    timescale,
                    'codec': entry?.codec ?? '',
                    'videoConfigHash': entry?.config ? hashBytes(entry.config) : null,
                    'audio': {
                        'codec': entry?.codec ?? '',
                        'timescale': timescale,
                        'objectType': asc.objectType,
                        'channels': asc.channels,
                        'sampleRateIndex': asc.sampleRateIndex,
                        'configHash': entry?.config ? hashBytes(entry.config) : 'none',
                    },
                };
            }
        }

        if (!video && !audio) return null;

        const videoKey = video
            ? `v:${video.codec || '?'}-${video.width ?? 0}x${video.height ?? 0}-${video.videoConfigHash ?? 'none'}`
            : 'v:none';
        const audioKey = audio
            ? `a:${audio.audio?.codec || '?'}-${audio.audio?.objectType ?? '?'}-${audio.timescale || 0}-${audio.audio?.channels ?? '?'}-${audio.audio?.configHash ?? 'none'}`
            : 'a:none';

        return { 'key': `${videoKey}|${audioKey}`, video, audio };
    } catch {
        return null;
    }
}

