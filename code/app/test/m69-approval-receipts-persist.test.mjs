/* 0.8.43（用户定·回执可靠送达）：回执要落盘，重启后还能送到 AI。
 *
 * 背景：回执原先只在进程内 Map 里；服务重启（升级、崩溃、fnOS 停止再启动）后，
 * 用户在 App 里批过的那条就消失了，AI 永远等不到。本套件直接测 lib/approval-receipts.mjs：
 *   M69-1 第 1 个实例 publish 后落盘文件存在，内容含 proposalId/action/ok/decidedAt。
 *   M69-2 换一个新实例（同一文件）能读回，且 take() 能取到这条未交付回执。
 *   M69-3 已交付状态也落盘：第 2 个实例 take 后，第 3 个实例 take 返回空（不重复搭车）。
 *   M69-4 过期（超过 TTL）条目在读回时丢弃。
 *   M69-5 坏文件（非 JSON / 字段缺失）不抛错，服务照常起来。
 *   M69-6 不给 file 时行为不变（纯内存，不写盘）。
 */
import fs from 'node:fs';
import path from 'node:path';

const TMP = path.join(process.cwd(), 'build-tmp', `tmp-0843-receipts-persist-${process.pid}`);
if (!/code[\\/]build-tmp$/.test(path.dirname(TMP))) {
  throw new Error(`临时目录必须在 code/build-tmp 下，实际=${TMP}｜请从 code 目录运行本测试`);
}
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

const { createApprovalReceipts } = await import('../lib/approval-receipts.mjs');

const results = [];
let failures = 0;
function record(name, expected, actual, pass, detail = '') {
  results.push({ name, pass });
  if (!pass) failures += 1;
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${name} | expected=${expected} actual=${actual}${detail ? ` | ${detail}` : ''}`);
}
const eq = (name, expected, actual, detail = '') => record(name, expected, actual, expected === actual, detail);
const ok = (name, actual, detail = '') => record(name, 'true', String(actual), Boolean(actual), detail);

const file = path.join(TMP, 'approval-receipts.json');
const credentialId = 'cred-1';

try {
  // M69-1：publish 落盘
  const first = createApprovalReceipts({ file, logger: null });
  first.publish({ credentialId, proposalId: 'p-1', action: 'accept', ok: true });
  ok('M69-1 落盘文件存在', fs.existsSync(file));
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  eq('M69-1 盘上版本号', 1, onDisk.version);
  eq('M69-1 盘上条数', 1, Array.isArray(onDisk.receipts) ? onDisk.receipts.length : -1);
  const diskRow = (onDisk.receipts || [])[0] || {};
  eq('M69-1 盘上 proposalId', 'p-1', diskRow.proposalId);
  eq('M69-1 盘上 action', 'accept', diskRow.action);
  eq('M69-1 盘上 ok', true, diskRow.ok);
  ok('M69-1 盘上 decidedAt 是 ISO 时间', Number.isFinite(Date.parse(diskRow.decidedAt)));
  eq('M69-1 盘上不带凭据令牌字段', undefined, diskRow.token);

  // M69-2：新实例读回并交付
  const second = createApprovalReceipts({ file, logger: null });
  const taken = second.take({ credentialId });
  eq('M69-2 读回后 take 条数', 1, taken.length);
  eq('M69-2 读回的 proposalId', 'p-1', taken[0] && taken[0].proposalId);
  eq('M69-2 读回的 action', 'accept', taken[0] && taken[0].action);

  // M69-3：已交付状态落盘，第三次启动不再重复交付
  const third = createApprovalReceipts({ file, logger: null });
  eq('M69-3 已交付的不再搭车', 0, third.take({ credentialId }).length);

  // M69-4：过期条目读回时丢弃
  const expiredFile = path.join(TMP, 'expired.json');
  fs.writeFileSync(expiredFile, JSON.stringify({
    version: 1,
    receipts: [{
      credentialId,
      proposalId: 'p-old',
      action: 'accept',
      ok: true,
      decidedAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
      deliveredAt: null,
    }],
  }), 'utf8');
  const expired = createApprovalReceipts({ file: expiredFile, logger: null });
  eq('M69-4 过期回执丢弃', 0, expired.take({ credentialId }).length);

  // M69-5：坏文件不抛错
  const brokenFile = path.join(TMP, 'broken.json');
  fs.writeFileSync(brokenFile, '{ not json', 'utf8');
  let brokenThrew = false;
  let broken;
  try {
    broken = createApprovalReceipts({ file: brokenFile, logger: null });
  } catch {
    brokenThrew = true;
  }
  ok('M69-5 坏文件不抛错', !brokenThrew);
  eq('M69-5 坏文件后可从空开始', 0, broken ? broken.take({ credentialId }).length : -1);
  broken.publish({ credentialId, proposalId: 'p-after-broken', action: 'reject', ok: false });
  const repaired = JSON.parse(fs.readFileSync(brokenFile, 'utf8'));
  eq('M69-5 坏文件被新内容覆盖', 1, (repaired.receipts || []).length);

  // M69-6：不给 file 时纯内存
  const memoryOnly = createApprovalReceipts({ logger: null });
  memoryOnly.publish({ credentialId, proposalId: 'p-mem', action: 'accept', ok: true });
  eq('M69-6 无 file 时 take 仍能取', 1, memoryOnly.take({ credentialId }).length);
  const files = fs.readdirSync(TMP).filter((name) => name.endsWith('.json'));
  ok('M69-6 无 file 时没有多写文件', files.length === 3, `json files=${files.join(',')}`);
} finally {
  fs.rmSync(TMP, { recursive: true, force: true });
}

const passed = results.filter((item) => item.pass).length;
console.log(`\n[m69] ${passed}/${results.length} 通过，失败 ${failures} 条`);
if (failures > 0) {
  console.log(`[m69] 失败项：${results.filter((item) => !item.pass).map((item) => item.name).join('；')}`);
  process.exitCode = 1;
}
