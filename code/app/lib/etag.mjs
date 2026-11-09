// 0.6.13 B：GET 条件请求的公共实现（ETag / If-None-Match / 304）。
//
// 只给「读接口」用：`/api/v1/calendars`（GET 列表）与 `/api/v1/kv`（GET 前缀列表，
// 网页侧的事件读取走这里）。`/api/mcp`、`/caldav/*` 不接这套头；401/403 也不加
// ETag —— 否则未登录的 401 会被缓存成 304。
import { createHash } from 'node:crypto';

/** 强校验：返回体 sha1 的前 16 字节（32 位十六进制），RFC 要求的双引号包住。 */
export function etagFor(payload) {
  const digest = createHash('sha1').update(payload).digest('hex').slice(0, 32);
  return `"${digest}"`;
}

/** If-None-Match 只做单值比较（网页客户端只会带一个；`*` 不参与）。 */
export function ifNoneMatchHits(headerValue, etag) {
  if (!headerValue || !etag) return false;
  return String(headerValue)
    .split(',')
    .map((part) => part.trim())
    .some((part) => part === etag);
}

/**
 * 发 JSON；200 时可带 ETag 并支持 304。
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {(res, status, body, extra) => void} sendJson 各模块自己的 sendJson
 * @param {number} status
 * @param {any} body
 * @param {Record<string,string>} [extra]
 */
export function sendJsonEtag(req, res, sendJson, status, body, extra = {}) {
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  const etag = etagFor(payload);
  const headers = { ETag: etag, ...extra };
  const conditional = status === 200
    && (req.method === 'GET' || req.method === 'HEAD')
    && ifNoneMatchHits(req.headers['if-none-match'], etag);
  if (conditional) {
    // 304：无正文；ETag 与 Cache-Control: no-store 仍在。
    res.writeHead(304, { 'Cache-Control': 'no-store', ...headers });
    res.end();
    return;
  }
  sendJson(res, status, body, { ...extra, ETag: etag });
}
