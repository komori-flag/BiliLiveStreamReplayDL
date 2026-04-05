/**
 * 对象转换为字符串（使用 URIComponent ）
 * @param {any} input 
 * @returns {string}
 */
export const queryConvert_URIComponent_toStr = (input) =>
    Object
        .keys(input)
        .map(key => `${encodeURIComponent(key)}=${encodeURIComponent(input[key])}`)
        .join('&');

/**
 * 对象转换为字符串（使用 URI ）
 * @param {any} input 
 * @returns {string}
 */
export const queryConvert_URI_toStr = (input) =>
    Object
        .keys(input)
        .map(key => `${encodeURI(key)}=${encodeURI(input[key])}`)
        .join('&');