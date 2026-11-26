// tfdt（Track Fragment Decode Time）平移
//
// 背景：上游切片器在直播中途把时间轴从头重启过一次（音视频同时回退、幅度一致），
// 而合并文件只是按下载顺序追加字节。不纠正的话，新一段内容的 tfdt 又从小值开始，
// 播放器 / ffmpeg 只能强行钳位，整段内容被压进同一时刻 —— 表现为「录像突然快进或卡住」。
//
// 做法：给每条轨道算一个平移量，把该分片内所有 moof→traf→tfdt 加上它，
// 使新一段紧接在上一次的结束时刻继续。段内相对时间不变，画面内容一帧不动。
//
// 只处理 tfdt：
// - 本项目的分片里没有 sidx（实测 B 站 fMP4 分片为 ftyp+moov+moof+mdat）
// - trun 的样本时长是相对量，不需要改
import { parseBoxes, parseTrun, readBoxHeader } from './partDataFix/mp4FragmentParser.js';
import type { Mp4BoxTop } from '../model/mp4.js';
import type { SegmentTrackTimeline } from '../model/mp4.js';

/** traf 下的全部 trun */
function parseTruns(buf: Buffer, traf: Mp4BoxTop, trafEnd: number) {
    return parseBoxes(buf, traf.offset + traf.headerSize, trafEnd)
        .filter(box => box.type === 'trun')
        .map(box => parseTrun(buf, box));
}

/** 单条 tfdt 的实际位置与当前值（供调试与测试） */
export interface TfdtEntryLocated {
    trackId: number;
    value: number;
    /** tfdt 数值字段在 buffer 中的偏移 */
    valueOffset: number;
    /** 数值宽度：4（version 0）或 8（version 1） */
    valueSize: 4 | 8;
}

/**
 * 定位分片里所有 tfdt 及其所属轨道
 *
 * 解析失败（box 结构异常、缺少 tfhd）时跳过该 traf，绝不猜测。
 */
export function locateTfdtEntries(buf: Buffer): TfdtEntryLocated[] {
    const entries: TfdtEntryLocated[] = [];

    for (let offset = 0; offset + 8 <= buf.length;) {
        const top = readBoxHeader(buf, offset);
        if (!top) break;
        offset += top.size;
        if (top.type !== 'moof') continue;

        const moofEnd = top.offset + top.size;
        for (let t = top.offset + top.headerSize; t + 8 <= moofEnd;) {
            const traf = readBoxHeader(buf, t, moofEnd);
            if (!traf) break;
            t += traf.size;
            if (traf.type !== 'traf') continue;

            const trafEnd = traf.offset + traf.size;
            let trackId: number | null = null;
            let tfdt: { offset: number; size: number; headerSize: number } | null = null;

            for (let c = traf.offset + traf.headerSize; c + 8 <= trafEnd;) {
                const box = readBoxHeader(buf, c, trafEnd);
                if (!box) break;
                c += box.size;
                if (box.type === 'tfhd' && box.size >= 16) {
                    trackId = buf.readUInt32BE(box.offset + 12);
                } else if (box.type === 'tfdt' && box.size >= 16) {
                    tfdt = box;
                }
            }

            if (trackId === null || !tfdt) continue;

            const version = buf[tfdt.offset + 8];
            const valueOffset = tfdt.offset + 12;
            if (version === 0) {
                if (valueOffset + 4 > tfdt.offset + tfdt.size) continue;
                entries.push({ trackId, 'value': buf.readUInt32BE(valueOffset), valueOffset, 'valueSize': 4 });
            } else if (version === 1) {
                if (valueOffset + 8 > tfdt.offset + tfdt.size) continue;
                entries.push({
                    trackId,
                    'value': Number(buf.readBigUInt64BE(valueOffset)),
                    valueOffset,
                    'valueSize': 8,
                });
            }
        }
    }

    return entries;
}

/**
 * 按轨道平移 tfdt
 *
 * @param buf     分片原始字节（不会被修改）
 * @param offsets trackId → 平移量（timescale 单位）
 * @returns 有改动时返回新 Buffer，无改动时返回原 buffer（调用方可用 === 判断）
 */
export function applyTfdtOffsets(buf: Buffer, offsets: Map<number, number> | undefined): Buffer {
    if (!offsets || offsets.size === 0) return buf;

    const entries = locateTfdtEntries(buf);
    if (!entries.length) return buf;

    let out: Buffer | null = null;
    for (const entry of entries) {
        const delta = offsets.get(entry.trackId);
        if (!delta) continue;

        const next = entry.value + delta;
        if (!Number.isFinite(next) || next < 0) continue;

        if (!out) out = Buffer.from(buf);
        if (entry.valueSize === 4) {
            if (next > 0xffffffff) continue;
            out.writeUInt32BE(next, entry.valueOffset);
        } else {
            out.writeBigUInt64BE(BigInt(Math.trunc(next)), entry.valueOffset);
        }
    }

    return out ?? buf;
}

/**
 * 从合并文件尾部解析最后一段媒体的时间轴
 *
 * 用于重启续录时恢复连续性基线：合并文件里最后一个 moof 的 tfdt 就是
 * 「上一分片结束在哪」，没有它就得等第二个新分片才能发现回退。
 *
 * @param tail 文件尾部若干 MB（必须包含完整的最后一个 moof）
 * @param trackDurations trackId → 该轨 timescale（来自 init 的 moov）
 */
export function parseTailTimeline(
    tail: Buffer,
    trackInfo: Map<number, { timescale: number; handler: string }>,
): { tracks: SegmentTrackTimeline[] } | null {
    // 从后往前找最后一个能自洽的 moof（size 字段 + 边界都合法）
    let moofStart = -1;
    for (let i = tail.length - 8; i >= 4; i--) {
        if (tail[i] !== 0x6d || tail[i + 1] !== 0x6f || tail[i + 2] !== 0x6f || tail[i + 3] !== 0x66) continue;
        const boxStart = i - 4;
        if (boxStart < 0) continue;
        const box = readBoxHeader(tail, boxStart, tail.length);
        if (box && box.type === 'moof') { moofStart = boxStart; break; }
    }
    if (moofStart < 0) return null;

    const moof = readBoxHeader(tail, moofStart, tail.length);
    if (!moof) return null;

    const tracks: SegmentTrackTimeline[] = [];
    const moofEnd = moof.offset + moof.size;
    for (let t = moof.offset + moof.headerSize; t + 8 <= moofEnd;) {
        const traf = readBoxHeader(tail, t, moofEnd);
        if (!traf) break;
        t += traf.size;
        if (traf.type !== 'traf') continue;

        const trafEnd = traf.offset + traf.size;
        let trackId: number | null = null;
        let tfdt: { offset: number; size: number; headerSize: number } | null = null;

        for (let c = traf.offset + traf.headerSize; c + 8 <= trafEnd;) {
            const box = readBoxHeader(tail, c, trafEnd);
            if (!box) break;
            c += box.size;
            if (box.type === 'tfhd' && box.size >= 16) trackId = tail.readUInt32BE(box.offset + 12);
            else if (box.type === 'tfdt' && box.size >= 16) tfdt = box;
        }
        if (trackId === null || !tfdt) continue;

        const info = trackInfo.get(trackId);
        if (!info) continue;

        // 末 fragment 的样本时长：基线要用它把「末帧起始时刻」换成「结束时刻」，
        // 否则续录时下一个分片的首帧会被误判成回退了整整一个 fragment
        let lastFragmentDuration = 0;
        for (const trun of parseTruns(tail, traf, trafEnd)) {
            if (trun.truncated || !trun.sizeConsistent) { lastFragmentDuration = 0; break; }
            if (trun.sampleDurationsKnown) lastFragmentDuration += trun.sampleDurationSum;
            else lastFragmentDuration = 0;
        }

        const version = tail[tfdt.offset + 8];
        const valueOffset = tfdt.offset + 12;
        let tdftValue: number;
        if (version === 0) {
            if (valueOffset + 4 > tfdt.offset + tfdt.size) continue;
            tdftValue = tail.readUInt32BE(valueOffset);
        } else if (version === 1) {
            if (valueOffset + 8 > tfdt.offset + tfdt.size) continue;
            tdftValue = Number(tail.readBigUInt64BE(valueOffset));
        } else {
            continue;
        }

        tracks.push({
            trackId,
            'handler': info.handler,
            'timescale': info.timescale,
            'firstTfdt': tdftValue,
            'lastTfdt': tdftValue,
            'lastFragmentDuration': lastFragmentDuration,
        });
    }

    return tracks.length ? { tracks } : null;
}

/**
 * 计算把 cur 接在 prev 之后所需的每轨平移量
 *
 * 只有「当前分片第一帧早于上一分片最后一帧」时才平移（时间轴回退）；
 * 正常前进或轻微抖动（容差内）返回空 Map。缺口不回填 —— 那是真实丢失的内容，
 * 用空缺如实地反映出来比伪造连续更好。
 *
 * @param prevFirstEnd 上一分片每轨的结束时刻（trackId → tfdt 末值 + 末 fragment 时长）
 * @param curFirst     当前分片每轨的起始 tfdt
 * @param toleranceSec 容差（秒）
 */
export function computeTfdtOffsets(
    prevFirstEnd: Map<number, { end: number; timescale: number }>,
    curFirst: Map<number, { first: number; timescale: number }>,
    toleranceSec = 1,
): Map<number, number> {
    const offsets = new Map<number, number>();
    for (const [trackId, cur] of curFirst) {
        const prev = prevFirstEnd.get(trackId);
        if (!prev) continue;
        if (prev.timescale <= 0 || cur.timescale <= 0) continue;
        const tolerance = toleranceSec * prev.timescale;
        if (cur.first >= prev.end - tolerance) continue;
        const delta = prev.end - cur.first;
        if (Number.isFinite(delta) && delta > 0) offsets.set(trackId, delta);
    }
    return offsets;
}
