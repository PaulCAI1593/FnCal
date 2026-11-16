import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

/**
 * 0.8.18（用户 2026-11-16 01:05：「除了这个小框，鼠标移上去，不要有其他的弹框」）。
 * 日程块与日期格不再设原生 `title`（浏览器灰底提示），只保留「还有 N 个」浮层；
 * 图标按钮的 title 是它唯一的名字，必须保留；删 title 后靠 aria-label 供读屏。
 */
const root = path.resolve(import.meta.dirname, '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');

const VIEW_FILES = [
  'src/js/views/month.js',
  'src/js/views/agenda.js',
  'src/js/views/timegrid.js',
  'src/js/views/year.js',
];

/** 已删除的 14 处原生提示（11 处派单 + 周号 / 日号 / 月格）+ 月格节日块。 */
const REMOVED = [
  'title: compactChip && !event.allDay',
  'title: dayLunarFullText(dayStart),',
  "title: task.title || t('agenda.task.untitled'),",
  "title: event.title || t('agenda.event.untitled'),",
  "title: source.title || t('agenda.event.untitled'),",
  'title: `${year} 第 ${week} 周`,',
  "title: t('month.openDay'),",
  "title: t('year.openMonth', { month: MONTHS_LONG[monthDate.getMonth()] }),",
  'title: item.title,',
  'title: name,',
];

describe('0.8.18 不弹原生提示', () => {
  it('日程块、日期格、节日块不再带 title 属性', () => {
    const hits = [];
    for (const file of VIEW_FILES) {
      const text = read(file);
      for (const needle of REMOVED) {
        if (text.includes(needle)) hits.push(`${file} → ${needle}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it('图标按钮仍保留 title（新建按钮）', () => {
    expect(read('src/js/app.js')).toContain("title: t('calendar.new'),");
  });

  it('日程块 aria-label 非空且含时间', () => {
    const month = read('src/js/views/month.js');
    // 月视图 chip：标题 + 时间（全天走「全天」，定时走 formatTime），数组三段拼接。
    expect(month).toMatch(/'aria-label': \[[\s\S]{0,600}?formatTime\(shownStartDate/);
    const agenda = read('src/js/views/agenda.js');
    // 0.8.25（总监 m03093）：读屏用真实完整区间，可见文本才按日界截到 00:00。
    expect(agenda).toMatch(/'aria-label': \[[\s\S]{0,600}?\$\{ariaTimeText\}/);
    const timegrid = read('src/js/views/timegrid.js');
    expect(timegrid).toMatch(/'aria-label': \[[\s\S]{0,600}?formatTimeRange\(/);
  });

  it('浮层行删掉圆点，全天/多日行走填色行', () => {
    const month = read('src/js/views/month.js');
    expect(month).not.toContain("const cells = [el('span', { class: 'chip__dot' })];");
    expect(month).toContain("const isFilled = !isTask && (ev.allDay || isMultiDayBar(ev));");
    expect(month).toContain("${isFilled ? ' is-filled' : ''}");
  });
});

/**
 * 0.8.20（用户 01:53：「还有 N 个」自己上面还会弹一个同名小标签）。
 * `buildMoreButton` 原来把按钮文字同时写进原生 `title`，悬停就弹同名灰框。
 * 现在源码层面只允许**非 DOM** 的 `title:` 用法；新增任何 DOM title 都会让这条失败。
 */
const NON_DOM_TITLE = /^(?:\d|m\.titleLh\b|hiddenCount\b|chip\.querySelector\('\.chip__title'\))/;

const stripComments = (text) =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('0.8.20 源码不再写 DOM title', () => {
  it('三个视图文件里 title: 只允许非 DOM 用法（量测键 / 空态数据 / 排版计数）', () => {
    const bad = [];
    for (const file of ['src/js/views/month.js', 'src/js/views/agenda.js', 'src/js/views/timegrid.js']) {
      const text = stripComments(read(file));
      const re = /\btitle:\s*/g;
      let m;
      while ((m = re.exec(text))) {
        const rest = text.slice(m.index + m[0].length, m.index + m[0].length + 90);
        if (!NON_DOM_TITLE.test(rest)) bad.push(`${file}: ${rest.split('\n')[0].slice(0, 70)}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it('「还有 N 个」按钮保留 aria-label 与 dataset.fullText，不设 title', () => {
    const month = read('src/js/views/month.js');
    expect(month).toContain("'aria-label': fullText,");
    expect(month).toContain('dataset: { fullText, count: String(hiddenEvents.length) },');
    expect(month).not.toContain('title: fullText,');
  });
});
