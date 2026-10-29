// 通用版本号落点：后端 server.mjs 的 VERSION 与 fnOS manifest（从当前值自愈式升到目标值）。
// 用法：node code/build-tmp/bump-version.mjs 0.2.28     （cwd = 仓库根）
// 只改这两个文件；前端版本串/指纹由 scripts/stamp-version.mjs 在构建时生成。
import fs from 'node:fs';

const target = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(target || '')) {
  console.error('[usage] node code/build-tmp/bump-version.mjs <x.y.z>');
  process.exit(2);
}

function bump(file, pairs) {
  let s = fs.readFileSync(file, 'utf8');
  for (const [from, to] of pairs) {
    if (!s.includes(from)) throw new Error(`[miss] ${file}: ${from}`);
    s = s.split(from).join(to);
  }
  fs.writeFileSync(file, s);
  console.log('[ok]', file);
}

const server = fs.readFileSync('code/app/server.mjs', 'utf8');
const from = /export const VERSION = '(\d+\.\d+\.\d+)'/.exec(server)?.[1];
if (!from) throw new Error('[miss] server.mjs VERSION');
const manifestFrom = /^version=(.+)$/m.exec(fs.readFileSync('code/fnos/manifest', 'utf8'))?.[1];

bump('code/app/server.mjs', [[`export const VERSION = '${from}';`, `export const VERSION = '${target}';`]]);
bump('code/fnos/manifest', [[`version=${manifestFrom}`, `version=${target}`]]);

const version = /^version=(.+)$/m.exec(fs.readFileSync('code/fnos/manifest', 'utf8'))?.[1];
const serverNow = /export const VERSION = '([^']+)'/.exec(fs.readFileSync('code/app/server.mjs', 'utf8'))?.[1];
const ok = version === target && serverNow === target;
console.log(`[check] ${from} -> manifest=${version} server=${serverNow} ${ok ? 'OK' : 'MISMATCH'}`);
if (!ok) process.exit(1);
