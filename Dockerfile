# FnCal — Docker 镜像（正式支持；0.4.1 起）
#
# 两阶段构建：node:22-alpine 构建前端 → 同版本运行时镜像。
# 运行期零 npm 依赖（后端只用 Node 内置模块 + 应用内 vendored 代码）。
#
# 构建（在仓库根目录执行，即与 code/ 同级的那层）：
#   docker build -f Dockerfile -t fncal:dev .
# 或：
#   docker build -f Dockerfile --build-arg VERSION=0.7.13 -t fncal:dev .
#
# 运行（命名卷）：
#   docker run -d --name fncal -p 5581:5280 -v fncal-data:/data \
#     -e CALDAV_ADMIN_PASSWORD='换成你的强密码' fncal:dev
#
# 与 fnOS .fpk 安装方式的差异见 DOCKER.md。

ARG NODE_VERSION=22

# ---------- 阶段 1：构建前端 ----------
FROM node:${NODE_VERSION}-alpine AS web

# 版本号只作为构建参数注入：OCI 标签、前端版本戳、后端源码三处必须一致，
# 不一致时构建直接失败（见下面的校验），避免镜像标签与代码脱钩。
ARG VERSION=0.7.13

WORKDIR /build/code

# 先只复制依赖清单，让 npm ci 命中 Docker 层缓存。
COPY code/web/package.json code/web/package-lock.json ./web/
RUN npm --prefix ./web ci --no-audit --no-fund

COPY code/web/ ./web/
# 必须先构建出 web/dist，stamp-version 才能盖章（它读 dist/sw.js、index.html、
# site.webmanifest）；少这一步会让镜像构建在 stamp 处失败。
RUN npm --prefix ./web run build

# 版本戳脚本与 manifest 模板：脚本按 manifest 的 version= 给 dist 盖章。
COPY code/scripts/stamp-version.mjs ./scripts/stamp-version.mjs
RUN printf 'version=%s\n' "${VERSION}" > ./fnos-manifest \
 && node ./scripts/stamp-version.mjs --dist web/dist --manifest fnos-manifest

# ---------- 阶段 2：运行时 ----------
FROM node:${NODE_VERSION}-alpine AS runtime

ARG VERSION=0.7.13
ARG REVISION=unknown
ARG SOURCE=https://github.com/PaulCAI1593/FnCal

# OCI 镜像标签（docker inspect 可见；version 来自构建参数，默认 0.7.13）。
LABEL org.opencontainers.image.title="FnCal" \
      org.opencontainers.image.description="Self-hosted CalDAV calendar with web UI (fnOS / Docker)" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.source="${SOURCE}" \
      org.opencontainers.image.vendor="PaulCAI1593" \
      org.opencontainers.image.url="https://github.com/PaulCAI1593/FnCal"

# tzdata：alpine 自带 UTC，装它才能让 TZ（事件时间、每日提醒）生效。
# su-exec：入口脚本以 root 起时按 PUID/PGID 改 /data 属主后降权执行。
RUN apk add --no-cache tzdata su-exec

# 数据根：accounts.json / calendars/ / logs/ / security.json 全在 /data 下。
# CALDAV_WEB_DIR 指向本镜像里的前端产物；端口默认 5280（HTTP）与 5243（内置 HTTPS）。
ENV NODE_ENV=production \
    TRIM_PKGVAR=/data \
    CALDAV_HOST=0.0.0.0 \
    CALDAV_PORT=5280 \
    CALDAV_HTTPS_PORT=5243 \
    CALDAV_WEB_DIR=/app/www \
    TZ=Asia/Shanghai

WORKDIR /app

COPY code/app/ ./
COPY --from=web /build/code/web/dist ./www
COPY entrypoint.sh /usr/local/bin/fncal-entrypoint

# 测试代码、本地运行残留与构建临时物不进镜像；/data 预建并交给 node 用户。
# 镜像标签版本必须与后端源码 VERSION 一致，否则构建失败（防止版本脱钩）。
RUN rm -rf /app/test /app/var /app/.var-* /app/*.log /app/.migrate-cli-test.log \
 && chmod 0755 /usr/local/bin/fncal-entrypoint \
 && mkdir -p /data \
 && chown -R node:node /app /data \
 && node -e "const fs=require('fs');const m=fs.readFileSync('/app/server.mjs','utf8').match(/export const VERSION = '([^']+)'/);if(!m||m[1]!=='${VERSION}'){console.error('VERSION mismatch: build arg ${VERSION} != server.mjs '+(m&&m[1]));process.exit(1)}"

# 非 root 运行：node 用户 uid/gid 1000。命名卷 /data 会继承镜像里的属主。
# 需要 bind mount 且宿主机属主不是 1000 时，用 PUID/PGID（见 DOCKER.md）。
USER node

VOLUME ["/data"]
EXPOSE 5280 5243

# 健康检查：接受 200 与 301（开启 HTTPS 强制跳转后 HTTP 仍会 301）。
# 用 http 模块而不是 fetch，避免 301 跟随到自签 HTTPS 后失败。
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "const p=process.env.CALDAV_PORT||5280;require('http').get('http://127.0.0.1:'+p+'/api/version',r=>process.exit(r.statusCode<500?0:1)).on('error',()=>process.exit(1))"

# 入口脚本：首次启动提示密码来源；root 起时改 /data 属主后降权；非 root 直接执行。
ENTRYPOINT ["/usr/local/bin/fncal-entrypoint"]
CMD ["node", "server.mjs"]
