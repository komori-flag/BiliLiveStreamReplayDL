import Log from "../modules/Log/index.ts";


declare global {
    namespace NodeJS {
        interface Global {
            readonly logger: Log;
        }
    }

    /**
     * 全局日志记录器
     */
    readonly var logger: Log;
}