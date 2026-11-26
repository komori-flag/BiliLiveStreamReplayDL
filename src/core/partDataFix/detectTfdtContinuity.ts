/**
 * tfdt（Track Fragment Decode Time）连续性检测
 *
 * 解析所有 moof→traf→tfdt 路径，提取 baseMediaDecodeTime，
 * 检查相邻片段之间的时间戳是否单调递增。
 *
 * 可检测：
 * - 时间倒流（delta < 0）—— 数据损坏或非正常重连
 * - 大幅跳变（delta >> avg × threshold）—— 中间缺失分片
 * - 缺少 tfdt box —— 结构异常
 */

import type { TfdtContinuityResult, TfdtEntry } from '../../model/mp4.js';

/** 解析 box size（支持 32/64 位 extended size） */
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

/** 解析顶层 box 列表 */
function parseTopLevelBoxes(buf: Buffer): Array<{ offset: number; size: number; type: string }> {
    const boxes: Array<{ offset: number; size: number; type: string }> = [];
    let off = 0;
    while (off + 8 <= buf.length) {
        const { size, headerSize } = readBoxSize(buf, off);
        const type = buf.toString('ascii', off + 4, off + 8);
        if (size < headerSize || off + size > buf.length) {
            boxes.push({ offset: off, size, type });
            break;
        }
        boxes.push({ offset: off, size, type });
        off += size;
    }
    return boxes;
}

/**
 * 解析 box 内部子 box
 * @param headerSize 父 box 的头部大小（标准 box=8，FullBox=12）
 */
function parseInnerBoxes(buf: Buffer, baseOffset: number, boxSize: number, headerSize: number = 8): Array<{ offset: number; size: number; type: string }> {
    const boxes: Array<{ offset: number; size: number; type: string }> = [];
    const end = baseOffset + boxSize;
    let off = baseOffset + headerSize;
    while (off + 8 <= end) {
        const { size, headerSize } = readBoxSize(buf, off);
        const type = buf.toString('ascii', off + 4, off + 8);
        if (size < headerSize || off + size > end) {
            boxes.push({ offset: off, size, type });
            break;
        }
        boxes.push({ offset: off, size, type });
        off += size;
    }
    return boxes;
}

/**
 * 检测分片文件中 tfdt 的连续性
 *
 * @param buf         分片文件缓冲区
 * @param gapThreshold 跳变阈值倍数（相对于平均增量的倍数，默认 10）
 */
export function detectTfdtContinuity(
    buf: Buffer,
    gapThreshold: number = 10,
): TfdtContinuityResult {
    const issues: TfdtContinuityResult['issues'] = [];
    const entries: TfdtEntry[] = [];

    // 1. 找出所有 moof
    const top = parseTopLevelBoxes(buf);
    const moofBoxes = top.filter(b => b.type === 'moof');

    if (moofBoxes.length === 0) {
        return {
            ok: false,
            entries: [],
            issues: [{ kind: 'missing_tfdt', detail: 'no moof box found in file' }],
            rawTimes: [],
        };
    }

    // 2. 遍历每个 moof，查找 traf→tfdt
    const rawTimes: bigint[] = [];

    for (const moof of moofBoxes) {
        // moof / traf 都不是 FullBox：只有 8 字节 size+type，没有 version/flags。
        // 早先按 12 解析会让内层整体偏移 4 字节，永远找不到 traf→tfdt（表现为恒判不合格）
        const inner = parseInnerBoxes(buf, moof.offset, moof.size, 8);
        const trafBoxes = inner.filter(b => b.type === 'traf');

        // 取每个 traf 中的第一个 tfdt
        for (const traf of trafBoxes) {
            const trafInner = parseInnerBoxes(buf, traf.offset, traf.size, 8);
            const tfdtBox = trafInner.find(b => b.type === 'tfdt');
            if (!tfdtBox) {
                issues.push({
                    kind: 'missing_tfdt',
                    detail: `moof@${moof.offset} traf@${traf.offset}: tfdt not found`,
                    at: moof.offset,
                });
                continue;
            }

            // 读取 tfdt: FullBox header (size+type=8) + version(1) + flags(3) = 12
            const tfdtPayload = tfdtBox.offset + 12;
            if (tfdtPayload + 4 > buf.length) {
                issues.push({
                    kind: 'missing_tfdt',
                    detail: `moof@${moof.offset}: tfdt truncated`,
                    at: moof.offset,
                });
                continue;
            }

            const version = buf.readUInt8(tfdtBox.offset + 8);
            let baseMediaDecodeTime: bigint;
            if (version === 0) {
                // 4 字节 uint32
                baseMediaDecodeTime = BigInt(buf.readUInt32BE(tfdtPayload));
            } else {
                // 8 字节 uint64 (version >= 1)
                if (tfdtPayload + 8 > buf.length) {
                    issues.push({
                        kind: 'missing_tfdt',
                        detail: `moof@${moof.offset}: tfdt version ${version} but insufficient bytes for uint64`,
                        at: moof.offset,
                    });
                    continue;
                }
                const hi = buf.readUInt32BE(tfdtPayload);
                const lo = buf.readUInt32BE(tfdtPayload + 4);
                baseMediaDecodeTime = (BigInt(hi) << 32n) | BigInt(lo);
            }

            rawTimes.push(baseMediaDecodeTime);

            // tfhd 是 FullBox：size+type(8) + version+flags(4) + track_ID(4)
            const tfhd = trafInner.find(b => b.type === 'tfhd');
            const trackId = tfhd && tfhd.offset + 16 <= buf.length
                ? buf.readUInt32BE(tfhd.offset + 12)
                : -1;

            entries.push({
                moofOffset: moof.offset,
                baseMediaDecodeTime: Number(baseMediaDecodeTime),
                delta: 0,   // 稍后按轨道分组时计算
                version,
                trackId,
            });
        }
    }

    if (entries.length === 0) {
        return {
            ok: false,
            entries: [],
            issues: issues.length > 0 ? issues : [{ kind: 'missing_tfdt', detail: 'no tfdt found in any traf' }],
            rawTimes,
        };
    }

    // 3. 按轨道分组：视频/音频的时间基不同，跨轨按文件顺序比较必然误报"时间倒流"
    const byTrack = new Map<number, TfdtEntry[]>();
    for (const e of entries) {
        const list = byTrack.get(e.trackId) ?? [];
        list.push(e);
        byTrack.set(e.trackId, list);
    }

    // 4. 每条轨各自算基准增量（正 delta 的下半分位数，避免被异常跳变自身拉高基准）并检查
    for (const [trackId, list] of byTrack) {
        for (let i = 1; i < list.length; i++) {
            list[i].delta = list[i].baseMediaDecodeTime - list[i - 1].baseMediaDecodeTime;
        }

        const positiveDeltas = list.map(e => e.delta).filter(d => d > 0);
        let typicalDelta = 0;
        if (positiveDeltas.length > 1) {
            const sorted = [...positiveDeltas].sort((a, b) => a - b);
            const halfIdx = Math.floor(sorted.length / 2);
            const lowerHalf = sorted.slice(0, halfIdx);
            typicalDelta = lowerHalf.reduce((a, b) => a + b, 0) / lowerHalf.length;
        } else if (positiveDeltas.length === 1) {
            typicalDelta = positiveDeltas[0];
        }

        for (let i = 1; i < list.length; i++) {
            const entry = list[i];
            const delta = entry.delta;

            if (delta < 0) {
                issues.push({
                    kind: 'time_rewind',
                    detail: `track ${trackId} moof@${entry.moofOffset}: baseMediaDecodeTime rewound by ${-delta} (prev=${list[i - 1].baseMediaDecodeTime}, cur=${entry.baseMediaDecodeTime})`,
                    at: entry.moofOffset,
                });
            } else if (typicalDelta > 0 && delta > typicalDelta * gapThreshold) {
                issues.push({
                    kind: 'time_gap',
                    detail: `track ${trackId} moof@${entry.moofOffset}: time gap ${delta} exceeds ${gapThreshold}x typical delta (${typicalDelta.toFixed(1)})`,
                    at: entry.moofOffset,
                });
            }
        }
    }

    return {
        ok: issues.length === 0,
        entries,
        issues,
        rawTimes,
    };
}

export default detectTfdtContinuity;
