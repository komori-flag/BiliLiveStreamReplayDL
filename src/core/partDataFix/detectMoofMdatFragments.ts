// moof/mdat 片段校验
//
// 校验项（均针对每个 moof 的【全部 traf】，而不只是第一个）：
// - tfhd / tfdt / trun 结构完整，trun 表长与 box 尺寸自洽
// - 每个 trun 的 data_offset 落点、样本大小总和
// - 所有 traf 的样本区间必须无缝铺满 mdat payload（含首尾）
// - 首个视频 moof 的首样本是否为同步样本（仅告警，不判坏片）
//
// 说明：B 站分片的每个 moof 同时带音频、视频两个 traf；只看 trafs[0]
// 等于只校验音频轨，视频轨（占分片 98% 字节）完全漏检。

import { parseMoof, parseTopLevelBoxes, parseTrackInfo } from './mp4FragmentParser.js';
import type { Mp4BoxTop, Mp4Fragment, Mp4FragmentMoof, Mp4TrafInfo, Mp4TrackInfo } from '../../model/mp4.js';

interface SampleSizeInfo {
    /** 每个 trun 的样本字节数；null = 缺少可用的 size 来源 */
    perTrun: Array<number | null>;
    /** 整个 traf 的样本字节数；null = 至少一个 trun 无法解析 */
    total: number | null;
}

/** 解析一个 traf 的样本大小（trun 样本表 → tfhd 默认值 → trex 默认值） */
function sampleSizeOfTraf(traf: Mp4TrafInfo, track: Mp4TrackInfo | undefined): SampleSizeInfo {
    const perTrun: Array<number | null> = [];
    let total: number | null = 0;

    for (const trun of traf.truns) {
        if (trun.truncated || !trun.sizeConsistent) {
            perTrun.push(null);
            total = null;
            continue;
        }
        if (trun.sampleSizesKnown) {
            perTrun.push(trun.sampleSizeSum);
            if (total !== null) total += trun.sampleSizeSum;
            continue;
        }
        const fallback = traf.defaultSampleSize ?? track?.trex?.defaultSampleSize;
        if (fallback !== undefined && fallback > 0) {
            const size = trun.sampleCount * fallback;
            perTrun.push(size);
            if (total !== null) total += size;
        } else {
            perTrun.push(null);
            total = null;
        }
    }

    return { perTrun, total };
}

/** 解析一个 traf 的样本总时长（timescale 单位）；无法解析返回 null */
export function trafDuration(traf: Mp4TrafInfo, track: Mp4TrackInfo | undefined): number | null {
    let total = 0;
    for (const trun of traf.truns) {
        if (trun.truncated || !trun.sizeConsistent) return null;
        if (trun.sampleDurationsKnown) {
            total += trun.sampleDurationSum;
            continue;
        }
        const fallback = traf.defaultSampleDuration ?? track?.trex?.defaultSampleDuration;
        if (fallback === undefined || fallback === 0) return null;
        total += trun.sampleCount * fallback;
    }
    return total;
}

/**
 * 主函数：检测 moof/mdat 片段的完整性
 * 返回每个 fragment 的检测结果数组
 */
function detectMoofMdatFragments(buf: Buffer): Mp4Fragment[] {
    const top = parseTopLevelBoxes(buf);
    const tracks = new Map(parseTrackInfo(buf).map(t => [t.trackId, t]));
    const videoTrackIds = new Set(
        [...tracks.values()].filter(t => t.handler === 'vide').map(t => t.trackId)
    );
    const fragments: Mp4Fragment[] = [];
    let firstVideoChecked = false;

    for (let i = 0, fragIndex = 0; i < top.length; i++) {
        const moofBox = top[i];
        if (moofBox.type !== 'moof') continue;

        const fragMoof: Mp4FragmentMoof = { offset: moofBox.offset, size: moofBox.size, ok: true };
        const frag: Mp4Fragment = {
            index: fragIndex++,
            moof: fragMoof,
            status: 'unknown',
            warnings: [],
        };
        const warnings = frag.warnings!;
        const moof = parseMoof(buf, moofBox);
        const sizeInfos = moof.trafs.map(traf => sampleSizeOfTraf(traf, tracks.get(traf.trackId)));

        // 兼容字段：跨 traf 汇总
        let sampleCount = 0;
        let declaredBytes = 0;
        let declaredBytesKnown = true;
        let defaultSampleSize: number | undefined;
        moof.trafs.forEach((traf, index) => {
            for (const trun of traf.truns) sampleCount += trun.sampleCount;
            const info = sizeInfos[index];
            if (info.total === null) declaredBytesKnown = false;
            else declaredBytes += info.total;
            if (defaultSampleSize === undefined)
                defaultSampleSize = traf.defaultSampleSize ?? tracks.get(traf.trackId)?.trex?.defaultSampleSize;
        });
        fragMoof.containsMfhd = moof.sequenceNumber !== undefined;
        fragMoof.trafCount = moof.trafs.length;
        fragMoof.trunSampleCount = sampleCount;
        fragMoof.trunDeclaredBytes = declaredBytesKnown ? declaredBytes : undefined;
        fragMoof.defaultSampleSize = defaultSampleSize;

        if (!moof.trafs.length) {
            fragMoof.ok = false;
            fragMoof.reason = 'moof has no traf';
            fragments.push(frag);
            continue;
        }

        // 找紧随其后的 mdat（遇到下一个 moof 即停止）
        let mdatBox: Mp4BoxTop | undefined;
        for (let j = i + 1; j < top.length; j++) {
            if (top[j].type === 'mdat') { mdatBox = top[j]; break; }
            if (top[j].type === 'moof') break;
        }
        if (!mdatBox) {
            frag.mdat = { offset: 0, size: 0, ok: false, reason: 'no following mdat for this moof' };
            frag.status = 'missing_mdat';
            fragments.push(frag);
            continue;
        }

        const mdatPayloadStart = mdatBox.offset + mdatBox.headerSize;
        const mdatEnd = mdatBox.offset + mdatBox.size;
        frag.mdat = {
            offset: mdatBox.offset,
            size: mdatBox.size,
            ok: true,
            payloadBytes: mdatEnd - mdatPayloadStart,
        };

        // 收集所有 traf 的样本数据区间
        const regions: Array<{ start: number; end: number; trackId: number }> = [];
        let coverageKnown = true;
        let structuralError: string | undefined;
        let prevTrafEnd: number | undefined;

        for (let ti = 0; ti < moof.trafs.length; ti++) {
            const traf = moof.trafs[ti];
            if (traf.parseError) {
                structuralError ??= `traf#${ti} track=${traf.trackId}: ${traf.parseError}`;
                coverageKnown = false;
                continue;
            }
            for (const trun of traf.truns) {
                if (trun.truncated || !trun.sizeConsistent) {
                    structuralError ??=
                        `traf#${ti} track=${traf.trackId}: trun@${trun.offset} 表长与 box 尺寸不一致` +
                        `（按 flags 计算 ${trun.tableBytes}，实际 ${trun.size}）`;
                }
            }

            const sizes = sizeInfos[ti];
            if (sizes.total === null) coverageKnown = false;

            // base data offset 优先级：显式 base_data_offset > default-base-is-moof > 上一个 traf 的数据末尾
            const base = traf.baseDataOffset !== undefined
                ? traf.baseDataOffset
                : (traf.tfhdFlags & 0x020000) ? moofBox.offset : (prevTrafEnd ?? moofBox.offset);

            let runStart = base;
            let trafEnd: number | undefined;
            for (let t = 0; t < traf.truns.length; t++) {
                const trun = traf.truns[t];
                const size = sizes.perTrun[t];
                const start = trun.dataOffset !== undefined ? base + trun.dataOffset : runStart;
                if (size === null || size === undefined || start < 0) {
                    coverageKnown = false;
                    continue;
                }
                const end = start + size;
                regions.push({ start, end, trackId: traf.trackId });
                runStart = end;
                if (trafEnd === undefined || end > trafEnd) trafEnd = end;
            }
            if (trafEnd !== undefined) prevTrafEnd = trafEnd;
        }

        // 首个视频 moof 的首样本应为同步样本（IDR）。只告警，不判坏片：
        // 极少数切片可能在非关键帧处开始，直接判坏会造成反复重下。
        if (!firstVideoChecked) {
            const videoTraf = moof.trafs.find(t => videoTrackIds.has(t.trackId));
            if (videoTraf) {
                firstVideoChecked = true;
                const flags = videoTraf.truns[0]?.firstSampleFlags ?? videoTraf.defaultSampleFlags;
                if (flags === undefined) {
                    warnings.push('无法解析首个视频样本的 sample flags，跳过起始关键帧校验');
                } else {
                    const dependsOn = (flags >>> 24) & 0x3;
                    const nonSync = (flags >>> 16) & 0x1;
                    if (dependsOn !== 2 || nonSync !== 0)
                        warnings.push(`首个视频样本不是同步样本（sample_flags=0x${flags.toString(16)}）`);
                }
            }
        }

        if (structuralError) {
            fragMoof.ok = false;
            fragMoof.reason = structuralError;
            frag.status = 'trun_table_mismatch';
        } else if (!coverageKnown) {
            warnings.push('部分 traf/trun 的样本大小无法解析（缺少 trun 样本表或 tfhd/trex 默认值），跳过 mdat 覆盖校验');
            frag.status = 'ok_warn';
        } else {
            // 精确覆盖：所有样本区间排序后必须从 mdat payload 起点无缝铺到终点
            const sorted = regions.slice().sort((a, b) => a.start - b.start);
            let cursor = mdatPayloadStart;
            let coverageError: string | undefined;
            for (const region of sorted) {
                if (region.start < cursor) {
                    coverageError = `样本区间重叠或越界：track=${region.trackId} start=${region.start} < 期望 ${cursor}`;
                    break;
                }
                if (region.start > cursor) {
                    coverageError = `mdat 存在未覆盖空洞：${cursor}..${region.start}`;
                    break;
                }
                cursor = region.end;
            }
            if (!coverageError && cursor !== mdatEnd) {
                coverageError = cursor < mdatEnd
                    ? `mdat 尾部有 ${mdatEnd - cursor} 字节未被任何样本覆盖`
                    : `样本数据超出 mdat ${cursor - mdatEnd} 字节`;
            }

            if (coverageError) {
                frag.mdat.ok = false;
                frag.mdat.reason = coverageError;
                frag.status = 'mdat_coverage_mismatch';
            } else {
                frag.status = warnings.length ? 'ok_warn' : 'ok';
            }
        }

        fragments.push(frag);
    }

    return fragments;
}

export default detectMoofMdatFragments;
