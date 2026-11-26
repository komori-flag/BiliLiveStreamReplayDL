// 跨分片时间轴：解析单分片摘要 + 比较相邻分片的连续性
//
// 纯函数，不做 I/O。调用方（HLSDownloader）负责持有"上一分片"的状态。
//
// 校验值：
// - 每条轨道的 tfdt（first/last）与最后 fragment 的样本总时长
// - mfhd.sequence_number（first/last）
//
// 时间类判定留容差：实测 B 站音频轨的 tfdt 增量偶尔比 count×default_duration
// 多 16/48000 秒（编码器/切片器的时间戳对齐），严格相等会误报。

import { parseMoof, parseTopLevelBoxes, parseTrackInfo } from './partDataFix/mp4FragmentParser.js';
import { trafDuration } from './partDataFix/detectMoofMdatFragments.js';
import type { ContinuityIssue, SegmentTimeline, SegmentTrackTimeline } from '../model/mp4.js';

/** 允许的时间轴抖动（秒）。分片时长通常 4s，1s 容差不会漏掉真正的缺片 */
const DEFAULT_TOLERANCE_SEC = 1;

/** 解析一个分片的时间轴摘要；没有 moov/moof 或解析不出轨道时返回 null */
export function parseSegmentTimeline(buf: Buffer): SegmentTimeline | null {
    const trackInfos = parseTrackInfo(buf);
    if (!trackInfos.length) return null;

    const moofs = parseTopLevelBoxes(buf)
        .filter(box => box.type === 'moof')
        .map(box => parseMoof(buf, box));
    if (!moofs.length) return null;

    const tracks: SegmentTrackTimeline[] = [];
    for (const info of trackInfos) {
        let firstTfdt: number | undefined;
        let lastTfdt: number | undefined;
        let lastFragmentDuration = 0;

        for (const moof of moofs) {
            for (const traf of moof.trafs) {
                if (traf.trackId !== info.trackId || traf.tfdt === undefined) continue;
                if (firstTfdt === undefined) firstTfdt = traf.tfdt;
                lastTfdt = traf.tfdt;
                lastFragmentDuration = trafDuration(traf, info) ?? 0;
            }
        }

        if (firstTfdt !== undefined && lastTfdt !== undefined) {
            tracks.push({
                trackId: info.trackId,
                handler: info.handler,
                timescale: info.timescale,
                firstTfdt,
                lastTfdt,
                lastFragmentDuration,
            });
        }
    }

    if (!tracks.length) return null;

    const sequences: number[] = [];
    for (const moof of moofs) {
        if (moof.sequenceNumber !== undefined) sequences.push(moof.sequenceNumber);
    }

    return {
        tracks,
        firstSequence: sequences.length ? sequences[0] : undefined,
        lastSequence: sequences.length ? sequences[sequences.length - 1] : undefined,
    };
}

function trackLabel(track: SegmentTrackTimeline): string {
    if (track.handler === 'vide') return `视频轨(track ${track.trackId})`;
    if (track.handler === 'soun') return `音频轨(track ${track.trackId})`;
    return `track ${track.trackId}`;
}

/**
 * 比较相邻两个分片的时间轴
 *
 * @param prev     上一分片摘要
 * @param cur      当前分片摘要
 * @param toleranceSec 允许的抖动（秒）
 */
export function diffSegmentTimeline(
    prev: SegmentTimeline,
    cur: SegmentTimeline,
    toleranceSec: number = DEFAULT_TOLERANCE_SEC,
): ContinuityIssue[] {
    const issues: ContinuityIssue[] = [];
    const prevById = new Map(prev.tracks.map(track => [track.trackId, track]));
    const curById = new Map(cur.tracks.map(track => [track.trackId, track]));

    const prevIds = [...prevById.keys()].sort((a, b) => a - b);
    const curIds = [...curById.keys()].sort((a, b) => a - b);
    if (prevIds.join(',') !== curIds.join(',')) {
        issues.push({
            kind: 'track_set_changed',
            detail: `轨道集合变化：[${prevIds.join(',')}] -> [${curIds.join(',')}]`,
        });
    }

    for (const prevTrack of prev.tracks) {
        const curTrack = curById.get(prevTrack.trackId);
        if (!curTrack) continue;

        if (prevTrack.timescale <= 0 || curTrack.timescale <= 0) continue;
        if (prevTrack.timescale !== curTrack.timescale) {
            issues.push({
                kind: 'timescale_changed',
                detail: `${trackLabel(prevTrack)} timescale ${prevTrack.timescale} -> ${curTrack.timescale}`,
            });
            continue;
        }

        const tolerance = toleranceSec * prevTrack.timescale;
        if (curTrack.firstTfdt < prevTrack.lastTfdt - tolerance) {
            issues.push({
                kind: 'tfdt_rewind',
                detail: `${trackLabel(prevTrack)} 时间轴回退 ${((curTrack.firstTfdt - prevTrack.lastTfdt) / prevTrack.timescale).toFixed(3)}s`,
            });
            continue;
        }

        // 上一分片最后一个 fragment 的时长为 0 时无法算期望值，只保留回退检查
        if (prevTrack.lastFragmentDuration > 0) {
            const expected = prevTrack.lastTfdt + prevTrack.lastFragmentDuration;
            const gapSec = (curTrack.firstTfdt - expected) / prevTrack.timescale;
            if (gapSec > toleranceSec) {
                issues.push({
                    kind: 'tfdt_gap',
                    detail: `${trackLabel(prevTrack)} 中间缺口约 ${gapSec.toFixed(2)}s`,
                });
            }
        }
    }

    if (
        prev.lastSequence !== undefined &&
        cur.firstSequence !== undefined &&
        cur.firstSequence !== prev.lastSequence + 1
    ) {
        issues.push({
            kind: 'sequence_gap',
            detail: `mfhd 序号不连续：${prev.lastSequence} -> ${cur.firstSequence}`,
        });
    }

    return issues;
}
