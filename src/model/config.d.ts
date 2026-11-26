// 配置文件的类型声明
//
// 这里只声明 `config` 的形状，具体值在 src/config.ts。用独立的 .d.ts 而不是在
// config.ts 里写 `as const` / 字面量断言：
// - 配置项仍然可以直接改值，不必连带修改断言
// - 'auto' 这类枚举值由类型约束（写错会在 tsc 阶段报错），而不是靠 `as string` 放过
//
// 注意：新增必填项后，部署端（如 NAS 的 src/config.ts）要同步补齐，否则构建会失败

/** 源文件删除策略 */
export type DeleteSourceStrategy = 'never' | 'safe' | 'auto';

/** 弹幕录制选项 */
export interface DanmakuConfig {
    /** 是否生成弹幕 XML（false 时仍会连接弹幕服务器，用于开播/下播通知） */
    record: boolean;
    /** 保存 SuperChat（醒目留言） */
    superChat: boolean;
    /** 保存舰长/提督/总督购买 */
    guardBuy: boolean;
    /** 保存礼物赠送 */
    gift: boolean;
}

/** ffmpeg 外部工具配置 */
export interface FfmpegConfig {
    /** ffmpeg 可执行文件路径；留空自动检测（项目 bin/ → 系统 PATH） */
    path: string;
    /** 连续多久没有任何输出就判定卡死并终止（ms）；0 表示不检测 */
    stallTimeoutMs: number;
}

/**
 * 单个输出文件的大小 / 时长限制（类似 blrec）
 *
 * 达到限制时不会停止录制：在"再加入当前分片就会超出"的分片处新开一个输出组
 * （`{基础名}_p{N}`），继续录到同一场次结束。限制按文件独立计算，
 * 分辨率/编码变化切出的新文件同样从头计数。
 */
export interface RecordLimitsConfig {
    /** 单个文件大小上限（MB）；0 = 不限制 */
    maxFileSizeMB: number;
    /** 单个文件时长上限（分钟）；0 = 不限制 */
    maxDurationMin: number;
}

/** 录制完成后的 MP4 重封装配置 */
export interface Mp4ConvertConfig {
    /** 场次录制结束后自动把合并文件重封装为 MP4（无转码，只换容器） */
    enable: boolean;
    /**
     * 转换成功后源 .m4s / .m3u8 的处理策略
     * - 'never'：始终保留
     * - 'safe'：仅当转换完全成功（无错误、无时间戳警告）才删除
     * - 'auto'：只要转换未失败就删除（时间戳被修正等警告也删）
     */
    deleteSource: DeleteSourceStrategy;
    /** moov 前置（faststart），便于边下边播 */
    faststart: boolean;
}

/** Cookie 管理 API 配置 */
export interface CookiesMgmtConfig {
    /** 是否启用 Cookie 管理 API */
    enable: boolean;
    /** API 地址 */
    api_url: string;
    /** 鉴权 Token */
    token: string;
    /** 请求目标用户的 DedeUserID（B站用户ID数字串） */
    dedeUserId: string;
}

/** 完整配置 */
export interface AppConfig {
    /** 录制的直播间房间号 */
    recorderRoomId: number;
    /** cookies.json 回落路径 */
    cookiesJSONPath: string;
    /** 录制产物输出目录 */
    outputDir: string;
    danmaku: DanmakuConfig;
    ffmpeg: FfmpegConfig;
    mp4Convert: Mp4ConvertConfig;
    /**
     * 单个输出文件的大小 / 时长限制；缺省视为不限制
     * 设为可选，避免已有部署（NAS 等）的 config.ts 因新增字段而编译失败
     */
    recordLimits?: RecordLimitsConfig;
    cookies_mgmt: CookiesMgmtConfig;
}
