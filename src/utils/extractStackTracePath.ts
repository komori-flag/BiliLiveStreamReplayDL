import { handleError } from './handleError.js';

/**
 * 从调用栈里取出指定层级的文件路径
 *
 * 注意：调用栈可能比 space 浅（例如从 Promise 续体、wasm 编译完成的回调里直接调 logger），
 * 这时取到的是 undefined —— 必须兜底，日志工具绝不能因此抛错把应用带崩。
 * 兜底策略：优先取最后一帧（最靠近底部的调用者），都取不到就返回空串。
 *
 * @param space 调用栈层级
 * @param startFrom 从哪个片段开始截取（默认 'src\'，编译后为 dist 时截不到就返回完整路径）
 */
const extractStackTracePath = (space = 2, startFrom: string = 'src\\') => {
    try {
        throw new Error("");
    } catch (e) {
        try {
            const lines = handleError(e).stack.split(/\n+/);
            const raw = lines[space] ?? lines[lines.length - 1] ?? '';
            const full = raw
                .replace(/(^\s+|\s+$)/, "")
                .replace(/\(?([a-zA-Z]:\\[^\s:()]+\.\w+:\d+:\d+)\)?/, "$1");

            if (!startFrom)
                return full;

            const i = full.toLowerCase().indexOf(startFrom.toLowerCase());
            return i >= 0 ? full.slice(i) : full;
        } catch {
            return '';
        }
    }
};

export default extractStackTracePath;
