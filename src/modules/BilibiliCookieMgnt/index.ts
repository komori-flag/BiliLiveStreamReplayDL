import type { Cookies } from "../../model/cookies.js";
import deepClone from "../../utils/deepClone.js";
import { httpErrRepeat } from "../../utils/http.js";

const DEFAULT_COOKIES = {
    SESSDATA: '',
    bili_jct: '',
    DedeUserID: '',
    DedeUserID__ckMd5: '',
    sid: '',
    buvid3: '',
    buvid4: ''
};

/**
 * @typedef {import('.').BilibiliCookieMgmtOptions} BilibiliCookieMgmtOptions
 */


class BilibiliCookieMgmt {
    token = '';

    #api_url = '';
    #base_path = '/api/v1';

    #api_headers = {
        'accept': 'application/json, text/plain, */*',
        'Authorization': '',
    };
    #httpErrorRepeat = 3;

    /**
     * 构造函数：初始化 BilibiliCookieMgmt 实例
     * @param {BilibiliCookieMgmtOptions} params 
     */
    constructor(params) {
        this.#check_api_url(params?.api_url);

        if (!params?.token)
            throw new Error('token 不能为空');

        this.#api_url = params.api_url;
        this.#api_headers.Authorization = `Bearer ${params.token}`;
        this.token = params.token;
        this.#httpErrorRepeat = params?.httpErrRepeat || 3;
    }

    /**
     * 异步工厂方法：创建实例并校验 Token
     * @param {any} params
     * @returns {Promise<BilibiliCookieMgmt>}
     */
    static async create(params) {
        const instance = new BilibiliCookieMgmt(params);
        await instance.#verify_token();
        return instance;
    }

    /**
     * 调用 API GET /cookies/{DedeUserID} 获取指定用户的 cookie 数据
     *
     * - DedeUserID 必须是数字字符串
     * - 用户不存在时返回 null（HTTP 404），不会抛出异常
     * - 成功时返回 CookieObject，核心结构：
     *   `{ raw: { cookie_info: { cookies: [] }, mid: number }, managed: { header_string, ... } }`
     *
     * @param dedeUserId B 站用户 ID
     */
    async getCookie(dedeUserId): Promise<Cookies | null> {
        const uid = String(dedeUserId);
        if (!uid || !/^\d+$/.test(uid))
            throw new Error('DedeUserID 必须是数字且不能为空');

        const params = {
            url: `${this.#api_url}${this.#base_path}/cookies/${encodeURIComponent(uid)}`,
            method: 'GET',
            headers: this.#api_headers,
            body: undefined,
        };
        void global.logger.debug(`[BilibiliCookieMgmt] 请求参数: ${JSON.stringify(params)}`);

        const res = await httpErrRepeat(params, this.#httpErrorRepeat, null);

        void global.logger.debug(`[BilibiliCookieMgmt] 请求响应: ${JSON.stringify(res)}`);

        const data = await res.json();

        if (!res.ok) {
            if (res.status === 404) {
                void global.logger.warn(`[BilibiliCookieMgmt] Cookie 不存在: DedeUserID=${uid}`);
                return null;
            }
            throw new Error(`获取 Cookie 失败 (HTTP ${res.status}): ${JSON.stringify(data)}`);
        }

        void global.logger.info(`[BilibiliCookieMgmt] Cookie 获取成功: DedeUserID=${uid}, mid=${data?.raw?.mid ?? '?'}`);

        const cookieObject = deepClone(DEFAULT_COOKIES);
        for(const DEFAULT_COOKIES_KEY in DEFAULT_COOKIES){
            cookieObject[DEFAULT_COOKIES_KEY] = data?.raw?.cookie_info?.cookies?.find(cookie => cookie.name === DEFAULT_COOKIES_KEY)?.value ?? '';
        }

        return cookieObject;
    }

    /**
     * 检查 API URL 是否有效
     */
    #check_api_url(api_url: string) {
        if (!api_url)
            throw new TypeError('api_url不能为空');

        const urlObj = new URL(api_url);
        if (urlObj.protocol !== 'http:' && urlObj.protocol !== 'https:')
            throw new TypeError('api_url必须是http或https协议');
    }

    /**
     * 向 /cookies/ 发起 GET 请求验证 Token 有效性
     * 无效 Token 返回 HTTP 401 {"detail":"无效的 Token"}
     */
    async #verify_token() {
        const params = {
            url: `${this.#api_url}${this.#base_path}/cookies/`,
            /** @type {'GET'} */
            method: 'GET',
            headers: this.#api_headers,
            body: undefined,
        };

        void global.logger.debug(`[BilibiliCookieMgmt] 请求参数: ${JSON.stringify(params)}`);

        const res = await httpErrRepeat(params, this.#httpErrorRepeat, null);

        void global.logger.debug(`[BilibiliCookieMgmt] 请求响应: status=${res.status}`);

        if (!res.ok) {
            const data = await res.json().catch(() => ({}));
            throw new Error(`Token 校验失败 (HTTP ${res.status}): ${JSON.stringify(data)}`);
        }

        void global.logger.info('[BilibiliCookieMgmt] Token 校验通过');
    }
}

export default BilibiliCookieMgmt;