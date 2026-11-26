// src/main.ts
import { config } from './config.js';
import { RecorderManager } from './core/RecorderManager.js';
import { DanmakuRecorder } from './core/DanmakuRecorder.js';
import { handleError } from './utils/handleError.js';
import { is_fileExist } from './utils/is_fileExist.js';
import getBiliCookie from './utils/getBiliCookie.js';

import type { Cookies } from './model/cookies.js';
import Log from './modules/Log/index.js';
import BilibiliCookieMgmt from './modules/BilibiliCookieMgnt/index.js';
import { shutdown } from './utils/shutdown.js';

async function main() {
    const logger = global.logger = new Log({
        'filePath': './logs',
    });

    try {
        if (!config.recorderRoomId) {
            logger.error('请提供房间号，例如：config.recorderRoomId = 866466');
            // 走 shutdown 而不是直接 exit：否则内存里缓存的日志不会落盘
            shutdown(1);
            return;
        }

        let cookies: Cookies | undefined = undefined; // 假设这里获取了cookies

        if (config?.cookies_mgmt?.enable) {
            const cookieMgnt = await BilibiliCookieMgmt.create(config.cookies_mgmt);
            const _cookies = await cookieMgnt.getCookie(config.cookies_mgmt.dedeUserId);
            if (_cookies) {
                cookies = _cookies;
            } else {
                logger.error(`通过 BilibiliCookieMgnt 获取 cookies 失败，降级到使用 cookiesJSONPath 获取 cookies`);
            }
        }

        if (!cookies && !config.cookiesJSONPath && !await is_fileExist(config.cookiesJSONPath)) {
            logger.error('Cookies JSON 文件路径不存在或无效');
            shutdown(1);
            return;
        }

        if (!cookies) {
            cookies = await getBiliCookie(config.cookiesJSONPath);
        }

        const roomid = Number(config.recorderRoomId);
        if (isNaN(roomid)) {
            logger.error('房间号必须是数字类型');
            shutdown(1);
            return;
        }

        logger.info(`启动录制任务，房间号：${roomid}，账号：${cookies?.DedeUserID ?? '未知'}`);

        const outputDir = config.outputDir || './recordings';
        // 弹幕服务器始终连接（用于开播/下播通知）；danmaku.record 只控制是否生成 XML
        const danmakuConfig = config.danmaku;
        const danmakuRecorder = new DanmakuRecorder(cookies, roomid, outputDir, {
            record: danmakuConfig?.record !== false,
            superChat: danmakuConfig?.superChat !== false,
            guardBuy: danmakuConfig?.guardBuy !== false,
            gift: danmakuConfig?.gift !== false,
        });

        // 初始化 RecorderManager
        const recorder = new RecorderManager(cookies, roomid, outputDir, danmakuRecorder);

        // 启动主循环
        await recorder.start();
    } catch (err) {
        logger.error(`录制过程中发生严重错误: ${handleError(err).errMsg}`);
        shutdown(1, `录制过程中发生严重错误: ${handleError(err).msg}`);
    } finally {
        // 正常结束（或上面已触发过 shutdown，此时是空操作，退出码不会被打乱）
        shutdown(0);
    }
}

// 捕获未处理异常
process.on('unhandledRejection', (err) => {
    global.logger?.error?.(`未捕获的 Promise 拒绝: ${handleError(err).errMsg}`);
    shutdown(1, `未捕获的 Promise 拒绝: ${handleError(err).msg}`);
});

process.on('uncaughtException', (err) => {
    global.logger?.error?.(`未捕获的异常: ${handleError(err).errMsg}`);
    shutdown(1, `未捕获的异常: ${handleError(err).msg}`);
});

// 捕获 Ctrl+C 信号
process.on('SIGINT', () => {
    global.logger?.info?.('收到 Ctrl+C 信号，程序退出');
    shutdown(0, '收到 Ctrl+C 信号');
});

// 捕获 SIGTERM（docker stop / k8s 默认发的就是它）
// 不接的话容器停止时进程被直接杀掉：日志缓冲（最多 5000 条）不会落盘、写入中的分片会留下 .temp
process.on('SIGTERM', () => {
    global.logger?.info?.('收到 SIGTERM 信号，程序退出');
    shutdown(0, '收到 SIGTERM 信号');
});

// 启动程序
main();
