import fs from 'fs/promises';
import { handleError } from './handleError.js';


type is_dirExist_result = {
    is_dir: boolean,
    errMsg: string
};

type is_dirExist_options = {
    throwError: boolean
}

/**
 * 检测目录是否存在
 * @param dir 目录路径
 */
export const is_dirExist = async (
    dir: string, 
    options: is_dirExist_options = { throwError: false }
): Promise<is_dirExist_result> => {
    let is_dir = false;
    let errMsg = '';

    try {
        is_dir = (await fs.stat(dir)).isDirectory();
    } catch (err) {
        errMsg = handleError(err).errMsg;
        if (options.throwError && !errMsg.includes('no such file or directory'))
            throw err;
    }

    return {
        is_dir,
        errMsg
    };
};