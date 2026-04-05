import { Cookies } from "../../type.js";

type CookiesArray = { name: string, value: string }[];

/**
 * 将 cookies 数组转换为对象
 * @param cookies cookies 数组
 * @returns cookies 对象
 */
export const cookiesToObject = (cookies: CookiesArray): Cookies => {
    const obj: Cookies = {
        'SESSDATA': '',
        'bili_jct': '',
        'DedeUserID': '',
        'DedeUserID__ckMd5': '',
        'sid': '',
        'buvid3': '',
        'buvid4': ''
    };
    cookies.forEach(cookie => {
        obj[cookie.name] = cookie.value;
    });
    return obj;
}
