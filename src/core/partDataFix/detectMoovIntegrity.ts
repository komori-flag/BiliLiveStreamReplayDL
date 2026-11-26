/**
 * 解析 m4s 文件，返回 top-level boxes 列表
 * @param buf 分片二进制数据
 * @returns 
 */
const listBoxes = (buf: Buffer): {
    ok: boolean;
    reason: string;
    boxes: Array<{ offset: number; size: number; type: string }>
} => {
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


/**
 * 检测 moov box 是否存在且完整
 * @param buf 分片二进制数据
 * @returns { valid: boolean; reason?: string }
 */
const detectMoovIntegrity = (buf: Buffer): { valid: boolean; reason?: string } => {
    // 快速检查是否包含 ftyp
    const top = listBoxes(buf);
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
};

export default detectMoovIntegrity;