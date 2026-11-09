#!/usr/bin/env node
/**
 * 0.6.14：会话默认值放宽（空闲 30 天 / 绝对 90 天）+ security.json schemaVersion 1→2 迁移。
 *
 * 六条用例：
 *   ① 空文件 → 空闲 43200 / 绝对 90 / schemaVersion 2；
 *   ② v1 文件 720 / 7 → 迁移为 43200 / 90，load() 后磁盘上的 schemaVersion 变成 2；
 *   ③ v1 文件自定义 60 / 3 → 原样保留（只升结构版本）；
 *   ④ v1 文件空闲 600、绝对 7 → 空闲保 600，绝对迁到 90；
 *   ⑤ sessionLifetimes() → 43200×60000 与 90×86400000；
 *   ⑥ 越界 999999 仍被 clamp 到上限（43200 / 365）。
 *
 * 运行：node app/test/session-defaults-0614.test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { createSecurityStore, normalizeSecurity } from '../security/config.mjs';
import { createSecurityService } from '../security/service.mjs';

const TMP = path.join(process.cwd(), 'build-tmp', `tmp-0614-session-${process.pid}`);
fs.mkdirSync(TMP, { recursive: true });

const silentLogger = { info() {}, warn() {}, error() {}, log() {} };
const fileOf = (name) => path.join(TMP, name);
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

let pass = 0;
let fail = 0;
function record(name, ok, detail = '') {
  if (ok) pass += 1;
  else fail += 1;
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` | ${detail}` : ''}`);
}

// ① 空文件（0 字节）：解析失败走缺省值，缺省即新默认。
const emptyFile = fileOf('empty.json');
fs.writeFileSync(emptyFile, '');
const empty = createSecurityStore({ file: emptyFile, logger: silentLogger }).load();
record(
  '① 空文件 → 空闲 43200 / 绝对 90 / schemaVersion 2',
  empty.session.idleMinutes === 43200 && empty.session.absoluteDays === 90 && empty.schemaVersion === 2,
  `idle=${empty.session.idleMinutes} absolute=${empty.session.absoluteDays} schema=v${empty.schemaVersion}`,
);

// ② v1 旧默认 720 / 7：内存迁移 + 立即回写磁盘。
const legacyFile = fileOf('v1-defaults.json');
fs.writeFileSync(legacyFile, `${JSON.stringify({ schemaVersion: 1, session: { idleMinutes: 720, absoluteDays: 7 } }, null, 2)}\n`);
const logs = [];
const logger = {
  info: (message) => logs.push(String(message)),
  warn: (message) => logs.push(`warn:${message}`),
  error() {},
  log() {},
};
const migrated = createSecurityStore({ file: legacyFile, logger }).load();
const legacyDisk = readJson(legacyFile);
record(
  '② v1 默认 720 / 7 → 迁移 43200 / 90，磁盘升到 v2',
  migrated.session.idleMinutes === 43200 && migrated.session.absoluteDays === 90 && migrated.schemaVersion === 2 &&
    legacyDisk.schemaVersion === 2 && legacyDisk.session.idleMinutes === 43200 && legacyDisk.session.absoluteDays === 90 &&
    logs.some((message) => message.includes('会话默认值迁移')),
  `mem=${migrated.session.idleMinutes}/${migrated.session.absoluteDays}/v${migrated.schemaVersion} ` +
    `disk=v${legacyDisk.schemaVersion} ${legacyDisk.session.idleMinutes}/${legacyDisk.session.absoluteDays} logs=${logs.length}`,
);

// ③ 自定义值不迁移，只升结构版本。
const custom = normalizeSecurity({ schemaVersion: 1, session: { idleMinutes: 60, absoluteDays: 3 } });
record(
  '③ v1 自定义 60 / 3 → 原样保留，schemaVersion 2',
  custom.session.idleMinutes === 60 && custom.session.absoluteDays === 3 && custom.schemaVersion === 2,
  `idle=${custom.session.idleMinutes} absolute=${custom.session.absoluteDays} schema=v${custom.schemaVersion}`,
);

// ④ 只有等于旧默认的那一项迁移。
const half = normalizeSecurity({ schemaVersion: 1, session: { idleMinutes: 600, absoluteDays: 7 } });
record(
  '④ v1 空闲 600、绝对 7 → 600 保留 / 绝对迁到 90',
  half.session.idleMinutes === 600 && half.session.absoluteDays === 90 && half.schemaVersion === 2,
  `idle=${half.session.idleMinutes} absolute=${half.session.absoluteDays}`,
);

// ⑤ 服务层把设置换算成毫秒。
const lifeFile = fileOf('v2.json');
fs.writeFileSync(lifeFile, `${JSON.stringify(normalizeSecurity({}), null, 2)}\n`);
const service = createSecurityService({ file: lifeFile, logger: silentLogger, accounts: {} });
const lifetimes = service.sessionLifetimes();
record(
  '⑤ sessionLifetimes() → 43200×60000 / 90×86400000',
  lifetimes.idleMs === 43200 * 60 * 1000 && lifetimes.absoluteMs === 90 * 24 * 60 * 60 * 1000,
  `idleMs=${lifetimes.idleMs} absoluteMs=${lifetimes.absoluteMs}`,
);

// ⑥ 上限仍由 LIMITS 夹住，不接受任意大数。
const clamped = normalizeSecurity({ schemaVersion: 2, session: { idleMinutes: 999999, absoluteDays: 999999 } });
record(
  '⑥ 越界 999999 夹到上限 43200 / 365',
  clamped.session.idleMinutes === 43200 && clamped.session.absoluteDays === 365,
  `idle=${clamped.session.idleMinutes} absolute=${clamped.session.absoluteDays}`,
);

console.log(`SUMMARY: pass=${pass} fail=${fail}`);
if (fail > 0) process.exitCode = 1;
