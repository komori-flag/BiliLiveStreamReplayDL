// src/main.ts
import { config } from './config.js';
import { RecorderManager } from './core/RecorderManager.js';
import { handleError } from './utils/handleError.js';
import { is_fileExist } from './utils/is_fileExist.js';
import getBiliCookie from './utils/getBiliCookie.js';

import type { Cookies } from './type/Cookies.js';
import Log from './modules/Log/index.js';

async function main() {
    const logger = global.logger = new Log({
        'filePath': './logs',
    });

    try {
        if (!config.recorderRoomId) {
            logger.error('请提供房间号，例如：config.recorderRoomId = 866466');
            process.exit(1);
        }
        if (!config.cookiesJSONPath && !await is_fileExist(config.cookiesJSONPath)) {
            logger.error('Cookies JSON 文件路径不存在或无效');
            process.exit(1);
        }

        const cookies: Cookies = await getBiliCookie(config.cookiesJSONPath);

        const roomid = Number(config.recorderRoomId);
        if (isNaN(roomid)) {
            logger.error('房间号必须是数字类型');
            process.exit(1);
        }

        logger.info(`启动录制任务，房间号：${roomid}`);

        // 初始化 RecorderManager
        const recorder = new RecorderManager(cookies, roomid, './recordings');

        // 启动主循环
        await recorder.start();
    } catch (err) {
        logger.error(`录制过程中发生严重错误: ${handleError(err).errMsg}`);
        await logger.close();
        process.exit(1);
    } finally {
        await logger.close();
        process.exit(0);
    }
}

// 捕获未处理异常
process.on('unhandledRejection', (err) => {
    logger.error(`未捕获的 Promise 拒绝: ${handleError(err).errMsg}`);
    // 关闭日志记录器
    global.logger.close(() => {
        process.exit(1);
    });
});

process.on('uncaughtException', (err) => {
    logger.error(`未捕获的异常: ${handleError(err).errMsg}`);
    // 关闭日志记录器
    global.logger.close(() => {
        process.exit(1);
    });
});

// 捕获 Ctrl+C 信号
process.on('SIGINT', () => {
    logger.info('收到 Ctrl+C 信号，程序退出');
    // 关闭日志记录器
    global.logger.close(() => {
        process.exit(0);
    });
});

// 启动程序
main();
