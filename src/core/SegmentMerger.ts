import fs from 'fs/promises';
import path from 'path';
import { spawn } from 'child_process';

export class SegmentMerger {
  /**
   * 合并分片为一个 MP4（依赖系统安装 ffmpeg）
   * 在 Windows/macOS/Linux 下均可运行；使用 concat 列表文件避免 shell 特性依赖。
   */
  async merge(segments: string[], output: string, breakpoints: number[] = []): Promise<void> {
    if (!segments.length) throw new Error('待合并分片为空');

    const outDir = path.dirname(output);
    const listPath = path.join(outDir, 'segments.txt');

    // 生成 concat 列表文件（绝对路径，避免路径解析问题）
    const listContent = segments
      .map(s => `file '${path.resolve(s).replace(/'/g, "'\\''")}'`)
      .join('\n');
    await fs.writeFile(listPath, listContent, 'utf-8');

    // 运行 ffmpeg 合并（直接复制流，不转码）
    await new Promise<void>((resolve, reject) => {
      const args = ['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy'];
      // 写入注释元数据（可用于记录断点等信息）
      if (breakpoints.length) {
        args.push('-metadata', `comment=breakpoints=${breakpoints.join(',')}`);
      }
      args.push(output);

      const ff = spawn('ffmpeg', args, { stdio: 'inherit' });
      ff.on('error', reject);
      ff.on('close', (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`ffmpeg 退出码 ${code}`));
        }
      });
    });
  }
}
