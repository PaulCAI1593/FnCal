/* 0.9.1 / 任务书 product/0.9.1-NAS文件夹-任务书.md §二 A 项：附件随日程回收站联动。
 *
 * 覆盖（8 条）：
 *   A1 单次事件 2 个附件 → 进回收站后原路径无目录，回收站条目里有 2 组。
 *   A2 还原单次事件 → 附件目录回原位、字节与 meta 条目一致。
 *   A3 系列 3 次各带附件 → 只删第 2 次，回收站里只有那一期；还原只回那一期。
 *   A4 删整系列 → 三组都进回收站；还原全部回原位、其他键不受影响。
 *   A5 清空回收站 → 附件目录被彻底删除，pruneOrphans 报 0 孤儿。
 *   A6 同一键重复还原 → 不覆盖，冲突文件带 `-restored`，meta 条目不重复。
 *   A7 到期清理 → purgeExpiredTrash 删过期条目、保留未过期条目。
 *   A8 回滚（删除失败）→ drop({restoreAttachments:true}) 把附件搬回原位。
 *
 * 跑法（cwd = projects/FnCal/code）：
 *   node app/test/m71-attachments-trash.test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';

const TMP = path.join(process.cwd(), 'build-tmp', `tmp-0845-trash-${process.pid}`);
if (!/code[\\/]build-tmp$/.test(path.dirname(TMP))) {
  throw new Error(`临时目录必须在 code/build-tmp 下，实际=${TMP}｜请从 code 目录运行本测试`);
}
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });

const { createStore } = await import('../store/file-store.mjs');
const { createAttachmentStore } = await import('../lib/attachments.mjs');
const { createAiTrash } = await import('../lib/ai-trash.mjs');
const { runWithContext } = await import('../lib/request-context.mjs');

const results = [];
let failures = 0;
function record(name, expected, actual, pass, detail = '') {
  results.push({ name, pass });
  if (!pass) failures += 1;
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${name} | expected=${expected} actual=${actual}${detail ? ` | ${detail}` : ''}`);
}
const eq = (name, expected, actual, detail = '') => record(name, expected, actual, expected === actual, detail);
const ok = (name, actual, detail = '') => record(name, 'true', String(actual), Boolean(actual), detail);

const USER = 'admin';
const CAL = 'cal1';
const store = createStore({ root: TMP, logger: null });
await store.ensureRoot();
await runWithContext({ userId: USER }, async () => {
  await store.createCalendar(USER, CAL, { displayName: '工作', color: '#3b82f6' });
});

const attachments = createAttachmentStore({ store, logger: null });
const trash = createAiTrash({ store, logger: null, attachments });

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
);
const TEXT = Buffer.from('quarter report 2026-Q4\n', 'utf8');

function ics(uid, extra = '') {
  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//FnCal//test//CN',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    'DTSTAMP:20261119T000000Z',
    'DTSTART:20261120T090000Z',
    'DTEND:20261120T100000Z',
    'SUMMARY:带附件的事件',
    extra,
    'END:VEVENT',
    'END:VCALENDAR',
  ].filter(Boolean).join('\r\n');
}

async function seed(key, files) {
  for (const file of files) {
    await attachments.addAttachment({ userId: USER, calendarId: CAL, key, name: file.name, data: file.bytes });
  }
}

function dirOf(key) {
  const base = path.join(TMP, USER, CAL, 'attachments');
  return path.join(base, key.replace('::', '-'));
}

function delObj(uid) {
  return runWithContext({ userId: USER }, () => store.deleteEvent(CAL, `${uid}.ics`));
}

const RID1 = '1796778000000';
const RID2 = '1801875600000';
const RID3 = '1804386000000';

// ---- A1：单次事件 2 个附件进回收站
await runWithContext({ userId: USER }, async () => {
  await store.putObject(USER, CAL, 'solo-one.ics', ics('solo-one'));
});
await seed('solo-one', [{ name: 'a.png', mime: 'image/png', bytes: PNG }, { name: 'b.txt', mime: 'text/plain', bytes: TEXT }]);
ok('A1 前置：单次事件附件目录在', fs.existsSync(dirOf('solo-one')));
const soloItem = await trash.add(USER, {
  calendarId: CAL, calendarName: '工作', uid: 'solo-one', ics: ics('solo-one'), title: '带附件的事件',
});
eq('A1 回收站条目记下 2 个附件键', 1, soloItem.attachmentKeys.length);
eq('A1 原附件目录已移走', false, fs.existsSync(dirOf('solo-one')));
const trashEntry = path.join(TMP, USER, CAL, '.attachments-trash', soloItem.id);
eq('A1 回收站目录里有该事件', true, fs.existsSync(path.join(trashEntry, 'solo-one')));
eq('A1 回收站里保留 2 个附件文件', 2, fs.readdirSync(path.join(trashEntry, 'solo-one')).filter((n) => n !== 'meta.json').length);

// ---- A2：还原（先像真实删除那样删掉对象）
await delObj('solo-one');
await runWithContext({ userId: USER }, async () => {
  const restored = await trash.restore(USER, soloItem.id);
  eq('A2 还原后对象可读', 'solo-one', restored.uid);
  const list = await attachments.listAttachments({ userId: USER, calendarId: CAL, key: 'solo-one' });
  eq('A2 附件条目回到 2 条', 2, list.items.length);
  eq('A2 回收站条目已消失', 0, fs.existsSync(trashEntry) ? 1 : 0);
  const read = await attachments.readAttachment({ userId: USER, attachmentId: list.items.find((i) => i.name === 'b.txt').id });
  eq('A2 字节一致', TEXT.toString('utf8'), read ? read.data.toString('utf8') : 'null');
});

// ---- A3：系列三次，只删第 2 期
await runWithContext({ userId: USER }, async () => {
  await store.putObject(USER, CAL, 'series-a.ics', ics('series-a', 'RRULE:FREQ=DAILY;COUNT=3'));
});
for (const [rid, label] of [[RID1, 'x'], [RID2, 'y'], [RID3, 'z']]) {
  await seed(`series-a::${rid}`, [{ name: `${label}.png`, mime: 'image/png', bytes: PNG }]);
}
const oneItem = await trash.add(USER, {
  calendarId: CAL, calendarName: '工作', uid: `series-a::${RID2}`, ics: ics('series-a'), title: '系列第 2 期',
});
eq('A3 只带走第 2 期一个键', `series-a::${RID2}`, oneItem.attachmentKeys.join(','));
eq('A3 第 1 期仍在原处', true, fs.existsSync(dirOf(`series-a::${RID1}`)));
eq('A3 第 3 期仍在原处', true, fs.existsSync(dirOf(`series-a::${RID3}`)));
await attachments.restoreFromTrash({ userId: USER, calendarId: CAL, trashId: oneItem.id });
eq('A3 第 2 期还原回原位', true, fs.existsSync(dirOf(`series-a::${RID2}`)));
eq('A3 第 2 期条目 1 条', 1, (await attachments.listAttachments({ userId: USER, calendarId: CAL, key: `series-a::${RID2}` })).items.length);

// ---- A4：删整系列
const allItem = await trash.add(USER, {
  calendarId: CAL, calendarName: '工作', uid: 'series-a', ics: ics('series-a', 'RRULE:FREQ=DAILY;COUNT=3'), title: '整个系列',
});
eq('A4 整系列带走 3 个键', 3, allItem.attachmentKeys.length);
for (const rid of [RID1, RID2, RID3]) eq(`A4 第 ${rid} 期已移走`, false, fs.existsSync(dirOf(`series-a::${rid}`)));
await delObj('series-a');
await runWithContext({ userId: USER }, async () => {
  await trash.restore(USER, allItem.id);
});
for (const rid of [RID1, RID2, RID3]) eq(`A4 还原后第 ${rid} 期回原位`, true, fs.existsSync(dirOf(`series-a::${rid}`)));

// ---- A6：同一键重复还原（同名文件冲突 → -restored，不覆盖）
await seed('solo-two', [{ name: 'dup.txt', mime: 'text/plain', bytes: TEXT }]);
const dupItem = await trash.add(USER, {
  calendarId: CAL, calendarName: '工作', uid: 'solo-two', ics: ics('solo-two'), title: '重复还原',
});
await delObj('solo-two');
const dupEntry = path.join(TMP, USER, CAL, '.attachments-trash', dupItem.id, 'solo-two');
const dupFile = fs.readdirSync(dupEntry).filter((n) => n !== 'meta.json')[0];
fs.mkdirSync(dirOf('solo-two'), { recursive: true });
fs.copyFileSync(path.join(dupEntry, dupFile), path.join(dirOf('solo-two'), dupFile));
await attachments.restoreFromTrash({ userId: USER, calendarId: CAL, trashId: dupItem.id });
const dupNames = fs.readdirSync(dirOf('solo-two')).filter((n) => n !== 'meta.json');
eq('A6 同名冲突不覆盖：文件变 2 个', 2, dupNames.length);
eq('A6 冲突文件加 -restored 后缀', true, dupNames.some((n) => n.includes('-restored')));
eq('A6 原文件名保留', true, dupNames.some((n) => n === dupFile));
eq('A6 meta 条目 1 条且指向改名后的文件', 'dup-restored.txt',
  (await attachments.listAttachments({ userId: USER, calendarId: CAL, key: 'solo-two' })).items[0].name);
// 清掉人为放进去的那份（没有 meta 条目），免得被 A5 的孤儿清扫当成越界证据
fs.unlinkSync(path.join(dirOf('solo-two'), dupFile));

// ---- A7：到期清理
await seed('solo-three', [{ name: 'old.txt', mime: 'text/plain', bytes: TEXT }]);
const oldItem = await trash.add(USER, {
  calendarId: CAL, calendarName: '工作', uid: 'solo-three', ics: ics('solo-three'), title: '过期',
});
const oldEntry = path.join(TMP, USER, CAL, '.attachments-trash', oldItem.id);
const past = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
fs.utimesSync(oldEntry, past, past);
await seed('solo-four', [{ name: 'new.txt', mime: 'text/plain', bytes: TEXT }]);
const newItem = await trash.add(USER, {
  calendarId: CAL, calendarName: '工作', uid: 'solo-four', ics: ics('solo-four'), title: '未过期',
});
const removed = await attachments.purgeExpiredTrash(USER, CAL, 24 * 60 * 60 * 1000);
eq('A7 只清掉 1 条过期条目', 1, removed);
eq('A7 过期条目目录已删', false, fs.existsSync(oldEntry));
eq('A7 未过期条目仍在', true, fs.existsSync(path.join(TMP, USER, CAL, '.attachments-trash', newItem.id)));

// ---- A8：回滚把附件搬回原位
await seed('solo-five', [{ name: 'rollback.txt', mime: 'text/plain', bytes: TEXT }]);
const rollItem = await trash.add(USER, {
  calendarId: CAL, calendarName: '工作', uid: 'solo-five', ics: ics('solo-five'), title: '回滚',
});
eq('A8 进回收站后原处无目录', false, fs.existsSync(dirOf('solo-five')));
await trash.drop(USER, rollItem.id, { restoreAttachments: true });
eq('A8 回滚后附件回原位', true, fs.existsSync(dirOf('solo-five')));
eq('A8 回滚后附件条目仍是 1 条', 1, (await attachments.listAttachments({ userId: USER, calendarId: CAL, key: 'solo-five' })).items.length);

// ---- A5：清空回收站（最后做，前面的条目都在）
const before = fs.readdirSync(path.join(TMP, USER, CAL, '.attachments-trash')).length;
ok('A5 清空前回收站里还有条目', before >= 1);
await trash.clear(USER);
const left = fs.existsSync(path.join(TMP, USER, CAL, '.attachments-trash'))
  ? fs.readdirSync(path.join(TMP, USER, CAL, '.attachments-trash')).filter((n) => fs.statSync(path.join(TMP, USER, CAL, '.attachments-trash', n)).isDirectory()).length
  : 0;
eq('A5 清空后回收站目录为空', 0, left);
const orphan = await attachments.pruneOrphans();
eq('A5 pruneOrphans 报 0 孤儿', 0, orphan.files + orphan.entries + orphan.dirs);

// ---- A9：删日历，附件随目录走
await runWithContext({ userId: USER }, async () => {
  await store.deleteCalendar(USER, CAL);
});
eq('A9 删日历后日历目录已移进回收站', false, fs.existsSync(path.join(TMP, USER, CAL)));

console.log(`\nSUMMARY: pass=${results.filter((r) => r.pass).length} fail=${failures} total=${results.length}`);
fs.rmSync(TMP, { recursive: true, force: true });
if (failures > 0) process.exitCode = 1;
