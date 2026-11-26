// box 尺寸 / 偏移异常检测
//
// 职责边界：
// - 本文件只做顶层 box 走链和 data_offset 落点检查
// - 样本大小与 mdat payload 的精确覆盖由 detectMoofMdatFragments 负责
//   （那边会解析全部 traf/traf，避免这里重复实现一套样本表解析）

import { parseMoof } from './mp4FragmentParser.js';
import type { Mp4BoxTop } from '../../model/mp4.js';

function readBoxSize(buf: Buffer, offset: number): { size: number; headerSize: number } {
    if (offset + 8 > buf.length) return { size: 0, headerSize: 8 }; // 会被 header_truncated 捕获
    const size32 = buf.readUInt32BE(offset);
    if (size32 === 0) return { size: buf.length - offset, headerSize: 8 }; // to EOF
    if (size32 === 1) {
        if (offset + 16 > buf.length) return { size: 0, headerSize: 16 };
        const hi = buf.readUInt32BE(offset + 8);
        const lo = buf.readUInt32BE(offset + 12);
        return { size: Number((BigInt(hi) << 32n) | BigInt(lo)), headerSize: 16 };
    }
    return { size: size32, headerSize: 8 };
}

function parseTopLevelBoxes(buf: Buffer): Mp4BoxTop[] {
    const out: Mp4BoxTop[] = [];
    let off = 0;
    while (off + 8 <= buf.length) {
        const { size, headerSize } = readBoxSize(buf, off);
        const type = buf.toString("ascii", off + 4, off + 8);
        if (size < headerSize || off + size > buf.length) {
            out.push({ offset: off, size, type, headerSize });
            break;
        }
        out.push({ offset: off, size, type, headerSize });
        off += size;
    }
    return out;
}

function sanityCheckBoxes(buf: Buffer) {
    const boxes = parseTopLevelBoxes(buf);
    const issues: Array<{ kind: string; detail: string; at?: number }> = [];
    const len = buf.length;

    if (boxes.length === 0) {
        issues.push({ kind: "no_boxes", detail: "cannot parse any top-level box" });
        return { boxes, issues };
    }

    let prevEnd = 0;
    for (const b of boxes) {
        // header 完整性
        if (b.offset + 8 > len) {
            issues.push({ kind: "header_truncated", detail: `header truncated at ${b.offset}`, at: b.offset });
            break;
        }

        // size 基本合法性
        if (b.size < b.headerSize) {
            issues.push({ kind: "box_size_too_small", detail: `${b.type} size=${b.size} < headerSize=${b.headerSize}`, at: b.offset });
            break;
        }

        // 越界
        const end = b.offset + b.size;
        if (end > len) {
            issues.push({ kind: "box_overrun", detail: `${b.type} end=${end} > fileLen=${len}`, at: b.offset });
            break;
        }

        // 重叠 or gap
        if (b.offset < prevEnd) {
            issues.push({ kind: "box_overlap", detail: `${b.type}@${b.offset} overlaps prev end ${prevEnd}`, at: b.offset });
        } else if (b.offset > prevEnd) {
            const gap = b.offset - prevEnd;
            // 允许 free/skip 等 padding？这里先记录出来
            issues.push({ kind: "gap_bytes", detail: `gap ${gap} bytes between ${prevEnd} and ${b.offset}`, at: b.offset });
        }

        prevEnd = end;
    }

    // 若最后一个 box 未走到文件末尾（通常意味着尾部垃圾或 header 解析中止）
    if (issues.length === 0 && prevEnd !== len) {
        issues.push({ kind: "tail_unparsed", detail: `unparsed ${len - prevEnd} bytes at tail`, at: prevEnd });
    }

    return { boxes, issues };
}

/**
 * box 尺寸或偏移异常检测
 * @param buf 待检查的 Buffer
 * @returns
 */
function detectBoxSizeOrOffsetIssues(buf: Buffer) {
    const { boxes, issues } = sanityCheckBoxes(buf);
    // 仅当基础体检已通过时，才做 fMP4 配对/细检
    if (issues.some(i => i.kind === "header_truncated" || i.kind === "box_size_too_small" || i.kind === "box_overrun")) {
        return { boxes, issues }; // 已有致命问题
    }

    // moof → mdat 配对 + 全部 traf 的 data_offset 落点检查
    for (let i = 0; i < boxes.length; i++) {
        const b = boxes[i];
        if (b.type !== "moof") continue;

        // 找到随后最近的 mdat（在下一个 moof 之前）
        let mdat: Mp4BoxTop | undefined;
        for (let j = i + 1; j < boxes.length; j++) {
            if (boxes[j].type === "mdat") { mdat = boxes[j]; break; }
            if (boxes[j].type === "moof") break;
        }
        if (!mdat) {
            issues.push({ kind: "missing_mdat", detail: `moof@${b.offset} has no following mdat before next moof`, at: b.offset });
            continue;
        }

        const payloadStart = mdat.offset + mdat.headerSize;
        const mdatEnd = mdat.offset + mdat.size;
        const moof = parseMoof(buf, b);
        let prevTrafEnd: number | undefined;

        for (const traf of moof.trafs) {
            if (traf.parseError) continue;

            // base data offset 优先级：显式 base_data_offset > default-base-is-moof > 上一个 traf 的数据末尾
            const base = traf.baseDataOffset !== undefined
                ? traf.baseDataOffset
                : (traf.tfhdFlags & 0x020000) ? b.offset : (prevTrafEnd ?? b.offset);

            let runStart = base;
            for (const trun of traf.truns) {
                const start = trun.dataOffset !== undefined ? base + trun.dataOffset : runStart;
                if (start < payloadStart || start >= mdatEnd) {
                    issues.push({
                        kind: "data_offset_out_of_mdat",
                        detail: `track=${traf.trackId} trun@${trun.offset}: start=${start} 不在 mdat payload [${payloadStart}, ${mdatEnd}) 内`,
                        at: b.offset,
                    });
                } else if (trun.sampleSizesKnown && !trun.truncated && start + trun.sampleSizeSum > mdatEnd) {
                    issues.push({
                        kind: "sample_data_exceeds_mdat",
                        detail: `track=${traf.trackId} trun@${trun.offset}: 样本结束 ${start + trun.sampleSizeSum} > mdat end ${mdatEnd}`,
                        at: b.offset,
                    });
                }

                if (trun.sampleSizesKnown && !trun.truncated) runStart = start + trun.sampleSizeSum;
                else runStart = start;
            }
            if (runStart > (prevTrafEnd ?? -1)) prevTrafEnd = runStart;
        }
    }

    return { boxes, issues };
}

export default detectBoxSizeOrOffsetIssues;
