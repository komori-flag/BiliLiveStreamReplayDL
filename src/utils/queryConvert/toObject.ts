/**
 * 字符串转换为对象（使用 decodeURIComponent ）
 * - 不会对下列字符解码 ：ASCII字母、数字、~!*()
 * - URIComponent 编码范围比 URI 的大。
 * @param {string} queryString 需要进行转换的字符串
 * @returns {any}
 */
export const queryConvert_URIComponent_toObj = queryString => {
    const obj = {};
    const pairs = queryString.split('&');
    for (const pair of pairs) {
        const [key, value] = pair.split('=');
        // @ts-ignore
        obj[decodeURIComponent(key)] = decodeURIComponent(value);
    }
    return obj;
};

/**
 * 字符串转换为对象（使用 decodeURI ）
 * - 不会对下列字符解码 ：ASCII字母、数字、~!@#$&*()=:/,;?+'
 * - 如果要编码 URL ，但需要跳转地址，那只能用 encodeURI 方法
 * @param {string} queryString 需要进行转换的字符串
 * @returns {any}
 */
export const queryConvert_URI_toObj = queryString => {
    const obj = {};
    const pairs = queryString.split('&');
    for (const pair of pairs) {
        const [key, value] = pair.split('=');
        // @ts-ignore
        obj[decodeURI(key)] = decodeURI(value);
    }
    return obj;
}