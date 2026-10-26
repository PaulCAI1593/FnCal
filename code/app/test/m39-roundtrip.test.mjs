#!/usr/bin/env node
/**
 * M3.9 iCal tests — no server needed.
 *
 * 1. S1–S8 roundtrip: `eventFromIcs` (original .ics) -> model A -> `eventToIcs`
 *    -> export file -> `eventFromIcs` (export) -> model B. Both A and B are
 *    asserted against the same `data/ical-samples/expected.json`, then the
 *    independent comparator `data/ical-samples/compare_roundtrip.mjs` runs on
 *    the export directory (exit 0 == pass=8 fail=0, TZID->UTC counts as FAIL).
 * 2. store.js model mapping: full field set (title/start/end/all-day/location/
 *    description/RRULE/EXDATE/overrides/VALARM/CATEGORIES/ATTENDEES/UID/STATUS)
 *    in both directions, plus VTODO.
 * 3. `uidDomain`: default `@caldav.local`, `globalThis` override, client UID
 *    (one that already has a domain) preserved verbatim.
 *
 * Exports land in `test/.roundtrip-out/` (recreated on every run).
 */

import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { eventFromIcs, eventToIcs, taskFromIcs, taskToIcs, uidFor } from '../lib/ical.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, '..');
const DATA = path.resolve(appRoot, '../../data/ical-samples');
const OUT = path.join(__dirname, '.roundtrip-out');
const DAY_MS = 86_400_000;

const results = [];
let failures = 0;

function record(name, expected, actual, pass, detail = '') {
  results.push({ name, pass });
  if (!pass) failures += 1;
  console.log(`[${pass ? 'PASS' : 'FAIL'}] ${name} | expected=${expected} actual=${actual}${detail ? ` | ${detail}` : ''}`);
}

const iso = (ms) => new Date(ms).toISOString().replace('.000Z', 'Z');
const sortStrings = (list) => [...list].sort();
/** JSON with object keys sorted, so model key order never causes a false FAIL. */
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/* ------------------------------------------------------------ expected check */

/** Assert a parsed model against expected.json for one sample. Returns failures. */
function checkModel(model, sample) {
  const problems = [];
  const check = (label, actual, wanted) => {
    if (stable(actual) !== stable(wanted)) {
      problems.push(`${label}: 期望 ${JSON.stringify(wanted)} 实际 ${JSON.stringify(actual)}`);
    }
  };
  const events = Array.isArray(sample.events) ? sample.events : null;
  const master = events ? events.find((e) => e.role !== 'override') : sample;
  const sampleRule = events ? (master.rrule || null) : sample.rrule;
  const allDay = Boolean(sample.all_day || (sample.dtstart && sample.dtstart.value_type === 'DATE'));
  check('uid', model.uid, sample.uid);
  check('title', model.title, master.summary ?? sample.summary);
  check('allDay', Boolean(model.allDay), allDay);
  if (!allDay) {
    check('start', iso(model.start), master.dtstart.utc);
    check('end', iso(model.end), master.dtend.utc);
    const wantedTz = (master.dtstart.params && master.dtstart.params.TZID) || 'UTC';
    check('timezone', model.timezone, wantedTz);
  }
  if (sample.description !== undefined) check('description', model.description, sample.description);
  if (sample.location !== undefined) check('location', model.location, sample.location);
  if (sampleRule) {
    const rule = model.recurrence || {};
    check('rrule.freq', String(rule.freq || '').toUpperCase(), sampleRule.freq);
    check('rrule.interval', rule.interval ?? 1, sampleRule.interval ?? 1);
    check('rrule.count', rule.count ?? null, sampleRule.count ?? null);
  } else {
    check('rrule', Boolean(model.recurrence), false);
  }
  if (Array.isArray(sample.exdate)) {
    check('exdates', sortStrings((model.exdates || []).map(iso)), sortStrings(sample.exdate.map((x) => x.utc)));
  }
  if (Array.isArray(sample.valarms)) {
    check('valarm.count', (model.alarms || []).length, sample.valarms.length);
    check(
      'valarm.trigger_seconds',
      sortStrings((model.alarms || []).map((a) => String((a.minutes ?? 0) * -60))),
      sortStrings(sample.valarms.map((a) => String(a.trigger_seconds))),
    );
    for (const wanted of sample.valarms) {
      const hit = (model.alarms || []).find((a) => (a.minutes ?? 0) * -60 === wanted.trigger_seconds);
      check(`valarm[${wanted.trigger}].description`, hit ? hit.description : null, wanted.description);
    }
  }
  if (events) {
    const overrides = model.overrides || {};
    const keys = Object.keys(overrides);
    check('override.count', keys.length, 1);
    const wantedOverride = events.find((e) => e.role === 'override');
    const key = keys.find((k) => iso(Number(k)) === wantedOverride.recurrence_id.utc);
    if (!key) problems.push('override: 找不到 RECURRENCE-ID 对应的覆盖实例');
    else {
      check('override.start', iso(overrides[key].start), wantedOverride.dtstart.utc);
      check('override.title', overrides[key].title, wantedOverride.summary);
    }
  }
  return problems;
}

/* ---------------------------------------------------------------- fixtures */

function storeEvent() {
  const start = Date.UTC(2026, 10, 2, 1, 0, 0);
  return {
    id: 'e3b0c442-98fc-4c14-9afb-f4c8996fb924',
    title: '周会 · 产品评审',
    description: '第一行\n第二行：多行描述，含逗号与分号；还有反斜杠 \\',
    location: '3 号会议室',
    start,
    end: start + 3600_000,
    allDay: false,
    color: '#3272d9',
    reminders: [15, 60],
    categories: ['工作', '产品'],
    organizer: { email: 'host@example.com', name: '主持人' },
    guests: [
      { email: 'alice@example.com', name: '张三', status: 'accepted' },
      { email: 'bob@example.com', status: 'declined' },
    ],
    status: 'CONFIRMED',
    recurrence: { freq: 'weekly', interval: 1, byWeekday: [1, 3], count: 5 },
    exdates: [Date.UTC(2026, 10, 9, 1, 0, 0)],
    overrides: {
      [Date.UTC(2026, 10, 11, 1, 0, 0)]: {
        start: Date.UTC(2026, 10, 11, 7, 0, 0),
        end: Date.UTC(2026, 10, 11, 8, 0, 0),
        title: '周会（改到 15:00）',
      },
    },
    createdAt: Date.UTC(2026, 9, 1),
    updatedAt: Date.UTC(2026, 9, 2),
  };
}

function allDayStoreEvent() {
  const start = new Date(2026, 11, 25, 0, 0, 0, 0).getTime();
  const end = new Date(2026, 11, 25, 23, 59, 59, 999).getTime();
  return { id: 'allday-1', title: '圣诞节假期', start, end, allDay: true, reminders: [], color: '#3272d9' };
}

function storeTask() {
  return {
    id: 'task-1',
    title: '提交周报',
    notes: '含本周数据\n和风险',
    due: Date.UTC(2026, 11, 31, 9, 0, 0),
    allDay: false,
    done: false,
    color: '#3272d9',
    categories: ['工作'],
    reminders: [30],
    createdAt: Date.UTC(2026, 11, 1),
    updatedAt: Date.UTC(2026, 11, 2),
  };
}

/* -------------------------------------------------------------------- main */

async function main() {
  await fs.rm(OUT, { recursive: true, force: true });
  await fs.mkdir(OUT, { recursive: true });

  const expected = JSON.parse(await fs.readFile(path.join(DATA, 'expected.json'), 'utf8'));
  for (const sample of expected.samples) {
    const original = await fs.readFile(path.join(DATA, sample.file), 'utf8');
    const modelA = await eventFromIcs(original);
    const exportText = eventToIcs(modelA);
    await fs.writeFile(path.join(OUT, `export-${sample.id}.ics`), exportText, 'utf8');
    const modelB = await eventFromIcs(exportText);

    const problemsA = checkModel(modelA, sample);
    record(`${sample.id} 原文件 -> 模型 A`, 'expected.json 全字段', problemsA.length ? `${problemsA.length} 处不符` : 'ok',
      problemsA.length === 0, problemsA.join('; '));

    const problemsB = checkModel(modelB, sample);
    record(`${sample.id} 导出文件 -> 模型 B（往返）`, 'expected.json 全字段', problemsB.length ? `${problemsB.length} 处不符` : 'ok',
      problemsB.length === 0, problemsB.join('; '));
  }

  /* store.js model -> ICS -> model */
  {
    const ics = eventToIcs(storeEvent());
    const back = await eventFromIcs(ics);
    const checks = [
      ['uid', back.uid, 'e3b0c442-98fc-4c14-9afb-f4c8996fb924@caldav.local'],
      ['title', back.title, '周会 · 产品评审'],
      ['description', back.description, '第一行\n第二行：多行描述，含逗号与分号；还有反斜杠 \\'],
      ['location', back.location, '3 号会议室'],
      ['start', iso(back.start), iso(storeEvent().start)],
      ['end', iso(back.end), iso(storeEvent().end)],
      ['allDay', back.allDay, false],
      ['status', back.status, 'CONFIRMED'],
      ['categories', back.categories, ['工作', '产品']],
      ['organizer', back.organizer, { email: 'host@example.com', name: '主持人' }],
      ['guests', back.guests, [
        { email: 'alice@example.com', name: '张三', status: 'accepted' },
        { email: 'bob@example.com', status: 'declined' },
      ]],
      ['reminders', back.reminders, [15, 60]],
      ['rrule.freq', back.recurrence.freq, 'weekly'],
      ['rrule.byWeekday', back.recurrence.byWeekday, [1, 3]],
      ['rrule.count', back.recurrence.count, 5],
      ['exdates', back.exdates, storeEvent().exdates],
      ['override.count', Object.keys(back.overrides || {}).length, 1],
    ];
    const problems = checks
      .filter(([, actual, wanted]) => stable(actual) !== stable(wanted))
      .map(([label, actual, wanted]) => `${label}: 期望 ${JSON.stringify(wanted)} 实际 ${JSON.stringify(actual)}`);
    const override = back.overrides && back.overrides[Date.UTC(2026, 10, 11, 1, 0, 0)];
    if (!override || override.title !== '周会（改到 15:00）' || iso(override.start) !== iso(Date.UTC(2026, 10, 11, 7, 0, 0))) {
      problems.push('override: 覆盖实例字段未往返');
    }
    const hasRules = /RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=5/.test(ics)
      && /BEGIN:VALARM[\s\S]*TRIGGER:-PT15M/.test(ics)
      && /ATTENDEE;CN=张三;PARTSTAT=ACCEPTED/.test(ics)
      && /CATEGORIES:工作,产品/.test(ics);
    if (!hasRules) problems.push('ICS 结构: RRULE/VALARM/CATEGORIES/ATTENDEE 缺失');
    record('store.js 事件模型 -> ICS -> 模型（全字段）', '17 字段 + RRULE/VALARM/ATTENDEE/CATEGORIES',
      problems.length ? `${problems.length} 处不符` : 'ok', problems.length === 0, problems.join('; '));
  }

  /* all-day store.js model (inclusive end -> exclusive DTEND) */
  {
    const ics = eventToIcs(allDayStoreEvent());
    const back = await eventFromIcs(ics);
    const ok = /DTSTART;VALUE=DATE:20261225/.test(ics)
      && /DTEND;VALUE=DATE:20261226/.test(ics)
      && back.allDay === true
      && back.startDate === '20261225'
      && back.endDate === '20261226';
    record('全天 store.js 模型 -> VALUE=DATE + 独占 DTEND', 'DATE 20261225/20261226 + 往返',
      `startDate=${back.startDate} endDate=${back.endDate}`, ok);
  }

  /* VTODO mapping */
  {
    const ics = taskToIcs(storeTask());
    const back = taskFromIcs(ics);
    const checks = [
      ['uid', back.uid, 'task-1@caldav.local'],
      ['title', back.title, '提交周报'],
      ['notes', back.notes, '含本周数据\n和风险'],
      ['done', back.done, false],
      ['due', iso(back.due), iso(storeTask().due)],
      ['allDay', back.allDay, false],
      ['categories', back.categories, ['工作']],
      ['reminders', back.reminders, [30]],
    ];
    const problems = checks
      .filter(([, actual, wanted]) => stable(actual) !== stable(wanted))
      .map(([label, actual, wanted]) => `${label}: 期望 ${JSON.stringify(wanted)} 实际 ${JSON.stringify(actual)}`);
    if (!/BEGIN:VTODO[\s\S]*DUE:20261231T090000Z/.test(ics)) problems.push('VTODO 缺少 DUE');
    record('store.js 任务模型 -> VTODO -> 模型', '8 字段 + DUE', problems.length ? `${problems.length} 处不符` : 'ok',
      problems.length === 0, problems.join('; '));
  }

  /* uidDomain */
  {
    const previous = globalThis.__FNCAL_UID_DOMAIN__;
    delete globalThis.__FNCAL_UID_DOMAIN__;
    const start = Date.UTC(2026, 10, 2, 1);
    const defaultIcs = eventToIcs({ id: 'uid-default', title: 'x', start, end: start + 3600_000 });
    const defaultOk = /^UID:uid-default@caldav\.local$/m.test(defaultIcs);
    globalThis.__FNCAL_UID_DOMAIN__ = 'fncal.example';
    const customIcs = eventToIcs({ id: 'uid-custom', title: 'x', start, end: start + 3600_000 });
    const customOk = /^UID:uid-custom@fncal\.example$/m.test(customIcs);
    globalThis.__FNCAL_UID_DOMAIN__ = 'fncal.example';
    const generated = uidFor({});
    const generatedOk = /@fncal\.example$/.test(generated);
    delete globalThis.__FNCAL_UID_DOMAIN__;
    const kept = uidFor({ uid: 'client-uid@corp.example' });
    record('uidDomain: 默认 @caldav.local', 'uid-default@caldav.local', defaultOk ? 'ok' : defaultIcs.split('\r\n')[6],
      defaultOk);
    record('uidDomain: globalThis 覆盖生效', 'uid-custom@fncal.example', customOk ? 'ok' : 'missing', customOk);
    record('uidDomain: 无 id 时生成', '@fncal.example', generated, generatedOk);
    record('uidDomain: 客户端 UID（含 @）原样保留', 'client-uid@corp.example', kept,
      kept === 'client-uid@corp.example');
    if (previous === undefined) delete globalThis.__FNCAL_UID_DOMAIN__;
    else globalThis.__FNCAL_UID_DOMAIN__ = previous;
  }

  /* Independent comparator over the export directory */
  console.log('\n--- compare_roundtrip.mjs（独立比对器，退出码 0 = pass=8 fail=0）---');
  const compared = spawnSync(process.execPath, [path.join(DATA, 'compare_roundtrip.mjs'), OUT], { stdio: 'inherit' });
  record('compare_roundtrip.mjs: 8 个样本', 'exit=0（pass=8 fail=0）', `exit=${compared.status}`, compared.status === 0);

  console.log(`\nM3.9 RESULTS: ${results.length - failures}/${results.length} passed`);
  if (failures) {
    console.log(`FAILURES: ${failures}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(`[FATAL] ${err.stack || err.message}`);
  process.exit(2);
});

