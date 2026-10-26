/**
 * 0.2.4：favicon 缓存自动刷新（构建期版本串，测真实 CLI）。
 *   - `stamp-version.mjs` 给 index.html 的 favicon/apple-touch/manifest 链接、
 *     以及 site.webmanifest 的 icons[].src 注入 `?v=<version>`；
 *   - 幂等：重复执行/换版本只替换，不叠加查询串；
 *   - 缺必需链接时退出码 1（避免打包出不会刷新的图标）。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const webRoot = process.cwd();
const scriptPath = path.resolve(webRoot, '..', 'scripts', 'stamp-version.mjs');

let dir;
let manifestPath;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fncal-stamp-'));
  const indexHtml = await fs.readFile(path.join(webRoot, 'index.html'), 'utf8');
  const manifest = await fs.readFile(path.join(webRoot, 'public', 'site.webmanifest'), 'utf8');
  manifestPath = path.join(dir, 'manifest');
  await fs.writeFile(manifestPath, 'appname=FnCal\nversion=9.9.9\n');
  await fs.writeFile(path.join(dir, 'sw.js'), "const CACHE = 'fncal-shell-v1';\n");
  await fs.writeFile(path.join(dir, 'index.html'), indexHtml);
  await fs.writeFile(path.join(dir, 'site.webmanifest'), manifest);
});

afterEach(async () => {
  if (dir) await fs.rm(dir, { recursive: true, force: true });
  dir = null;
});

const read = (name) => fs.readFile(path.join(dir, name), 'utf8');
const writeManifestVersion = (version) => fs.writeFile(manifestPath, `appname=FnCal\nversion=${version}\n`);
const runStamp = () => spawnSync(process.execPath, [scriptPath, '--dist', dir, '--manifest', manifestPath], {
  stdio: 'ignore',
});

describe('构建期 favicon/manifest 版本串', () => {
  it('index.html 的 favicon/apple-touch/manifest 链接带 ?v=9.9.9', async () => {
    expect(runStamp().status).toBe(0);
    const html = await read('index.html');
    for (const file of [
      'favicon.ico',
      'favicon-16x16.png',
      'favicon-32x32.png',
      'apple-touch-icon.png',
      'site.webmanifest',
    ]) {
      expect(html).toContain(`${file}?v=9.9.9`);
    }
    expect(html).not.toMatch(/\?v=9\.9\.9\?v=/);
  });

  it('site.webmanifest icons[].src 全部带 ?v=9.9.9，原路径不变', async () => {
    expect(runStamp().status).toBe(0);
    const wm = JSON.parse(await read('site.webmanifest'));
    expect(wm.icons.length).toBe(4);
    for (const icon of wm.icons) expect(icon.src).toMatch(/\?v=9\.9\.9$/);
    expect(wm.icons.map((i) => i.src.split('?')[0])).toEqual([
      '/icon-192.png',
      '/icon-512.png',
      '/icon-192-maskable.png',
      '/icon-512-maskable.png',
    ]);
  });

  it('幂等：重复执行不叠加；换版本只替换查询串', async () => {
    expect(runStamp().status).toBe(0);
    expect(runStamp().status).toBe(0);
    let html = await read('index.html');
    expect((html.match(/favicon-32x32\.png\?v=9\.9\.9/g) || []).length).toBe(1);

    await writeManifestVersion('9.9.10');
    expect(runStamp().status).toBe(0);
    html = await read('index.html');
    expect(html).toContain('favicon-32x32.png?v=9.9.10');
    expect(html).not.toContain('?v=9.9.9');
    const wm = JSON.parse(await read('site.webmanifest'));
    for (const icon of wm.icons) expect(icon.src.endsWith('?v=9.9.10')).toBe(true);
    const sw = await read('sw.js');
    expect(sw).toContain('fncal-shell-9.9.10');
    expect(sw).not.toMatch(/fncal-shell-v1/);
  });

  it('缺必需链接（apple-touch）时退出码 1，而不是悄悄出包', async () => {
    const html = (await read('index.html')).replace(/\s*<link rel="apple-touch-icon"[^>]*>/, '');
    await fs.writeFile(path.join(dir, 'index.html'), html);
    expect(runStamp().status).toBe(1);
  });
});
