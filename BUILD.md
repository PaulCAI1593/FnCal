# 从源码构建 FnCal

目标：从本仓库的源码，构建出可安装到飞牛OS（fnOS）的 `FnCal-<版本>.fpk`。

- 构建需要 **Node.js 22**（与 fnOS 的 `nodejs_v22` 依赖同大版本）。
- 只有安装前端 devDependencies 那一步需要联网；构建产物与运行期都**不访问网络**。
- 打包脚本是纯 Node 实现（自写 tar/gzip），**不需要 fnpack**，Windows / Linux / macOS 都能跑。

## 目录

```text
code/
├── app/       后端（Node ESM，零运行期 npm 依赖；vendored bcryptjs / iCal）
├── web/       前端（Vite + 原生 JS，界面源自 HeyPuter/everything 的 src/calendar）
├── shared/    前后端共用的农历模块
├── fnos/      fnOS 包工程：manifest、cmd/、config/、wizard/、app/{server,ui,www}
├── scripts/   装配与审计脚本（assemble / repack-fpk / audit-* / check-icons …）
└── build/     打包脚本（make-fpk / verify-fpk / bump-version）
```

## 1. 构建前端

```bash
cd code/web
npm install          # 一次性：vite / vitest / jsdom
npm run build        # 产出 code/web/dist
cd ..                # 回到 code/
node scripts/stamp-version.mjs   # 给 dist 盖章：?v=、SW 缓存名、fncal-version / fncal-build meta
```

`stamp-version.mjs` 必须在 `assemble.mjs` 之前跑：它改的是 `code/web/dist`，装配时该目录会被
复制到 `fnos/app/www`。先装配再盖章，包里留下的就是旧版本串与旧缓存名。

`npm run dev`（开发服务器，`/api` 代理到 5280）、`npm run preview`、`npm run mock`
（本地契约 mock server）都只用于开发。

## 2. 装配进 fnOS 包工程

```bash
cd code
node scripts/assemble.mjs
```

它做四件事：

1. `code/app` → `code/fnos/app/server`（排除 `var/`、`.var-*`、`test/`、`build-tmp/`、
   `node_modules/`、`*.log`、`*.pid`）；
2. `code/web/dist` → `code/fnos/app/www`（清空后复制，并剔除 `.map` source map）；
3. 一致性检查：`manifest` 的 `appname` / `service_port` 与 `app/ui/config` 入口、
   `desktop_applaunchname` 是否自洽；
4. 图标检查：`ICON.PNG` 必须 64×64、`ICON_256.PNG` 必须 256×256，源图与包内图标逐字节同源。

任何一项失败，脚本以退出码 1 结束。

## 3. 生成 .fpk

```bash
cd code
node build/make-fpk.mjs --out dist/FnCal-0.2.38.fpk
```

包结构与真机验证过的包一致：

- 外层 `tar.gz` 条目：`app.tgz`、`cmd/`、`config/`、`wizard/`、`ICON.PNG`、
  `ICON_256.PNG`、`manifest`；
- `app.tgz` 条目：`config/`、`server/`、`ui/`、`www/`；
- 权限：目录 `0755`，`cmd/` 下文件 `0755`（生命周期脚本必须可执行），其余 `0644`；
- ustar 头、目录名不带结尾斜杠、gzip level 9。

> 重新打包得到的 `.fpk` **不会与上游发布包逐字节相同**：文件 mtime 与 gzip 实现细节不同，
> 所以 SHA-256 也不同。这是正常的——请以你本地构建产物的实际 SHA 为准。内容与结构等价，
> 包内 `app.tgz` 的大小应当与发布包一致。

## 4. 校验构建产物

```bash
cd code
node build/verify-fpk.mjs dist/FnCal-0.2.38.fpk 0.2.38 --port-entry --url-entry
```

这是包级结构断言（约 40 项），覆盖：manifest 关键字段、`ui/config` 入口类型为 `url`
（浏览器新标签打开）、`cmd/` 生命周期脚本行为、包内 `server.mjs` 版本号、包内前端
`index.html` 的版本查询串与 `sw.js` 缓存名一致、无 `.map`、无运行残留（`.var*` / `*.log` /
`node_modules` / `test`）、许可文本含版权人等。`checks_failed=0` 才算通过。

## 5. 本地运行

```bash
cd code/app
node server.mjs            # 默认 0.0.0.0:5280，数据在 code/app/var/
```

首次启动会在 `var/accounts.json` 初始化管理员账号（正式安装时由 fnOS 安装向导写入端口与账号）。
前端静态文件会自动探测：`<app>/../www`（打包态）→ `<app>/../web/dist`（开发态）。

常用环境变量：`CALDAV_PORT`、`CALDAV_HOST`、`CALDAV_ADMIN_PASSWORD`、`TRIM_PKGVAR`、
`CALDAV_WEB_DIR`、`CALDAV_SECURE_COOKIES`。完整列表见 [`code/app/README.md`](./code/app/README.md)。

## 6. 测试

```bash
# 前端全量（时区固定 America/New_York）
cd code/web && node scripts/test.mjs

# 后端：逐文件跑，不要用 node --test 聚合（聚合会 spawn 子进程，在受限沙箱里会 EPERM）
cd code/app
for f in test/*.test.mjs; do node "$f" || exit 1; done
```

## 版本号

改版本号分两步，**两个脚本各管一半**：

1. `node code/build/bump-version.mjs <x.y.z>`（cwd = 源码根目录，即含 `code/` 的那一层）——只改两处：
   - `code/fnos/manifest` 的 `version=`
   - `code/app/server.mjs` 的 `VERSION` 常量
2. `node scripts/stamp-version.mjs`（cwd = `code`，**`vite build` 之后、`assemble.mjs` 之前**）——
   对构建产物盖章：
   - `dist/index.html` 里 favicon / apple-touch-icon / manifest 链接追加 `?v=<版本>`，
     并写入 `<meta name="fncal-version">` 与 `<meta name="fncal-build">`（构建指纹）；
   - `dist/sw.js` 的 Service Worker 缓存名改为 `fncal-shell-<版本>`；
   - `dist/site.webmanifest` 的 `icons[].src` 同样追加 `?v=<版本>`。

漏掉第 2 步的后果：页面与 SW 仍指向旧版本串，`verify-fpk.mjs` 的「包内前端构建指纹」检查会失败。
`stamp-version.mjs` 是幂等的，重复跑只会替换成当前版本。

**同一个版本号不允许重新打包**：只要包内容有任何变化，就必须升版本号，否则 SHA 与版本号脱钩。

## 换行与编码注意

- `code/web/src/styles/*.css` 必须是 **LF** 换行（用 CRLF 保存会让 `tests/ooo-color.test.js` 失败）；
  在 Windows 上批量改这类文件时，请用不改行尾的方式写回（例如
  `[System.IO.File]::WriteAllText($p, $text, [System.Text.UTF8Encoding]::new($false))`）。
- 源码与配置统一 UTF-8（无 BOM）。`cmd/` 是 shell 脚本，保持 LF 与可执行位。

## 零云检查

发布前建议跑一遍：

```bash
cd code
node scripts/audit-zero-cloud.mjs
node scripts/audit-i18n.mjs
node scripts/audit-lifecycle.mjs
node scripts/check-icons.mjs
```

它们分别检查：无第三方云域名/统计脚本、i18n key 完整、生命周期脚本约定、图标尺寸与来源。
