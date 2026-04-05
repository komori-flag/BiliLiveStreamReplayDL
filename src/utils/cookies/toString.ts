import { Cookies } from "../../type.js";

/**
 * Cookies 对象转换为字符串
 * @param obj Cookies 对象
 * @returns 字符串
 */
export const cookiesToString = (obj: Cookies): string =>
    Object.entries(obj)
        .map(([key, value]) => `${key}=${value}`)
        .join('; ');