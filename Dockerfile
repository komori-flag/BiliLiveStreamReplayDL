# BiliLiveReplayDL —— Node 运行镜像
#
# 构建：  docker build -t bili-live-replay-dl-recorder .
# 运行：  docker run -d --name biliLiveReplayDL-recorder --restart unless-stopped \
#           -e TZ=Asia/Shanghai \
#           -v "$PWD/recordings:/app/recordings" \
#           -v "$PWD/logs:/app/logs" \
#           -v "$PWD/data:/app/data" \
#           bili-live-replay-dl-recorder
#
# 说明：运行阶段不需要 node_modules —— 编译产物只 import Node 内置模块与自身模块
#      （已实测：清空依赖后 51 个产物里只有死文件 utils/logger.js 加载失败）。

# ---------- 构建阶段 ----------
FROM node:24-bookworm-slim AS build
WORKDIR /app

# 国内网络拉 npm 慢/超时的话，构建时覆盖：
#   docker compose build --build-arg NPM_REGISTRY=https://registry.npmmirror.com
ARG NPM_REGISTRY=https://registry.npmjs.org

# 先只拷依赖清单，让这层能被缓存
COPY package.json package-lock.json ./

# 用 install 而不是 ci：本项目以 bun 为主（bun.lock 才是权威锁），
# npm 的 package-lock.json 会漂移（当前就缺 @types/bun 等条目），
# 而 npm ci 要求两份清单严格一致，会直接失败。
RUN npm install --no-audit --no-fund --registry=$NPM_REGISTRY

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---------- 运行阶段 ----------
FROM node:24-bookworm-slim
WORKDIR /app

# 日志时间戳用本地时区；不设的话容器内是 UTC，排查时对不上
ENV NODE_ENV=production \
    TZ=Asia/Shanghai

# 产物自包含，不拷 node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

# 输出目录：录制产物 / 日志 / cookies.json 回落路径
RUN mkdir -p /app/recordings /app/logs /app/data
VOLUME ["/app/recordings", "/app/logs", "/app/data"]

# MP4 自动转换（config.mp4Convert）依赖 ffmpeg；需要该功能所以装进运行镜像
# 不用该功能可注释掉本行（config.mp4Convert.enable 设为 false）
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# 以非 root 运行（node 镜像自带 uid 1000 的 node 用户）
RUN chown -R node:node /app
USER node

# 收到 SIGTERM 会走 index.ts 的优雅退出（落盘日志缓冲）；给 10 秒足够
STOPSIGNAL SIGTERM

CMD ["node", "dist/index.js"]
