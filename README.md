# BiliLiveReplayDL

GitHub is a global platform, and theoretically, everyone should use English. But since this project is mostly meant for Chinese user and rely on a Chinese website [BiliBili](https://www.bilibili.com) (*[wikipedia](https://en.wikipedia.org/wiki/Bilibili)*), most things related to this project like code comments, documentations and other related repositories are written in Chinese.

这是一个依赖于主播授权直播回放的实时直播剪辑权限的直播录制脚本，请确保主播能够授予你直播回放或实时直播剪辑权限。

![](./img/1.png)


## 项目结构总览

```
bilibili-recorder/
├── package.json
├── tsconfig.json
├── README.md
├── src/
│   ├── index.ts                     # 入口文件，初始化与主循环逻辑
│   ├── config.ts                    # 全局配置（房间号、输出目录、弹幕、MP4 转换与单文件限制）
│   ├── core/
│   │   ├── RecorderManager.ts       # 录制任务调度器，管理场次生命周期
│   │   ├── SegmentFetcher.ts        # 分片获取逻辑（含 6 次快速重试 + 请求队列策略）
│   │   ├── HLSDownloader.ts         # m3u8 解析、并发下载、校验与输出组切换
│   │   ├── ByterangePlaylistWriter.ts # BYTERANGE 播放列表与合并文件的写出
│   │   ├── Mp4Converter.ts          # 场次结束后的 MP4 重封装
│   │   ├── DanmakuRecorder.ts       # 弹幕录制（WebSocket + XML 写出）
│   │   └── Fetcher.ts               # 网络请求封装，支持错误重试与延时
│   │
│   ├── utils/
│   │   ├── ffmpeg.ts                # ffmpeg 进程管理（路径探测、进度、停滞超时）
│   │   ├── recordingHealth.ts       # 磁盘空间与追播进度检查
│   │   └── ...
│   │
│   └── model/
│       ├── config.d.ts              # 配置文件的类型声明
│       ├── api.ts                   # B 站接口响应类型
│       ├── cookies.ts               # Cookie 类型
│       ├── hls.ts                   # HLS 下载/播放列表类型
│       ├── mp4.ts                   # fMP4 box 检测类型
│       └── ...
│
└── recordings/                      # 录制产物（outputDir，默认 ./recordings）
    ├── {roomId}_{开播时刻}.m4s       # 合并后的媒体数据（切分时另有 _p2、_p3 …）
    ├── {roomId}_{开播时刻}.m3u8      # BYTERANGE 播放列表（切分时另有 _p2、_p3 …）
    ├── {roomId}_{开播时刻}.mp4       # 场次结束后重封装的标准 MP4
    ├── {roomId}_{开播时刻}.xml       # 弹幕
    └── fragments/                   # 下载中的临时分片
```

## MP4 自动转换

每场直播录制结束后（主播下播 / 场次切换），程序会自动把该场次的合并文件重封装为标准 MP4：

- 一个场次可能因分辨率/编码变化或单文件大小/时长限制拆成多个 `_pN` 输出组，逐组转换
- 用 `ffmpeg -c copy` 无转码重封装，只重写容器与索引，不改变画质和音质
- 转换在后台串行执行，不阻塞下一次开播检测；失败只记日志，源文件保留
- 输出文件名与源文件同名，扩展名为 `.mp4`（如 `123456_2026-01-01_20-00-00.mp4`）

配置见 [`src/config.ts`](src/config.ts)：

```ts
ffmpeg: {
    path: '',          // 留空：项目 bin/ 目录 → 系统 PATH
    stallTimeoutMs: 5 * 60 * 1000,
},
mp4Convert: {
    enable: true,
    // 源文件删除策略：
    // 'never' 始终保留 / 'safe' 完全成功才删 / 'auto' 未失败就删（当前）
    deleteSource: 'auto',
    faststart: true,   // moov 前置，便于边下边播；大文件会多一遍整文件搬移
},
```

要点：

- 需要目标机器安装 ffmpeg：程序会依次查找 `config.ffmpeg.path` → 项目 `bin/` 目录 → 系统 `PATH`；Docker 镜像已内置
- 转换时源文件与产物同时存在，需要约「源文件大小 + 256 MB」的磁盘余量，空间不足会跳过并打 ERROR
- 当前为 `auto`：转换未失败就删除源 `.m4s/.m3u8`。想保留原始合并文件时改成 `safe`（有警告时仍保留源文件）或 `never`
- **转换结果分级**：
  - 退出码非 0，或输出里出现 `error/invalid/corrupt/...` → 判定失败，删除半成品、保留源文件
  - 退出码 0 但出现 `Non-monotonous DTS`（合并文件有真实缺口时可能发生）→ 判定“完成但有警告”，`safe` 策略下保留源文件
  - 其余为完全成功
- 只处理**今后结束的场次**，不会自动补转历史遗留的 `.m4s`；需要时可手动执行：
  `ffmpeg -i old.m4s -map 0 -c copy -movflags +faststart old.mp4`

## 单个文件大小 / 时长限制

类似 blrec 的「文件大小限制」与「时长限制」，用于避免单场直播生成一个过大的文件：

```ts
recordLimits: {
    maxFileSizeMB: 4096, // 单个文件上限 4 GB；0 = 不限制
    maxDurationMin: 180, // 单个文件上限 3 小时；0 = 不限制
},
```

- 达到任一限制时**不会停止录制**，而是在分片边界（约 4 秒）新开一个输出组文件（`_p2`、`_p3` …），继续录制到本场次结束
- 分辨率/编码变化也会新开输出组，两者共用同一套 `_pN` 序号；每个文件独立计数
- 场次结束后逐组重封装为 MP4，产物是一组同名前缀的文件
- 切分判断用「当前文件已写入大小 + 下一分片大小」，实际文件大小会在限制附近略有出入（新建文件时 init 只写一次）；若单个分片本身就超过限制，它仍会单独成为一个文件
- 默认值 0 表示不限制，行为与之前一致

## 运维注意

### 磁盘容量

录制产物写入 `outputDir`（默认 `./recordings`），单场 1080p 直播约 **5~6 GB/小时**。

- 一晚两场（约 3 小时）约 18~19 GB，长期运行需要足够的磁盘空间
- `SegmentFetcher` 在会话启动时及每 30 分钟检查一次磁盘，剩余低于总量的 10% 时打 WARN
- 目前**没有自动清理机制**，容量不足时需要人工处理：删除 `recordings/` 下的历史场次，或把输出目录迁移到更大的磁盘
- 可把 `mp4Convert.deleteSource` 设为 `auto`，转换成功后自动删除源 `.m4s/.m3u8`，减少约一半占用
