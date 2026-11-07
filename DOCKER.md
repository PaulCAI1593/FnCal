# FnCal Docker 部署说明（0.6.11）

FnCal 是自托管日历服务，提供网页界面与 CalDAV 接口。本说明讲清楚用 Docker 在 NAS 或 Linux 主机上部署 FnCal 0.6.11。

- 适用版本：0.6.11
- 部署方式：Docker Compose（推荐）或 `docker run`
- 验证状态：**部分完成**
  - 已验证：首启初始化、网页登录、CalDAV 读写、重启后数据保留、随机初始密码文件生成（本机模拟 17 项）；amd64 镜像构建、OCI 标签写入、容器健康检查、容器内非 root 运行、首启密码文件 0600（GitHub Actions run `41506831612`，2026-11-03，两个 job 全绿）。
  - 未验证：内置 HTTPS、arm64 实机上运行容器、GHCR 镜像推送、真机 Docker 安装。见第十节。

## 一、前提条件

1. Docker 20.10 以上，Compose v2。用 `docker compose`，不要用旧的 `docker-compose`。
2. 架构支持 amd64 或 arm64。arm64 未实测，见第十节。
3. 容器内端口固定：HTTP 5280、HTTPS 5243。宿主机默认映射 5581→5280、5243→5243。
4. 时区默认 Asia/Shanghai，用 `TZ` 改。

## 二、准备源码

1. 取 0.6.11 源码：`git clone --branch v0.6.11 https://github.com/PaulCAI1593/FnCal`，或在 GitHub 下载 tag `v0.6.11` 的源码压缩包并解压。
2. 进入含 `code/` 的那一层目录，后文命令都在这个目录执行。
3. 确认目录里有 `Dockerfile` 与 `docker-compose.yml`。缺文件说明包不完整。

## 三、部署

### 3.1 装法一：Docker Compose（推荐）

1. 设版本号与管理员密码。

   ```bash
   export FNCAL_VERSION=0.6.11
   export CALDAV_ADMIN_PASSWORD='替换成你的强密码'
   ```

2. 构建并启动。

   ```bash
   docker compose up -d --build
   ```

3. 看日志：`docker compose logs -f`
4. 浏览器打开 `http://<NAS-IP>:5581/`，用管理员账号登录。

构建时校验版本号与源码版本。不一致则失败，并打印 `VERSION mismatch`。

### 3.2 装法二：docker run

1. 构建镜像。

   ```bash
   docker build -f Dockerfile --build-arg VERSION=0.6.11 -t fncal:0.6.11 .
   ```

2. 建卷并启动。

   ```bash
   docker volume create fncal-data
   docker run -d --name fncal \
     --restart unless-stopped \
     -p 5581:5280 -p 5243:5243 \
     -v fncal-data:/data \
     -e TZ=Asia/Shanghai \
     -e PUID=1000 -e PGID=1000 \
     -e CALDAV_USER=caldav \
     -e CALDAV_ADMIN_PASSWORD='替换成你的强密码' \
     fncal:0.6.11
   ```

3. 浏览器打开 `http://<NAS-IP>:5581/` 登录。

不传 `CALDAV_ADMIN_PASSWORD` 时，服务退回内置默认口令 `caldav`（仅限本机试用）。必须显式设置：写强密码；或用 `-e CALDAV_ADMIN_PASSWORD=` 显式留空，生成随机密码。

## 四、首次启动与管理员密码

1. 管理员用户名由 `CALDAV_USER` 决定，默认 `caldav`。
2. 密码有两个来源。
   - 显式设置 `CALDAV_ADMIN_PASSWORD`：用你设置的密码。
   - 显式留空：服务生成随机密码，写入 `/data/admin-initial-password.txt`，权限 0600。
3. 随机密码模式下首次登录必须改密。改密前 CalDAV 同步被拒绝。
4. 查看随机密码并立即删除该文件。

   ```bash
   docker exec fncal cat /data/admin-initial-password.txt
   docker exec fncal rm /data/admin-initial-password.txt
   ```

5. 管理员账号只在首次启动时创建。已有账号时重启不重置密码。

## 五、环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `TRIM_PKGVAR` | `/data` | 数据根目录。账号、日历、日志、密钥都在这里。 |
| `CALDAV_PORT` | `5280` | 容器内 HTTP 端口。改它要同时改端口映射。 |
| `CALDAV_HTTPS_PORT` | `5243` | 容器内 HTTPS 端口。启用 HTTPS 后才监听。 |
| `CALDAV_HOST` | `0.0.0.0` | 容器内监听地址，保持默认。 |
| `CALDAV_USER` | `caldav` | 管理员用户名。网页登录与 CalDAV 共用。 |
| `CALDAV_ADMIN_PASSWORD` | 未设置时退回内置默认口令 | 首次启动的管理员密码。显式留空则生成随机密码。 |
| `CALDAV_WEB_DIR` | `/app/www` | 前端静态文件目录。镜像内已设好。 |
| `CALDAV_SECURE_COOKIES` | 关 | 置 `1` 表示只通过 HTTPS 发会话 Cookie。 |
| `CALDAV_DAV_PREFIX` | 空（根路径） | 非空时 CalDAV 挂到该前缀下，例如 `/dav`。 |
| `TZ` | `Asia/Shanghai` | 容器时区。事件时间按此时区解释。 |
| `PUID` | `1000` | 入口脚本把 `/data` 属主改成这个用户 id。容器以 root 启动时生效。 |
| `PGID` | `1000` | 入口脚本把 `/data` 属主改成这个组 id。容器以 root 启动时生效。 |

Compose 包装变量：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `FNCAL_VERSION` | `0.6.11` | 镜像版本号。必须与源码版本一致，否则构建失败。 |
| `FNCAL_HTTP_PORT` | `5581` | 宿主机 HTTP 端口。 |
| `FNCAL_HTTPS_PORT` | `5243` | 宿主机 HTTPS 端口。 |

## 六、数据与备份

### 6.1 数据目录内容

| 文件或目录 | 内容 |
| --- | --- |
| `accounts.json` | 账号与密码哈希。丢失要重建全部账号。 |
| `secret.key` | 会话与签名密钥。丢失后所有会话失效。 |
| `security.json` | 安全设置：证书、两步验证、反向代理配置。 |
| `calendars/` | 日历数据，每个日历一个目录。 |
| `logs/` | 运行日志与审计日志。 |
| `config.json` | 运行配置，例如端口。首次启动时创建。 |

### 6.2 备份命名卷

```bash
docker run --rm -v fncal-data:/data:ro -v "$PWD":/backup \
  alpine tar czf /backup/fncal-data-$(date +%F-%H%M).tar.gz -C /data .
```

### 6.3 恢复

```bash
docker stop fncal
docker run --rm -v fncal-data:/data -v "$PWD":/backup \
  alpine sh -c "cd /data && tar xzf /backup/fncal-data-<时间戳>.tar.gz"
docker start fncal
```

### 6.4 从 .fpk 安装迁移到 Docker

.fpk 是飞牛应用包。两种装法的数据内容一致，可以直接迁移。

1. 在飞牛应用中心停用 FnCal。
2. .fpk 装法的数据在 `/vol1/@appdata/FnCal/var` 下。数据在别的存储卷时把 `/vol1` 换成对应卷号。
3. 备份：`sudo tar czf ~/fncal-fpk-data.tar.gz -C /vol1/@appdata/FnCal var`
4. 装进数据卷。

   ```bash
   docker run --rm -v fncal-data:/data -v "$PWD":/backup -v "$HOME":/host:ro \
     alpine sh -c "cd /data && tar xzf /host/fncal-fpk-data.tar.gz --strip-components=1"
   ```

5. 修正属主。`PUID` 是 `1000` 时：`docker run --rm -v fncal-data:/data alpine chown -R 1000:1000 /data`
6. 起容器登录，账号与密码沿用原来的。

## 七、权限与 PUID/PGID

1. Compose 默认以 root 启动容器。入口脚本按 `PUID`、`PGID` 修正 `/data` 属主，然后降权运行。命名卷与 bind mount 都能首启。
2. `docker run` 时加 `--user 0` 走同一条路径。
3. 跳过降权：把 Compose 的 `user` 改成 `"${PUID:-1000}:${PGID:-1000}"`，卷属主要与 `PUID` 一致。
4. bind mount：宿主机目录属主与 `PUID`、`PGID` 一致。

   ```bash
   mkdir -p ./fncal-data && sudo chown -R 1000:1000 ./fncal-data
   ```

5. `/data` 不可写时入口脚本会退出。按顺序试：`sudo chown -R 1000:1000 <宿主机数据目录>`；把 `PUID`、`PGID` 改成宿主机目录属主；或用 `--user 0` 启动一次让入口脚本改属主后降权。

## 八、反向代理与 HTTPS

公网暴露的推荐做法是前面放一个反向代理。顺序不能颠倒。

1. 先配反向代理。代理必须传 `X-Forwarded-Proto: https`。

   ```nginx
   location / {
       proxy_pass http://<宿主机IP>:5581;
       proxy_set_header Host $host;
       proxy_set_header X-Real-IP $remote_addr;
       proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
       proxy_set_header X-Forwarded-Proto $scheme;
   }
   ```

2. 打开头像菜单里的「安全设置」，在「反向代理与真实来源」分区打开「启用可信反向代理」，在「可信代理地址」里填代理地址或网段（每行一条），再点「保存代理」。代理与 FnCal 同机时本机回环地址始终可信，可不填。
3. 用反代的 HTTPS 地址打开本页，确认能登录。
4. 回到同一分区，打开「通过反向代理提供 HTTPS」。
5. 走反代 HTTPS 时把 `CALDAV_SECURE_COOKIES` 置 `1`，重建容器。

顺序说明：

- 打开后证书由反向代理负责。若没有同时打开「启用 HTTPS」，FnCal 不监听 5243；若已经打开内置 HTTPS，5243 仍监听，但外部应走反代地址。请求必须来自可信代理且带 `X-Forwarded-Proto: https`，才按 HTTPS 处理。
- 此后浏览器用 HTTP 访问会被 301 到 `https://主机`（不带端口，即 443）。反代没配好就打不开。
- 兜底：停容器，把 `/data/security.json` 里的 `https.behindProxy` 改成 `false`，再启动。

内置 HTTPS 的做法：在「加密证书」页签打开「启用 HTTPS」，先准备好证书。证书与私钥只存在本机数据目录。

## 九、升级与卸载

1. 升级：换新版源码包，在同一目录重新构建并启动。

   ```bash
   export FNCAL_VERSION=0.6.11
   docker compose up -d --build
   ```

   数据在数据卷里，重建镜像不动数据。

2. 删容器、保留数据：`docker compose down`
3. 删容器、删数据：`docker compose down -v`

   **警告：`down -v` 会删除数据卷，`accounts.json`、`secret.key`、`calendars/` 一起消失，无法恢复。执行前先按 6.2 备份。**

4. 只删容器、留着卷：`docker compose rm -f`

## 十、已知限制与未验证项

未验证项：

1. 镜像构建在 CI 里跑通一次（amd64 构建、OCI 标签、容器冒烟、健康检查、非 root、首启密码文件）；本机没有 Docker，所以「在你自己机器上构建」仍未由第三方复现。
2. arm64 架构：CI 用 QEMU 构建通过，但没有在 arm64 机器上真正起容器验证。
3. 镜像推送默认关闭。没有公开镜像地址，需要自己构建。
4. /data/admin-initial-password.txt 的 0600 权限已在 CI 容器里用 stat 校验通过；Windows 本机模拟无法验。

已知限制：

1. 容器里没有安装向导与桌面图标。端口与管理员账号靠环境变量。
2. 端口只能靠环境变量与端口映射设置。改端口要重建容器，并同步改客户端地址。
3. 管理员密码只在首次启动时生效。
4. 内置 HTTPS 要自己准备证书。客户端可能提示证书不受信任。
5. 不支持多个容器共享同一个数据卷。
6. 宿主机不支持 `chown` 时，属主需要手工处理。

## 十一、故障排查

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 浏览器一直 301 或 302 | 反代没配好，或没传 `X-Forwarded-Proto`，而「通过反向代理提供 HTTPS」已打开 | 停容器，把 `/data/security.json` 里的 `https.behindProxy` 改成 `false`，重启后再修反代 |
| 容器日志报 /data 不可写 | 数据卷属主与 `PUID`、`PGID` 不匹配 | 按第七节的三种修法逐个试 |
| 端口被占用 | 宿主机 5581 或 5243 被别的服务占用 | 换端口：`export FNCAL_HTTP_PORT=5290 && docker compose up -d`。不要用 5232，那是 Radicale 的默认端口 |
| 时间不对 | `TZ` 没设或设错 | 设好 `TZ` 后重建：`export TZ=Asia/Shanghai && docker compose up -d` |
| 健康检查不通过 | 端口被占、数据目录不可写、版本号与源码不一致 | `docker inspect --format '{{.State.Health.Status}}' fncal` 看状态，`docker compose logs --tail 100` 看日志 |
| 构建报 VERSION mismatch | 构建参数里的版本号与源码版本号不一致 | 把 `FNCAL_VERSION` 或 `--build-arg VERSION` 改成源码版本 |
| CalDAV 客户端看不到日历 | 日历的 CalDAV 权限是「只读」或「不可见」，或地址漏了端口 | 把权限改成「可读写」，地址带端口，例如 `http://<NAS-IP>:5581/`。用随机初始密码且没改密时同步会被拒绝，先在网页端改密 |

## 十二、CalDAV 客户端接入

| 项 | 填什么 |
| --- | --- |
| 服务器地址 | `http://<NAS-IP>:5581/` |
| 用户名 | `caldav`，或 `CALDAV_USER` 里设的名字 |
| 密码 | 管理员密码 |
| 用反代 HTTPS | `https://<你的域名>/` |
| 用内置 HTTPS | `https://<NAS-IP>:5243/` |

1. 填根 URL，客户端会自动发现服务。地址不要漏端口号。
2. 改过宿主机端口后，客户端地址要一起改。
3. 开启两步验证后主密码不能用于同步。在「安全设置 → 我的安全」的「CalDAV 专用密码」分区点「新建专用密码」，客户端填这个密码。撤销后同步立即失效。
4. 新建账号默认可以同步自己名下的日历。管理员在账号管理里能看到各账号权限。
