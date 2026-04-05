// src/core/HLSDownloader.ts
import fs from 'fs/promises';
import path from 'path';
import { Fetcher } from './Fetcher.js';
import { delay, exponentialDelay } from '../utils/delay.js';
import { is_dirExist } from '../utils/is_dirExist.js';
import { createDir } from '../utils/createDir.js';
import { is_fileExist } from '../utils/is_fileExist.js';
import { getFileSizeBytes } from '../utils/getFileSizeBytes.js';
import { handleError } from '../utils/handleError.js';
import crypto from 'crypto';
import detectMoofMdatFragments from './partDataFix/detectMoofMdatFragments.js';
import detectBoxSizeOrOffsetIssues from './partDataFix/detectBoxSizeOrOffsetIssues.js';
import CRC32 from "crc-32";

/**
 * HLS 下载器配置
 */
export interface HLSDownloaderConfig {
    /** 目标下载目录 */
    outputDir: string;
    /** 最大并发下载数（默认为 3） */
    concurrency?: number;
    /** 请求超时时间（ms） */
    timeout?: number;
    /** 最大重试次数 */
    maxRetry?: number;
    /** 是否保留中间的 .m4s 分片 */
    keepSegments?: boolean;
    /** 
     * 分片文件校验功能
     * - 此开启会将下载到的分片文件暂存到 Temp 目录中等待校验，校验完毕后再移动到目标目录
     * - 校验异常，会尝试从获取到的播放列表中还存在的 url 重新下载并校验
     * - 校验通过后，会将校验通过的分片文件移动到目标目录，并删除 Temp 目录中的文件
     */
    checkSegmentsChecksum?: boolean;
    /** 检测单分片在请求的播放列表中不存在的最大次数 */
    maxSegmentNotFoundCount?: number;
    /** 分片保存的子目录（相对 outputDir），便于调试归档 */
    segmentsSubdir?: string;
    /** 保存校验分片元信息的 JSON 文件路径（相对 outputDir） */
    segmentsMetaJSONPath?: string;
}

/**
 * 每个分片的元信息
 */
export interface SegmentInfo {
    index: number;
    duration: number;
    url: string;
    filename: string;
    byterange?: { len: number; offset: number };
}

/**
 * 每个分片的元信息（带 MD5、ETag、大小）
 */
export interface SegmentMetaData {
    /** 分片名 */
    filename: string;
    /** 分片 URL */
    url: Set<string> | string[] | string;
    /** 分片 MD5 值 */
    MD5: {
        /** 远端服务器的值 */
        remote: string;
        /** 本地计算的值 */
        local: string;
    };
    /** 分片 ETag 值 */
    ETag: SegmentMetaData['MD5'];
    /** 分片大小 */
    size: {
        /** 远端服务器的值 */
        remote: number;
        /** 本地计算的值 */
        local: number;
    };
}

type ListBoxes = {
    /** 解析状态 */
    ok: boolean;
    /** 解析信息 */
    reason: string;
    /** 解析结果 */
    boxes: Array<{
        /** box 所在的起始位置 */
        offset: number;
        /** box 大小 */
        size: number;
        /** box 类型 */
        type: string;
    }>
}

/**
 * HLSDownloader
 * 改进点：
 * - 更健壮的 m3u8 解析（支持 BYTERANGE、EXTINF 容错）
 * - worker 池式并发下载（避免递归 + new Promise）
 * - 安全写入 combined file（临时文件 + 重命名）
 * - 更明确的日志与错误处理
 */
export class HLSDownloader {
    private fetcher: Fetcher;
    private config: Required<HLSDownloaderConfig>;
    /** 分片保存的实际目录（绝对路径） */
    private segmentsDir: string;
    /** 分片目录的相对引用（用于 simple m3u8 中的路径） */
    private segmentsRel?: string;
    /** 已合并并记录到本地 BYTERANGE M3U8 的分片文件名（用于 keepSegments=false 时跳过重复下载） */
    private appendedSegments: Set<string> = new Set();
    /** 临时记录已下载分片的元信息 */
    private downloadedSegmentsTemp: Map<string, SegmentMetaData> = new Map();

    // private lastSegmentInfo: { lock: boolean; info: Map<SegmentInfo['filename'], SegmentInfo> } = {
    //     lock: false,
    //     info: new Map(),
    // };

    private testSegmentsMeta: Map<string, { filename: string; url: string; MD5: string; ETag: string; size: number, 'x-cos-hash-crc64ecma': string }> = new Map();

    private pendingChecksumQueue: Map<string, SegmentMetaData> = new Map();
    // private lostSegments: Set<string> = new Set();

    private lastInitMap?: { uri: string; byterange?: { len: number; offset: number } };

    constructor(config: HLSDownloaderConfig) {
        this.config = {
            concurrency: 8,
            timeout: 10000,
            maxRetry: 3,
            keepSegments: true,
            segmentsSubdir: './fragments',
            checkSegmentsChecksum: true,
            maxSegmentNotFoundCount: 5,
            segmentsMetaJSONPath: './segments.json',
            ...config,
        };

        this.fetcher = new Fetcher(this.config.maxRetry);

        // 计算分片保存目录
        this.segmentsRel = this.config.segmentsSubdir;
        this.segmentsDir = this.segmentsRel
            ? path.join(this.config.outputDir, this.segmentsRel)
            : this.config.outputDir;
    }

    /**
     * 下载入口：拉取 m3u8、解析、确保目录、并发下载分片
     */
    async downloadPlaylist(
        m3u8Url: string,
        generate?: {
            type?: 'simple' | 'byterange';
            filename?: string;
            combinedName?: string;
            initFile?: string;
            targetDuration?: number;
            mediaSequence?: number;
        }
    ): Promise<SegmentInfo[]> {
        global.logger.info(`[HLSDownloader] 获取播放列表: ${m3u8Url}`);

        const response = await this.fetcher.httpErrRepeat<string>(
            m3u8Url,
            { timeout: this.config.timeout },
            'text'
        );

        const segments = this.parseM3U(response.data, m3u8Url);

        this.lastInitMap = this.detectInitMap(response.data, m3u8Url);
        global.logger.info(`[HLSDownloader] 解析到 ${segments.length} 个分片`);

        // 确保目录存在
        if (!(await is_dirExist(this.config.outputDir, { throwError: true })).is_dir)
            await createDir(this.config.outputDir);

        // 若设置了分片子目录，确保其存在
        if (
            this.segmentsDir !== this.config.outputDir &&
            !(await is_dirExist(this.segmentsDir, { throwError: true })).is_dir
        )
            await createDir(this.segmentsDir);

        // 如果设置了分片校验，则需要在分片子目录下创建临时目录
        if (
            this.config.checkSegmentsChecksum &&
            !(await is_dirExist(path.join(this.config.outputDir, 'Temp'), { throwError: true })).is_dir
        )
            await createDir(path.join(this.config.outputDir, 'Temp'));

        // 下载并返回
        await this.downloadSegments(segments);
        global.logger.info('[HLSDownloader] 分片下载流程结束');

        // 新增：检测时间跳跃点
        // const segmentGroups = this.detectSegmentGaps(segments, 2.5); // 阈值 2.5 秒

        // 生成本地播放列表（可选）
        if (generate?.type === 'simple') {
            // const groups = this.detectSegmentGaps(segments, 2.5);
            // for (let i = 0; i < groups.length; i++) {
            //     const ts = new Date().toISOString().replace(/[:.]/g, '');
            //     const file = `index_part${i + 1}_${ts}.m3u8`;
            //     await this.writeLocalM3U8(groups[i], file, {
            //         targetDuration: generate.targetDuration,
            //         mediaSequence: generate.mediaSequence,
            //         initFile: generate.initFile,
            //     });
            //     global.logger.info(`[HLSDownloader] 生成分段播放列表: ${file}`);
            // }

            const filename = generate.filename ?? 'index.m3u8';
            await this.writeLocalM3U8(segments, filename, {
                'targetDuration': generate.targetDuration,
                'mediaSequence': generate.mediaSequence,
                'initFile': generate.initFile,
            });
        } else if (generate?.type === 'byterange') {
            const filename = generate.filename ?? 'index-br.m3u8';
            const combinedName = generate.combinedName ?? 'combined.m4s';
            await this.writeLocalM3U8Byterange(segments, filename, combinedName, {
                'targetDuration': generate.targetDuration,
                'mediaSequence': generate.mediaSequence,
                'initMap': this.lastInitMap,
            });
        }

        return segments;
    }

    /**
     * 解析 m3u8（兼容相对/绝对 URL、BYTERANGE 行、容错的 EXTINF 格式）
     */
    private parseM3U(content: string, baseUrl: string): SegmentInfo[] {
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

    /**
     * 检测并解析 #EXT-X-MAP（返回绝对 URI + 可选 byterange）
     */
    private detectInitMap(content: string, baseUrl: string): {
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

    /**
     * 下载所有分片：基于 worker 池的并发实现，避免递归与复杂 promise 控制
     */
    private async downloadSegments(segments: SegmentInfo[]): Promise<void> {
        if (!segments.length)
            return;

        const queue = segments.slice(); // FIFO
        const concurrency = Math.max(1, Math.min(64, this.config.concurrency));
        let processed = 0;
        const errors: Error[] = [];
        // const nowSegments: Map<SegmentInfo['filename'], SegmentInfo> = new Map();

        const workers: Promise<void>[] = [];

        const getNext = () => {
            // safe shift
            return queue.length ? queue.shift()! : undefined;
        };

        const worker = async () => {
            while (true) {
                const seg = getNext();
                if (!seg)
                    break;
                try {
                    await this.downloadSegmentWithRetry(seg);
                    // if (this.config.checkSegmentsChecksum) {
                    //     if (!this.lastSegmentInfo.lock) {
                    //         this.lastSegmentInfo.info.set(seg.filename, seg);
                    //     } else {
                    //         nowSegments.set(seg.filename, seg);
                    //     }
                    // }
                    processed++;
                } catch (err) {
                    const { errObj, errMsg } = handleError(err);
                    // 记录错误但继续其他任务，避免单个分片卡住整个队列
                    global.logger.error(`[HLSDownloader] 下载分片失败（略过）: ${seg.filename} -> ${errMsg}`);
                    if (errObj instanceof Error)
                        errors.push(errObj);
                    else {
                        global.logger.error(`[HLSDownloader] 未知错误类型: ${errMsg}`);
                        errors.push(new Error(errMsg));
                    }
                }
            }
        };

        for (let i = 0; i < concurrency; i++) {
            workers.push(worker());
        }

        await Promise.all(workers);

        if (errors.length) {
            global.logger.warn(`[HLSDownloader] 下载完成，但存在 ${errors.length} 个失败分片（已记录并跳过）`);
        } else {
            global.logger.info(`[HLSDownloader] 全部 ${processed} 个分片下载成功`);
        }

        // 写入到本地校验分片元信息（可选）
        if (this.config.checkSegmentsChecksum) {
            let str = '';
            // 遍历 this.testSegmentsMeta 并打印到日志中
            for (const [filename, metaData] of this.testSegmentsMeta) {
                str += `filename: ${filename} -> url: ${metaData.url} -> MD5: ${metaData.MD5} -> ETag: ${metaData.ETag} -> size: ${metaData.size} -> x-cos-hash-crc64ecma: ${metaData['x-cos-hash-crc64ecma']}\n`;
            }

            global.logger.debug(`[HLSDownloader] 校验分片元信息: \n${str}`);

            this.testSegmentsMeta.clear();
        }
    }

    /**
     * 单分片下载封装：使用 fetcher (带重试)，并进行基本本地校验
     */
    private async downloadSegmentWithRetry(seg: SegmentInfo, options?: { retryCount: number, maxRetry: number }): Promise<void> {
        const destPath = path.join(this.segmentsDir, seg.filename);
        // const tempPath = path.join(this.config.outputDir, './Temp', seg.filename);
        const tmpPath = destPath + '.temp';
        let fileStreamCRC32 = '';

        if (!options?.retryCount || !options?.maxRetry) {
            options = { retryCount: 0, maxRetry: 3 };
        };

        if (options.retryCount > options.maxRetry) {
            throw new Error(`分片 ${seg.filename} 下载失败，超过最大重试次数 ${options.maxRetry}`);
        }

        // 收集分片的响应头信息
        const getHeadersInfo = async () => {
            if (this.testSegmentsMeta.has(seg.filename)) {
                const segmentMetaData = this.testSegmentsMeta.get(seg.filename)!;
                if (segmentMetaData?.ETag !== '') {
                    return;
                }
            }

            try {
                const response = await this.fetcher.getRequestHeadersOnly(seg.url, { timeout: this.config.timeout });

                const remoteSize = Number(response.headers.get('Content-Length'));

                const ETag = this.parseETag((response.headers.get('ETag') || '')
                    .replace(/"/g, "").trim());
                const partMetaData = {
                    'filename': seg.filename,
                    'url': seg.url,
                    'MD5': (response.headers.get('Content-MD5') || '')
                        .replace(/"/g, "").trim(),
                    'ETag': (ETag?.version ? '' : ETag?.hash) || '',
                    'x-cos-hash-crc64ecma': (response.headers.get('x-cos-hash-crc64ecma') || '')
                        .replace(/"/g, "").trim(),
                    'size': !Number.isNaN(remoteSize) ? remoteSize : 0,
                };

                this.testSegmentsMeta.set(seg.filename, partMetaData);
            } catch (error) {
                global.logger.error(`[HLSDownloader] 获取分片响应头失败: ${handleError(error).errMsg}`);
            }

        }

        const downloadAndCheck = async () => {
            // 文件已合并，则跳过下载
            if (this.appendedSegments.has(seg.filename)) {
                global.logger.debug(`[HLSDownloader] ${seg.filename} 已合并，跳过下载`);
                return;
            }

            // 已下载到 dest 的情况
            if (await is_fileExist(destPath)) {
                global.logger.debug(`[HLSDownloader] ${seg.filename} 已存在，跳过`);
                return;
            }

            // // 文件校验功能
            // if (await this.checkSegmentsChecksum(seg, {
            //     dest: destPath,
            //     temp: tempPath,
            // })) {
            //     // 文件校验通过，直接移动到目标目录
            //     await fs.rename(tempPath, destPath);  // Move file to final directory
            //     global.logger.info(`[HLSDownloader] 文件校验完成，移动至目标目录: ${destPath}`);
            //     return;
            // }

            try {
                const response = await this.fetcher.httpErrRepeat<ArrayBuffer>(
                    seg.url,
                    { timeout: this.config.timeout },
                    'arrayBuffer'
                );

                const localPartData = Buffer.from(response.data);
                fileStreamCRC32 = this.crc32Hex(localPartData);

                // 文件校验功能
                if (this.config.checkSegmentsChecksum) {
                    const remoteSize = Number(response.headers.get('Content-Length'));

                    const partMetaData: SegmentMetaData = {
                        'filename': seg.filename,
                        'url': seg.url,
                        'MD5': {
                            'remote': (response.headers.get('Content-MD5') || '')
                                .replace(/"/g, "").trim(),
                            'local': this.md5Base64(localPartData)
                        },
                        'ETag': {
                            'remote': (response.headers.get('ETag') || '')
                                .replace(/"/g, "").trim(),
                            'local': this.md5Hex(localPartData)
                        },
                        'size': {
                            'remote': !Number.isNaN(remoteSize) ? remoteSize : 0,
                            'local': localPartData.byteLength
                        },
                    };

                    global.logger.debug(`partMetaData: ${JSON.stringify(partMetaData)}`);

                    // 检测 moov box 是否存在且完整
                    const checkMoovIntegrity = this.detectMoovIntegrity(localPartData);
                    global.logger.debug(`[HLSDownloader] 检测分片 ${seg.filename} 的 moov box 是否完整：\n${JSON.stringify(checkMoovIntegrity)}`);
                    if (!checkMoovIntegrity.valid) {
                        global.logger.error(`[HLSDownloader] 分片 ${seg.filename} 的 moov box 缺失或不完整，重新下载`);
                        options.retryCount++;
                        return await this.downloadSegmentWithRetry(seg, options);
                    }

                    // 检测 moof/mdat 片段的完整性
                    const checkMoofMdatFragments = detectMoofMdatFragments(localPartData);
                    global.logger.debug(`[HLSDownloader] 检测分片 ${seg.filename} 的 moof/mdat 片段是否完整：\n${JSON.stringify(checkMoofMdatFragments)}`);
                    const moofMdatIssue = checkMoofMdatFragments.find(item => !item.moof?.ok || !item.mdat?.ok);
                    if (moofMdatIssue) {
                        global.logger.error(`[HLSDownloader] 分片 ${seg.filename} 的 moof/mdat 片段缺失或不完整，重新下载`);
                        global.logger.debug(`[HLSDownloader] 分片 ${seg.filename} moof/mdat 片段缺失或不完整，\n${JSON.stringify(moofMdatIssue)}`);
                        options.retryCount++;
                        return await this.downloadSegmentWithRetry(seg, options);
                    }

                    // 检测 FMP4 分片 box 尺寸或偏移异常
                    const checkBoxSizeOrOffsetIssues = detectBoxSizeOrOffsetIssues(localPartData);
                    global.logger.debug(`[HLSDownloader] 检测分片 ${seg.filename} 的 FMP4 box 尺寸或偏移异常：\n${JSON.stringify(detectBoxSizeOrOffsetIssues(localPartData))}`);
                    if (checkBoxSizeOrOffsetIssues.issues.length) {
                        global.logger.error(`[HLSDownloader] 分片 ${seg.filename} 的 FMP4 box 尺寸或偏移异常，重新下载`);
                        global.logger.debug(`[HLSDownloader] 分片 ${seg.filename} 的 FMP4 box 尺寸或偏移异常，\n${JSON.stringify(checkBoxSizeOrOffsetIssues.issues)}`);
                        options.retryCount++;
                        return await this.downloadSegmentWithRetry(seg, options);
                    }

                    // const getPartMetaData = this.downloadedSegmentsTemp.get(seg.filename);
                    // if (getPartMetaData && getPartMetaData?.url instanceof Set) {
                    //     getPartMetaData.url.add(seg.url);
                    // } else {
                    //     partMetaData.url = new Set([seg.url]);
                    //     this.downloadedSegmentsTemp.set(seg.filename, partMetaData);
                    // }

                    await fs.writeFile(tmpPath, localPartData);
                    // await fs.writeFile(tempPath, localPartData);

                    // // 如果没有远程校验信息，将其加入延迟校验队列
                    // if (partMetaData.MD5.remote === '' && partMetaData.ETag.remote === '') {
                    //     this.pendingChecksumQueue.set(seg.filename, partMetaData);
                    // }
                } else {
                    await fs.writeFile(tmpPath, localPartData);
                }

                // 再次校验写入文件一致性
                const written = await fs.readFile(tmpPath);
                if (fileStreamCRC32 !== this.crc32Hex(written)) {
                    global.logger.error(`[HLSDownloader] 写入后数据不一致，重写: ${seg.filename}`);
                    await fs.writeFile(tmpPath, localPartData);
                }
                global.logger.debug(`[HLSDownloader] 校验写入文件一致性成功 -> ${seg.filename}`);
                // 原子替换目标文件
                await fs.rename(tmpPath, destPath);

                global.logger.info(`[HLSDownloader] 下载完成 -> ${seg.filename}`);

                await delay(20);
            } catch (err) {
                // 再尝试一次指数退避后重试（作为额外保险）
                const backoff = exponentialDelay(500, 2, 1, 3000);
                global.logger.warn(`[HLSDownloader] 下载 ${seg.filename} 出错，稍后再试 ${backoff}ms: ${handleError(err).errMsg}`);
                await delay(backoff);
                // 最后一次尝试（若仍失败则抛出）
                const response = await this.fetcher.httpErrRepeat<ArrayBuffer>(
                    seg.url,
                    { timeout: this.config.timeout },
                    'arrayBuffer'
                );
                const localPartData = Buffer.from(response.data);
                await fs.writeFile(tmpPath, localPartData);
                // 再次校验写入文件一致性
                const written = await fs.readFile(tmpPath);
                if (fileStreamCRC32 !== this.crc32Hex(written)) {
                    global.logger.error(`[HLSDownloader] 写入后数据不一致，重写: ${seg.filename}`);
                    await fs.writeFile(tmpPath, localPartData);
                }
                global.logger.info(`[HLSDownloader] 复试成功 -> ${seg.filename}`);
                // 原子替换目标文件
                await fs.rename(tmpPath, destPath);
            }
        }

        await Promise.all([
            getHeadersInfo(),
            downloadAndCheck(),
        ]);

    }

    /**
     * 生成标准 simple m3u8（相对引用分片），可选包含 initFile 与 ENDLIST（VOD）
     */
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
            const rel = this.segmentsRel ? `${this.segmentsRel.replace(/\\/g, '/')}/${seg.filename}` : seg.filename;
            lines.push(rel);
        }

        if (options?.endList !== false) {
            lines.push('#EXT-X-ENDLIST');
        }

        const outPath = path.join(this.config.outputDir, filename);
        // 原子写入：先写临时文件再重命名
        const tmp = outPath + '.tmp';
        await fs.writeFile(tmp, lines.join('\n'), 'utf-8');
        await fs.rename(tmp, outPath);
        global.logger.info(`[HLSDownloader] 已生成 local m3u8: ${outPath}`);
        return outPath;
    }

    /**
     * 生成 BYTERANGE 播放列表与合并文件（更健壮实现）
     * - 会创建临时 combined file（combined.tmp），写入 init (来自 initMap 或从首段提取 ftyp+moov）
     * - 追加所有分片数据（仅 moof+mdat），计算 len@offset，并生成 playlist（带 MAP）
     */
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
    ): Promise<{ playlistPath: string; combinedPath: string; initBytes: number }> {
        if (!segments.length)
            throw new Error('无分片可写入');

        const combinedPath = path.join(this.config.outputDir, combinedName);
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
                const response = await this.fetcher.httpErrRepeat<ArrayBuffer>(
                    options.initMap.uri,
                    { timeout: this.config.timeout },
                    'arrayBuffer'
                );
                let initBuf = Buffer.from(response.data);
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
                    const segPath = path.join(this.segmentsDir, seg.filename);
                    const fullBuf = await fs.readFile(segPath);
                    const { media } = this.extractInitAndMedia(fullBuf);

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

                    if (!this.config.keepSegments) {
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
                const firstPath = path.join(this.segmentsDir, segments[0].filename);
                const firstBuf = await fs.readFile(firstPath);

                const { init, media } = this.extractInitAndMedia(firstBuf);

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

                if (!this.config.keepSegments) {
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
                    const segPath = path.join(this.segmentsDir, seg.filename);
                    const fullBuf = await fs.readFile(segPath);
                    const { media } = this.extractInitAndMedia(fullBuf);

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

                    if (!this.config.keepSegments) {
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

        // （可选）如果你已经实现了 normalizeTfdtGlobal，可以在这里对 tmpCombined 做一次 tfdt 归一化
        // try {
        //     const raw = await fs.readFile(tmpCombined);
        //     const patched = this.normalizeTfdtGlobal(raw);
        //     await fs.writeFile(tmpCombined, patched);
        // } catch (e) {
        //     logger.warn(`[HLSDownloader] tfdt 归一化失败（忽略）: ${handleError(e).errMsg}`);
        // }

        // 原子替换 combined 文件
        if (await is_fileExist(combinedPath)) {
            // 先备份旧文件
            const bak = combinedPath + '.bak-' + Date.now();
            try {
                await fs.rename(combinedPath, bak);
            } catch (e) {
                global.logger.warn(
                    `[HLSDownloader] 备份旧 combined 文件失败（忽略）: ${handleError(e).errMsg}`
                );
            }
        }
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

        for (const r of ranges) {
            const d =
                Number.isFinite(r.duration) && r.duration > 0
                    ? r.duration
                    : targetDuration;
            lines.push(`#EXTINF:${d},${r.filename}`);
            lines.push(`#EXT-X-BYTERANGE:${r.len}@${r.offset}`);
            lines.push(combinedName);
        }

        if (options?.finalize) lines.push('#EXT-X-ENDLIST');

        const playlistPath = path.join(this.config.outputDir, playlistName);
        const tmpPlaylist = playlistPath + '.tmp';
        await fs.writeFile(tmpPlaylist, lines.join('\n'), 'utf-8');
        await fs.rename(tmpPlaylist, playlistPath);
        global.logger.info(`[HLSDownloader] 已生成 BYTERANGE 播放列表: ${playlistPath}`);

        // 记录已追加的分片
        for (const s of segments)
            this.appendedSegments.add(s.filename);

        return { playlistPath, combinedPath, initBytes };
    }

    /**
     * 追加分片到已存在的 combined.m4s + 更新 playlist（安全追加）
     * - 会读取当前 combined 文件大小作为 offset
     * - 追加分片二进制并计算 len@offset，然后在 playlist 末尾追加条目
     */
    async appendLocalM3U8Byterange(
        segments: SegmentInfo[],
        playlistName = 'index-br.m3u8',
        combinedName = 'combined.m4s'
    ): Promise<{ added: number; playlistPath: string; combinedPath: string }> {
        const playlistPath = path.join(this.config.outputDir, playlistName);
        const combinedPath = path.join(this.config.outputDir, combinedName);

        if (!await is_fileExist(playlistPath) || !await is_fileExist(combinedPath)) {
            // initialize from scratch
            await this.writeLocalM3U8Byterange(
                segments,
                playlistName,
                combinedName,
                {
                    'initMap': this.lastInitMap,
                    'finalize': true
                }
            );
            return {
                'added': segments.length,
                playlistPath,
                combinedPath
            };
        }

        // read existing playlist and build seen set
        const existing = await fs.readFile(playlistPath, 'utf-8');
        const lines = existing.split(/\r?\n/);
        const seen = new Set<string>();
        const INF_RE = /^#EXTINF:[^,]+,(.+)$/;
        for (const l of lines) {
            if (!l.startsWith('#EXTINF:'))
                continue;
            const m = INF_RE.exec(l);
            if (m) seen.add(m[1].trim());
        }

        const newSegs = segments.filter(s => !seen.has(s.filename));
        if (!newSegs.length) {
            global.logger.info('[HLSDownloader] 无新增分片需要追加');
            return {
                'added': 0,
                playlistPath,
                combinedPath
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

        // compute current combined size
        let offset = await getFileSizeBytes(combinedPath);
        const fh = await fs.open(combinedPath, 'a');
        const ranges: { len: number; offset: number; duration: number; filename: string }[] = [];

        try {
            for (const seg of newSegs) {
                const segPath = path.join(this.segmentsDir, seg.filename);
                const buf = await fs.readFile(segPath);
                await fh.write(buf);
                ranges.push({
                    'len': buf.length,
                    offset,
                    'duration': seg.duration || 0,
                    'filename': seg.filename
                });
                offset += buf.length;
                if (!this.config.keepSegments) {
                    try { await fs.unlink(segPath); }
                    catch (e) { global.logger.error(`[HLSDownloader] 删除分片失败: ${handleError(e).errMsg}`); }
                }
            }
        } finally {
            await fh.close();
        }

        // append playlist entries
        const appendLines: string[] = [];
        for (const r of ranges) {
            const d = Number.isFinite(r.duration) && r.duration > 0 ? r.duration : 0.001;
            appendLines.push(`#EXTINF:${d},${r.filename}`);
            appendLines.push(`#EXT-X-BYTERANGE:${r.len}@${r.offset}`);
            appendLines.push(combinedName);
        }
        appendLines.push('#EXT-X-ENDLIST');

        await fs.appendFile(playlistPath, '\n' + appendLines.join('\n'), 'utf-8');
        global.logger.info(`[HLSDownloader] 已追加 ${ranges.length} 个分片并更新播放列表: ${playlistPath}`);

        for (const s of newSegs)
            this.appendedSegments.add(s.filename);

        return { added: ranges.length, playlistPath, combinedPath };
    }

    /**
     * 解析一个 m4s/mp4 缓冲区：
     * - 如果开头是 ftyp + moov，则作为 init 返回；
     * - 其后部分作为 media 返回；
     * - 如果没有完整的 ftyp + moov，则 init=null，整块作为 media。
     */
    private extractInitAndMedia(buf: Buffer): { init: Buffer | null; media: Buffer } {
        let offset = 0;
        const len = buf.length;

        const readBox = (start: number): { type: string; size: number } | null => {
            if (start + 8 > len)
                return null;
            const size = buf.readUInt32BE(start);
            const type = buf.toString('ascii', start + 4, start + 8);
            if (size < 8 || start + size > len)
                return null;
            return { type, size };
        };

        // 第一个 box 必须是 ftyp
        const box1 = readBox(offset);
        if (!box1 || box1.type !== 'ftyp') {
            return { init: null, media: buf };
        }
        offset += box1.size;

        // 第二个 box 必须是 moov
        const box2 = readBox(offset);
        if (!box2 || box2.type !== 'moov') {
            return { init: null, media: buf };
        }
        offset += box2.size;

        const init = buf.subarray(0, offset);
        const media = buf.subarray(offset);

        return { init, media };
    }

    /**
     * 计算缓冲区的 md5 值
     * @param buf 原始 m4s/mp4 缓冲区
     * @returns md5 值（16进制字符串）
     */
    private md5Hex(buf: Buffer): string {
        return crypto.createHash('md5').update(buf).digest('hex');
    }

    /**
     * 解析 ETag 值
     * @param etag ETag 值
     * @returns { hash: string; version?: number } | null
     */
    private parseETag(etag: string): { hash: string; version?: number } | null {
        const m = /^"?([a-fA-F0-9]{32})(?:-(\d+))?"?$/.exec(etag);
        return m ? { hash: m[1].toLowerCase(), version: m[2] ? parseInt(m[2]) : undefined } : null;
    }

    /**
     * 计算缓冲区的 base64 编码的 md5 值
     * @param buf 原始 m4s/mp4 缓冲区
     * @returns base64 编码的 md5 值
     */
    private md5Base64(buf: Buffer): string {
        return Buffer.from(this.md5Hex(buf), 'hex').toString('base64');
    }

    /**
     * 计算缓冲区的 crc32 值（16进制字符串）
     * @param data 原始 m4s/mp4 缓冲区
     * @returns crc32 值（16进制字符串）
     */
    private crc32Hex(data: Buffer): string {
        const val = CRC32.buf(data) >>> 0; // 确保为无符号
        return val.toString(16).padStart(8, '0');
    }

    /**
     * 检测分片校验和
     * @param segments 分片信息数组
     */
    private async checkSegmentsChecksum(
        seg: SegmentInfo,
        segPath: { dest: string, temp: string }

    ): Promise<boolean> {
        if (!this.config.checkSegmentsChecksum)
            return false;

        // 对还在下载队列中的分片，进行延迟校验
        // if(this.pendingChecksumQueue.has(seg.filename)) {
        //     global.logger.debug(`[HLSDownloader] ${seg.filename} 正在下载，延迟校验`);
        //     await this.processPendingChecks();
        //     return false;
        // }

        // 判断分片名对应 map 数据是否存在 MD5 或 ETag 值
        const partMetaData = this.downloadedSegmentsTemp.get(seg.filename);
        if (!partMetaData) {
            // 若分片名对应 map 数据不存在，则说明分片已下载完成，但校验数据未不存在，重新获取并存储
            global.logger.debug(`[HLSDownloader] ${seg.filename} 已存在，但校验数据不存在，重新获取并存储`);
            // 重新下载
            // await this.downloadSegmentWithRetry(seg);
            return false;
        }

        const { MD5, ETag, size } = partMetaData;

        const localPartData = await fs.readFile(segPath.dest);

        switch (true) {
            // 若本地分片大小与远端分片大小不一致，则说明分片已损坏，重新下载
            case size.remote !== size.local:
                break;
            // MD5 或 ETag 值需要存在才可进行校验
            case MD5.remote === '' || ETag.remote === '':
                break;
            // 若本地分片 MD5 或 ETag 值与远端分片值一致，则说明分片已下载完成，跳过
            case MD5.remote && MD5.local === this.md5Base64(localPartData):
                global.logger.debug(`[HLSDownloader] ${seg.filename} 已存在，MD5 值匹配`);
                return true;
            // 若本地分片 ETag 值与远端分片值一致，则说明分片已下载完成，跳过
            case ETag.remote && ETag.local === this.md5Hex(localPartData):
                global.logger.debug(`[HLSDownloader] ${seg.filename} 已存在，ETag 值匹配`);
                return true;
            // 都未匹配，说明分片已损坏，重新下载
            default:
                global.logger.debug(`[HLSDownloader] ${seg.filename} 已损坏，重新下载`);
                break;
        }

        // 移除已标记的分片名
        this.downloadedSegmentsTemp.delete(seg.filename);

        // 重新下载
        // await this.downloadSegmentWithRetry(seg);
        return false;
    }

    /**
     * 处理延迟校验队列：当远程校验信息缺失时，调用此方法补全校验
     */
    public async processPendingChecks(): Promise<void> {
        for (const [filename, partMetaData] of this.pendingChecksumQueue) {
            const seg = { filename, url: '', index: 0, duration: 0 }; // 需要根据上下文补全
            const partData = await this.downloadSegmentWithRetry(seg);
            // 如果校验成功则从延迟队列中移除
            if (partMetaData) {
                this.pendingChecksumQueue.delete(filename);
            }
        }
    }

    /**
     * 根据连续分片 duration 判断是否存在时间跳跃
     * @param segments 已下载分片信息
     * @param threshold 跳跃阈值（秒）
     * @returns 分组后的分片数组
     */
    private detectSegmentGaps(segments: SegmentInfo[], threshold: number): SegmentInfo[][] {
        if (segments.length === 0)
            return [];

        const groups: SegmentInfo[][] = [];
        let current: SegmentInfo[] = [segments[0]];

        for (let i = 1; i < segments.length; i++) {
            const gap = Math.abs(segments[i].index - segments[i - 1].index);
            // 如果索引跨度过大或 duration 异常
            if (gap > 1 || Math.abs(segments[i].duration - segments[i - 1].duration) > threshold) {
                groups.push(current);
                current = [segments[i]];
            } else {
                current.push(segments[i]);
            }
        }
        if (current.length) groups.push(current);
        return groups;
    }

    /**
     * 获取分片请求头
     * @param seg 分片信息
     */
    // private getSegmentHeaders(seg: SegmentInfo): Record<string, string> { }



    /**
     * 以下为待测试 code
     */


    /**
     * 分片修复系统
     */

    private TOP_BOX_TYPES = new Set([
        'moov', 'moof', 'mdat', 'free', 'skip', 'wide', 'pnot', 'udta', 'sidx', 'styp', 'uuid', 'meta', 'ftyp'
    ]);

    /**
     * 在前若干字节（默认 512）里尝试“识别并修复”因脏字节导致的 ftyp 头缺失问题：
     * - 场景：文件开头不是合法 box；但某个偏移处开始出现了 ftyp 的有效负载（major_brand/minor/compatible_brands）
     * - 做法：定位 ftyp 负载起点；向后找到“下一个顶层 box”的起点；据此计算 ftyp 实际长度；重建前 8 字节（size + 'ftyp'）
     * - 成功则返回“修复后的 Buffer”；失败则原样返回
     */
    private repairFtypGenerically(buf: Buffer, scanBytes = 512): Buffer {
        if (buf.length < 16) return buf; // 太短无从修

        // 如果开头已经是合法 box，就不动（避免误修）
        const firstSize = buf.readUInt32BE(0);
        const firstTypeAscii = this.isAsciiFourCC(buf, 4);
        if (firstSize >= 8 && firstTypeAscii) return buf;

        const limit = Math.min(buf.length, scanBytes);

        // 在 [8 .. limit) 内尝试寻找 ftyp 负载的“可信起点”
        // 一个“可信”的 ftyp 负载应满足：
        //   [off .. off+3]   major_brand（ASCII，常见 isom/iso5/avc1/hev1/mp42 等）
        //   [off+4 .. +7]    minor_version（任意 u32）
        //   [off+8 .. next)  由若干个 4 字节 ASCII 兼容品牌 fourcc 构成
        //   接下来应该出现一个“像样的顶层 box”起点（size>=8 & type in TOP_BOX_TYPES）
        for (let off = 8; off + 12 < limit; off += 1) {
            if (!this.isAsciiFourCC(buf, off)) continue;          // major_brand
            const major = buf.toString('ascii', off, off + 4);
            // 常见 major 品牌（放宽：只要是 ASCII fourcc 就行；这里加个常见白名单更稳）
            const commonMajors = new Set(['isom', 'iso5', 'iso6', 'mp42', 'avc1', 'hev1', 'iso2', 'dash', 'iso8']);
            if (!commonMajors.has(major)) continue;

            // minor_version 存在即可
            const minor = buf.readUInt32BE(off + 4);
            // if (minor === 0) continue;

            // // 兼容品牌列表存在即可
            // let brands = 0;
            // for (let p = off + 8; p < limit; p += 4) {
            //     if (!this.isAsciiFourCC(buf, p)) break;
            //     brands++;
            // }
            // if (brands === 0) continue;

            // 从 off+8 开始，步长 4，向后找“下一个顶层 box”作为 ftyp 的结束位置
            for (let nxt = off + 8; nxt + 8 <= limit; nxt += 4) {
                const sz = buf.readUInt32BE(nxt);
                if (sz >= 8 && this.isAsciiFourCC(buf, nxt + 4)) {
                    const typ = buf.toString('ascii', nxt + 4, nxt + 8);
                    if (this.TOP_BOX_TYPES.has(typ)) {
                        // 进一步验证：off+8..nxt 之间应能被 4 整除（兼容品牌列表）
                        const brandPayload = nxt - (off + 8);
                        if (brandPayload % 4 !== 0) continue;

                        // 兼容品牌全是 ASCII fourcc 吗？（宽松：至少 1~N 个）
                        let okBrands = true;
                        for (let p = off + 8; p < nxt; p += 4) {
                            if (!this.isAsciiFourCC(buf, p)) { okBrands = false; break; }
                        }
                        if (!okBrands) continue;

                        // 走到这里，认为 [off .. nxt) 是可信的 ftyp 负载
                        const payloadLen = nxt - off;
                        const ftypSize = 8 + payloadLen;

                        // 构造新头 + 负载 + 余下数据（丢弃 off 之前的脏字节）
                        const fixed = Buffer.allocUnsafe(ftypSize + (buf.length - nxt));
                        // 写 size & 'ftyp'
                        fixed.writeUInt32BE(ftypSize, 0);
                        fixed.write('ftyp', 4, 'ascii');
                        // 拷贝负载
                        buf.copy(fixed, 8, off, nxt);
                        // 拷贝剩余
                        buf.copy(fixed, ftypSize, nxt);
                        return fixed;
                    }
                }
            }
        }

        // 未找到可信 ftyp 负载 → 不修，让后续结构校验去报错或重下
        return buf;
    }

    private isAsciiFourCC(buf: Buffer, off: number): boolean {
        if (off + 4 > buf.length) return false;
        for (let i = 0; i < 4; i++) {
            const b = buf[off + i];
            const ok = (b >= 0x20 && b <= 0x7E);
            if (!ok) return false;
        }
        return true;
    }

    // moov box 缺失或损坏检测

    /**
     * 检测 moov box 是否存在且完整
     * @param buf 分片二进制数据
     * @returns { valid: boolean; reason?: string }
     */
    private detectMoovIntegrity(buf: Buffer): {
        /** 
         * 检测结果
         * - true 代表 moov 完整；
         * - false 代表 moov 缺失或不完整 
         */
        valid: boolean;
        /** 诊断原因 */
        reason: string
    } {
        // 快速检查是否包含 ftyp
        const top = this.listBoxes(buf);
        if (!top.ok) {
            // listBoxes 会在遇到第一个异常时返回诊断 reason
            return { valid: false, reason: top.reason };
        }

        // 搜索 top-level boxes 是否包含 moov（从 listBoxes 返回的 boxes 已是 top-level）
        const moov = top.boxes.find((b) => b.type === "moov");
        const ftyp = top.boxes.find((b) => b.type === "ftyp");

        // 如果文件是 init segment（有 ftyp 或 moov），要求 moov 存在且 size 合法
        if (ftyp && !moov) {
            return { valid: false, reason: "ftyp present but moov missing (likely truncated init segment)" };
        }
        if (moov) {
            // moov 已作为 top-level 且 listBoxes 校验 size 与边界，说明完整
            return { valid: true, reason: "OK" };
        }

        // 对于仅媒体 fragment（moof+mdat），把它视作有效（init detection handled elsewhere）
        const moof = top.boxes.find((b) => b.type === "moof");
        const mdat = top.boxes.find((b) => b.type === "mdat");
        if (moof && mdat) return { valid: true, reason: "fragment OK (moof+mdat)" };

        // 其它未知情况认为无效
        return { valid: false, reason: "No recognizable top-level boxes (ftyp/moov or moof+mdat) found" };
    }

    /**
     * 列出 box 信息
     * @param buf 分片二进制数据
     * @returns box 信息
     */
    private listBoxes(buf: Buffer): ListBoxes {
        const len = buf.length;
        let offset = 0;
        const boxes: Array<{ offset: number; size: number; type: string }> = [];

        while (offset + 8 <= len) {
            const size = buf.readUInt32BE(offset);
            const type = buf.toString("ascii", offset + 4, offset + 8);

            if (size < 8) {
                return { ok: false, reason: `Invalid box size ${size} at offset ${offset}`, boxes };
            }
            if (offset + size > len) {
                return { ok: false, reason: `Box '${type}' at ${offset} claims size ${size} > file end (${len})`, boxes };
            }

            boxes.push({ offset, size, type });
            offset += size;
        }

        if (offset !== len) {
            return { ok: false, reason: `Leftover ${len - offset} bytes at end (incomplete box)`, boxes };
        }

        return { ok: true, reason: "OK", boxes };
    }
}
