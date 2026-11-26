import type { Cookies } from "../model/cookies.js";
import { cookiesToString } from "../utils/cookies/toString.js";

/**
 * BiliBili 直播请求头基类
 */
export default class BiliLiveResHeadersBase {
    /**
     * Cookie
     */
    public cookies: Cookies = {
        'SESSDATA': '',
        'bili_jct': '',
        'DedeUserID': '',
        'DedeUserID__ckMd5': '',
        'sid': '',
        'buvid3': '',
        'buvid4': ''
    };

    /** cookies 字符串 */
    public cookies_str = '';

    /** CSRF_TOKEN （即 Cookies 中 bili_jct )*/
    public CSRF_TOKEN = '';

    /** 公共请求头 */
    public public_headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:121.0) Gecko/20100101 Firefox/121.0',
        'Accept': 'application/json, text/plain, */*',
        'Cookie': '',
        'Accept-encoding': 'gzip, deflate, br',
        'Pragma': 'no-cache',
        'Accept-language': 'zh-CN,zh;q=0.8,zh-TW;q=0.7,zh-HK;q=0.5,en-US;q=0.3,en;q=0.2',
        'Referer': '',
    };

    /** 公共请求头（GET 请求） */
    public get_public_headers = {
        ...this.public_headers
    };

    /** 公共请求头（POST 请求） */
    public post_public_headers = {
        ...this.public_headers,
        'Content-Type': 'application/json',
    };

    /**
     * BiliBili 模块基类
     * @param cookies
     */
    constructor(cookies: Cookies) {
        this.cookies = cookies;
        this.cookies_str = cookiesToString(cookies);
        this.CSRF_TOKEN = cookies['bili_jct'];
    }

    /**
     * 实例化 Headers 对象
     * @param init 初始 Headers 对象，默认为 get_public_headers
     * @param callback 回调函数，用于修改 Headers
     * @returns
     */
    public createHeaders(init?: BiliLiveResHeadersBase['get_public_headers'], callback?: (headers: BiliLiveResHeadersBase['public_headers']) => any) {
        if(init === undefined){
            init = this.get_public_headers;
        }
        
        const headers = structuredClone(init);
        headers['Cookie'] = this.cookies_str;
        if (callback) {
            const callback_return = callback(headers);
            if (callback_return !== undefined && callback_return !== null) {
                return callback_return;
            }
        }
        return headers;
    }

    /**
     * 实例化 Headers 对象（POST 请求）
     * @param init 初始 Headers 对象，默认为 post_public_headers
     * @param callback 回调函数，用于修改 Headers
     * @returns
     */
    public createHeaders_post = (init = this.post_public_headers, callback: (headers: BiliLiveResHeadersBase['post_public_headers']) => any): any => {
        // @ts-ignore
        return this.createHeaders(init, callback);
    }
}