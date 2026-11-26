export type Cookies = {
    SESSDATA: string;
    bili_jct: string;
    DedeUserID: string;
    DedeUserID__ckMd5: string;
    sid: string;
    buvid3?: string;
    buvid4?: string;
};

export type CookieJsonData = {
    expires: number;
    http_only: number;
    name: 'SESSDATA' | 'bili_jct' | 'DedeUserID' | 'DedeUserID__ckMd5' | 'sid' | 'buvid3' | 'buvid4';
    same_site: number;
    secure: number;
    value: string;
}[]
