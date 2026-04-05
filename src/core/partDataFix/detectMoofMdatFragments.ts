/**
 * 读取 32-bit BE 或 64-bit 大尺寸（若 size === 1 则读取 extended size）
 * 返回 { size: number, headerSize: number } 其中 headerSize 是 size字段占用的 bytes (8 or 16)
 */
function readBoxSize(buf: Buffer, offset: number): { size: number; headerSize: number } {
    if (offset + 8 > buf.length)
        throw new Error("not enough bytes for box header");

    const size32 = buf.readUInt32BE(offset);
    if (size32 === 0) {
        // size == 0 -> box extends to end of file
        return { size: buf.length - offset, headerSize: 8 };
    }
    if (size32 === 1) {
        // extended size: 64-bit
        if (offset + 16 > buf.length) throw new Error("not enough bytes for extended size");
        const high = buf.readUInt32BE(offset + 8);
        const low = buf.readUInt32BE(offset + 12);
        const big = BigInt(high) << 32n | BigInt(low);
        const n = Number(big); // may overflow for huge boxes, but fMP4 fragments are usually small
        return { size: n, headerSize: 16 };
    }
    return { size: size32, headerSize: 8 };
}

/** 解析 top-level boxes（返回数组，包含 offset, size, type） */
function parseTopLevelBoxes(buf: Buffer) {
    const res: Array<{ offset: number; size: number; type: string }> = [];
    let offset = 0;
    const len = buf.length;

    while (offset + 8 <= len) {
        try {
            const { size, headerSize } = readBoxSize(buf, offset);
            const type = buf.toString("ascii", offset + 4, offset + 8);
            if (size < headerSize || offset + size > len) {
                // 遇到不合法或截断的 box -> 推入错误信息并停止解析
                res.push({ offset, size, type });
                break;
            }
            res.push({ offset, size, type });
            offset += size;
        } catch (e) {
            // 无法读取 header -> 停止
            break;
        }
    }
    return res;
}

/** 解析一个 box 内部的 top-level children（只在 box payload 中解析） */
function parseInnerBoxes(buf: Buffer, baseOffset: number, boxSize: number) {
    const boxes: Array<{ offset: number; size: number; type: string; relativeOffset: number }> = [];
    const start = baseOffset + 8; // 假定 caller 已处理 extended size if needed; here we assume standard header
    let offset = start;
    const end = baseOffset + boxSize;
    while (offset + 8 <= end) {
        const { size, headerSize } = readBoxSize(buf, offset);
        const type = buf.toString("ascii", offset + 4, offset + 8);
        if (size < headerSize || offset + size > end) {
            boxes.push({ offset, size, type, relativeOffset: offset - baseOffset });
            break;
        }
        boxes.push({ offset, size, type, relativeOffset: offset - baseOffset });
        offset += size;
    }
    return boxes;
}

/**
 * 从 traf -> 获取 tfhd(default_sample_size) 与 trun (sample_count, sample_size entries if present)
 * 返回 { sampleCount?: number, sampleSizeSum?: number, defaultSampleSize?: number, parsed: boolean }
 */
function parseTfhdAndTrunFromTraf(buf: Buffer, trafBox: { offset: number; size: number }) {
    const inner = parseInnerBoxes(buf, trafBox.offset, trafBox.size);
    let defaultSampleSize: number | undefined = undefined;
    let sampleCount: number | undefined = undefined;
    let sampleSizeSum: number | undefined = undefined;
    let parsed = false;

    for (const child of inner) {
        if (child.type === "tfhd") {
            // tfhd layout: version(1) + flags(3) + possibly fields per flags
            // For our purpose we parse flags for base-data-offset/ default-sample-size presence (flags bits)
            // const ver = buf.readUInt8(child.offset + 8);
            // const flags = buf.readUIntBE(child.offset + 9, 3);
            // tfhd fields after base: track_id (4), then optional...
            // field order: track_ID(4) then optional: base_data_offset(8) | sample_description_index(4) | default_sample_duration(4) | default_sample_size(4) | default_sample_flags(4)
            // flags bit 0x000008 => default_sample_size present? Actually tfhd flags' meaning: see ISO-BMFF; we do best-effort:
            // We'll attempt to read default_sample_size from the end if possible (best-effort).
            try {
                // const trackId = buf.readUInt32BE(child.offset + 12);
                // try to locate default_sample_size at end if remaining >=4
                // const tfhdPayloadStart = child.offset + 12;
                const tfhdPayloadLen = child.size - 12;
                // naive scan: if payloadLen >= 4, take last 4 as default_sample_size (best-effort, conservative)
                if (tfhdPayloadLen >= 4) {
                    const possible = buf.readUInt32BE(child.offset + child.size - 4);
                    defaultSampleSize = possible;
                }
            } catch (e) {
                // ignore
            }
        } else if (child.type === "trun") {
            // trun: version(1) + flags(3) + sample_count(4) + optional data fields depending on flags
            parsed = true;
            // const ver = buf.readUInt8(child.offset + 8);
            const flags = buf.readUIntBE(child.offset + 9, 3);
            const sampleCount = buf.readUInt32BE(child.offset + 12);
            let cursor = child.offset + 16; // start of optional fields
            // flags bits: data-offset-present(0x000001), first-sample-flags-present(0x000004), sample-duration-present(0x000100), sample-size-present(0x000200), sample-flags-present(0x000400), sample-composition-time-offsets-present(0x000800)
            const DATA_OFFSET = 0x000001;
            const FIRST_SAMPLE_FLAGS = 0x000004;
            const SAMPLE_DURATION = 0x000100;
            const SAMPLE_SIZE = 0x000200;
            const SAMPLE_FLAGS = 0x000400;
            const SAMPLE_CTO = 0x000800;

            if (flags & DATA_OFFSET) {
                cursor += 4; // data offset
            }
            if (flags & FIRST_SAMPLE_FLAGS) {
                cursor += 4;
            }

            let totalSize = 0;
            // iterate per-sample entries
            for (let i = 0; i < sampleCount; i++) {
                if (cursor >= child.offset + child.size) break; // truncated
                let thisSampleSize: number | undefined = undefined;
                if (flags & SAMPLE_DURATION) {
                    cursor += 4;
                }
                if (flags & SAMPLE_SIZE) {
                    thisSampleSize = buf.readUInt32BE(cursor);
                    cursor += 4;
                }
                if (flags & SAMPLE_FLAGS) {
                    cursor += 4;
                }
                if (flags & SAMPLE_CTO) {
                    cursor += 4;
                }
                if (thisSampleSize !== undefined) totalSize += thisSampleSize;
            }
            return { sampleCount, sampleSizeSum: totalSize > 0 ? totalSize : undefined, defaultSampleSize, parsed: true };
        }
    }

    return { sampleCount, sampleSizeSum, defaultSampleSize, parsed };
}

type Fragment = {
    index: number;
    moof?: {
        offset: number;
        size: number;
        ok: boolean;
        reason?: string;
        containsMfhd?: boolean;
        trafCount?: number;
        trunSampleCount?: number | undefined;
        trunDeclaredBytes?: number | undefined;
        defaultSampleSize?: number | undefined;
    };
    mdat?: {
        offset: number;
        size: number;
        ok: boolean;
        reason?: string;
        payloadBytes?: number;
    };
    status: "ok" | "ok_warn" | "missing_mdat" | "moof_truncated" | "mdat_truncated" | "trun_mismatch" | "unknown";
}

/**
 * 主函数：检测 moof/mdat 片段的完整性
 * 返回每个 fragment 的检测结果数组
 */
function detectMoofMdatFragments(buf: Buffer) {
    const top = parseTopLevelBoxes(buf);
    const fragments: Array<Fragment> = [];

    // scan top-level boxes and pair moof->next mdat (simple linear pass)
    for (let i = 0, fragIndex = 0; i < top.length; i++) {
        const b = top[i];
        if (b.type === "moof") {
            const frag: Fragment & {
                moof: {
                    offset: number;
                    size: number;
                    ok: boolean;
                    reason?: string;
                    containsMfhd?: boolean;
                    trafCount?: number;
                    trunSampleCount?: number | undefined;
                    trunDeclaredBytes?: number | undefined;
                    defaultSampleSize?: number | undefined;
                };
                mdat: {
                    offset: number;
                    size: number;
                    ok: boolean;
                    reason?: string;
                    payloadBytes: number;
                };
            } = {
                index: fragIndex++,
                moof: { offset: b.offset, size: b.size, ok: true },
                mdat: { offset: 0, size: 0, ok: false, payloadBytes: 0 },
                status: "unknown"
            };

            // check moof within file boundary
            if (b.offset + b.size > buf.length) {
                frag.moof.ok = false;
                frag.moof.reason = `moof claims size ${b.size} extends beyond file (${buf.length})`;
                frag.status = "moof_truncated";
                fragments.push(frag);
                continue;
            }

            // parse moof inner boxes to check presence of mfhd/traf/trun
            let inner = parseInnerBoxes(buf, b.offset, b.size);
            let containsMfhd = inner.some(x => x.type === "mfhd");
            const trafs = inner.filter(x => x.type === "traf");
            frag.moof.containsMfhd = containsMfhd;
            frag.moof.trafCount = trafs.length;

            // try parse first traf for trun/tfhd info (best-effort)
            if (trafs.length > 0) {
                const info = parseTfhdAndTrunFromTraf(buf, trafs[0]);
                frag.moof.trunSampleCount = info.sampleCount;
                frag.moof.trunDeclaredBytes = info.sampleSizeSum;
                frag.moof.defaultSampleSize = info.defaultSampleSize;
            }

            // now find mdat: typically it's the immediate next top-level box(s).
            let foundMdat: { offset: number; size: number } | undefined = undefined;
            for (let j = i + 1; j < top.length; j++) {
                if (top[j].type === "mdat") {
                    foundMdat = top[j];
                    break;
                }
                if (top[j].type === "moof") break; // if we encounter another moof before mdat
            }

            if (!foundMdat) {
                frag.status = "missing_mdat";
                frag.mdat.ok = false;
                frag.mdat.reason = "no following mdat for this moof";
                fragments.push(frag);
                continue;
            }

            frag.mdat.offset = foundMdat.offset;
            frag.mdat.size = foundMdat.size;
            frag.mdat.payloadBytes = foundMdat.size - 8;
            frag.mdat.ok = true;

            // check mdat within file boundary
            if (foundMdat.offset + foundMdat.size > buf.length) {
                frag.mdat.ok = false;
                frag.mdat.reason = `mdat claims size extends beyond file`;
                frag.status = "mdat_truncated";
                fragments.push(frag);
                continue;
            }

            // Insert the provided code for checking missing trun details
            if (frag.moof.trunSampleCount === undefined || frag.moof.trunDeclaredBytes === undefined) {
                if (frag.moof.ok && frag.mdat.ok) {
                    frag.status = 'ok_warn'; // or 'parse_incomplete'
                    frag.moof.reason = 'trun missing details but playback likely fine';
                } else {
                    frag.moof.ok = false;
                    frag.moof.reason = 'trun missing details';
                    frag.status = 'unknown';
                }
                fragments.push(frag);
                continue;
            }

            // If trun says sampleSizeSum present, compare with mdat payload bytes
            if (frag.moof.trunDeclaredBytes !== undefined && frag.mdat.payloadBytes !== undefined) {
                if (frag.moof.trunDeclaredBytes > frag.mdat.payloadBytes) {
                    frag.status = "trun_mismatch";
                    frag.moof.ok = false;
                    frag.moof.reason = `trun declared ${frag.moof.trunDeclaredBytes} bytes but mdat payload is ${frag.mdat.payloadBytes}`;
                    fragments.push(frag);
                    continue;
                } else {
                    frag.status = "ok";
                    fragments.push(frag);
                    continue;
                }
            }

            // If we have sampleCount and defaultSampleSize
            if ((frag.moof.trunSampleCount !== undefined) && (frag.moof.defaultSampleSize !== undefined)) {
                const need = frag.moof.trunSampleCount * frag.moof.defaultSampleSize;
                if (need > frag.mdat.payloadBytes!) {
                    frag.status = "trun_mismatch";
                    frag.moof.ok = false;
                    frag.moof.reason = `need ${need} bytes (sampleCount*defaultSampleSize) but mdat payload ${frag.mdat.payloadBytes}`;
                    fragments.push(frag);
                    continue;
                } else {
                    frag.status = "ok";
                    fragments.push(frag);
                    continue;
                }
            }

            // Otherwise we cannot fully verify sample payloads, but both moof and mdat are within file bounds
            frag.status = "ok";
            fragments.push(frag);
        }
    }

    return fragments;
}

export default detectMoofMdatFragments;