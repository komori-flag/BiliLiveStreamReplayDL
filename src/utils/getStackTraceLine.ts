/**
 * 获取调用栈的行列数
 * @param {number?} space 调用栈的层级，默认为 2 (即调用getStackTraceLine函数的地方)
 * @returns {string} 行列数
 */
const getStackTraceLine = (space = 2) => {
    try {
        throw new Error("");
    } catch (e) {
        // @ts-ignore
        return e.stack
            .split(/\n+/)[space]
            .replace(/(^\s+|\s+$)/, "")
            .match(/:(\d+:\d+)/)[1];
    }
}

export default getStackTraceLine;
