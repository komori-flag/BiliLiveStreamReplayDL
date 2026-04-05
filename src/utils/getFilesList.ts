import { handleError } from './handleError.js';
import fs from 'fs/promises';
import path from 'path';

type getFilesList = {
    /** 文件名 */
    name: string;
    /** 是否为目录 */
    isDirectory: boolean;
    /** 是否为文件 */
    isFile: boolean;
}

/**
 * 获取指定路径内的文件目录列表
 * @param dirPath 路径
 * @returns 文件目录列表
 */
export const getFilesList = async (dirPath: string): Promise<getFilesList[]> => {
    try {
        const files = await fs.readdir(dirPath);
        const fileDetails = await Promise.all(
            files.map(async file => {
                const filePath = path.join(dirPath, file);
                const stat = await fs.stat(filePath);
                return {
                    name: file,
                    isDirectory: stat.isDirectory(),
                    isFile: stat.isFile()
                };
            }));

        return fileDetails;
    } catch (error) {
        throw new Error(handleError(error).errMsg);
    }
}

