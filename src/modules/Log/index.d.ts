export interface LogOptions {
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
    logPrint?: ConstrainBoolean;

    /**
     * 控制台输出日志的等级
     */
    logPrintLevel?: 'debug' | 'info' | 'warn' | 'error';
    
    /**
     * 日志缓存的最大容量
     */
    maxCacheSize?: number;  // 新增配置项，设置最大缓存大小
}

/**
 * 日志记录器
 */
export declare class Log {

    /**
     * 日志配置项
     */
    private options: LogOptions;

    /**
     * 日志等级
     */
    private level: 0 | 1 | 2 | 3;

    constructor(options?: LogOptions);

    /**
     * 记录“消息”日志
     * @param message 日志信息
     * @param modulePath 所记录的模块路径
     * @param stackTraceLine 代码执行位置行列数
     */
    info(message: string, modulePath?: string, stackTraceLine?: string): Promise<void>;

    /**
     * 记录“警告”日志
     * @param message 日志信息
     * @param modulePath 所记录的模块路径
     * @param stackTraceLine 代码执行位置行列数
     */
    warn(message: string, modulePath?: string, stackTraceLine?: string): Promise<void>;

    /**
     * 记录“错误”日志
     * @param message 日志信息
     * @param modulePath 所记录的模块路径
     * @param stackTraceLine 代码执行位置行列数
     */
    error(message: string, modulePath?: string, stackTraceLine?: string): Promise<void>;

    /**
     * 记录“调试”日志
     * @param message 日志信息
     * @param modulePath 所记录的模块路径
     * @param stackTraceLine 代码执行位置行列数
     */
    debug(message: string, modulePath?: string, stackTraceLine?: string): Promise<void>;

    /**
     * 输出日志
     */
    print(): string[];

    /**
     * 关闭日志记录器
     */
    close(callback?: () => void): Promise<void>;

    /**
     * 设置日志配置项
     */
    setting(key: "enableWriteLog", value: boolean): boolean;
    setting(key: "onlyCache", value: boolean): boolean;
    setting(key: "level", value: LogOptions["level"]): boolean;
}