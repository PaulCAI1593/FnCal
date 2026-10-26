# FnCal 的 Docker 部署草稿（实验性，未验证）

> **状态：草稿，没有实测过。** 写这份文件时本机没有 Docker，所以 `Dockerfile` 与
> `docker-compose.yml` 是按源码依赖关系推导的，**没有跑过 `docker build` / `docker run`**。
> 它们现在只适合自己试，不适合对外承诺。正式支持计划在 v1.1；到时补齐实测与文档再宣传。
>
> 这 4 个文件（`Dockerfile`、`docker-compose.yml`、`.dockerignore`、`DOCKER.md`）随
> **v0.2.38 源码包**一起提供，放在仓库根目录。它们只是额外的部署方式，不影响 .fpk 安装。

## 一、它和 .fpk 装法的关系

后端是零第三方运行期依赖的 Node 服务（只用 Node 内置模块 + 应用内 vendored 的 `ical` /
`bcryptjs`），前端是 Vite 构建出来的静态文件——这正好是 Docker 最省事的形态：不需要数据库、
不需要编译原生模块、没有系统依赖。所以容器化本身不难，难的是**验证**（见第四节）和**边界**
（见第三节：docker 版没有 fnOS 应用中心那套生命周期与安装向导）。

## 二、怎么跑起来

在仓库根目录（与 `code/` 同级）执行：

```bash
# 方式 A：docker run
docker build -t fncal:dev .
docker run -d --name fncal \
  -p 5581:5280 \
  -v fncal-data:/data \
  -e CALDAV_ADMIN_PASSWORD='换成你的强密码' \
  fncal:dev
```

```bash
# 方式 B：compose
docker compose up -d --build
```

起来后浏览器打开 `http://<NAS-IP>:5581/`，用 `CALDAV_USER`（默认 `caldav`）+ 上面设的密码登录。
容器内端口固定 5280，左边那个宿主机端口随便换（≥ 1024；**不要用 5232**，那是 Radicale 的默认端口）。

**环境变量**

| 变量 | 默认 | 说明 |
|---|---|---|
| `CALDAV_ADMIN_PASSWORD` | `caldav` | **首次启动**用它初始化管理员。不设就是内置默认，只适合本机试跑 |
| `CALDAV_USER` | `caldav` | 管理员用户名 |
| `CALDAV_PORT` | `5280` | 容器内监听端口 |
| `CALDAV_HOST` | `0.0.0.0` | 监听地址 |
| `TRIM_PKGVAR` | `/data` | 数据根目录（账号、日历、日志都在里面） |
| `CALDAV_WEB_DIR` | `/app/www` | 前端静态文件目录 |

其余变量（`CALDAV_DAV_PREFIX`、`CALDAV_FRAME_ANCESTORS`、`CALDAV_TOMBSTONE_LIMIT` 等）见
[`code/app/README.md`](code/app/README.md)。

**数据与备份**：`/data` 下就是 `accounts.json`、`calendars/`、`logs/`。备份这个卷即可；
换机器时把卷带过去，镜像重跑容器，数据照旧。

## 三、和 .fpk 装法的差异（别指望它一样）

| 项 | .fpk（飞牛OS 应用） | 这份 docker 草稿 |
|---|---|---|
| 安装 | 应用中心 + 安装向导 | `docker compose up`，端口与管理员用环境变量 |
| 桌面图标 | 有 | 没有，自己存书签 |
| 进程管理 | fnOS 生命周期脚本（`cmd/*`） | 由 Docker 负责（`restart` 策略） |
| 升级 | 应用中心覆盖安装、数据保留 | 重新 build / 换镜像 tag、数据卷保留 |
| 数据位置 | `/vol1/@appdata/FnCal/` | `/data` 卷 |
| 端口 | 安装时写入 `config.json` | 环境变量 + 端口映射 |
| HTTPS | 自己套反代 | 同样自己套反代，容器内不终止 TLS |
| 两步验证等高级安全能力 | 后端有、界面没有 | 完全一样（同版本后端，同样没有界面） |

## 四、拿到后必须验的 6 项（验过才算能用）

1. **构建**：`docker build` 成功，镜像能启动，日志里没有异常堆栈；
2. **首启初始化**：`/data` 里出现 `accounts.json`，浏览器能打开登录页（静态资源 200）；
3. **登录**：用 `CALDAV_ADMIN_PASSWORD` 设的密码能登录；
4. **持久化**：建一个事件 → 刷新还在 → `docker restart fncal` 后仍然在；
5. **CalDAV**：手机/电脑客户端（DAVx5、Thunderbird 等）连 `http://<NAS-IP>:5581/`，能拉到日历并写一条事件；
6. **非 root**：`docker exec fncal id` 显示 uid 1000（`node` 用户），并且 `/data` 可写。

任何一项不过，就说明这份草稿还差东西——把现象发到仓库 Issues（附上
`docker compose logs` 的相关片段），不要当「大概能用」放出去。

## 五、已知坑

- **bind mount 权限**：把 `fncal-data:/data` 换成 `./data:/data` 时，宿主机目录可能属 root，
  容器内 uid 1000 写不进去。先 `chown -R 1000:1000 ./data`（NAS / Linux）。
- **不要用 5232 端口**：那是 Radicale 的默认端口，容易和别的日历服务撞。
- **公网必须套 HTTPS 反代**：和 .fpk 一样，FnCal 自身不做来源 IP 白名单，
  谁能连到端口谁就能看到登录页。
- **没有安装向导**：端口、管理员只有在**首次启动**时生效；之后改环境变量不会改已有密码/端口。
- **ARM 机器**：镜像按构建机架构生成；群晖/飞牛 ARM 机型请在目标机上 `docker build`，
  或用 `docker buildx` 指定 `--platform`。
- **体积**：基于 `node:22-alpine`，两阶段构建后约 200 MB 量级（未实测）。

## 六、什么时候正式支持

v1.1 的候选范围里（内部路线图已列入）：补齐上面 6 项实测、
加 CI 里的构建检查、写进 README 与 Release 说明。在那之前，这份文件只是给愿意自己试的人。
