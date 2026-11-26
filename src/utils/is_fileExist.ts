import fs from 'node:fs/promises';

/**
 * 检查文件是否存在
 * @param filePath 文件路径
 * @returns 是否存在
 */
export const is_fileExist = async (filePath: string): Promise<boolean> => {
    try {
        const stats = await fs.stat(filePath);
        return stats.isFile();
    } catch (error) {
        if (
            typeof error === 'object' &&
            error instanceof Object &&
            'message' in error &&
            typeof error?.message === 'string' &&
            error?.message?.includes('no such file or directory')
        ) {
            return false;
        }

        throw error;
    }
}