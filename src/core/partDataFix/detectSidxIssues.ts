type Top = { offset: number; size: number; type: string; headerSize: number };

/** ——— 最小依赖：读取 box size（支持 32/64 位） ——— */
function readBoxSize(buf: Buffer, offset: number): { size: number; headerSize: number } {
    if (offset + 8 > buf.length) return { size: 0, headerSize: 8 };
    const sz32 = buf.readUInt32BE(offset);
    if (sz32 === 0) return { size: buf.length - offset, headerSize: 8 };
    if (sz32 === 1) {
        if (offset + 16 > buf.length) return { size: 0, headerSize: 16 };
        const hi = buf.readUInt32BE(offset + 8);
        const lo = buf.readUInt32BE(offset + 12);
        return { size: Number((BigInt(hi) << 32n) | BigInt(lo)), headerSize: 16 };
    }
    return { size: sz32, headerSize: 8 };
}

/** ——— 最小依赖：解析顶层 box ——— */
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

/** ——— 解析并校验单个 sidx ——— */
function parseAndCheckSidx(buf: Buffer, sidx: Top) {
    const issues: string[] = [];
    const end = sidx.offset + sidx.size;
    const needBase = sidx.offset + 12; // FullBox header (size+type 8) + version/flags(4) = 12
    if (end > buf.length) {
        issues.push(`box_overrun: sidx end ${end} > fileLen ${buf.length}`);
        return { ok: false, issues };
    }
    if (needBase > end) {
        issues.push(`header_truncated: not enough for FullBox header`);
        return { ok: false, issues };
    }

    const version = buf.readUInt8(sidx.offset + 8);
    // flags = buf.readUIntBE(sidx.offset + 9, 3); // 用不到可不取

    // 固定字段起点
    let p = sidx.offset + 12;
    const must = (n: number) => {
        if (p + n > end) { issues.push(`payload_truncated @${p} need ${n}`); return false; }
        return true;
    };

    if (!must(4 + 4)) return { ok: false, issues };
    const reference_ID = buf.readUInt32BE(p); p += 4;
    const timescale = buf.readUInt32BE(p); p += 4;
    if (timescale === 0) issues.push(`timescale_zero`);

    let earliest_presentation_time = 0n;
    let first_offset = 0n;

    if (version === 0) {
        if (!must(4 + 4)) return { ok: false, issues };
        earliest_presentation_time = BigInt(buf.readUInt32BE(p)); p += 4;
        first_offset = BigInt(buf.readUInt32BE(p)); p += 4;
    } else if (version === 1) {
        if (!must(8 + 8)) return { ok: false, issues };
        const ehi = buf.readUInt32BE(p); const elo = buf.readUInt32BE(p + 4); p += 8;
        const fhi = buf.readUInt32BE(p); const flo = buf.readUInt32BE(p + 4); p += 8;
        earliest_presentation_time = (BigInt(ehi) << 32n) | BigInt(elo);
        first_offset = (BigInt(fhi) << 32n) | BigInt(flo);
    } else {
        issues.push(`bad_version:${version}`);
        return { ok: false, issues };
    }

    if (!must(2 + 2)) return { ok: false, issues };
  /* reserved */ p += 2;
    const reference_count = buf.readUInt16BE(p); p += 2;

    // 按 entry 校验
    type Entry = {
        reference_type: number; // 0 or 1
        referenced_size: number; // 31 bits
        subsegment_duration: number;
        starts_with_SAP: number; // 1 bit
        SAP_type: number;        // 3 bits
        SAP_delta_time: number;  // 28 bits
    };
    const entries: Entry[] = [];
    for (let i = 0; i < reference_count; i++) {
        if (!must(12)) break;
        const refAndType = buf.readUInt32BE(p); p += 4;
        const reference_type = (refAndType >>> 31) & 0x1;
        const referenced_size = refAndType & 0x7FFFFFFF;

        const subsegment_duration = buf.readUInt32BE(p); p += 4;

        const sap = buf.readUInt32BE(p); p += 4;
        const starts_with_SAP = (sap >>> 31) & 0x1;
        const SAP_type = (sap >>> 28) & 0x7;
        const SAP_delta_time = sap & 0x0FFFFFFF;

        // 基础合理性
        if (referenced_size === 0) issues.push(`entry_${i}: referenced_size_zero`);
        if (subsegment_duration === 0) issues.push(`entry_${i}: subsegment_duration_zero`);
        if (reference_type !== 0 && reference_type !== 1) issues.push(`entry_${i}: bad_reference_type:${reference_type}`);

        entries.push({ reference_type, referenced_size, subsegment_duration, starts_with_SAP, SAP_type, SAP_delta_time });
    }

    // 字节总量核对：
    // 规范：sidx 后面的 media 起点 = sidxEnd + first_offset
    const sidxEnd = end;
    const mediaStart = sidxEnd + Number(first_offset);
    if (mediaStart > buf.length) {
        issues.push(`first_offset_overrun: sidxEnd(${sidxEnd}) + first_offset(${first_offset}) > fileLen(${buf.length})`);
    }

    // 如果 entries 都是 reference_type=0，可将 referenced_size 累加做一个粗校验
    const allType0 = entries.every(e => e.reference_type === 0);
    if (allType0 && entries.length > 0 && mediaStart <= buf.length) {
        const totalRefBytes = entries.reduce((a, e) => a + e.referenced_size, 0);
        const tailBytes = buf.length - mediaStart;
        if (totalRefBytes > tailBytes) {
            issues.push(`referenced_size_sum_exceeds_tail: sum=${totalRefBytes} > tail=${tailBytes} (from mediaStart)`);
        }
    }

    return {
        ok: issues.length === 0,
        version,
        reference_ID,
        timescale,
        earliest_presentation_time,
        first_offset,
        reference_count,
        entries,
        issues,
    };
}

/** ——— 顶层检测：查找 sidx，按需报缺失/损坏 ——— */
export function detectSidxIssues(buf: Buffer, opts?: { expectSidx?: boolean }) {
    const boxes = parseTopLevelBoxes(buf);
    const sidxBoxes = boxes.filter(b => b.type === "sidx");
    const results = sidxBoxes.map(b => ({ offset: b.offset, size: b.size, ...parseAndCheckSidx(buf, b) }));

    const issues: Array<{ kind: string; detail: string; at?: number }> = [];

    if (sidxBoxes.length === 0) {
        if (opts?.expectSidx) {
            issues.push({ kind: "missing_sidx", detail: "expected sidx but not found (DASH-like scenario)" });
        }
        return { sidxCount: 0, results: [], issues, boxes };
    }

    // 汇总每个 sidx 的问题
    for (const r of results) {
        if (!r.ok) {
            issues.push({ kind: "sidx_corrupt", detail: r.issues.join("; "), at: r.offset });
        }
    }

    return { sidxCount: sidxBoxes.length, results, issues, boxes };
}