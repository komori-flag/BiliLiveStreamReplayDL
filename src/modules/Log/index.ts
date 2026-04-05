import path from "path";
import fs from "fs";
import formatTimestamp from "../../utils/formatTimestamp.js";
import { handleError } from "../../utils/handleError.js";
import extractStackTracePath from "../../utils/extractStackTracePath.js";

interface LogOptions {
    /**
     * 是否开启日志写入本地文件功能
     */
    enableWriteLog?: boolean;

    /**
     * 日志输出等级
     */
    level?: 'debug' | 'info' | 'warn' | 'error';

    /**
     * 日志文件名
     */
    name?: string;

    /**
     * 现在的时间
     */
    nowTime?: number;

    /**
     * 日志文件路径
     */
    filePath: string;

    /**
     * 仅捕获异常日志到内存中
     * - 状态一旦改变，就会将之前的日志全部输出并清空
     */
    onlyCache?: boolean;

    /**
     * 是否自动输出日志到控制台
     */
    logPrint?: boolean;

    /**
     * 控制台输出日志的等级
     */
    logPrintLevel?: 'debug' | 'info' | 'warn' | 'error';

    /**
     * 日志缓存的最大容量
     */
    maxCacheSize?: number;  // 新增配置项，设置最大缓存大小
}

type _LogOptions = {
    /**
     * 是否开启日志写入本地文件功能
     */
    enableWriteLog: boolean;

    /**
     * 日志输出等级
     */
    level: 'debug' | 'info' | 'warn' | 'error';

    /**
     * 日志文件名
     */
    name: string;

    /**
     * 现在的时间
     */
    nowTime: number;

    /**
     * 日志文件路径
     */
    filePath: string;

    /**
     * 仅捕获异常日志到内存中
     * - 状态一旦改变，就会将之前的日志全部输出并清空
     */
    onlyCache: boolean;

    /**
     * 是否自动输出日志到控制台
     */
    logPrint: boolean;

    /**
     * 控制台输出日志的等级
     */
    logPrintLevel: 'debug' | 'info' | 'warn' | 'error';

    /**
     * 日志缓存的最大容量
     */
    maxCacheSize: number;  // 新增配置项，设置最大缓存大小
}

class Log {
    #options: _LogOptions = {
        "enableWriteLog": true,
        "level": "debug",
        "name": "BiliLiveReplayDL",
        "nowTime": 0,
        "filePath": ".\\logs",
        'onlyCache': false,
        'logPrint': true,
        'logPrintLevel': 'info',
        'maxCacheSize': 5000  // 默认缓存最大1000条日志
    }

    #level = 0;
    #printLevel = 0;

    /** @type {{ status: 0 | 1, log: string }[]} */
    #logsCache: { status: 0 | 1; log: string; }[] = [];

    #closed = false;
    /** 日志写入锁 */
    #isWriting = false;

    #writeQueue: Promise<void> = Promise.resolve();

    constructor(options: LogOptions) {
        this.#options.filePath = options.filePath;
        this.#options.name = options?.name || "BiliLiveReplayDL";
        this.#options.nowTime = options?.nowTime || Date.now();
        this.#options.enableWriteLog = options?.enableWriteLog || true;
        this.#options.level = options?.level || "debug";
        this.#options.onlyCache = options?.onlyCache || false;
        this.#options.logPrint = options?.logPrint || true;
        this.#options.maxCacheSize = options?.maxCacheSize || 5000; // 使用用户传入的值或者默认值

        // 检测配置文件指定的日志目录是否存在，不存在则在默认目录下创建
        !this.#options.enableWriteLog || this.#ensureLogDirectoryExists();
        this.#level = this.#logLevelFilter();
        this.#printLevel = this.#logLevelFilter(this.#options.logPrintLevel);
    }

    /**
     * 设置日志配置
     * @param key 配置项名称
     * @param value 配置项值
     * @returns 是否设置成功
     */
    setting(key: 'enableWriteLog' | 'onlyCache' | 'level', value: any): boolean {
        let status = false;
        if (status = (/^(enableWriteLog|onlyCache)$/.test(key))) {
            // @ts-ignore
            this.#options[key] = Boolean(value);
        } else if (status = (key === 'level')) {
            this.#options["level"] = value;
            this.#level = this.#logLevelFilter();
        }
        return status;
    }

    async close(callback = () => { }) {
        if (this.#closed)
            return;

        await this.info("Log closed");

        const logPath = path.join(
            this.#options.filePath,
            `${this.#options.name}_${formatTimestamp().replace(/[<>:"/\\|?*]/g, '_')}.log`
        );

        if (!this.#options.onlyCache) {
            try {
                await this.appendData(logPath);
            } catch (err) {
                console.error('写入日志文件时出错:', handleError(err).msg);
            }
        }

        this.#closed = true;

        callback();
    }

    /**
     * 写入日志文件
     * @param {string} logPath 
     */
    async appendData(logPath: string) {
        this.#writeQueue = this.#writeQueue.then(async () => {
            // 防止并发写入
            if (this.#isWriting) return;
            this.#isWriting = true;

            try {
                for (const logCache of this.#logsCache) {
                    if (logCache.status === 0) {
                        await fs.promises.appendFile(logPath, logCache.log + '\n');
                        logCache.status = 1;
                    }
                }
                this.#logsCache.length = 0;
            } finally {
                this.#isWriting = false;
            }
        });

        return this.#writeQueue;
    }

    /**
     * 记录“消息”日志
     * @param message 日志内容
     * @param modulePath 模块路径
     * @param stackTraceLine 代码执行位置行列数
     */
    async info(message: string, modulePath?: string, stackTraceLine?: string) {
        if (this.#level <= 2) {
            const msg = `${formatTimestamp()} | INFO |${modulePath ? ` ${modulePath}:${stackTraceLine || this.#getStackTrace()} |` : ` ${extractStackTracePath(4)} |`} ${message}`;
            (this.#options.enableWriteLog ? (
                await this.#log(msg),
                this.#printLevel <= 2 ? this.#options.logPrint : false
            ) : this.#printLevel <= 2 ? this.#options.logPrint : false) &&
                console.info('\x1b[32m%s\x1b[0m', msg);

            // 检查缓存是否超过最大容量，若是则输出日志
            if (this.#logsCache.length >= this.#options.maxCacheSize && this.#options.enableWriteLog) {
                await this.appendData(path.join(
                    this.#options.filePath,
                    // `${this.#options.name}_${formatTimestamp(this.#options.nowTime).replace(/[<>:"/\\|?*]/g, '_')}.log`
                    `${this.#options.name}_${formatTimestamp().replace(/[<>:"/\\|?*]/g, '_')}.log`
                ));
            }
        }
    }

    /**
     * 记录“警告”日志
     * @param message 日志内容
     * @param modulePath 模块路径
     * @param stackTraceLine 代码执行位置行列数
     */
    async warn(message: string, modulePath?: string, stackTraceLine?: string) {
        if (this.#level <= 3) {
            const msg = `${formatTimestamp()} | WARN |${modulePath ? ` ${modulePath}:${stackTraceLine || this.#getStackTrace()} |` : ` ${extractStackTracePath(4)} |`} ${message}`;
            (this.#options.enableWriteLog ? (
                await this.#log(msg),
                this.#printLevel <= 3 ? this.#options.logPrint : false
            ) : this.#printLevel <= 3 ? this.#options.logPrint : false) &&
                console.warn('\x1b[33m%s\x1b[0m', msg);

            // 检查缓存是否超过最大容量，若是则输出日志
            if (this.#logsCache.length >= this.#options.maxCacheSize && this.#options.enableWriteLog) {
                await this.appendData(path.join(
                    this.#options.filePath,
                    // `${this.#options.name}_${formatTimestamp(this.#options.nowTime).replace(/[<>:"/\\|?*]/g, '_')}.log`
                    `${this.#options.name}_${formatTimestamp().replace(/[<>:"/\\|?*]/g, '_')}.log`
                ));
            }
        }
    }

    /**
     * 记录“错误”日志
     * @param message 日志内容
     * @param modulePath 模块路径
     * @param stackTraceLine 代码执行位置行列数
     */
    async error(message: string, modulePath?: string, stackTraceLine?: string) {
        if (this.#level <= 4) {
            const msg = `${formatTimestamp()} | ERROR |${modulePath ? ` ${modulePath}:${stackTraceLine || this.#getStackTrace()} |` : ` ${extractStackTracePath(4)} |`} ${message}`;
            (this.#options.enableWriteLog ? (
                await this.#log(msg),
                this.#printLevel <= 4 ? this.#options.logPrint : false
            ) : this.#printLevel <= 4 ? this.#options.logPrint : false) &&
                console.error('\x1b[31m%s\x1b[0m', msg);

            // 检查缓存是否超过最大容量，若是则输出日志
            if (this.#logsCache.length >= this.#options.maxCacheSize && this.#options.enableWriteLog) {
                await this.appendData(path.join(
                    this.#options.filePath,
                    // `${this.#options.name}_${formatTimestamp(this.#options.nowTime).replace(/[<>:"/\\|?*]/g, '_')}.log`
                    `${this.#options.name}_${formatTimestamp().replace(/[<>:"/\\|?*]/g, '_')}.log`
                ));
            }
        }
    }

    /**
     * 记录“调试”日志
     * @param message 日志内容
     * @param modulePath 模块路径
     * @param stackTraceLine 代码执行位置行列数
     */
    async debug(message: string, modulePath?: string, stackTraceLine?: string) {
        if (this.#level <= 1) {
            const msg = `${formatTimestamp()} | DEBUG |${modulePath ? ` ${modulePath}:${stackTraceLine || this.#getStackTrace()} |` : ` ${extractStackTracePath(4)} |`} ${message}`;
            (this.#options.enableWriteLog ? (
                await this.#log(msg),
                this.#printLevel <= 1 ? this.#options.logPrint : false
            ) : this.#printLevel <= 1 ? this.#options.logPrint : false) &&
                console.debug('\x1b[36m%s\x1b[0m', msg);

            // 检查缓存是否超过最大容量，若是则输出日志
            if (this.#logsCache.length >= this.#options.maxCacheSize && this.#options.enableWriteLog) {
                await this.appendData(path.join(
                    this.#options.filePath,
                    // `${this.#options.name}_${formatTimestamp(this.#options.nowTime).replace(/[<>:"/\\|?*]/g, '_')}.log`
                    `${this.#options.name}_${formatTimestamp().replace(/[<>:"/\\|?*]/g, '_')}.log`
                ));
            }
        }
    }

    print() {
        return this.#logsCache.map(log => log.log).join('\n');
    }

    /**
     * 写入日志文件
     * @param message 日志内容
     */
    async #log(message: string) {
        if (this.#closed)
            return;

        this.#logsCache.push({
            "status": 0,
            "log": message
        });
    }

    #ensureLogDirectoryExists() {
        if (!fs.existsSync(this.#options.filePath)) {
            fs.mkdirSync(this.#options.filePath, { recursive: true });
        }
    }

    #logLevelFilter(levelStr = this.#options.level) {
        let level = 0;
        switch (levelStr) {
            case "debug":
                level = 1;
                break;
            case "info":
                level = 2;
                break;
            case "warn":
                level = 3;
                break;
            case "error":
                level = 4;
                break;
            default:
                throw new Error("Invalid log level");
        }

        return level;
    }

    #getStackTrace() {
        try {
            throw new Error("");
        } catch (e) {
            // @ts-ignore
            return e.stack
                .split(/\n+/)[3]
                .replace(/(^\s+|\s+$)/, "")
                .match(/:(\d+:\d+)/)[1];
        }
    }

}

export default Log;