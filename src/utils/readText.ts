import fs from 'fs/promises';
import { handleError } from './handleError.js';
import { TextDecoder } from 'util';

/**
 * 读取文本文件
 * @param filePath 文本文件路径
 * @returns 文本内容
 */
const readText = async (filePath: string): Promise<string> => {
    const contextBuffer = await fs.readFile(filePath);

    try {
        // 尝试将二进制数据转换为 UTF-8 字符串
        return new TextDecoder('utf-8', { fatal: true })
            .decode(contextBuffer);
    } catch (e) {
        throw new TypeError(`文本文件 ${filePath} 不是有效的 UTF-8 编码。\n` + handleError(e).errMsg);
    }
};

export default readText;
