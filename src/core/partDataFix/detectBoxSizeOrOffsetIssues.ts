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

function parseTopLevelBoxes(buf: Buffer): Top[] {
    const out: Top[] = [];
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

function parseInnerBoxes(buf: Buffer, base: number, total: number) {
    const boxes: { offset: number; size: number; type: string }[] = [];
    let off = base + 8; // 简化：不展开 extended header，因为上面 readBoxSize 已给出 headerSize
    const end = base + total;
    while (off + 8 <= end) {
        const { size, headerSize } = readBoxSize(buf, off);
        const type = buf.toString("ascii", off + 4, off + 8);
        if (size < headerSize || off + size > end) {
            boxes.push({ offset: off, size, type });
            break;
        }
        boxes.push({ offset: off, size, type });
        off += size;
    }
    return boxes;
}

function parseTfhdTrunQuick(buf: Buffer, moof: Top) {
    const inner = parseInnerBoxes(buf, moof.offset, moof.size);
    const traf = inner.find(b => b.type === "traf");
    if (!traf) return {};

    const children = parseInnerBoxes(buf, traf.offset, traf.size);
    const tfhd = children.find(b => b.type === "tfhd");
    const trun = children.find(b => b.type === "trun");

    let defaultSampleSize: number | undefined;
    if (tfhd) {
        const payloadLen = tfhd.size - 12;
        if (payloadLen >= 4) {
            defaultSampleSize = buf.readUInt32BE(tfhd.offset + tfhd.size - 4);
        }
    }
    if (!trun) return { defaultSampleSize };

    const flags = buf.readUIntBE(trun.offset + 9, 3);
    const sampleCount = buf.readUInt32BE(trun.offset + 12);
    let cursor = trun.offset + 16;

    const DATA_OFFSET = 0x000001;
    const FIRST_SAMPLE_FLAGS = 0x000004;
    const SAMPLE_DURATION = 0x000100;
    const SAMPLE_SIZE = 0x000200;
    const SAMPLE_FLAGS = 0x000400;
    const SAMPLE_CTO = 0x000800;

    let dataOffsetVal: number | undefined;
    if (flags & DATA_OFFSET) { dataOffsetVal = buf.readInt32BE(cursor); cursor += 4; }
    if (flags & FIRST_SAMPLE_FLAGS) cursor += 4;

    let sizeSum = 0;
    for (let i = 0; i < sampleCount; i++) {
        if (flags & SAMPLE_DURATION) cursor += 4;
        if (flags & SAMPLE_SIZE) { sizeSum += buf.readUInt32BE(cursor); cursor += 4; }
        if (flags & SAMPLE_FLAGS) cursor += 4;
        if (flags & SAMPLE_CTO) cursor += 4;
    }

    return {
        defaultSampleSize,
        sampleCount,
        sampleSizeSum: sizeSum > 0 ? sizeSum : undefined,
        dataOffset: dataOffsetVal
    };
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

type Top = { offset: number; size: number; type: string; headerSize: number };

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

    // moof --> mdat 配对 + data_offset 落点检查
    for (let i = 0; i < boxes.length; i++) {
        const b = boxes[i];
        if (b.type !== "moof") continue;

        // 找到随后最近的 mdat（在下一个 moof 之前）
        let mdat: Top | undefined;
        for (let j = i + 1; j < boxes.length; j++) {
            if (boxes[j].type === "mdat") { mdat = boxes[j]; break; }
            if (boxes[j].type === "moof") break;
        }
        if (!mdat) {
            issues.push({ kind: "missing_mdat", detail: `moof@${b.offset} has no following mdat before next moof`, at: b.offset });
            continue;
        }

        // 可选：trun.data_offset 落点是否在 mdat payload 内
        const info = parseTfhdTrunQuick(buf, b);
        if (info && typeof info.dataOffset === "number") {
            const moofStart = b.offset;
            const probe = moofStart + info.dataOffset; // 通常 data_offset 相对于 moof 起点
            const mdatPayloadStart = mdat.offset + 8;
            const mdatPayloadEnd = mdat.offset + mdat.size;
            if (probe < mdatPayloadStart || probe >= mdatPayloadEnd) {
                issues.push({
                    kind: "data_offset_out_of_mdat",
                    detail: `trun.data_offset(${info.dataOffset}) => ${probe}, not in mdat[${mdatPayloadStart}, ${mdatPayloadEnd})`,
                    at: b.offset
                });
            }
        }

        // 若能拿到样本总字节（或 defaultSampleSize*count），再对比 mdat payload
        const need =
            (info.sampleSizeSum !== undefined && info.sampleSizeSum) ||
            (info.sampleCount !== undefined && info.defaultSampleSize !== undefined
                ? info.sampleCount * info.defaultSampleSize
                : undefined);

        if (need !== undefined) {
            const payload = Math.max(0, mdat.size - 8);
            if (need > payload) {
                issues.push({
                    kind: "trun_mismatch",
                    detail: `need ${need} bytes > mdat payload ${payload}`,
                    at: b.offset
                });
            }
        }
    }

    return { boxes, issues };
}

export default detectBoxSizeOrOffsetIssues;