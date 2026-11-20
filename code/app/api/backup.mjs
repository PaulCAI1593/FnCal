// 0.9.2（任务书 §三·五）：按用户的备份接口。所有路由按会话身份，没有 userId 参数。
//
//   GET  /api/v1/backup/settings   本人设置（密钥只回 hasPassword / hasSecret）
//   PUT  /api/v1/backup/settings   保存；开启自动备份前必须测试成功
//   POST /api/v1/backup/test       测试目的地
//   POST /api/v1/backup/run        立即备份（后台执行，返回 started）
//   GET  /api/v1/backup/status     状态行
//   GET  /api/v1/backup/list       目的地的备份文件（最近 5 个）
//   POST /api/v1/backup/restore    恢复：?file=<已有备份> 或原始包体（流式落盘）
//   GET  /api/v1/backup/download   下载备份文件
//
// AI 凭据（Bearer）不走这些接口：403「备份只能在日历界面操作」。

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { pipeline } from 'node:stream/promises';

import { viewOf } from '../lib/backup-settings.mjs';
import { DestinationError } from '../lib/backup-destinations.mjs';

const PREFIX = '/api/v1/backup';

const MESSAGES = {
  unauthorized: '请先登录',
  session_required: '备份只能在日历界面操作',
  csrf: 'CSRF 校验失败，请刷新后重试',
  not_found: '接口不存在',
  method: '不支持的方法',
};

function json(res, status, body, headers = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

function readJsonBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > limit) {
        const err = new Error('请求内容过大');
        err.status = 413;
        err.code = 'payload_too_large';
        reject(err);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) return resolve({});
      try {
        const parsed = JSON.parse(text);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          const err = new Error('请求内容不是合法的 JSON');
          err.status = 400;
          err.code = 'invalid_body';
          return reject(err);
        }
        return resolve(parsed);
      } catch {
        const err = new Error('请求内容不是合法的 JSON');
        err.status = 400;
        err.code = 'invalid_body';
        return reject(err);
      }
    });
    req.on('error', reject);
  });
}

function sendError(res, err) {
  const code = (err && err.code) || 'backup_failed';
  const status = {
    backup_running: 409,
    backup_queue_full: 409,
    backup_invalid: 400,
    backup_settings_invalid: 400,
    backup_scope_empty: 400,
    backup_test_required: 400,
    backup_safety_failed: 400,
    backup_root_unusable: 400,
    backup_no_space: 507,
    destination_unreachable: 502,
    s3_unreachable: 502,
    forbidden: 403,
  }[code] || 500;
  json(res, status, { ok: false, code, message: (err && err.message) || '备份操作失败' });
}

export function createBackupApi({ auth, store, service, logger = null }) {
  async function identityOf(req, res) {
    // AI 凭据（Bearer）只走 /mcp：备份接口明确回 403，而不是让它落到「请先登录」。
    if (/^Bearer\s+/i.test(String(req.headers.authorization || ''))) {
      json(res, 403, { ok: false, code: 'forbidden', message: MESSAGES.session_required });
      return null;
    }
    const identity = await auth.authenticate(req);
    if (!identity.ok) {
      json(res, 401, { ok: false, code: 'unauthorized', message: MESSAGES.unauthorized });
      return null;
    }
    if (identity.via !== 'session') {
      json(res, 403, { ok: false, code: 'forbidden', message: MESSAGES.session_required });
      return null;
    }
    return identity.account;
  }

  async function handle(req, res, url) {
    const pathname = url.pathname.replace(/\/+$/, '');
    if (!pathname.startsWith(PREFIX)) return json(res, 404, { ok: false, code: 'not_found', message: MESSAGES.not_found });
    const actor = await identityOf(req, res);
    if (!actor) return undefined;
    const userId = actor.id;
    const action = pathname.slice(PREFIX.length).replace(/^\/+/, '');
    const method = String(req.method || 'GET').toUpperCase();

    if (action === 'settings') {
      if (method === 'GET') {
        const settings = await service.settingsStore.read(userId);
        return json(res, 200, { ok: true, settings: viewOf(settings) });
      }
      if (method !== 'PUT') return json(res, 405, { ok: false, code: 'method_not_allowed', message: MESSAGES.method }, { Allow: 'GET, PUT' });
      if (!auth.validateCsrf(req, actor)) return json(res, 403, { ok: false, code: 'csrf', message: MESSAGES.csrf });
      let body;
      try {
        body = await readJsonBody(req);
      } catch (err) {
        return json(res, err.status || 400, { ok: false, code: err.code || 'invalid_body', message: err.message });
      }
      try {
        const before = await service.settingsStore.read(userId);
        const wantsEnable = body.enabled === true && !before.enabled;
        const settings = await service.settingsStore.write(userId, body);
        if (wantsEnable) {
          const status = await service.settingsStore.readStatus(userId);
          if (!status.lastTestOk || !status.lastTestAt) {
            await service.settingsStore.write(userId, { enabled: false });
            return json(res, 400, {
              ok: false,
              code: 'backup_test_required',
              message: '开启自动备份前请先点「测试」并确认备份位置可用',
            });
          }
        }
        return json(res, 200, { ok: true, settings: viewOf(await service.settingsStore.read(userId)) });
      } catch (err) {
        return sendError(res, err);
      }
    }

    if (action === 'test' && method === 'POST') {
      if (!auth.validateCsrf(req, actor)) return json(res, 403, { ok: false, code: 'csrf', message: MESSAGES.csrf });
      try {
        const body = await readJsonBody(req);
        const result = await service.testDestination(userId, body.destination || null);
        return json(res, 200, {
          ok: Boolean(result.ok),
          message: result.message || (result.ok ? '可写入' : '不可写'),
          status: await service.readStatus(userId),
        });
      } catch (err) {
        return sendError(res, err);
      }
    }

    if (action === 'run' && method === 'POST') {
      if (!auth.validateCsrf(req, actor)) return json(res, 403, { ok: false, code: 'csrf', message: MESSAGES.csrf });
      try {
        const settings = await service.settingsStore.read(userId);
        if (!settings.scope.settings && !settings.scope.calendars && !settings.scope.attachments) {
          throw new DestinationError('backup_scope_empty', '至少要勾选一项备份内容');
        }
        service.enqueue(userId, { manual: true }).catch((err) => {
          if (logger && typeof logger.event === 'function') logger.event('backup-manual-failed', { userId, code: err.code });
        });
        return json(res, 202, { ok: true, started: true, status: await service.readStatus(userId) });
      } catch (err) {
        return sendError(res, err);
      }
    }

    if (action === 'status' && method === 'GET') {
      return json(res, 200, { ok: true, status: await service.readStatus(userId) });
    }

    if (action === 'list' && method === 'GET') {
      try {
        const items = await service.listBackups(userId);
        return json(res, 200, { ok: true, items: items.slice(0, 20) });
      } catch (err) {
        return sendError(res, err);
      }
    }

    if (action === 'download' && method === 'GET') {
      const name = url.searchParams.get('file') || '';
      if (!name) return json(res, 400, { ok: false, code: 'backup_invalid', message: '缺少文件名' });
      try {
        const file = await service.download(userId, name);
        const stat = await fsp.stat(file);
        res.writeHead(200, {
          'content-type': 'application/gzip',
          'content-length': stat.size,
          'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`,
          'cache-control': 'no-store',
        });
        await pipeline(fs.createReadStream(file), res);
        return undefined;
      } catch (err) {
        return sendError(res, err);
      }
    }

    if (action === 'restore' && method === 'POST') {
      if (!auth.validateCsrf(req, actor)) return json(res, 403, { ok: false, code: 'csrf', message: MESSAGES.csrf });
      const mode = url.searchParams.get('mode') === 'overwrite' ? 'overwrite' : 'merge';
      const confirm = url.searchParams.get('confirm') || '';
      const named = url.searchParams.get('file') || '';
      const uploadDir = path.join(store.userPaths(userId).userDir, 'backups', '.upload');
      await fsp.mkdir(uploadDir, { recursive: true });
      let filePath = '';
      try {
        if (named) {
          filePath = await service.download(userId, named);
        } else {
          filePath = path.join(uploadDir, `${randomBytes(6).toString('hex')}.tar.gz`);
          await pipeline(req, fs.createWriteStream(filePath, { mode: 0o600 }));
        }
        const result = await service.restore(userId, { filePath, mode, confirm });
        return json(res, 200, { ok: true, mode, result });
      } catch (err) {
        return sendError(res, err);
      } finally {
        if (!named && filePath) await fsp.rm(filePath, { force: true }).catch(() => {});
      }
    }

    return json(res, 404, { ok: false, code: 'not_found', message: MESSAGES.not_found });
  }

  return { handle, PREFIX };
}
