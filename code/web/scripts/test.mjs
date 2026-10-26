/**
 * 测试入口：把进程时区固定为 America/New_York 后再启动 vitest。
 *
 * 为什么需要 wrapper：上游的 DST / 时区用例以「春季拨快那天只有 23 小时」为
 * 基线（America/New_York 的 3 月第二个周日）。若在 Asia/Hong_Kong 等无 DST
 * 的机器上直接跑，断言会失败，属于环境噪声而非代码问题。
 *
 * Windows 的 Node 在进程启动后修改 process.env.TZ 不会生效，所以必须在
 * 子进程启动前设置。用法：
 *   npm test            → vitest run
 *   npm run test:watch  → vitest（监听）
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const vitest = path.resolve(here, '..', 'node_modules', 'vitest', 'vitest.mjs');

const mode = process.argv[2] === 'watch' ? 'watch' : 'run';
const rest = process.argv.slice(mode === 'watch' ? 3 : 2);
const args = mode === 'watch' ? rest : ['run', ...rest];

const env = { ...process.env, TZ: process.env.TZ || 'America/New_York' };
const child = spawn(process.execPath, [vitest, ...args], { stdio: 'inherit', env });
child.on('exit', (code) => process.exit(code == null ? 1 : code));
child.on('error', (err) => {
  console.error('[test] failed to start vitest:', err.message);
  process.exit(1);
});
