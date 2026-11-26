// 公开仓库使用的配置模板：同步脚本会把它复制为公开仓库的 src/config.ts。
// 只放占位值，不要写真实房间号 / API 地址 / Token / DedeUserID。
// 字段结构需与 src/model/config.d.ts 的 AppConfig 保持一致。
import type { AppConfig } from './model/config.js';

export const config: AppConfig = {
    recorderRoomId: 0, // 改成要录制的直播间房间号
    cookiesJSONPath: './data/cookies.json',
    outputDir: './recordings',
    danmaku: {
        record: true,
        superChat: true,
        guardBuy: true,
        gift: true,
    },
    ffmpeg: {
        path: '',
        stallTimeoutMs: 5 * 60 * 1000,
    },
    recordLimits: {
        maxFileSizeMB: 0,
        maxDurationMin: 0,
    },
    mp4Convert: {
        enable: true,
        deleteSource: 'auto',
        faststart: true,
    },
    cookies_mgmt: {
        enable: false, // 使用固定 cookies.json 时关闭；启用时填 api_url / token / dedeUserId
        api_url: '',
        token: '',
        dedeUserId: '',
    },
};