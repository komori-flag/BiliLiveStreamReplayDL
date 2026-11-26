// BYTERANGE 播放列表的解析与拼装工具
// writeLocalM3U8Byterange / appendLocalM3U8Byterange / primeAppendedFromPlaylist 共用
import fs from 'node:fs/promises';
import type { ByterangeRange, PlaylistEntry, PlaylistIndex } from '../model/hls.js';

/**
 * 生成 `#EXTINF` + `#EXT-X-BYTERANGE` + 合并文件名的三连行
 *
 * 注意 durationFallback 必须由调用方给出（初始写入用 targetDuration、追加用 0.001），
 * 两者原本就不同，统一会改变产物字节
 */
export function emitEntryLines(
    ranges: ByterangeRange[],
    combinedName: string,
    durationFallback: number
): string[] {
    const lines: string[] = [];
    for (const r of ranges) {
        const d = Number.isFinite(r.duration) && r.duration > 0 ? r.duration : durationFallback;
        lines.push(`#EXTINF:${d},${r.filename}`);
        lines.push(`#EXT-X-BYTERANGE:${r.len}@${r.offset}`);
        lines.push(combinedName);
    }
    return lines;
}

/** 原子写文本：先写 .tmp 再 rename，避免写到一半被读到 */
export async function atomicWriteText(filePath: string, text: string): Promise<void> {
    const tmp = filePath + '.tmp';
    await fs.writeFile(tmp, text, 'utf-8');
    await fs.rename(tmp, filePath);
}

/** EXTINF 行：`#EXTINF:4.000,文件名` */
const EXTINF_RE = /^#EXTINF:([^,]+),(.+)$/;
/** BYTERANGE 行：`#EXT-X-BYTERANGE:长度@偏移`（不带 @ 偏移的形式无法定位，视为不可信） */
const BYTERANGE_RE = /^#EXT-X-BYTERANGE:(\d+)@(\d+)$/;
/** MAP 行：`#EXT-X-MAP:URI="文件",BYTERANGE="长度@偏移"`，init 区间也占合并文件的空间 */
const MAP_RE = /^#EXT-X-MAP:URI="([^"]+)"(?:,BYTERANGE="(\d+)@(\d+)")?/;

/**
 * 解析已有 BYTERANGE 播放列表
 *
 * 只信"能对上号"的内容：条目必须指向同一个合并文件、BYTERANGE 必须带偏移、MAP 的区间也算进去。
 * 任何看不懂的地方都标记 suspicious —— 播种是"跳过下载"的依据，判错会导致漏录，
 * 所以宁可退回重新下载。
 */
export function parsePlaylistIndex(content: string, combinedName: string): PlaylistIndex {
    const seen = new Set<string>();
    const entries: PlaylistEntry[] = [];
    let maxEnd = 0;
    let totalDuration = 0;
    let suspicious = false;
    let reason: string | undefined;

    const fail = (why: string) => {
        if (!suspicious) { suspicious = true; reason = why; }
    };

    // 当前正在解析的条目：EXTINF 起头，BYTERANGE 补区间，URI 行收尾
    let current: { filename: string, duration: number, len?: number, offset?: number } | undefined;

    for (const rawLine of content.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line) continue;

        const map = MAP_RE.exec(line);
        if (map) {
            if (map[1] !== combinedName) {
                fail(`#EXT-X-MAP 指向的不是合并文件（${map[1]}）`);
            } else if (map[2] && map[3]) {
                maxEnd = Math.max(maxEnd, Number(map[2]) + Number(map[3]));
            } else {
                fail('#EXT-X-MAP 没有带 BYTERANGE，无法确认 init 区间');
            }
            continue;
        }

        const inf = EXTINF_RE.exec(line);
        if (inf) {
            const filename = inf[2].trim();
            const parsed = Number(inf[1]);
            const duration = Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
            // seen 保持宽松：只要出现 EXTINF 就算已收录 —— 与 append 里原来的去重逻辑逐字一致，
            // 改严会让"已收录"的分片被当成新分片再追加一次，产生重复条目
            seen.add(filename);
            current = { filename, duration };
            continue;
        }

        const br = BYTERANGE_RE.exec(line);
        if (br) {
            if (!current) {
                fail('出现没有对应 #EXTINF 的 BYTERANGE');
                continue;
            }
            current.len = Number(br[1]);
            current.offset = Number(br[2]);
            continue;
        }

        // 不带 @ 偏移的 BYTERANGE（顺序推断）无法校验，保守起见视为可疑
        if (line.startsWith('#EXT-X-BYTERANGE:')) {
            fail('存在不带偏移的 #EXT-X-BYTERANGE，无法校验');
            continue;
        }

        if (line.startsWith('#')) continue;

        // 非注释行 = 分片 URI（BYTERANGE 之后才出现，必须在这里校验它指向哪个文件）
        if (!current) continue;

        if (line !== combinedName) {
            fail(`分片 ${current.filename} 指向的不是合并文件（${line}）`);
        } else {
            const len = current.len ?? 0;
            const offset = current.offset ?? 0;
            entries.push({ filename: current.filename, uri: line, offset, len, duration: current.duration });
            totalDuration += current.duration;
            maxEnd = Math.max(maxEnd, len + offset);
        }
        current = undefined;
    }

    // 结尾挂着没有 URI 的 EXTINF → 文件可能被截断，这种列表不能用来跳过下载
    if (current) fail(`播放列表结尾的 #EXTINF（${current.filename}）没有对应的分片 URI，疑似被截断`);

    return { seen, entries, maxEnd, totalDuration, suspicious, reason };
}
