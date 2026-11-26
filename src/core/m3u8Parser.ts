// m3u8 解析：纯函数，无状态
import path from 'path';
import type { SegmentInfo } from '../model/hls.js';

export function parseM3U(content: string, baseUrl: string): SegmentInfo[] {
    const lines = content.split(/\r?\n/);
    const segments: SegmentInfo[] = [];
    let duration = 0;
    let awaitingSegment: {
        'duration': number;
        byterange?: { len: number; offset: number }
    } | null = null;
    let index = 0;

    for (let rawLine of lines) {
        const line = rawLine.trim();
        if (!line) continue;

        if (line.startsWith('#EXTINF:')) {
            // 兼容 "#EXTINF:4.17,filename" 与 "#EXTINF:4.17,"
            const m = line.match(/#EXTINF:([\d.]+)(?:,(.*))?/);
            duration = m ? parseFloat(m[1]) : 0;
            awaitingSegment = { duration };
            continue;
        }

        if (line.startsWith('#EXT-X-BYTERANGE:')) {
            const m = line.match(/#EXT-X-BYTERANGE:(\d+)(?:@(\d+))?/);
            if (m && awaitingSegment) {
                const len = parseInt(m[1], 10);
                const offset = m[2] ? parseInt(m[2], 10) : undefined;
                awaitingSegment.byterange = { len, offset: offset ?? 0 };
            }
            continue;
        }

        if (line.startsWith('#EXT-X-MAP:')) {
            // handled elsewhere
            continue;
        }

        if (line.startsWith('#')) {
            // 其他注释，忽略
            continue;
        }

        // 非注释行 -> segment uri (可能紧跟在 EXTINF 后，或没有 EXTINF)
        const uri = line.startsWith('http') ? line : new URL(line, baseUrl).toString();
        const match = uri.match(/\/([^/?#]+\.m4s)(?:[?#]|$)/);
        const filename = match ?
            match[1] :
            path.basename(new URL(uri).pathname) || `seg_${index}.m4s`;
        const segInfo: SegmentInfo = {
            index,
            'duration': awaitingSegment?.duration ?? duration ?? 0,
            'url': uri,
            filename,
        };
        if (awaitingSegment?.byterange)
            segInfo.byterange = awaitingSegment.byterange;
        segments.push(segInfo);
        index++;
        awaitingSegment = null;
    }

    return segments;
}

export function detectInitMap(content: string, baseUrl: string): {
    uri: string;
    byterange?: {
        len: number;
        offset: number
    }
} | undefined {
    const lines = content.split(/\r?\n/);
    for (const raw of lines) {
        const line = raw.trim();
        if (!line.startsWith('#EXT-X-MAP:'))
            continue;
        const uriMatch = line.match(/URI="([^"]+)"/);
        if (!uriMatch)
            return;
        const rawUri = uriMatch[1];
        const uri = rawUri.startsWith('http') ? rawUri : new URL(rawUri, baseUrl).toString();
        const brMatch = line.match(/BYTERANGE="(\d+)@(\d+)"/);
        if (brMatch) {
            return {
                uri,
                'byterange': {
                    'len': parseInt(brMatch[1], 10),
                    'offset': parseInt(brMatch[2], 10)
                }
            };
        } else {
            return { uri };
        }
    }
    return;
}
