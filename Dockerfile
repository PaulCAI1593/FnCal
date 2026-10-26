# FnCal —— 实验性 Dockerfile（草稿，未验证）
#
# 状态：**草稿**。写这份文件的本机没有装 Docker，因此没有做过 docker build /
# docker run 的实测；下面每一步都是按源码的依赖关系静态推导出来的（已核对：
# 数据目录走 TRIM_PKGVAR、前端目录走 CALDAV_WEB_DIR、端口走 CALDAV_PORT、
# 首启管理员走 CALDAV_ADMIN_PASSWORD、健康检查用公开的 GET /api/version）。
# 正式支持计划在 v1.1，验证清单见同目录 DOCKER.md。
#
# 构建（在仓库根目录执行，即与 code/ 同级的那层）：
#   docker build -t fncal:dev .
# 运行：
#   docker run -d --name fncal -p 5581:5280 -v fncal-data:/data \
#     -e CALDAV_ADMIN_PASSWORD='换成你的强密码' fncal:dev
#
# 与官方 .fpk 安装方式的差异（无安装向导、无 fnOS 生命周期脚本等）见 DOCKER.md。

# ---------- 阶段 1：构建前端 ----------
FROM node:22-alpine AS web
WORKDIR /src
COPY code/web/package.json code/web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY code/web/ ./
RUN node node_modules/vite/bin/vite.js build

# ---------- 阶段 2：运行 ----------
FROM node:22-alpine

# TRIM_PKGVAR 是后端认的数据根：accounts.json / calendars/ / logs/ 全在它下面
ENV NODE_ENV=production \
    TRIM_PKGVAR=/data \
    CALDAV_HOST=0.0.0.0 \
    CALDAV_PORT=5280 \
    CALDAV_WEB_DIR=/app/www

WORKDIR /app

# 后端零第三方运行期依赖：只用 Node 内置模块 + 应用内 vendored 的 ical / bcryptjs
COPY code/app/ ./
COPY --from=web /src/dist ./www

# 测试代码与本地运行残留不进镜像
RUN rm -rf /app/test /app/var /app/.var-* /app/*.log \
 && mkdir -p /data \
 && chown -R node:node /app /data

# 非 root 运行（容器内端口 5280 > 1024，不需要特权）
USER node

VOLUME ["/data"]
EXPOSE 5280

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.CALDAV_PORT||5280)+'/api/version').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# 首次启动初始化管理员，密码取 CALDAV_ADMIN_PASSWORD；不设则退到内置默认
# "caldav"（只适合本机试跑，正式用必须设）。也可在命令后追加 --diagnose / --migrate。
CMD ["node", "server.mjs"]
