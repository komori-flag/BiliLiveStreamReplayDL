import type { Cookies } from "../model/cookies.js";
import { cookiesToObject } from "./cookies/toObject.js";
import readText from "./readText.js";

/**
 * 获取 biliCookieData
 * @param cookies_filePath bili 参数 
 * @returns cookie 对象
 */
const getBiliCookie = async (cookies_filePath: string): Promise<Cookies> => {
    const text = await readText(cookies_filePath);
    const parsedData = JSON.parse(text);
    const cookies = cookiesToObject(parsedData.cookie_info.cookies);
    return cookies;
};

export default getBiliCookie;
