import fs from 'fs/promises';

/**
 * 创建目录
 * @param {string} targetDir 目标目录
 * @returns {Promise<void>}
 */
export const createDir = async targetDir => {
    await fs.mkdir(
        targetDir,
        { recursive: true }
    );
}
