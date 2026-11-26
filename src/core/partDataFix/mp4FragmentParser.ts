// fMP4 片段结构解析：纯函数，供分片校验 / 时间轴连续性检查复用
//
// 只解析校验需要的字段。遇到越界、截断或 flags 与实际长度不符时，
// 一律记录到 parseError / truncated 上，不做任何"猜测性"修复。

import type {
    Mp4BoxTop,
    Mp4MoofInfo,
    Mp4TrafInfo,
    Mp4TrackDefaults,
    Mp4TrackInfo,
    Mp4TrunInfo,
} from '../../model/mp4.js';

/** 读取 box 头；size/边界不合法返回 null（size=0 按"延伸到 end"处理） */
export function readBoxHeader(buf: Buffer, offset: number, end: number = buf.length): Mp4BoxTop | null {
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
        size = end - offset;
    }
    if (size < headerSize || offset + size > end) return null;
    return { offset, size, type, headerSize };
}

/** 解析 [start, end) 内连续的 box；遇到非法头停止，返回已解析部分 */
export function parseBoxes(buf: Buffer, start: number, end: number): Mp4BoxTop[] {
    const boxes: Mp4BoxTop[] = [];
    for (let offset = start; offset + 8 <= end;) {
        const box = readBoxHeader(buf, offset, end);
        if (!box) break;
        boxes.push(box);
        offset += box.size;
    }
    return boxes;
}

/** 解析顶层 box 列表 */
export function parseTopLevelBoxes(buf: Buffer): Mp4BoxTop[] {
    return parseBoxes(buf, 0, buf.length);
}

/** 解析一个 moov 下的直接子 box */
function moovChildren(buf: Buffer, moov: Mp4BoxTop): Mp4BoxTop[] {
    return parseBoxes(buf, moov.offset + moov.headerSize, moov.offset + moov.size);
}

/**
 * 解析 trun
 *
 * 除样本大小/时长总和外，还计算 tableBytes = 16 + 可选字段 + sample_count × 每样本字段，
 * 并与 box 实际 size 比对：不一致说明 flags / sample_count / 样本表损坏。
 */
export function parseTrun(buf: Buffer, box: Mp4BoxTop): Mp4TrunInfo {
    const info: Mp4TrunInfo = {
        offset: box.offset,
        size: box.size,
        flags: 0,
        sampleCount: 0,
        sampleSizesKnown: false,
        sampleSizeSum: 0,
        sampleDurationsKnown: false,
        sampleDurationSum: 0,
        tableBytes: 0,
        sizeConsistent: false,
        truncated: false,
    };

    // box 头 8 + version/flags 4 + sample_count 4
    if (box.size < 16) {
        info.tableBytes = 16;
        info.truncated = true;
        return info;
    }

    const end = box.offset + box.size;
    info.flags = buf.readUIntBE(box.offset + 9, 3);
    info.sampleCount = buf.readUInt32BE(box.offset + 12);

    let cursor = box.offset + 16;
    let optionalBytes = 0;

    const DATA_OFFSET = 0x000001;
    const FIRST_SAMPLE_FLAGS = 0x000004;
    const SAMPLE_DURATION = 0x000100;
    const SAMPLE_SIZE = 0x000200;
    const SAMPLE_FLAGS = 0x000400;
    const SAMPLE_CTO = 0x000800;

    if (info.flags & DATA_OFFSET) {
        if (cursor + 4 > end) {
            info.truncated = true;
        } else {
            info.dataOffset = buf.readInt32BE(cursor);
            cursor += 4;
            optionalBytes += 4;
        }
    }
    if (!info.truncated && (info.flags & FIRST_SAMPLE_FLAGS)) {
        if (cursor + 4 > end) {
            info.truncated = true;
        } else {
            info.firstSampleFlags = buf.readUInt32BE(cursor);
            cursor += 4;
            optionalBytes += 4;
        }
    }

    const perSampleBytes =
        ((info.flags & SAMPLE_DURATION) ? 4 : 0) +
        ((info.flags & SAMPLE_SIZE) ? 4 : 0) +
        ((info.flags & SAMPLE_FLAGS) ? 4 : 0) +
        ((info.flags & SAMPLE_CTO) ? 4 : 0);

    info.tableBytes = 16 + optionalBytes + info.sampleCount * perSampleBytes;
    info.sizeConsistent = info.tableBytes === box.size;
    if (info.tableBytes > box.size) info.truncated = true;

    info.sampleSizesKnown = (info.flags & SAMPLE_SIZE) !== 0;
    info.sampleDurationsKnown = (info.flags & SAMPLE_DURATION) !== 0;
    if (perSampleBytes === 0) return info;

    // sample_count 可能是坏值：按 box 剩余长度限制实际读取的样本数
    const maxSamples = Math.floor((end - cursor) / perSampleBytes);
    const count = Math.min(info.sampleCount, Math.max(0, maxSamples));
    let sizeSum = 0;
    let durationSum = 0;
    for (let i = 0; i < count; i++) {
        if (info.flags & SAMPLE_DURATION) {
            durationSum += buf.readUInt32BE(cursor);
            cursor += 4;
        }
        if (info.flags & SAMPLE_SIZE) {
            sizeSum += buf.readUInt32BE(cursor);
            cursor += 4;
        }
        if (info.flags & SAMPLE_FLAGS) {
            const flags = buf.readUInt32BE(cursor);
            cursor += 4;
            if (i === 0 && info.firstSampleFlags === undefined) info.firstSampleFlags = flags;
        }
        if (info.flags & SAMPLE_CTO) cursor += 4;
    }
    if (count < info.sampleCount) info.truncated = true;

    if (info.sampleSizesKnown) info.sampleSizeSum = sizeSum;
    if (info.sampleDurationsKnown) info.sampleDurationSum = durationSum;
    return info;
}

/** 解析 traf（tfhd + tfdt + 全部 trun） */
export function parseTraf(buf: Buffer, traf: Mp4BoxTop): Mp4TrafInfo {
    const children = parseBoxes(buf, traf.offset + traf.headerSize, traf.offset + traf.size);
    const info: Mp4TrafInfo = {
        offset: traf.offset,
        size: traf.size,
        trackId: 0,
        tfhdFlags: 0,
        truns: [],
    };

    const tfhd = children.find(b => b.type === 'tfhd');
    if (!tfhd) {
        info.parseError = 'missing tfhd';
    } else if (tfhd.size < 16) {
        info.parseError = 'tfhd too small (track_ID missing)';
    } else {
        const end = tfhd.offset + tfhd.size;
        info.tfhdFlags = buf.readUIntBE(tfhd.offset + 9, 3);
        info.trackId = buf.readUInt32BE(tfhd.offset + 12);

        let cursor = tfhd.offset + 16;
        let ok = true;

        // 字段顺序固定：base_data_offset(8) → sample_description_index(4)
        // → default_sample_duration(4) → default_sample_size(4) → default_sample_flags(4)
        if (info.tfhdFlags & 0x000001) {
            if (cursor + 8 > end) {
                ok = false;
            } else {
                info.baseDataOffset = Number(buf.readBigUInt64BE(cursor));
                cursor += 8;
            }
        }
        if (ok && (info.tfhdFlags & 0x000002)) {
            if (cursor + 4 > end) ok = false;
            else cursor += 4; // sample_description_index，校验用不到
        }
        if (ok && (info.tfhdFlags & 0x000008)) {
            if (cursor + 4 > end) ok = false;
            else {
                info.defaultSampleDuration = buf.readUInt32BE(cursor);
                cursor += 4;
            }
        }
        if (ok && (info.tfhdFlags & 0x000010)) {
            if (cursor + 4 > end) ok = false;
            else {
                info.defaultSampleSize = buf.readUInt32BE(cursor);
                cursor += 4;
            }
        }
        if (ok && (info.tfhdFlags & 0x000020)) {
            if (cursor + 4 > end) ok = false;
            else {
                info.defaultSampleFlags = buf.readUInt32BE(cursor);
                cursor += 4;
            }
        }
        if (!ok) info.parseError = 'tfhd optional fields truncated';
    }

    const tfdt = children.find(b => b.type === 'tfdt');
    if (tfdt && tfdt.size >= 16) {
        const version = buf[tfdt.offset + 8];
        if (version === 1) {
            if (tfdt.size >= 20) info.tfdt = Number(buf.readBigUInt64BE(tfdt.offset + 12));
        } else {
            info.tfdt = buf.readUInt32BE(tfdt.offset + 12);
        }
    }

    info.truns = children.filter(b => b.type === 'trun').map(b => parseTrun(buf, b));
    if (!info.truns.length && !info.parseError) info.parseError = 'missing trun';
    return info;
}

/** 解析 moof（mfhd + 全部 traf） */
export function parseMoof(buf: Buffer, moof: Mp4BoxTop): Mp4MoofInfo {
    const children = parseBoxes(buf, moof.offset + moof.headerSize, moof.offset + moof.size);
    const info: Mp4MoofInfo = {
        offset: moof.offset,
        size: moof.size,
        trafs: [],
    };

    const mfhd = children.find(b => b.type === 'mfhd');
    if (mfhd && mfhd.size >= 16) info.sequenceNumber = buf.readUInt32BE(mfhd.offset + 12);

    info.trafs = children.filter(b => b.type === 'traf').map(b => parseTraf(buf, b));
    return info;
}

/**
 * 解析 moov 中的轨道信息：track_ID、handler、timescale、trex 默认值
 *
 * 解析失败的 trak 直接跳过（调用方拿不到该轨道信息时按"未知"处理，不做负向判定）。
 */
export function parseTrackInfo(buf: Buffer): Mp4TrackInfo[] {
    const top = parseTopLevelBoxes(buf);
    const moov = top.find(b => b.type === 'moov');
    if (!moov) return [];

    const children = moovChildren(buf, moov);

    const trexByTrack = new Map<number, Mp4TrackDefaults>();
    const mvex = children.find(b => b.type === 'mvex');
    if (mvex) {
        for (const trex of parseBoxes(buf, mvex.offset + mvex.headerSize, mvex.offset + mvex.size)) {
            if (trex.type !== 'trex' || trex.size < 32) continue;
            const trackId = buf.readUInt32BE(trex.offset + 12);
            trexByTrack.set(trackId, {
                defaultSampleDuration: buf.readUInt32BE(trex.offset + 20),
                defaultSampleSize: buf.readUInt32BE(trex.offset + 24),
                defaultSampleFlags: buf.readUInt32BE(trex.offset + 28),
            });
        }
    }

    const tracks: Mp4TrackInfo[] = [];
    for (const trak of children) {
        if (trak.type !== 'trak') continue;
        const trakChildren = parseBoxes(buf, trak.offset + trak.headerSize, trak.offset + trak.size);

        const tkhd = trakChildren.find(b => b.type === 'tkhd');
        if (!tkhd || tkhd.size < 24) continue;
        const tkhdVersion = buf[tkhd.offset + 8];
        const trackIdOffset = tkhdVersion === 1 ? 28 : 20;
        if (tkhd.offset + trackIdOffset + 4 > tkhd.offset + tkhd.size) continue;
        const trackId = buf.readUInt32BE(tkhd.offset + trackIdOffset);

        let timescale = 0;
        let handler = '';
        const mdia = trakChildren.find(b => b.type === 'mdia');
        if (mdia) {
            const mdiaChildren = parseBoxes(buf, mdia.offset + mdia.headerSize, mdia.offset + mdia.size);

            const mdhd = mdiaChildren.find(b => b.type === 'mdhd');
            if (mdhd && mdhd.size >= 24) {
                const mdhdVersion = buf[mdhd.offset + 8];
                const timescaleOffset = mdhdVersion === 1 ? 28 : 20;
                if (mdhd.offset + timescaleOffset + 4 <= mdhd.offset + mdhd.size)
                    timescale = buf.readUInt32BE(mdhd.offset + timescaleOffset);
            }

            // hdlr: box 头 8 + version/flags 4 + pre_defined 4 → handler_type
            const hdlr = mdiaChildren.find(b => b.type === 'hdlr');
            if (hdlr && hdlr.size >= 20)
                handler = buf.toString('ascii', hdlr.offset + 16, hdlr.offset + 20);
        }

        tracks.push({ trackId, handler, timescale, trex: trexByTrack.get(trackId) });
    }

    return tracks;
}
