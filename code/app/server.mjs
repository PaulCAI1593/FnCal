#!/usr/bin/env node
/**
 * fnOS CalDAV — application entry point (M3.2 skeleton).
 *
 * Responsibilities:
 *   - configuration from the environment (TRIM_PKGVAR first, sane fallback)
 *   - process lifecycle: PID file, graceful SIGINT/SIGTERM, optional stdin-EOF
 *     fallback (Windows/service wrappers that cannot deliver a catchable SIGTERM)
 *   - no source-IP guard: 0.1.7 removed the LAN-only network guard at the user's
 *     request; every source is accepted, rate-limit/audit/CSRF/session stay
 *   - routing: `/api/*` -> REST facade, everything else -> DAV handler
 *   - startup wiring: accounts (bcrypt, vendored), session secret, rate limiter,
 *     audit log, JSON Lines app log
 *
 * Zero cloud; the only third-party code is the vendored bcryptjs and the
 * vendored iCal modules under app/vendor/ (see THIRD_PARTY_NOTICES.md).
 *
 * Run:  node server.mjs
 */

import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { readFileSync, appendFileSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { createStore } from './store/file-store.mjs';
import { createDavHandler } from './dav/handler.mjs';
import { createApiHandler } from './api/index.mjs';
import { createKvApi } from './api/kv.mjs';
import { createAdminApi } from './api/admin.mjs';
import { createDataApi } from './api/data.mjs';
import { createCalendarsApi } from './api/calendars.mjs';
import { createLogger } from './lib/log.mjs';
import { createMigration, resolveMigrationOptions } from './lib/migration.mjs';
import { createReconciler } from './lib/reconcile.mjs';
import { createAccountStore } from './auth/accounts.mjs';
import { loadOrCreateSecret, createSessionCodec } from './auth/session.mjs';
import { createRateLimiter } from './auth/rate-limit.mjs';
import { createAuditLog } from './auth/audit.mjs';
import { createAuthService } from './auth/index.mjs';
import { createSecurityService } from './security/service.mjs';
import { createSecretVault } from './security/vault.mjs';
import { createProxyResolver } from './security/proxy.mjs';
import { createSecurityApi } from './api/security.mjs';
import { createStaticHandler, resolveWebDir } from './lib/static.mjs';
import { runWithContext } from './lib/request-context.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// 0.2.9：阻断「CalDAV 老数据读不到」（启动常驻对账自愈 + --diagnose/--repair + 设置页自检行）
//        + 16 条 UI（搜索筛选/头像菜单/账号编辑删除/拖拽手柄/非本月浅灰/周号竖排/页签间距/
//        复选框主题色/未应用提示常驻/年视图今天环留空隙/多日条连续填色/日程天数标注/
//        周视图与年视图连条+长事件置顶/日程加载更多/详情卡所属日历）。
// 0.2.8：真机 9 条 UI 修复（筛选合体/任务栏关闭/二级菜单翻转/自定义色选中/浅灰与滚动条/年视图圆/齿轮设置/账号管理重做/设置页签）+ 周号竖排。
// 0.2.7：覆盖升级残留进程/端口占用修复（只改 fnos 生命周期脚本，应用代码未改）。
// 0.2.6：仅更新 logo 为 v8（用户最终确认版）；功能代码与 0.2.4 完全一致。
// 0.2.4：真机复测 13 项修复（清空装配链、设置开关命中区、搜索筛选入口、选中行底色、
// 复选框语义、任务日历、任务栏勾色、HTTPS 提示收敛、行菜单二级菜单、自定义颜色圆、
// 周数双口径、年视图圆底色、用户管理编辑 + 密码策略）。
// 0.2.16：A 批五条（保存失败不关窗、412 出口、登录三缺一、401 保草稿、i18n 收口）——
// 版本号只用于包标识，功能改动全在前端 www；后端仅 VERSION 变更。
// 0.2.17：B 批 UI 八条（手机月视图文字 chip、触屏 44px、空态两级、周数联动+快捷键清单、
// 开关对比度、迷你月历点线、年视图换行断开、「四日」）——同样是纯前端。
// 0.2.18：C 批七条（年视图圆几何、迷你点线一整条、四视图拼接条与箭头方向、
// 搜索面板加宽、编辑弹窗农历日期选择、搜索胶囊圆头等高）——同样是纯前端。
export const VERSION = '0.2.42';

const ADMIN_INITIAL_PASSWORD_FILE = 'admin-initial-password.txt';
const DEFAULT_UID_DOMAIN = 'caldav.local';

function envFlag(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').toLowerCase());
}

/**
 * `<varDir>/config.json` (M2 §4.1) is written by the fnOS install wizard.
 * Only the keys the Node backend consumes are read here; unknown keys are
 * ignored so the package scripts can own the rest. A malformed file must not
 * stop the service (the wizard validates it, but a hand-edited file can be
 * broken): treat it as absent.
 */
function readVarConfig(varDir) {
  try {
    const raw = readFileSync(path.join(varDir, 'config.json'), 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** The UID domain appended to generated UIDs (M3.9). Never contains '@'. */
export function normalizeUidDomain(value) {
  const text = String(value ?? '').trim().replace(/^@+/, '').toLowerCase();
  if (!text || text.length > 255) return DEFAULT_UID_DOMAIN;
  if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(text)) return DEFAULT_UID_DOMAIN;
  return text;
}

/**
 * 0.1.9 诊断：读安装入口模板 `app/ui/config` 的 port 值（全新安装时应已展开成
 * 数字；覆盖升级可能仍是未展开的 `${wizard_port}` 或为空）。用于在健康接口
 * 与启动日志里区分「入口模板」和「本次实际监听端口」，排查卡片地址无端口。
 * 读不到返回 null，绝不影响启动。
 */
export function readEntryPortTemplate(appDest = process.env.TRIM_APPDEST) {
  if (!appDest) return null;
  try {
    const raw = readFileSync(path.join(appDest, 'ui', 'config'), 'utf8');
    const parsed = JSON.parse(raw);
    const entry = parsed && parsed['.url'] && parsed['.url']['FnCal.main'];
    return entry && typeof entry.port === 'string' ? entry.port : null;
  } catch {
    return null;
  }
}

/** '' (root) or '/dav' — never with a trailing slash. */
function normalizeDavPrefix(value) {
  const text = String(value || '').trim().replace(/^\/+|\/+$/g, '');
  return text ? `/${text}` : '';
}

/** fnOS 统一网关的公开前缀，例如 `/app/FnCal`（0.1.6）。 */
export function normalizeGatewayPrefix(value) {
  const text = String(value || '').trim().replace(/^\/+|\/+$/g, '');
  return text ? `/${text}` : '/app/FnCal';
}

/**
 * 统一网关的 Unix Socket 列表（0.1.6）。官方文档要求放在 `${TRIM_APPDEST}/app.sock`；
 * 社区实测也有应用放在应用根目录，因此允许逗号分隔多个路径，逐个尝试监听。
 */
export function parseGatewaySockets(env = process.env) {
  const raw = env.CALDAV_GATEWAY_SOCKETS !== undefined
    ? env.CALDAV_GATEWAY_SOCKETS
    : env.CALDAV_GATEWAY_SOCKET;
  if (!raw) return [];
  return String(raw)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => path.resolve(item));
}

/**
 * True for paths owned by the CalDAV handler rather than the SPA. With the
 * default empty prefix the collections live at the URL root; with a prefix the
 * whole `<prefix>/…` subtree belongs to DAV.
 */
export function isDavPath(pathname, prefix = '') {
  if (pathname === '/.well-known/caldav') return true;
  const base = prefix || '';
  if (!base) {
    return pathname === '/principals' || pathname.startsWith('/principals/')
      || pathname === '/calendars' || pathname.startsWith('/calendars/');
  }
  return pathname === base || pathname.startsWith(`${base}/`);
}

export function resolveConfig(env = process.env) {
  const varDir = env.TRIM_PKGVAR && env.TRIM_PKGVAR.trim()
    ? path.resolve(env.TRIM_PKGVAR)
    : path.resolve(__dirname, 'var');
  const fileConfig = readVarConfig(varDir);
  // UID domain priority: CALDAV_UID_DOMAIN env -> config.json:uidDomain ->
  // caldav.local. The fnOS install wizard writes uidDomain into config.json,
  // so the env var is only an override for local runs/tests.
  const uidDomain = normalizeUidDomain(
    env.CALDAV_UID_DOMAIN !== undefined ? env.CALDAV_UID_DOMAIN : fileConfig.uidDomain,
  );
  // M3.7: the Vite build served on the same port. CALDAV_WEB_DIR wins, then the
  // packaged `app/www`, then the dev `code/web/dist`; null keeps DAV-only mode.
  const webDir = resolveWebDir({ appDir: __dirname, env });
  // Administrator bootstrap password, in priority order:
  //   CALDAV_ADMIN_PASSWORD -> CALDAV_PASS -> built-in dev default "caldav".
  // An explicitly empty value ("") means "generate one and write it to a 0600
  // file". Real installs must set CALDAV_ADMIN_PASSWORD (README §安全).
  const adminPassword = env.CALDAV_ADMIN_PASSWORD !== undefined
    ? env.CALDAV_ADMIN_PASSWORD
    : (env.CALDAV_PASS !== undefined ? env.CALDAV_PASS : 'caldav');
  return {
    version: VERSION,
    // 监听端口优先级：env（本机测试/覆盖）→ config.json:port（安装向导写入）→ 5280。
    port: Number(env.CALDAV_PORT || fileConfig.port || 5280),
    // 0.2.13：HTTPS 端口由安装/应用设置向导写入 config.json:httpsPort（默认 5243），
    // 之后可在安全设置里覆盖（security.json 优先）。
    httpsPort: Number(env.CALDAV_HTTPS_PORT || fileConfig.httpsPort || 5243),
    // 0.1.9 诊断：install_callback 写入的端口 + 安装入口模板里的 port 值。
    configPort: Number.isFinite(Number(fileConfig.port)) ? Number(fileConfig.port) : null,
    entryPortTemplate: readEntryPortTemplate(env.TRIM_APPDEST),
    host: env.CALDAV_HOST || '0.0.0.0',
    // Legacy single-account knobs kept so existing DAV Basic clients and the
    // conformance baseline keep working; the account itself lives in accounts.json.
    user: env.CALDAV_USER || 'caldav',
    pass: env.CALDAV_PASS || 'caldav',
    auth: String(env.CALDAV_AUTH || 'on').toLowerCase() !== 'off',
    adminUsername: env.CALDAV_USER || 'caldav',
    adminDisplayName: env.CALDAV_ADMIN_DISPLAY_NAME || '管理员',
    adminPassword,
    secureCookies: envFlag(env.CALDAV_SECURE_COOKIES),
    // 0.2.0 数据迁移的人工开关（见 lib/migration.mjs）。
    migrationDisable: envFlag(env.CALDAV_MIGRATION_DISABLE) || envFlag(fileConfig.migrationDisable),
    migrationRollback: envFlag(env.CALDAV_MIGRATION_ROLLBACK) || envFlag(fileConfig.migrationRollback),
    stdinExit: envFlag(env.CALDAV_STDIN_EXIT),
    davPrefix: normalizeDavPrefix(env.CALDAV_DAV_PREFIX),
    // 0.1.6：统一网关入口（Socket listener）与公开前缀。没有 socket 环境变量时
    // 保持「纯 TCP 端口」旧行为，测试与直连不受影响。
    gatewayPrefix: normalizeGatewayPrefix(env.CALDAV_GATEWAY_PREFIX),
    gatewaySockets: parseGatewaySockets(env),
    uidDomain,
    webDir,
    // 0.1.10：入口 type=url（浏览器标签打开），不需要被嵌入 → 默认只允许 'self'。
    frameAncestors: env.CALDAV_FRAME_ANCESTORS || "'self'",
    configFile: path.join(varDir, 'config.json'),
    varDir,
    calendarsDir: env.CALDAV_CALENDARS_DIR
      ? path.resolve(env.CALDAV_CALENDARS_DIR)
      : path.join(varDir, 'calendars'),
    logFile: env.CALDAV_LOG ? path.resolve(env.CALDAV_LOG) : path.join(varDir, 'logs', 'app.log'),
    pidFile: env.CALDAV_PID ? path.resolve(env.CALDAV_PID) : path.join(varDir, 'caldav.pid'),
    accountsFile: env.CALDAV_ACCOUNTS_FILE ? path.resolve(env.CALDAV_ACCOUNTS_FILE) : path.join(varDir, 'accounts.json'),
    secretFile: env.CALDAV_SECRET_FILE ? path.resolve(env.CALDAV_SECRET_FILE) : path.join(varDir, 'secret.key'),
    auditFile: env.CALDAV_AUDIT_LOG ? path.resolve(env.CALDAV_AUDIT_LOG) : path.join(varDir, 'logs', 'audit.log'),
    // 0.2.13：安全设置独立命名空间（HTTPS/证书/TOTP/白名单…），缺省全关等价旧行为。
    securityFile: env.CALDAV_SECURITY_FILE ? path.resolve(env.CALDAV_SECURITY_FILE) : path.join(varDir, 'security.json'),
  };
}

function processIsAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

async function acquirePid(config, logger) {
  await fs.mkdir(path.dirname(config.pidFile), { recursive: true });
  try {
    const raw = await fs.readFile(config.pidFile, 'utf8');
    const oldPid = Number.parseInt(raw.trim(), 10);
    if (processIsAlive(oldPid) && oldPid !== process.pid) {
      logger.event('pid-conflict', { pidFile: config.pidFile, oldPid });
      throw new Error(`another instance is running (pid=${oldPid}, pidFile=${config.pidFile})`);
    }
    logger.event('pid-stale', { pidFile: config.pidFile, oldPid });
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  await fs.writeFile(config.pidFile, `${process.pid}\n`, 'utf8');
}

async function releasePid(config) {
  try {
    const raw = await fs.readFile(config.pidFile, 'utf8');
    if (Number.parseInt(raw.trim(), 10) === process.pid) await fs.unlink(config.pidFile);
  } catch {
    /* already gone */
  }
}

/** Create the administrator on first start; store a generated password 0600. */
async function bootstrapAdmin({ config, accounts, logger }) {
  const result = await accounts.ensureAdmin({
    username: config.adminUsername,
    displayName: config.adminDisplayName,
    password: config.adminPassword,
  });
  if (!result.created) {
    logger.event('accounts-loaded', { file: config.accountsFile, accounts: (await accounts.all()).length });
    return { created: false };
  }
  let passwordFile = null;
  if (result.generatedPassword) {
    passwordFile = path.join(config.varDir, ADMIN_INITIAL_PASSWORD_FILE);
    await fs.mkdir(path.dirname(passwordFile), { recursive: true });
    await fs.writeFile(passwordFile, `${result.generatedPassword}\n`, { encoding: 'utf8', mode: 0o600 });
    try {
      await fs.chmod(passwordFile, 0o600);
    } catch {
      /* Windows: advisory */
    }
  }
  logger.event('admin-initialized', {
    username: result.account.username,
    id: result.account.id,
    passwordSource: result.generatedPassword ? 'generated' : 'env',
    passwordFile,
  });
  return { created: true, username: result.account.username, passwordFile };
}

export async function createApp(
  config = resolveConfig(),
  { logger = createLogger({ file: config.logFile }), skipAutoReconcile = false, readOnly = false } = {},
) {
  await fs.mkdir(path.dirname(config.logFile), { recursive: true });

  // M3.9: the vendored ics.js appends this domain to generated UIDs; set it
  // before anything can export an .ics. Client-supplied UIDs are never touched.
  globalThis.__FNCAL_UID_DOMAIN__ = normalizeUidDomain(config.uidDomain);

  // M3.3: per-user calendar store. The request context (lib/request-context.mjs)
  // carries the authenticated user id to the store on every request.
  const store = createStore({ root: config.calendarsDir, logger });
  await store.ensureRoot();

  // 0.2.37（S4）：先把会话密钥读出来，再建账号库 —— 账号库用它经 HKDF 派生的
  // 落盘密文艺（TOTP 种子），旧明文在首次读取时自动改写为 `enc:v1:` 密文。
  const secret = await loadOrCreateSecret(config.secretFile);
  const session = createSessionCodec({ secret });
  const vault = createSecretVault({ secret, info: 'fncal/totp-v1' });

  const accounts = createAccountStore({ file: config.accountsFile, logger, vault });
  const admin = await bootstrapAdmin({ config, accounts, logger });

  // Every existing account gets its two automatic calendars on startup
  // (idempotent): `default` ("我的日历", VEVENT) and `tasks` ("任务", VTODO).
  // `readOnly`（--diagnose）不写盘：不建日历、不迁移、不修数据。
  if (!readOnly) {
    for (const account of await accounts.all()) {
      await store.ensureUser(account.id);
    }
  }

  // 0.2.0 data migration (v1 -> v2). Runs before the listeners start; a failure
  // restores the pre-migration backup and rejects here, so the process exits
  // non-zero instead of serving a half-migrated data set.
  const migration = createMigration({
    store,
    accounts,
    varDir: config.varDir,
    logger,
    options: resolveMigrationOptions(config),
  });
  await (readOnly ? Promise.resolve() : migration.run());
  // A rollback restores a pre-0.2.0 tree that has no `tasks` calendar; make sure
  // the automatic calendars exist again for the running process.
  if (!readOnly) {
    for (const account of await accounts.all()) {
      await store.ensureUser(account.id);
    }
    await store.purgeTrash();
  }

  // 0.2.9（发布阻断）：启动自愈对账——与迁移标记解耦，每次启动都按用户/日历把
  // 老 KV 里缺失的对象补写成 .ics（幂等、不覆盖已有），并补建缺失的自定义日历。
  // 失败不阻断启动（Web 仍可用），原因写日志；`--diagnose` / `--repair` 可单独跑。
  const reconciler = createReconciler({
    store,
    accounts,
    varDir: config.varDir,
    logger,
    markerPath: path.join(config.varDir, 'migration.json'),
  });
  if (!skipAutoReconcile && !readOnly) {
    try {
      const reconciled = await reconciler.run({ reason: 'startup' });
      const totals = reconciled.totals || {};
      logger.event('reconcile-startup-done', {
        imported: totals.imported || 0,
        skipped: totals.skipped || 0,
        invalid: totals.invalid || 0,
        createdCalendars: totals.createdCalendars || 0,
        failed: totals.failed || 0,
      });
      if (totals.imported || totals.createdCalendars || totals.invalid) {
        console.log(
          `[caldav] CalDAV 启动自检：补写 ${totals.imported || 0} 个对象、`
          + `补建 ${totals.createdCalendars || 0} 个日历、跳过 ${totals.skipped || 0}、无效 ${totals.invalid || 0}。`,
        );
      }
    } catch (err) {
      logger.event('reconcile-startup-failed', { message: String((err && err.message) || err) });
      console.error(`[caldav] CalDAV 启动自检失败（不阻断启动）：${(err && err.message) || err}`);
    }
  }

  const limiter = createRateLimiter();
  const audit = createAuditLog({ file: config.auditFile });
  // 0.2.13 安全设置（独立 security.json；缺省全关 = 与 0.2.12 行为一致）。
  const security = createSecurityService({
    file: config.securityFile,
    config,
    accounts,
    audit,
    logger,
  });
  // 已勾选启用 HTTPS 但证书缺失（例如换机/迁移后）：启动时自动生成自签证书，
  // 否则 HTTPS 端口起不来、用户又进不去设置页改回来。
  if (!readOnly && security.getSettings().https.enabled && !security.getSettings().certificate.source) {
    try {
      await security.generateSelfSigned({ actor: 'system', now: new Date() });
      logger.event('security-self-signed-generated', { reason: 'https-enabled-without-certificate' });
    } catch (err) {
      logger.event('security-self-signed-failed', { message: String((err && err.message) || err) });
    }
  }
  // 0.2.37（S1/S2）：可信反代解析器。默认关闭 = 完全旧行为；关闭时 resolve()
  // 返回的就是 socket 地址与 socket 协议，调用方无需分支。
  const proxy = createProxyResolver({ getSettings: () => security.getSettings() });
  const auth = createAuthService({ config, accounts, session, limiter, audit, logger, security, proxy });
  const securityApi = createSecurityApi({ accounts, auth, security, audit, logger, proxy });

  const davHandler = createDavHandler({ store, config, logger, auth });
  const kvApi = createKvApi({ store });
  const calendarsApi = createCalendarsApi({
    store,
    logger,
    config,
    version: config.version,
  });
  const adminApi = createAdminApi({ accounts, store, auth, audit, logger });
  const dataApi = createDataApi({ store, logger });
  const apiHandler = createApiHandler({
    version: config.version,
    auth,
    kv: kvApi,
    admin: adminApi,
    data: dataApi,
    calendars: calendarsApi,
    audit,
    securityApi,
    // 0.2.14（P0-2）：/api/version 带上 HTTPS 运行态（公开、只含布尔/端口/原因代码，
    // 不含证书细节），供前端任何页面显示「HTTPS 未监听，已临时走 HTTP」横幅。
    httpsStatus: () => {
      const failure = security.httpsFailure();
      return {
        enabled: security.httpsActive(),
        serving: security.httpsServing(),
        port: config.httpsPort,
        reason: failure ? String(failure.reason || 'listen-failed') : '',
      };
    },
    // 0.2.9：设置 → CalDAV 账户页的同步自检状态（只读，按用户）。
    reconcileStatus: (userId) => reconciler.status(userId),
    // 0.2.10（阻断）：设置页「导出诊断包」——只含结构信息，供用户回传定位数据层。
    reconcileDiagnostics: () => reconciler.diagnostics({ version: config.version }),
    // 0.2.10（1-17）：自检行「修复为可读写」按钮——只改自己的默认日历 davAccess。
    reconcileFixDavAccess: (userId) => reconciler.normalizeDefaultDavAccess(userId, { source: 'api' }),
    health: () => {
      const state = migration.state();
      return {
        migration: {
          status: state.status,
          at: state.at || null,
          lastError: state.lastError || null,
        },
        // 0.1.9 诊断：本次实际监听端口 / config.json 端口 / 安装入口模板。
        // 覆盖升级时入口模板可能仍是未展开的 `${wizard_port}` 或为空，
        // 与 listening port 对照即可判断「卡片地址无端口」是否由此引起。
        port: config.port,
        configPort: config.configPort,
        entryPortTemplate: config.entryPortTemplate,
      };
    },
  });
  const staticHandler = config.webDir
    ? createStaticHandler({
      webDir: config.webDir,
      frameAncestors: config.frameAncestors,
      logger,
      version: config.version,
      // 网关入口下页面位于 /app/FnCal/，theme-prepaint.js 必须带同名前缀。
      basePath: config.gatewaySockets.length ? config.gatewayPrefix : '',
    })
    : null;
  const startedAt = Date.now();

  // One request-scoped context per DAV request; the handler fills in the
  // authenticated account after Basic/session authentication.
  const davContext = (req, res) => runWithContext(
    { userId: config.auth ? null : 'anonymous' },
    () => davHandler(req, res),
  );

  /**
   * 单请求处理。TCP listener 走完整路由（DAV + API + 静态）；统一网关的 Unix
   * socket listener 只处理 API 与静态（DAV 客户端用 Basic，不能走 NAS 会话网关），
   * 并在路由前剥掉 `/app/FnCal` 前缀（兼容网关保留前缀转发的实现）。
   */
  function handleRequest(req, res, { gateway = false } = {}) {
    const rawUrl = req.url || '/';
    const queryIndex = rawUrl.indexOf('?');
    const rawPath = queryIndex === -1 ? rawUrl : rawUrl.slice(0, queryIndex);
    const query = queryIndex === -1 ? '' : rawUrl.slice(queryIndex);
    let pathname = rawPath || '/';

    if (gateway) {
      // 只由 unix-socket listener 设置，仅用于记录来源（网关已做 NAS 登录校验）。\r
      // 绝不从 Header/客户端输入读取该标记。Cookie 仍用 Path=/。
      req.appGateway = true;
      const prefix = config.gatewayPrefix;
      if (pathname === prefix || pathname.startsWith(`${prefix}/`)) {
        pathname = pathname.slice(prefix.length) || '/';
        if (!pathname.startsWith('/')) pathname = `/${pathname}`;
        req.url = pathname + query;
      }
    }

    // 0.2.37（S1）：来源地址/协议按请求解析一次并缓存在 req 上，
    // 路由、认证、审计、访问日志看到的是同一个结果。
    const source = proxy.resolve(req);

    // 0.2.32（L3）：客户端中途断开时 req/res 上的流错误必须有人接住。没有监听器的
    // 'error' 事件会升级成 process 级异常——真机上就表现为「服务突然关闭」。
    req.on('error', (err) => {
      logger.event('request-aborted', {
        method: req.method, path: pathname, code: (err && err.code) || null,
      });
    });
    res.on('error', (err) => {
      logger.event('response-aborted', {
        method: req.method, path: pathname, code: (err && err.code) || null,
      });
    });

    /** 同步抛出与 Promise 拒绝都不许落到进程级（0.2.32 L3）。 */
    const failRequest = (err, label) => {
      logger.event('request-error', {
        label,
        method: req.method,
        path: pathname,
        message: (err && err.message) || String(err),
        stack: String((err && err.stack) || '').slice(0, 2000),
      });
      try {
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': 16 });
          res.end('internal error\n');
        } else {
          res.end();
        }
      } catch {
        /* socket 已消失：记过日志就够了 */
      }
    };
    const guarded = (fn, label) => {
      try {
        const result = fn();
        if (result && typeof result.then === 'function') result.catch((err) => failRequest(err, label));
        return result;
      } catch (err) {
        failRequest(err, label);
        return undefined;
      }
    };

    if (!gateway && security) {
      const remoteAddress = source.ip || '';
      // 来源白名单（默认关）：不匹配直接 403 中文，并记审计；网关 socket 不走这里。
      if (security.ipAllowed(remoteAddress) === false) {
        audit.ipBlocked({ remoteAddress, path: pathname, method: req.method });
        const body = Buffer.from('当前来源地址不在允许范围内（来源白名单）\n', 'utf8');
        res.writeHead(403, {
          'Content-Type': 'text/plain; charset=utf-8',
          'Content-Length': body.length,
          'Cache-Control': 'no-store',
        });
        res.end(body);
        return;
      }
      const httpsSettings = security.getSettings().https;
      // 0.2.37（S2）：外部协议以可信解析结果为准 —— 反代终止 TLS 时 socket 是
      // 明文 HTTP，但外部访问是 HTTPS；不可信来源伪造 X-Forwarded-Proto 无效。
      const isSecure = source.proto === 'https';
      // 0.2.14（P0-2/P1-2）：以「监听器真的在 listening」为准，而不是只看配置。
      // 监听失败时这里一律为 false，HTTP 端口继续提供完整服务，不会把人 301 到空端口。
      const httpsServing = security.httpsServing();
      // 0.2.37（S2）：TLS 由前面的反代终止时，本进程没有 TLS 监听器，
      // 但「外部是 HTTPS」这一事实仍要驱动 Cookie/HSTS/跳转，所以合并判断。
      const behindProxy = httpsSettings.behindProxy === true;
      const httpsMode = httpsServing || behindProxy;
      if (httpsMode && !isSecure) {
        // CalDAV 客户端（非 /api/ 的非 GET，或 DAV 路径）在 HTTP 端口上返回 403 中文
        // 指引，而不是 301：301 会让客户端重发凭据或直接断流。
        const isDavRequest = !pathname.startsWith('/api/')
          && (req.method !== 'GET' && req.method !== 'HEAD' ? true : isDavPath(pathname, config.davPrefix));
        if (isDavRequest) {
          if (httpsSettings.davAllowHttp !== true) {
            const hostHeader = String(req.headers.host || '').trim();
            const host = hostHeader ? hostHeader.replace(/:\d+$/, '') : 'localhost';
            // 反代模式下外部 HTTPS 端口由反代决定（通常 443），不要把内部 TLS 端口
            // 写进给用户的指引里，否则客户端会去连一个从外部根本不通的端口。
            const portPart = behindProxy ? '' : (Number(httpsSettings.httpsPort) === 443 ? '' : `:${httpsSettings.httpsPort}`);
            const body = Buffer.from(`请把 CalDAV 客户端地址改为 https://${host}${portPart}/（HTTP 端口不再接受 CalDAV 请求）\n`, 'utf8');
            logger.event('dav-http-blocked', {
              path: pathname,
              method: req.method,
              httpsPort: httpsSettings.httpsPort,
              remoteAddress: remoteAddress || null,
            });
            res.writeHead(403, {
              'Content-Type': 'text/plain; charset=utf-8',
              'Content-Length': body.length,
              'Cache-Control': 'no-store',
              'X-FnCal-Https-Port': String(httpsSettings.httpsPort || ''),
            });
            res.end(body);
            return;
          }
          // 允许 HTTP 直连：DAV 请求既不 403 也不 301，直接交给 DAV 处理器。
        } else if (httpsSettings.redirectHttp && !httpsSettings.allowHttp) {
          // 浏览器路径：启用 HTTPS + 自动跳转 → 301，保留路径与查询串。
          const hostHeader = String(req.headers.host || '').trim();
          const host = hostHeader ? hostHeader.replace(/:\d+$/, '') : 'localhost';
          const portPart = behindProxy ? '' : (Number(httpsSettings.httpsPort) === 443 ? '' : `:${httpsSettings.httpsPort}`);
          res.writeHead(301, {
            Location: `https://${host}${portPart}${rawUrl}`,
            'Cache-Control': 'no-store',
            'Content-Length': 0,
          });
          res.end();
          return;
        }
      }
      // HSTS 只在真正的 HTTPS 响应上发送（HTTP 响应上的 HSTS 会被浏览器忽略，纯误导）。
      // 0.2.37：反代终止 TLS 时，外部看到的确就是 HTTPS，所以同样要发。
      if (httpsMode && isSecure && httpsSettings.hsts) {
        res.setHeader('Strict-Transport-Security', `max-age=${Number(httpsSettings.hstsMaxAge) || 0}`);
      }
    }

    // 0.2.37（S5）：低风险安全响应头。CSP 暂不在这里下发（需要浏览器回归整套
    // 前端才能确认不打断内联样式/主题脚本），先由静态处理器按页给 frame-ancestors。
    // 框住策略只走 CSP frame-ancestors（可用 CALDAV_FRAME_ANCESTORS 放开给嵌入方），
    // 因此这里**不加 X-Frame-Options**：加了反而会压掉允许的外部嵌入（m37-static 有断言）。
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');

    if (pathname.startsWith('/api/')) {
      const start = Date.now();
      res.on('finish', () => {
        logger.access({
          method: req.method,
          path: pathname,
          status: res.statusCode,
          ms: Date.now() - start,
          ua: req.headers['user-agent'] ?? null,
          remoteAddress: source.ip || null,
          gateway: gateway || undefined,
        });
      });
      return guarded(() => runWithContext({ userId: null }, () => apiHandler(req, res)), 'api');
    }

    if (gateway) {
      // 网关 listener 不接 DAV：非只读请求直接 404。
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        const body = Buffer.from('not found\n', 'utf8');
        res.writeHead(404, {
          'Content-Type': 'text/plain; charset=utf-8',
          'Content-Length': body.length,
          'Cache-Control': 'no-store',
        });
        res.end(body);
        return;
      }
    } else {
      const isRead = req.method === 'GET' || req.method === 'HEAD';
      // Everything that is not a plain page read stays with the DAV handler
      // (OPTIONS/PROPFIND/REPORT/PUT…), so protocol clients keep working even
      // when the SPA is mounted at `/`.
      if (!isRead || isDavPath(pathname, config.davPrefix)) {
        return guarded(() => davContext(req, res), 'dav');
      }
    }

    if (staticHandler) {
      const start = Date.now();
      res.on('finish', () => {
        logger.access({
          method: req.method,
          path: pathname,
          status: res.statusCode,
          ms: Date.now() - start,
          ua: req.headers['user-agent'] ?? null,
          remoteAddress: source.ip || null,
          static: true,
          gateway: gateway || undefined,
        });
      });
      return staticHandler.handle(req, res, pathname).catch((err) => {
        logger.event('static-error', { path: pathname, message: err?.message });
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
          res.end('internal error\n');
        }
      });
    }

    if (gateway) {
      const body = Buffer.from('not found\n', 'utf8');
      res.writeHead(404, {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Length': body.length,
        'Cache-Control': 'no-store',
      });
      res.end(body);
      return;
    }
    return guarded(() => davContext(req, res), 'dav');
  }

  // 0.2.32（L3）：路由层自己抛错也不许打死进程（静态处理之前的路径解析、鉴权等）。
  const safeHandle = (req, res, options) => {
    try {
      handleRequest(req, res, options);
    } catch (err) {
      logger.event('request-error', {
        label: 'router',
        method: req.method,
        path: req.url,
        message: (err && err.message) || String(err),
        stack: String((err && err.stack) || '').slice(0, 2000),
      });
      try {
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': 16 });
          res.end('internal error\n');
        } else {
          res.end();
        }
      } catch {
        /* socket 已消失 */
      }
    }
  };

  const server = attachSocketGuards(http.createServer((req, res) => safeHandle(req, res, { gateway: false })), logger, 'http');
  // 每个 socket 路径一个 listener；网关请求共享同一个 app/store。
  const gatewayServers = config.gatewaySockets.map((socketPath) => ({
    socketPath,
    server: attachSocketGuards(http.createServer((req, res) => safeHandle(req, res, { gateway: true })), logger, 'gateway'),
  }));

  return {
    config,
    store,
    accounts,
    auth,
    security,
    logger,
    server,
    handleRequest,
    gatewayServers,
    startedAt,
    admin,
    migration,
    reconciler,
  };
}

/**
 * 0.2.13：按当前安全设置创建 HTTPS 监听器（证书缺失/无效时返回 null）。
 * 证书或端口变更后需要重启应用生效（设置页会提示）。
 */
export function createHttpsServer({ security, handleRequest, logger = null }) {
  let credentials = null;
  try {
    credentials = security.tlsCredentials();
  } catch (err) {
    if (logger && logger.event) logger.event('https-credentials-failed', { message: String(err && err.message) });
    return null;
  }
  if (!credentials) return null;
  // 0.2.32（L3）：HTTPS 监听器与 HTTP 同口径——路由层抛错只记日志 + 500，不带走进程。
  const httpsHandler = (req, res) => {
    try {
      handleRequest(req, res, { gateway: false });
    } catch (err) {
      if (logger && logger.event) {
        logger.event('request-error', {
          label: 'https-router',
          method: req.method,
          path: req.url,
          message: (err && err.message) || String(err),
          stack: String((err && err.stack) || '').slice(0, 2000),
        });
      }
      try {
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': 16 });
          res.end('internal error\n');
        } else {
          res.end();
        }
      } catch {
        /* socket 已消失 */
      }
    }
  };
  return attachSocketGuards(https.createServer(credentials, httpsHandler), logger, 'https');
}

/**
 * 0.2.14（P0-2）：启动 HTTPS 监听并把结果写进安全服务的运行态。
 *
 * 只有 `listening` 事件到达后才把 `httpsServing` 置真；证书缺失、端口被占用等
 * 任何失败都把运行态置假（HTTP 端口继续服务、301 自动关闭）并记审计
 * `https-listen-failed`。返回值 `{ server, port, ok }`，失败时 server 可能为 null。
 */
export function startHttpsListener({ security, handleRequest, logger = null, port, host = '0.0.0.0', onFailure = null }) {
  const settings = security.getSettings().https;
  const targetPort = Number(port || settings.httpsPort);
  const fail = (reason, message, err = null) => {
    security.setHttpsListening({ listening: false, port: targetPort, reason, message });
    if (logger && logger.event) logger.event('https-listen-failed', { port: targetPort, reason, message, code: err && err.code });
    if (typeof onFailure === 'function') onFailure({ port: targetPort, reason, message, error: err });
  };

  let server = null;
  try {
    server = createHttpsServer({ security, handleRequest, logger });
  } catch (err) {
    fail('credentials', String(err && err.message), err);
    return { server: null, port: targetPort, ok: false };
  }
  if (!server) {
    fail('no-certificate', '已启用 HTTPS 但没有可用证书');
    return { server: null, port: targetPort, ok: false };
  }

  server.on('error', (err) => {
    // 运行中再次出错（例如 listener 被关掉）也退回「HTTP 继续服务」的安全状态。
    if (!server.listening) fail(err.code || 'listen-error', err.message, err);
    else if (logger && logger.event) logger.event('https-server-error', { message: err.message, code: err.code, port: targetPort });
  });
  server.once('listening', () => {
    security.setHttpsListening({ listening: true, port: targetPort });
    const certificate = security.getSettings().certificate;
    if (logger && logger.event) {
      logger.event('https-listening', {
        host,
        port: targetPort,
        certificateSource: certificate.source,
        cn: certificate.cn,
        notAfter: certificate.notAfter,
        hsts: settings.hsts,
      });
    }
  });

  try {
    server.listen(targetPort, host);
  } catch (err) {
    fail(err.code || 'listen-error', err.message, err);
    return { server: null, port: targetPort, ok: false };
  }
  return { server, port: targetPort, ok: true };
}

/**
 * Purely functional part of the shutdown fallback: arm "stdin ended/closed" and
 * call `shutdown(reason)`. Exported so it can be tested without OS pipes (the
 * confined sandbox cannot spawn a child with piped stdio).
 * @returns {() => void} cleanup
 */
export function armStdinShutdown({ stdin, shutdown, logger = null }) {
  if (!stdin || typeof stdin.on !== 'function') return () => {};
  const onEnd = () => shutdown('stdin-end');
  const onClose = () => shutdown('stdin-close');
  stdin.on('end', onEnd);
  stdin.on('close', onClose);
  if (typeof stdin.resume === 'function') stdin.resume();
  if (logger && typeof logger.event === 'function') logger.event('stdin-shutdown-armed', {});
  return () => {
    if (typeof stdin.off === 'function') {
      stdin.off('end', onEnd);
      stdin.off('close', onClose);
    }
  };
}

/** 等待 unix socket server 开始监听（0.1.6 统一网关）。 */
function listenUnixSocket(server, socketPath) {
  return new Promise((resolve, reject) => {
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    const onError = (err) => {
      server.off('listening', onListening);
      reject(err);
    };
    server.once('listening', onListening);
    server.once('error', onError);
    server.listen(socketPath);
  });
}

/**
 * 0.2.32（L3）：裸 TCP 层的协议错误（半截请求、客户端硬断）也要有人接。
 * `clientError` 没有监听器时 Node 会按默认行为处理，但真机上的「服务突然消失」我们
 * 需要在日志里留下痕迹，所以统一记一条 `client-error` 再安全收尾。
 */
function attachSocketGuards(server, logger, label) {
  if (!server || typeof server.on !== 'function') return server;
  server.on('clientError', (err, socket) => {
    if (logger && logger.event) {
      logger.event('client-error', {
        label,
        code: (err && err.code) || null,
        message: (err && err.message) || null,
      });
    }
    try {
      if (socket && socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
      else if (socket) socket.destroy();
    } catch {
      /* 连接已消失 */
    }
  });
  return server;
}

/**
 * 0.2.32（L3）：进程级兜底。**崩溃必须留下原因**，不允许像 0.2.31 那样静默消失
 * （用户 m01405「为什么有时候就突然关闭了」，诊断包里 7 次 startup 却没有任何退出记录）。
 *
 * - `uncaughtException` / `unhandledRejection` → 写 `<var>/logs/crash.log`（一行 JSON，
 *   含堆栈、pid、运行秒数）+ app.log 的 `crash` 事件 + stderr，然后退出码 1；
 * - stdout/stderr 的 EPIPE 兜底：daemon 化后管道被关，写日志不许把进程带走。
 */
export function installCrashHandlers({ logger, crashFile, onExit = null }) {
  let handled = false;
  const onCrash = (kind) => (err) => {
    if (handled) return;
    handled = true;
    writeCrashRecord({ logger, crashFile, kind, err });
    try {
      if (typeof onExit === 'function') onExit();
    } catch {
      /* ignore */
    }
    // 给日志落盘一点时间，然后按异常退出，让 fnOS 明确看到「非 0 退出」。
    setTimeout(() => process.exit(1), 200).unref();
  };
  process.on('uncaughtException', onCrash('uncaughtException'));
  process.on('unhandledRejection', onCrash('unhandledRejection'));
  process.stdout.on('error', () => {});
  process.stderr.on('error', () => {});
}

/**
 * 0.2.32（L3）：崩溃记录单独导出，测试可以不触发 `process.exit`。
 * 返回写进 crash.log 的 payload（写盘失败也返回，便于断言）。
 */
export function writeCrashRecord({ logger, crashFile, kind, err }) {
  const payload = {
    ts: new Date().toISOString(),
    kind,
    message: (err && err.message) || String(err),
    stack: String((err && err.stack) || '').slice(0, 8000),
    pid: process.pid,
    uptimeSec: Math.round(process.uptime()),
  };
  try {
    if (crashFile) appendFileSync(String(crashFile), `${JSON.stringify(payload)}\n`, 'utf8');
  } catch {
    /* 崩溃路径上不能再抛 */
  }
  try {
    if (logger && logger.event) {
      logger.event('crash', { kind, message: payload.message, stack: payload.stack.slice(0, 2000) });
    }
  } catch {
    /* 日志设施本身坏了也不能二次崩 */
  }
  try {
    process.stderr.write(`[caldav] crash(${kind}): ${payload.message}\n${payload.stack}\n`);
  } catch {
    /* stderr 已关 */
  }
  return payload;
}

async function main() {
  const config = resolveConfig();
  const logger = createLogger({ file: config.logFile });
  // 0.2.32（L3）：先装崩溃兜底，再碰任何业务——之后任何未捕获异常都会留下
  // `logs/crash.log` + app.log 的 crash 事件，而不是静默退出。
  installCrashHandlers({
    logger,
    crashFile: path.join(config.varDir, 'logs', 'crash.log'),
    onExit: () => {
      releasePid(config).catch(() => {});
    },
  });
  // 0.2.9：不依赖升级脚本的强制修复/诊断入口。
  const cliDiagnose = process.argv.includes('--diagnose');
  const cliRepair = process.argv.includes('--repair');
  const { server, gatewayServers, admin, migration, reconciler, security, handleRequest } = await createApp(config, {
    logger,
    readOnly: cliDiagnose,
    skipAutoReconcile: cliDiagnose || cliRepair,
  });

  // `--diagnose`：只读中文报告（每账号 KV / objects / 缺失 + 孤儿键 + 遗留 .ics），不写盘。
  if (cliDiagnose) {
    const report = await reconciler.diagnose();
    for (const line of report.report) console.log(`[caldav] ${line}`);
    process.exit(report.totals.failed ? 1 : 0);
  }

  // `--repair`：强制跑一次写修复（补建日历 + 补写对象 + 默认日历 davAccess 归一 rw），
  // 不依赖迁移标记/升级回调。
  if (cliRepair) {
    const segment = await reconciler.run({ reason: 'cli-repair', normalizeDavAccess: true });
    const totals = segment.totals || {};
    console.log(`[caldav] CalDAV 对账修复：用户 ${Object.keys(segment.users).length} 个`);
    for (const [userId, item] of Object.entries(segment.users)) {
      if (item.error) {
        console.log(`[caldav]   user=${item.username || userId} 失败：${item.error}`);
        continue;
      }
      console.log(
        `[caldav]   user=${item.username || userId} kv=事件 ${item.kvEvents} 任务 ${item.kvTasks} `
        + `objects=${item.objectsBefore}->${item.objectsAfter} 补写=事件 ${item.importedEvents} 任务 ${item.importedTasks} `
        + `跳过=${item.skipped} 无效=${item.invalid} 新建日历=${(item.createdCalendars || []).join(',') || 0}`,
      );
      for (const fix of item.davAccessFixed || []) {
        console.log(`[caldav]     davAccess 归一：${fix.calendarId} ${fix.from} -> ${fix.to}`);
      }
    }
    console.log(
      `[caldav] 合计：补写=${totals.imported || 0} 跳过=${totals.skipped || 0} `
      + `无效=${totals.invalid || 0} 新建日历=${totals.createdCalendars || 0} 失败=${totals.failed || 0} `
      + `davAccess 归一=${(segment.davAccessFixed || []).length}`,
    );
    process.exit(totals.failed ? 1 : 0);
  }

  // 0.2.8：`--migrate` = 只做升级数据迁移/对账然后退出（供 cmd/upgrade_callback 调用）。
  // 不监听端口、不写 pid；成功（done/disabled）退出 0，失败（failed/rolled_back）退出 1。
  if (process.argv.includes('--migrate')) {
    const st = migration.state();
    const ok = st.status === 'done' || st.status === 'disabled';
    let counts = {};
    try {
      counts = st.counts && typeof st.counts === 'object' ? st.counts : {};
    } catch {
      counts = {};
    }
    const summary = Object.entries(counts).map(([userId, item]) => {
      const legacy = item && item.legacy ? item.legacy : null;
      if (!legacy) return `${userId}: ok`;
      return `${userId}: 老事件 ${legacy.legacyEvents} 老任务 ${legacy.legacyTasks}`
        + ` 补写 ${legacy.importedEvents + legacy.importedTasks} 跳过 ${legacy.skipped} 无效 ${legacy.invalid}`
        + ` objects ${legacy.objectsBefore}->${legacy.objectsAfter}`;
    });
    console.log(`[caldav] 升级迁移/对账：status=${st.status}${st.lastError ? ` error=${st.lastError}` : ''}`);
    for (const line of summary) console.log(`[caldav]   ${line}`);
    // 0.2.9：启动自愈对账也在 createApp 里跑过，一并打印（这是真正修老数据的那一步）。
    const rec = reconciler.state();
    if (rec && rec.totals) {
      console.log(
        `[caldav] CalDAV 启动自愈：补写 ${rec.totals.imported || 0} 跳过 ${rec.totals.skipped || 0} `
        + `无效 ${rec.totals.invalid || 0} 新建日历 ${rec.totals.createdCalendars || 0} 失败 ${rec.totals.failed || 0}`,
      );
    }
    process.exit(ok ? 0 : 1);
  }

  await acquirePid(config, logger);

  // 0.1.6：先启动统一网关的 unix socket（桌面卡片不依赖 TCP 端口）。任一
  // socket 失败只告警，不阻止 TCP/直连；全部失败时卡片不可用，但服务仍可用。
  const gatewayReady = [];
  for (const gateway of gatewayServers) {
    try {
      await fs.rm(gateway.socketPath, { force: true }).catch(() => {});
      await listenUnixSocket(gateway.server, gateway.socketPath);
      try {
        await fs.chmod(gateway.socketPath, 0o666);
      } catch {
        /* 权限位尽力而为；网关若连不上需人工检查 */
      }
      gatewayReady.push(gateway);
      logger.event('gateway-listening', {
        socket: gateway.socketPath,
        prefix: config.gatewayPrefix,
      });
    } catch (err) {
      logger.event('gateway-listen-failed', {
        socket: gateway.socketPath,
        message: err.message,
        code: err.code,
      });
      console.error(
        `[caldav] 统一网关 Socket 监听失败（${gateway.socketPath}）：${err.message}；`
        + '桌面图标可能不可用，直连端口仍可访问。',
      );
    }
  }
  const gatewayActive = gatewayReady.length > 0;

  // 0.2.13：HTTPS 监听（默认关；证书/开关都在 security.json）。
  // 0.2.14（P0-2）：只有真正 listen 成功才把 HTTP→HTTPS 跳转打开；失败时 HTTP 端口
  // 继续提供完整服务、跳转自动关闭，并记审计 https-listen-failed——绝不把用户锁在门外。
  let httpsServer = null;
  if (security && security.httpsActive()) {
    const httpsSettings = security.getSettings().https;
    const started = startHttpsListener({
      security,
      handleRequest,
      logger,
      port: httpsSettings.httpsPort,
      host: config.host,
      onFailure: ({ port: failedPort, reason, message }) => {
        console.error(
          `[caldav] HTTPS 端口 ${failedPort} 无法监听（${reason || message || '未知原因'}）；`
          + `HTTP 端口 ${config.port} 继续提供服务，自动跳转已关闭。请在安全设置里检查证书或换端口。`,
        );
      },
    });
    httpsServer = started.server;
    if (!started.ok && !httpsServer) {
      // 审计与运行态已由 startHttpsListener 写入（https-listen-failed）。
      logger.event('https-skipped', { reason: 'no-certificate-or-listen-failed', port: httpsSettings.httpsPort });
    }
  }

  server.listen(config.port, config.host, () => {
    logger.event('listening', {
      version: VERSION,
      host: config.host,
      port: config.port,
      auth: config.auth ? 'password+basic' : 'off',
      davPrefix: config.davPrefix || '/',
      uidDomain: config.uidDomain,
      gatewayPrefix: config.gatewayPrefix,
      gatewaySockets: gatewayReady.map((gateway) => gateway.socketPath),
      migration: migration.state(),
      // 0.1.9 诊断：入口模板 vs 实际监听端口（排查卡片地址无端口）。
      configPort: config.configPort,
      entryPortTemplate: config.entryPortTemplate,
      configFile: config.configFile,
      varDir: config.varDir,
      calendarsDir: config.calendarsDir,
      logFile: config.logFile,
      auditFile: config.auditFile,
      accountsFile: config.accountsFile,
      pidFile: config.pidFile,
      pid: process.pid,
    });
    if (admin && admin.passwordFile) {
      logger.event('admin-password-written', { file: admin.passwordFile });
    }
  });

  server.on('error', (err) => {
    logger.event('server-error', { message: err.message, code: err.code, port: config.port });
    if (err.code === 'EADDRINUSE' && gatewayActive) {
      // 端口被占用但网关已就绪：卡片仍可用；CalDAV 客户端需换端口。
      logger.event('port-busy-keep-gateway', { port: config.port });
      console.error(
        `[caldav] 端口 ${config.port} 已被占用：本次只启用统一网关入口（桌面图标可用），`
        + 'CalDAV 客户端需改用其他端口（或在 SSH 下修改 config.json 的 port 后重启）。',
      );
      return;
    }
    if (err.code === 'EADDRINUSE') {
      // 与 cmd/main 的提示保持一致，直接运行时也能给出可执行指引。
      console.error(
        `[caldav] 端口 ${config.port} 已被占用：请卸载时保留数据后重装并选择其他端口，`
        + `或在 SSH 下修改 ${config.configFile} 的 port 后重启应用。`,
      );
    } else {
      console.error(`[caldav] ${err.code || 'error'}: ${err.message}`);
    }
    releasePid(config).finally(() => process.exit(1));
  });

  let closing = false;
  const closeGatewayServers = () => Promise.all(gatewayReady.map((gateway) => new Promise((resolve) => {
    gateway.server.close(() => {
      fs.rm(gateway.socketPath, { force: true }).catch(() => {}).finally(resolve);
    });
  })));
  const shutdown = async (reason) => {
    if (closing) return;
    closing = true;
    logger.event('shutdown', { reason });
    const finish = async () => {
      await closeGatewayServers();
      await releasePid(config);
      logger.event('stopped', { pid: process.pid });
      process.exit(0);
    };
    if (httpsServer && httpsServer.listening) {
      await new Promise((resolve) => httpsServer.close(() => resolve()));
    }
    if (server.listening) server.close(() => { void finish(); });
    else void finish();
    setTimeout(() => {
      void closeGatewayServers().finally(() => releasePid(config).finally(() => process.exit(0)));
    }, 3000).unref();
  };

  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => shutdown(`signal:${signal}`));

  // Windows/service-wrapper fallback: when the parent closes stdin (or a TTY
  // ends), Node cannot deliver a catchable SIGTERM, so treat end-of-stdin as a
  // shutdown request. Opt-in because a service started with no stdin would
  // otherwise exit immediately (CALDAV_STDIN_EXIT=1).
  if (config.stdinExit) {
    armStdinShutdown({ stdin: process.stdin, shutdown, logger });
  }
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isDirectRun) {
  main().catch((err) => {
    console.error(`[caldav] fatal: ${err.message}`);
    process.exit(1);
  });
}



