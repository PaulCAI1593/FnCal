#!/bin/sh
# FnCal 容器入口脚本（0.4.1）。
#
# 职责：
#   1. 首次启动（/data 里还没有 accounts.json）时，打印管理员密码从哪来；
#   2. 以 root 启动时，按 PUID/PGID（默认 1000:1000）修正 /data 属主，再降权执行；
#   3. 以非 root 启动时跳过改属主，只检查 /data 可写并给出可执行的修法。
#
# 镜像默认 USER node（uid/gid 1000）；compose 默认 `user: "0:0"`，会走 root
# 分支：先按 PUID/PGID 修 /data 属主，再降权（降权用 alpine 的 su-exec）。
# 直接用 docker run 时，可用 `--user 0` 走同一分支；PUID=0 则直跑不降权。
set -eu

log() {
  printf '[fncal] %s\n' "$*"
}

PUID="${PUID:-1000}"
PGID="${PGID:-1000}"
DATA_DIR="${TRIM_PKGVAR:-/data}"

# ---- 首次启动提示：管理员密码来源（不打印密码本身） ----
if [ ! -f "${DATA_DIR}/accounts.json" ]; then
  log "首次启动：将在 ${DATA_DIR} 初始化管理员账号。"
  if [ "${CALDAV_ADMIN_PASSWORD+x}" = "x" ] && [ -z "${CALDAV_ADMIN_PASSWORD}" ]; then
    log "CALDAV_ADMIN_PASSWORD 为空：随机密码写入 ${DATA_DIR}/admin-initial-password.txt（权限 0600，首登须改密）。"
  elif [ "${CALDAV_ADMIN_PASSWORD+x}" = "x" ]; then
    log "管理员密码来自环境变量 CALDAV_ADMIN_PASSWORD。"
  else
    log "未设置 CALDAV_ADMIN_PASSWORD：使用内置默认密码 caldav（仅限本机试用；正式部署请设置强密码）。"
  fi
fi

# ---- root：改 /data 属主后降权 ----
if [ "$(id -u)" = "0" ]; then
  mkdir -p "${DATA_DIR}"
  if [ "${PUID}" = "0" ]; then
    log "以 root 运行（PUID=0）。"
    exec "$@"
  fi
  if chown -R "${PUID}:${PGID}" "${DATA_DIR}" 2>/dev/null; then
    log "已把 ${DATA_DIR} 属主设为 ${PUID}:${PGID}，降权运行。"
  else
    log "警告：无法修改 ${DATA_DIR} 属主（只读挂载？），继续以 ${PUID}:${PGID} 运行。"
  fi
  exec su-exec "${PUID}:${PGID}" "$@"
fi

# ---- 非 root：只检查可写 ----
mkdir -p "${DATA_DIR}" 2>/dev/null || true
if [ ! -w "${DATA_DIR}" ]; then
  log "错误：${DATA_DIR} 对当前用户 $(id -u):$(id -g) 不可写。"
  log "修法（任选一种）："
  log "  1) 宿主机执行 chown -R ${PUID}:${PGID} <宿主机数据目录>；"
  log "  2) compose 里把 PUID/PGID 改成宿主机数据目录的属主，并保持 user 跟随；"
  log "  3) 用 --user 0 启动一次，让入口脚本按 PUID/PGID 改属主后再降权。"
  exit 1
fi

if [ "${PUID}" != "$(id -u)" ] || [ "${PGID}" != "$(id -g)" ]; then
  log "注意：当前以 $(id -u):$(id -g) 运行；PUID/PGID=${PUID}:${PGID} 需要 root 才能改属主，本次未生效。"
fi

exec "$@"
