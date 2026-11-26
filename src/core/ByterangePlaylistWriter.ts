// BYTERANGE 播放列表的写出与续写
//
// 从 HLSDownloader 拆出：只负责把已校验分片写进合并文件、维护播放列表。
// 所需外部状态（哪些分片已校验/已合并、init 信息、配置）通过 deps 显式传入，
// 不再隐式依赖下载器内部字段。
import fs from 'node:fs/promises';
import path from 'path';
import { is_fileExist } from '../utils/is_fileExist.js';
import { handleError } from '../utils/handleError.js';
import { atomicWriteText, emitEntryLines, parsePlaylistIndex } from './playlistByterange.js';
import { extractInitAndMedia } from './mp4BoxUtil.js';
import { applyTfdtOffsets } from './TfdtRewriter.js';
import type { ByterangeWriterDeps, SegmentInfo } from '../model/hls.js';

export class ByterangePlaylistWriter {
    constructor(private deps: ByterangeWriterDeps) { }

    /**
     * 读取分片字节，并按需平移 tfdt
     *
     * 上游切片器中途重启时间轴时，下载器会在合并前给出每轨的平移量；
     * 这里在写盘前应用，保证合并文件内部时间轴单调（否则播放会突然快进/卡住）。
     */
    private async readSegBytes(filename: string): Promise<Buffer> {
        const buf = await fs.readFile(path.join(this.deps.segmentsDir, filename));
        const offsets = this.deps.getTfdtOffsets?.(filename);
        if (!offsets || offsets.size === 0) return buf;
        const patched = applyTfdtOffsets(buf, offsets);
        if (patched !== buf) {
            global.logger.debug(`[HLSDownloader] 已平移 ${filename} 的 tfdt：${[...offsets].map(([t, d]) => `track ${t} +${d}`).join(', ')}`);
        }
        return patched;
    }

    async writeLocalM3U8(
        segments: SegmentInfo[],
        filename = 'index.m3u8',
        options?: { initFile?: string; targetDuration?: number; mediaSequence?: number; endList?: boolean }
    ): Promise<string> {
        if (!segments.length)
            throw new Error('无可写入的分片');

        const targetDuration = options?.targetDuration ?? Math.max(...segments.map(s => (s.duration > 0 ? s.duration : 0.001)));
        const mediaSequence = options?.mediaSequence ?? (segments[0]?.index ?? 0);

        const lines: string[] = [];
        lines.push('#EXTM3U');
        lines.push('#EXT-X-VERSION:7');
        lines.push('#EXT-X-PLAYLIST-TYPE:VOD');
        lines.push(`#EXT-X-TARGETDURATION:${Math.ceil(targetDuration) || 4}`);
        lines.push(`#EXT-X-MEDIA-SEQUENCE:${mediaSequence}`);
        if (options?.initFile) {
            const initRef = options.initFile;
            lines.push(`#EXT-X-MAP:URI="${initRef}"`);
        }

        for (const seg of segments) {
            const d = seg.duration > 0 ? seg.duration : targetDuration;
            lines.push(`#EXTINF:${d.toFixed(3)},`);
            const rel = this.deps.segmentsRel ? `${this.deps.segmentsRel.replace(/\\/g, '/')}/${seg.filename}` : seg.filename;
            lines.push(rel);
        }

        if (options?.endList !== false) {
            lines.push('#EXT-X-ENDLIST');
        }

        const outPath = path.join(this.deps.outputDir, filename);
        // 原子写入：先写临时文件再重命名
        const tmp = outPath + '.tmp';
        await fs.writeFile(tmp, lines.join('\n'), 'utf-8');
        await fs.rename(tmp, outPath);
        global.logger.info(`[HLSDownloader] 已生成 local m3u8: ${outPath}`);
        return outPath;
    }

    async writeLocalM3U8Byterange(
        segments: SegmentInfo[],
        playlistName = 'index-br.m3u8',
        combinedName = 'combined.m4s',
        options?: {
            targetDuration?: number;
            mediaSequence?: number;
            initMap?: { uri: string; byterange?: { len: number; offset: number } };
            finalize?: boolean;
        }
    ): Promise<{
        playlistPath: string;
        combinedPath: string;
        initBytes: number;
        /** 写完后合并文件的字节数（含 init），用于输出组大小限制 */
        combinedBytes: number;
        /** 该组播放列表当前总时长（秒），用于输出组时长限制 */
        durationSec: number;
    }> {
        // 调用方只传已通过本地结构校验的分片
        if (!segments.length)
            throw new Error('无可写入的分片');

        const combinedPath = path.join(this.deps.outputDir, combinedName);
        const tmpCombined = combinedPath + '.tmp';

        // 确保重写时不会同时有并发写入（调用方需保证）
        // 先写入 init（来自 initMap 或从第一个分片提取）
        let offset = 0;
        let initBytes = 0;
        const ranges: { len: number; offset: number; duration: number; filename: string }[] = [];

        const writer = await fs.open(tmpCombined, 'w');

        try {
            if (options?.initMap?.uri) {
                // 1) 外部提供的 init（通常来自 #EXT-X-MAP）
                let initBuf = Buffer.from(await this.deps.fetchInit(options.initMap.uri));
                if (options.initMap.byterange) {
                    const { len, offset: o } = options.initMap.byterange;
                    initBuf = initBuf.subarray(o, o + len);
                }
                await writer.write(initBuf);
                initBytes = initBuf.length;
                offset += initBytes;

                // 写入所有分片的“媒体部分”（剥掉每个文件里的 ftyp+moov）
                for (let i = 0; i < segments.length; i++) {
                    const seg = segments[i];
                    const segPath = path.join(this.deps.segmentsDir, seg.filename);
                    const fullBuf = await this.readSegBytes(seg.filename);
                    const { media } = extractInitAndMedia(fullBuf);

                    if (media.length) {
                        await writer.write(media);
                        ranges.push({
                            'len': media.length,
                            offset,
                            'duration': seg.duration || 0,
                            'filename': seg.filename,
                        });
                        offset += media.length;
                    }

                    if (!this.deps.keepSegments) {
                        try {
                            await fs.unlink(segPath);
                        } catch (e) {
                            global.logger.error(
                                `[HLSDownloader] 删除分片失败: ${handleError(e).errMsg}`
                            );
                        }
                    }
                }
            } else {
                // 2) 没有 initMap：从第一个分片里抽 ftyp+moov 作为 init
                const firstPath = path.join(this.deps.segmentsDir, segments[0].filename);
                const firstBuf = await this.readSegBytes(segments[0].filename);

                const { init, media } = extractInitAndMedia(firstBuf);

                if (init && init.length) {
                    await writer.write(init);
                    initBytes = init.length;
                    offset += initBytes;
                } else {
                    // 兼容：如果文件里没有 ftyp+moov，就退回到旧逻辑：以 moof 之前作为“伪 init”
                    const moofIdx = firstBuf.indexOf(Buffer.from('moof'));
                    // const moofIdx = firstBuf.indexOf(Uint8Array.from([0x6d, 0x6f, 0x6f, 0x66]));
                    const prefixLen = moofIdx > 0 ? moofIdx : 0;
                    if (prefixLen > 0) {
                        const initBuf = firstBuf.subarray(0, prefixLen);
                        await writer.write(initBuf);
                        initBytes = initBuf.length;
                        offset += initBytes;
                    }
                }

                // 写入第一个分片的媒体数据
                const firstMedia =
                    init && init.length
                        ? media
                        : initBytes > 0
                            ? firstBuf.subarray(initBytes)
                            : firstBuf;

                if (firstMedia.length) {
                    await writer.write(firstMedia);
                    ranges.push({
                        'len': firstMedia.length,
                        offset,
                        'duration': segments[0].duration || 0,
                        'filename': segments[0].filename,
                    });
                    offset += firstMedia.length;
                }

                if (!this.deps.keepSegments) {
                    try {
                        await fs.unlink(firstPath);
                    } catch (e) {
                        global.logger.error(
                            `[HLSDownloader] 删除首段失败: ${handleError(e).errMsg}`
                        );
                    }
                }

                // 追加剩余分片（同样剥掉可能存在的 ftyp+moov）
                for (let i = 1; i < segments.length; i++) {
                    const seg = segments[i];
                    const segPath = path.join(this.deps.segmentsDir, seg.filename);
                    const fullBuf = await this.readSegBytes(seg.filename);
                    const { media } = extractInitAndMedia(fullBuf);

                    if (media.length) {
                        await writer.write(media);
                        ranges.push({
                            'len': media.length,
                            offset,
                            'duration': seg.duration || 0,
                            'filename': seg.filename,
                        });
                        offset += media.length;
                    }

                    if (!this.deps.keepSegments) {
                        try {
                            await fs.unlink(segPath);
                        } catch (e) {
                            logger.error(
                                `[HLSDownloader] 删除分片失败: ${handleError(e).errMsg}`
                            );
                        }
                    }
                }
            }
        } finally {
            await writer.close();
        }


        // 原子替换 combined 文件（rename 在同文件系统下是原子操作）
        await fs.rename(tmpCombined, combinedPath);

        // build playlist
        const targetDuration =
            options?.targetDuration ??
            Math.max(
                ...ranges.map(r =>
                    Number.isFinite(r.duration) && r.duration > 0 ? r.duration : 0.001
                )
            );
        const mediaSequence = options?.mediaSequence ?? (segments[0]?.index ?? 0);

        const lines: string[] = [];
        lines.push('#EXTM3U');
        lines.push('#EXT-X-VERSION:7');
        lines.push(`#EXT-X-TARGETDURATION:${Math.ceil(targetDuration) || 2}`);
        lines.push('#EXT-X-START:TIME-OFFSET=0.0');
        lines.push('#EXT-X-INDEPENDENT-SEGMENTS');
        lines.push(`#EXT-X-MEDIA-SEQUENCE:${mediaSequence}`);
        if (initBytes > 0) {
            lines.push(
                `#EXT-X-MAP:URI="${combinedName}",BYTERANGE="${initBytes}@0"`
            );
        }

        lines.push(...emitEntryLines(ranges, combinedName, targetDuration));

        if (options?.finalize) lines.push('#EXT-X-ENDLIST');

        const playlistPath = path.join(this.deps.outputDir, playlistName);
        await atomicWriteText(playlistPath, lines.join('\n'));

        global.logger.info(`[HLSDownloader] 已生成 BYTERANGE 播放列表: ${playlistPath}`);

        // 只记录真正写进合并文件的分片（ranges 里是实际产出区间的那些）
        // 若按 segments 记录，遇到"文件已消失 / media 为空"被跳过的分片会被误标为已合并，
        // 之后永远不会再尝试，等于静默丢数据
        for (const r of ranges)
            this.deps.markAppended(r.filename, playlistName);

        const durationSec = ranges.reduce((sum, r) => sum + (Number.isFinite(r.duration) && r.duration > 0 ? r.duration : 0), 0);
        return { playlistPath, combinedPath, initBytes, 'combinedBytes': offset, durationSec };
    }

    async appendLocalM3U8Byterange(
        segments: SegmentInfo[],
        playlistName = 'index-br.m3u8',
        combinedName = 'combined.m4s',
        opts?: {
            /**
             * from-scratch 时是否强制用分片自带的 ftyp+moov 提炼 init
             * （新开的输出组必须如此：gateway 的 EXT-X-MAP 属于第一组的流，不适用于新分辨率）
             */
            initFromSegment?: boolean;
        }
    ): Promise<{
        added: number;
        playlistPath: string;
        combinedPath: string;
        /** 追加完成后合并文件的字节数，用于输出组大小限制 */
        combinedBytes: number;
        /** 追加完成后该组播放列表的总时长（秒），用于输出组时长限制 */
        durationSec: number;
    }> {
        const playlistPath = path.join(this.deps.outputDir, playlistName);
        const combinedPath = path.join(this.deps.outputDir, combinedName);

        if (!await is_fileExist(playlistPath) || !await is_fileExist(combinedPath)) {
            // 谨慎：from-scratch 会清空并重写合并文件，而它只认得"本次运行校验过"的分片。
            // 如果该组内存里已经有已合并记录（说明之前录过、只是文件被删/被挪走了），
            // 重建会把那些分片从播放列表里抹掉，等于把还能修的局面变成永久丢数据。
            const appendedCount = this.deps.appendedCount(playlistName);
            if (appendedCount > 0) {
                throw new Error(
                    `[HLSDownloader] 已有 ${appendedCount} 个已合并分片，但播放列表或合并文件缺失` +
                    `（playlist=${await is_fileExist(playlistPath)}，combined=${await is_fileExist(combinedPath)}）；` +
                    `拒绝重建以避免丢数据，请人工确认这两个文件后再运行`
                );
            }

            // initialize from scratch
            const created = await this.writeLocalM3U8Byterange(
                segments,
                playlistName,
                combinedName,
                {
                    'initMap': opts?.initFromSegment ? undefined : this.deps.getInitMap(),
                    'finalize': true
                }
            );
            return {
                'added': segments.length,
                playlistPath,
                combinedPath,
                'combinedBytes': created.combinedBytes,
                'durationSec': created.durationSec
            };
        }

        // read existing playlist and build seen set
        const existing = await fs.readFile(playlistPath, 'utf-8');
        const lines = existing.split(/\r?\n/);
        const index = parsePlaylistIndex(existing, combinedName);
        const { seen } = index;

        // 播放列表里出现过的分片 = 已合并，记进内存集合：
        // 重启后老分片的文件已被删除、集合又是空的，不记就会把它们整段重新下载一遍再丢弃
        for (const name of seen) this.deps.markAppended(name, playlistName);

        // 调用方只传已通过本地结构校验的分片
        const newSegs = segments.filter(s => !seen.has(s.filename));

        if (!newSegs.length) {
            global.logger.info('[HLSDownloader] 无新增已校验分片需要追加');
            const combinedBytes = await fs.stat(combinedPath).then(s => s.size).catch(() => index.maxEnd);
            return {
                'added': 0,
                playlistPath,
                combinedPath,
                combinedBytes,
                'durationSec': index.totalDuration
            };
        }

        // remove trailing ENDLISTs to append safely
        let last = lines[lines.length - 1];
        while (last && last.trim() === '#EXT-X-ENDLIST') {
            lines.pop();
            last = lines[lines.length - 1];
        }
        // rewrite playlist without ENDLIST
        const basePlaylist = lines.join('\n');
        await fs.writeFile(playlistPath, basePlaylist, 'utf-8');

        // compute current combined size: 先 open 再 stat 避免时序窗口
        const fh = await fs.open(combinedPath, 'a');
        let offset = (await fh.stat()).size;
        const ranges: { len: number; offset: number; duration: number; filename: string }[] = [];

        try {
            for (const seg of newSegs) {
                let buf: Buffer;
                try {
                    buf = await this.readSegBytes(seg.filename);
                } catch {
                    global.logger.warn(`[HLSDownloader] 分片 ${seg.filename} 在追加时已不存在，跳过`);
                    continue;
                }
                await fh.write(buf);
                ranges.push({
                    'len': buf.length,
                    offset,
                    'duration': seg.duration || 0,
                    'filename': seg.filename
                });
                offset += buf.length;
                if (!this.deps.keepSegments) {
                    try { await fs.unlink(path.join(this.deps.segmentsDir, seg.filename)); }
                    catch (e) { global.logger.error(`[HLSDownloader] 删除分片失败: ${handleError(e).errMsg}`); }
                }
            }
        } finally {
            await fh.close();
        }

        // append playlist entries
        // 追加路径的 duration 兜底是 0.001，与初始写入的 targetDuration 不同，不能统一
        const appendLines: string[] = emitEntryLines(ranges, combinedName, 0.001);
        appendLines.push('#EXT-X-ENDLIST');

        await fs.appendFile(playlistPath, '\n' + appendLines.join('\n'), 'utf-8');
        global.logger.info(`[HLSDownloader] 已追加 ${ranges.length} 个分片并更新播放列表: ${playlistPath}`);

        // 同上：按实际产出的区间记账，被跳过的分片（文件消失等）不算已合并
        for (const r of ranges)
            this.deps.markAppended(r.filename, playlistName);

        const durationSec = index.totalDuration
            + ranges.reduce((sum, r) => sum + (Number.isFinite(r.duration) && r.duration > 0 ? r.duration : 0), 0);
        return { added: ranges.length, playlistPath, combinedPath, 'combinedBytes': offset, durationSec };
    }

    async primeAppendedFromPlaylist(
        playlistName: string,
        combinedName: string
    ): Promise<{
        /** 播种的已合并分片数量（0 = 没有可用现场，将重新下载） */
        count: number;
        /** 合并文件当前字节数（含 init），用于续录后的大小限制 */
        sizeBytes: number;
        /** 播放列表记录的已合并总时长（秒），用于续录后的时长限制 */
        durationSec: number;
    }> {
        const playlistPath = path.join(this.deps.outputDir, playlistName);
        const combinedPath = path.join(this.deps.outputDir, combinedName);
        const empty = { 'count': 0, 'sizeBytes': 0, 'durationSec': 0 };

        try {
            if (!await is_fileExist(playlistPath) || !await is_fileExist(combinedPath)) return empty;

            const content = await fs.readFile(playlistPath, 'utf-8');
            const index = parsePlaylistIndex(content, combinedName);
            const { seen, maxEnd, totalDuration, suspicious, reason } = index;

            // 合并文件的实际大小总是可信的：即使播放列表不可用，也要把基准大小带出去，
            // 否则大小限制会从 0 重新计数，续录的文件可能远超上限
            const combinedSize = (await fs.stat(combinedPath)).size;
            const stats = { sizeBytes: combinedSize, durationSec: totalDuration };

            if (!seen.size) return { ...empty, ...stats };

            if (suspicious) {
                global.logger.warn(`[HLSDownloader] 已有播放列表不可信（${reason}），不跳过已合并分片，将重新下载`);
                return { ...stats, 'count': 0 };
            }

            if (combinedSize < maxEnd) {
                global.logger.warn(
                    `[HLSDownloader] 合并文件只有 ${combinedSize} 字节，播放列表却记录到 ${maxEnd} 字节，` +
                    `不跳过已合并分片（将重新下载）: ${combinedPath}`
                );
                return { ...stats, 'count': 0 };
            }

            for (const name of seen) this.deps.markAppended(name, playlistName);

            global.logger.info(
                `[HLSDownloader] 检测到已有录制现场：${seen.size} 个已合并分片（合并文件 ${combinedSize} 字节），本次将跳过重复下载`
            );
            return { 'count': seen.size, ...stats };
        } catch (err) {
            // 播种失败不是致命问题：退回"重新下载"即可，绝不能让启动流程挂掉
            global.logger.warn(`[HLSDownloader] 读取已有播放列表失败，本次不跳过已合并分片: ${handleError(err).msg}`);
            return empty;
        }
    }
}
