// 输出组命名：一组 = 一对 (playlist, combined) 文件
//
// 组 1 保持现状名字（`{roomId}_{stamp}.m3u8/.m4s`，向后兼容）；
// 之后每次流签名变化（分辨率 / 编码 / 编码参数 / 音频参数）新开一组，
// 在扩展名前插 `_p{N}`，例如：
//   866466_2026-10-04_20-30-45.m4s
//   866466_2026-10-04_20-30-45_p2.m4s
//
// 组 2 及以后不再带描述性后缀：分辨率与编码都能从合并文件头的 moov 解析出来，
// 文件名保持简洁；兼容早期带 `_p{N}_{宽}x{高}` 的旧现场（仍能识别）。
import path from 'path';

export interface GroupNameInfo {
    /** 组序号：1 = 基础名本身 */
    order: number;
    /** 分辨率 key（`宽x高`）；组 1 与新式组名为 null，仅旧式组名能解析出来 */
    dimsKey: string | null;
}

function stemOf(name: string): string {
    const ext = path.extname(name);
    return name.slice(0, name.length - ext.length);
}

function escapeRegExp(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 由基础名推导某一组的文件名（播放列表/合并文件各自用它们的基础名调用）
 */
export function groupFileName(baseName: string, order: number, dimsKey: string | null): string {
    if (order <= 1) return baseName;
    const ext = path.extname(baseName);
    // 新式命名只带序号；保留 dimsKey 参数以兼容旧调用点（不再写入文件名）
    void dimsKey;
    return `${stemOf(baseName)}_p${order}${ext}`;
}

/**
 * 由播放列表文件名推导对应的合并文件名
 *
 * 两者共用同一个 stem，只是扩展名不同。不能再用 groupFileName 重新拼：
 * 旧式组名带 `_{宽}x{高}` 后缀，重新拼会丢掉它。
 */
export function combinedNameFromPlaylist(playlistName: string, combinedBaseName: string): string {
    const ext = path.extname(combinedBaseName);
    return `${stemOf(playlistName)}${ext}`;
}

/**
 * 播放列表文件名 → 分组信息
 *
 * 认三种形态：
 * - 基础名本身 → 组 1
 * - `{基础名}_p{N}{扩展名}` → 新式组名（N ≥ 2）
 * - `{基础名}_p{N}_{宽}x{高}{扩展名}` → 旧式组名（N ≥ 2，附带分辨率）
 */
export function matchGroupPlaylist(fileName: string, basePlaylistName: string): GroupNameInfo | null {
    if (fileName === basePlaylistName) return { order: 1, dimsKey: null };
    const ext = path.extname(basePlaylistName);
    const stem = escapeRegExp(stemOf(basePlaylistName));
    const extRe = escapeRegExp(ext);

    const legacy = new RegExp(`^${stem}_p(\\d+)_(\\d+x\\d+)${extRe}$`).exec(fileName);
    if (legacy) {
        const order = Number(legacy[1]);
        if (!Number.isInteger(order) || order < 2) return null;
        return { order, dimsKey: legacy[2] };
    }

    const current = new RegExp(`^${stem}_p(\\d+)${extRe}$`).exec(fileName);
    if (current) {
        const order = Number(current[1]);
        if (!Number.isInteger(order) || order < 2) return null;
        return { order, dimsKey: null };
    }

    return null;
}
