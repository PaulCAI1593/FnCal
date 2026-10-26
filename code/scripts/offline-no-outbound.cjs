/**
 * offline-no-outbound.cjs —— M3.11 断网验证的进程内探针（Node `--require` 预载）。
 *
 * 只做一件事：拦截 Node 的**出站**连接（http/https request/get、net.Socket.connect），
 * 把目标不是回环地址的尝试写进 `FNCAL_OUTBOUND_LOG`。服务端正常启动、监听端口、
 * 处理本机 curl 都不会产生记录；一旦运行期偷偷访问外网（CDN/云 API/统计），
 * 这里就有行。
 *
 * 用法（由 scripts/offline-smoke.mjs 自动设置）：
 *   NODE_OPTIONS="--require <abs>/offline-no-outbound.cjs" FNCAL_OUTBOUND_LOG=<file> node server.mjs
 */

'use strict';

const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');

const LOG_FILE = process.env.FNCAL_OUTBOUND_LOG || '';

function isLoopback(host) {
  if (!host) return true; // Node defaults to localhost for TCP connects
  const value = String(host).toLowerCase().replace(/^\[|\]$/g, '');
  return value === 'localhost'
    || value === '::1'
    || value === '::'
    || value.startsWith('127.')
    || value.endsWith('.localhost');
}

function record(kind, host, port) {
  if (!LOG_FILE) return;
  try {
    fs.appendFileSync(LOG_FILE, `${JSON.stringify({ kind, host: host || '', port: port || null, at: Date.now() })}\n`);
  } catch {
    /* probing must never break the app */
  }
}

function hostOf(options) {
  if (!options) return '';
  if (typeof options === 'string') {
    try {
      return new URL(options).hostname;
    } catch {
      return '';
    }
  }
  if (options instanceof URL) return options.hostname;
  return options.hostname || options.host || '';
}

function wrapRequest(module, name, kind) {
  const original = module[name];
  if (typeof original !== 'function') return;
  module[name] = function patched(...args) {
    const host = hostOf(args[0]);
    if (!isLoopback(host)) record(kind, host, args[0] && args[0].port);
    return original.apply(this, args);
  };
}

wrapRequest(http, 'request', 'http.request');
wrapRequest(http, 'get', 'http.get');
wrapRequest(https, 'request', 'https.request');
wrapRequest(https, 'get', 'https.get');

const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function patchedConnect(...args) {
  try {
    const first = args[0];
    if (first && typeof first === 'object' && !Array.isArray(first)) {
      if (!isLoopback(first.host || first.hostname)) record('net.connect', first.host || first.hostname, first.port);
    } else if (typeof first === 'number') {
      const host = args[1];
      if (!isLoopback(host)) record('net.connect', host, first);
    }
  } catch {
    /* ignore probe errors */
  }
  return originalConnect.apply(this, args);
};
