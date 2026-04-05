/**
 * 处理错误信息
 * @param error 错误对象
 */
export const handleError = (error: unknown): {
    msg: string,
    stack: string,
    errMsg: string,
    name: string,
    errObj: Error | null,
} => {
    let msg = '';
    let stack = '';
    let errMsg = '';
    let name = '';
    let errObj: Error | null = null;

    if (error instanceof Error) {
        name = error.name;
        msg = error.message;
        stack = String(error.stack);
        errMsg = stack ? `${msg}\n${stack}` : msg;
        errObj = error;
    } else {
        msg = String(error);
        errMsg = msg;
    }
    return { msg, stack, errMsg, name, errObj };
}