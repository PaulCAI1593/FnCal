#!/usr/bin/env node
/**
 * 0.6.12 B：静态文件运行时压缩（进程内缓存）。
 *
 * 覆盖：
 *   1. `Accept-Encoding: br` -> `Content-Encoding: br` + `Vary: Accept-Encoding`，
 *      `Content-Length` 是压缩后的长度，解压后与磁盘原文一致；
 *   2. `Accept-Encoding: gzip` -> `Content-Encoding: gzip`；
 *   3. 没有 `Accept-Encoding` -> 原文，且不带 `Content-Encoding`；
 *   4. 第一次请求写入缓存（misses+1），第二次命中（hits+1）；
 *   5. 缓存总量上限：超过上限只压缩、不再新增缓存；
 *   6. `/api/*` 响应任何 `Accept-Encoding` 都不带 `Content-Encoding`（安全边界）；
 *   7. `dist` 与 `fnos/app/www` 下 `.map` 计数为 0（0.6.12 A）。
 *
 * 运行：node app/test/static-precompress.test.mjs（与其它 mXX 测试同一方式）
 */
import { spawn } from 'node:child_process';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';

import { createStaticHandler } from '../lib/static.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, '..');
const codeRoot = path.resolve(appRoot, '..');
const DIST = path.join(codeRoot, 'web', 'dist');
const WWW = path.join(appRoot, 'www');
const API_PORT = Number(process.env.CALDAV_PRECOMPRESS_PORT || 5298);
const VAR_DIR = '.var-precompress-test';

const results = [];
let failures = 0;
const children = [];

function record(name, pass, detail = '') {
  results.push({ name, pass });
  if (!pass) failures += 1;
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${name}${detail ? ` | ${detail}` : ''}`);
}

function request(port, pathname, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, method: 'GET', path: pathname, headers },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

async function listen(handler) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://localhost');
    handler(req, res, url.pathname).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, port: server.address().port };
}

async function waitFor(base) {
  for (let i = 0; i < 200; i++) {
    try {
      const r = await fetch(`${base}/api/health`);
      if (r.status) return;
    } catch {
      /* not up yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`server did not start: ${base}`);
}

async function startApiServer(port) {
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: appRoot,
    env: {
      ...process.env,
      CALDAV_PORT: String(port),
      CALDAV_HOST: '127.0.0.1',
      TRIM_PKGVAR: path.join(appRoot, VAR_DIR, String(port)),
      CALDAV_USER: 'admin',
      CALDAV_ADMIN_PASSWORD: 'Precompress-Pass-1',
      CALDAV_AUTH: 'on',
      CALDAV_WEB_DIR: DIST,
    },
    stdio: 'ignore',
  });
  children.push(child);
  await waitFor(`http://127.0.0.1:${port}`);
  return `http://127.0.0.1:${port}`;
}

/** 造一个够大的 JS 文件，确保 br/gzip 都明显变小。 */
async function makeFixtureWebDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fncal-precompress-'));
  await fs.mkdir(path.join(dir, 'assets'), { recursive: true });
  const js = `// fixture\n${'export const repeated = "fncal-precompress-0.6.12";\n'.repeat(200)}`;
  await fs.writeFile(path.join(dir, 'assets', 'app.js'), js);
  await fs.writeFile(path.join(dir, 'index.html'), '<!doctype html><title>FnCal</title>');
  await fs.writeFile(path.join(dir, 'sw.js'), 'self.addEventListener("install", () => {});');
  await fs.writeFile(path.join(dir, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]));
  return { dir, js };
}

async function main() {
  await fs.rm(path.join(appRoot, VAR_DIR), { recursive: true, force: true });
  const fixture = await makeFixtureWebDir();
  const handler = createStaticHandler({ webDir: fixture.dir, version: '0.6.12' });
  const { server, port } = await listen(handler.handle);
  try {
    /* ---------- 1) brotli ---------- */
    {
      const res = await request(port, '/assets/app.js', { 'Accept-Encoding': 'br, gzip' });
      record('br：状态 200', res.status === 200, `status=${res.status}`);
      record('br：Content-Encoding=br', res.headers['content-encoding'] === 'br', `got=${res.headers['content-encoding']}`);
      record(
        'br：Vary 含 Accept-Encoding',
        String(res.headers.vary || '').toLowerCase().includes('accept-encoding'),
        `vary=${res.headers.vary}`,
      );
      const decoded = brotliDecompressSync(res.body).toString('utf8');
      record('br：解压后与原文一致', decoded === fixture.js, `bytes=${res.body.length}`);
      record(
        'br：Content-Length 是压缩后长度',
        Number(res.headers['content-length']) === res.body.length && res.body.length < Buffer.byteLength(fixture.js),
        `len=${res.headers['content-length']} raw=${Buffer.byteLength(fixture.js)}`,
      );
      const stats1 = handler.compressionStats();
      record('br：第一次是 miss 并写入缓存', stats1.misses >= 1 && stats1.entries >= 1, JSON.stringify(stats1));
    }

    /* ---------- 2) 第二次命中缓存 ---------- */
    {
      const before = handler.compressionStats();
      const res = await request(port, '/assets/app.js', { 'Accept-Encoding': 'br' });
      const after = handler.compressionStats();
      record('缓存：第二次命中（hits +1）', after.hits === before.hits + 1, `${before.hits} -> ${after.hits}`);
      record('缓存：没有新增 miss', after.misses === before.misses, `${before.misses} -> ${after.misses}`);
      record('缓存：body 仍是 br', res.headers['content-encoding'] === 'br', `got=${res.headers['content-encoding']}`);
    }

    /* ---------- 3) gzip 回退 ---------- */
    {
      const res = await request(port, '/assets/app.js', { 'Accept-Encoding': 'gzip' });
      record('gzip：Content-Encoding=gzip', res.headers['content-encoding'] === 'gzip', `got=${res.headers['content-encoding']}`);
      record('gzip：解压后一致', gunzipSync(res.body).toString('utf8') === fixture.js, `bytes=${res.body.length}`);
      record('gzip：Vary 保留', String(res.headers.vary || '').toLowerCase().includes('accept-encoding'), `vary=${res.headers.vary}`);
    }

    /* ---------- 4) 无 Accept-Encoding -> 原文 ---------- */
    {
      const res = await request(port, '/assets/app.js');
      record('无 header：不带 Content-Encoding', !res.headers['content-encoding'], `got=${res.headers['content-encoding']}`);
      record('无 header：原文一致', res.body.toString('utf8') === fixture.js, `bytes=${res.body.length}`);
    }

    /* ---------- 5) index.html / sw.js 也压缩 ---------- */
    {
      const index = await request(port, '/', { 'Accept-Encoding': 'br' });
      record('index.html：br 压缩', index.headers['content-encoding'] === 'br', `got=${index.headers['content-encoding']}`);
      const sw = await request(port, '/sw.js', { 'Accept-Encoding': 'gzip' });
      record('sw.js：gzip 压缩', sw.headers['content-encoding'] === 'gzip', `got=${sw.headers['content-encoding']}`);
      const png = await request(port, '/logo.png', { 'Accept-Encoding': 'br, gzip' });
      record('png：不压缩', !png.headers['content-encoding'], `got=${png.headers['content-encoding']}`);
    }

    /* ---------- 6) 8 MB 上限：只压缩不新增缓存 ---------- */
    {
      const bigDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fncal-precompress-big-'));
      await fs.mkdir(path.join(bigDir, 'assets'), { recursive: true });
      const big = 'const x = 1;\n'.repeat(2000); // ~24 KB
      await fs.writeFile(path.join(bigDir, 'assets', 'big.js'), big);
      const smallHandler = createStaticHandler({ webDir: bigDir, compressionLimit: 64 });
      const small = await listen(smallHandler.handle);
      try {
        const res = await request(small.port, '/assets/big.js', { 'Accept-Encoding': 'br' });
        const stats = smallHandler.compressionStats();
        record('上限：仍返回 br', res.headers['content-encoding'] === 'br', `got=${res.headers['content-encoding']}`);
        record('上限：缓存不新增（entries=0, bytes=0）', stats.entries === 0 && stats.bytes === 0, JSON.stringify(stats));
      } finally {
        await new Promise((resolve) => small.server.close(resolve));
      }
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  /* ---------- 7) API 响应永不压缩 ---------- */
  {
    const base = await startApiServer(API_PORT);
    for (const accept of ['br, gzip', 'gzip', '']) {
      const res = await fetch(`${base}/api/health`, {
        headers: accept ? { 'Accept-Encoding': accept } : { 'Accept-Encoding': 'identity' },
      });
      record(
        `/api/health 不带 Content-Encoding（AE=${accept || 'identity'}）`,
        !res.headers.get('content-encoding'),
        `got=${res.headers.get('content-encoding')}`,
      );
    }
    const boot = await fetch(`${base}/api/bootstrap`, { headers: { 'Accept-Encoding': 'br, gzip' } });
    record('API：/api/bootstrap 不带 Content-Encoding', !boot.headers.get('content-encoding'), `got=${boot.headers.get('content-encoding')}`);
  }

  /* ---------- 8) 产物 .map 计数 0 ---------- */
  {
    const countMaps = async (dir) => {
      let n = 0;
      async function walk(d) {
        let entries = [];
        try {
          entries = await fs.readdir(d, { withFileTypes: true });
        } catch {
          return;
        }
        for (const entry of entries) {
          const p = path.join(d, entry.name);
          if (entry.isDirectory()) await walk(p);
          else if (/\.map$/i.test(entry.name)) n += 1;
        }
      }
      await walk(dir);
      return n;
    };
    const distMaps = await countMaps(DIST);
    const wwwMaps = await countMaps(WWW);
    record('dist 下 .map 计数为 0', distMaps === 0, `count=${distMaps}`);
    record('fnos/app/www 下 .map 计数为 0', wwwMaps === 0, `count=${wwwMaps}`);
  }

  /* ---------- 9) 包内不新增压缩件 ---------- */
  {
    const files = [];
    async function walk(dir) {
      let entries = [];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(p);
        else files.push(entry.name);
      }
    }
    await walk(WWW);
    const compressed = files.filter((name) => /\.(gz|br)$/i.test(name));
    record('fnos/app/www 中没有 .gz/.br 文件', compressed.length === 0, `files=${compressed.length}`);
  }

  await fs.rm(fixture.dir, { recursive: true, force: true });
  await fs.rm(path.join(appRoot, VAR_DIR), { recursive: true, force: true });
  for (const child of children) child.kill();

  const pass = results.filter((r) => r.pass).length;
  console.log(`SUMMARY: pass=${pass} fail=${failures} checks=${results.length}`);
  if (failures > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error('UNEXPECTED', err);
  for (const child of children) child.kill();
  process.exitCode = 1;
});
