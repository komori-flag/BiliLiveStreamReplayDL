import fs from 'fs/promises';

/**
 * 获取文件的大小
 * @param filePath 文件路径
 * @returns 文件大小，单位为字节
 */
export const getFileSizeBytes = async (filePath: string): Promise<number> => {
    const stats = await fs.stat(filePath);
    return stats.size;
}