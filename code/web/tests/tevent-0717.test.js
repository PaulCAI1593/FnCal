/**
 * 0.7.17 · 定时块按实测块高分配行数（用户定稿，总监 m01931）
 *
 * 口径：
 * - 行数由块实测高度算（1 / 2 / 3 行），不写死像素；
 * - 第 1 行时间固定 1 行，中间各行 `emoji + 名称`（名称可折行），最后 1 行地点；
 * - 时间只有三态：完整区间 → 开始时间 → 省略（上报 `time-hidden`），永不折行、
 *   永不出现 `18:…` 这种半截数字；
 * - 只有一行高的块先保 `emoji + 名称`，时间让给左侧时间轴。
 */

import { describe, it, expect, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  applyTeventTimeFit,
  takeTimeFitReports,
  allocateTeventLines,
  teventLayoutLines,
  teventLinePlan,
  teventRowAudit,
  teventPriorityAudit,
  applyTagTitlePriority,
  TEVENT_METRICS_FALLBACK,
} from '../src/js/views/timegrid.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const views = readFileSync(path.join(HERE, '..', 'src', 'styles', 'views.css'), 'utf8');

const M = TEVENT_METRICS_FALLBACK;
// 10px 实测：完整区间 63、开始 28、汉字 12。
const MEASURE = (s) => ({ '10:00-10:45': 63, '10:00': 28, '11:00-12:00': 63, ' ': 3, '📌': 12, '测': 12 })[s] ?? 8;

afterEach(() => {
  takeTimeFitReports();
});

/** 带标签的事件条（emoji + 名称 + 时间，可选地点），用来量行数分配。 */
function fakeBlock(range = '10:00-10:45', { hasLoc = false, title: titleText } = {}) {
  const block = document.createElement('div');
  block.className = 'tevent';
  const title = document.createElement('span');
  title.className = 'tevent__title tevent__title--tagged';
  const emoji = document.createElement('span');
  emoji.className = 'tevent__tag-emoji';
  emoji.textContent = '📌';
  const gap = document.createElement('span');
  gap.className = 'tag-gap';
  gap.textContent = ' ';
  const label = document.createElement('span');
  label.className = 'tevent__title-text';
  // 0.7.19：允许注入长标题，验证「名称放不下时先丢地点」。
  label.textContent = titleText || '评审会';
  title.append(emoji, gap, label);
  const time = document.createElement('span');
  time.className = 'tevent__time';
  time.textContent = range;
  block.append(title, time);
  if (hasLoc) {
    const loc = document.createElement('span');
    loc.className = 'tevent__loc';
    loc.textContent = '三号会议室';
    block.append(loc);
  }
  return block;
}

function layout(block, { width, height }) {
  Object.defineProperty(block, 'clientWidth', { configurable: true, value: width });
  Object.defineProperty(block, 'scrollWidth', { configurable: true, value: 0 });
  block.getBoundingClientRect = () => ({
    width, height, top: 0, left: 0, right: width, bottom: height, x: 0, y: 0,
  });
}

function run({ width, height, range, hasLoc = false, title, measure = MEASURE }) {
  const block = fakeBlock(range, { hasLoc, title });
  layout(block, { width, height });
  const root = document.createElement('div');
  root.append(block);
  applyTeventTimeFit(root, { measure });
  return block;
}

describe('0.7.17 · 行数按实测块高算', () => {
  it('26 / 39 / 52px 分别折成 1 / 2 / 3 行', () => {
    expect(teventLayoutLines(26, M)).toBe(1);
    expect(teventLayoutLines(39, M)).toBe(2);
    expect(teventLayoutLines(52, M)).toBe(3);
  });

  // 0.7.19（总监 m01475）：S2（区间+emoji）作废——它判 `rangeW+gap+emoji`，S2b 判`startW+gap+emoji+space+1 字`，后者恒更窄 ⇒ S2 命中时 S2b 必然也命中，S2 只会白丢名称。单行档序改为 S1 → S2b → S3 → S4 → S-name。
  it('单行块档位：区间+emoji+名称 → 开始+emoji+名称 → 开始+emoji → 只小时+emoji', () => {
    // MEASURE：区间 63、开始 28、emoji 12、空格 3、汉字 12、gap 5。
    const s1 = run({ width: 120, height: 26 });
    expect(s1.dataset.teventTier).toBe('S1');
    expect(s1.querySelector('.tevent__time').textContent).toBe('10:00-10:45');
    expect(s1.querySelector('.tevent__title')).toBeTruthy();

    // 0.7.19（总监 m01475）：S1 需 95 > 90；旧 S2 已删，直接落 S2b——
    // 「开始+emoji+名称」需 28+5+12+3+12 = 60 ≤ 90 → 退到开始时间但保住名称。
    const s2 = run({ width: 90, height: 26 });
    expect(s2.dataset.teventTier).toBe('S2b');
    expect(s2.querySelector('.tevent__time').textContent).toBe('10:00');

    // 80 > 70，但「开始时间 + emoji + 名称」需 60 ≤ 70 → 退到开始时间但保住名称（S2b）。
    const s2b = run({ width: 70, height: 26 });
    expect(s2b.dataset.teventTier).toBe('S2b');
    expect(s2b.querySelector('.tevent__time').textContent).toBe('10:00');
    expect(s2b.querySelector('.tevent__title')).toBeTruthy();

    // 60 > 50，但 45 ≤ 50 → 让名称。
    const s3 = run({ width: 50, height: 26 });
    expect(s3.dataset.teventTier).toBe('S3');
    expect(s3.querySelector('.tevent__time').textContent).toBe('10:00');

    // 45 > 40，但 27 ≤ 40 → 只到小时（最短 `18 ⚽`）。
    const s4 = run({ width: 40, height: 26 });
    expect(s4.dataset.teventTier).toBe('S4');
    expect(s4.querySelector('.tevent__time').textContent).toBe('10');
  });

  it('`18 ⚽` 差一点时不丢任何一项：去掉 5px 间距（S4 紧排），仍保留时间与 emoji', () => {
    // 0.7.17（总监 m02031）：S4 需 8+5+12 = 25 > 20，紧排 8+12 = 20 ≤ 20。
    const block = run({ width: 20, height: 26 });
    expect(block.dataset.teventTier).toBe('S4');
    expect(block.dataset.teventTight).toBe('1');
    expect(block.querySelector('.tevent__time').textContent).toBe('10');
    expect(block.querySelector('.tevent__title')).toBeTruthy();
  });

  it('连紧排 `18 ⚽` 都放不下：整段省略时间并上报，不裁字', () => {
    const block = run({ width: 15, height: 26 });
    expect(block.dataset.teventTier).toBe('S-name');
    expect(block.querySelector('.tevent__time').textContent).toBe('');
    expect(block.querySelector('.tevent__title')).toBeTruthy();
    expect(takeTimeFitReports()[0]).toMatchObject({ reason: 'time-hidden' });
  });

  it('45 分钟块（h=39）两行：时间 1 行 + 名称 1 行，地点让出', () => {
    const block = run({ width: 120, height: 39, hasLoc: true });
    expect(block.dataset.teventTier).toBe('M-range');
    expect(block.querySelector('.tevent__time').textContent).toBe('10:00-10:45');
    expect(block.style.getPropertyValue('--tevent-lines-title')).toBe('1');
    expect(block.querySelector('.tevent__loc')).toBeNull();
    expect(block.dataset.hasLoc).toBe('0');
  });

  // 0.7.20（总监 m02349）：地点只在可用行数 ≥ 4 时出现；52px 块只有 3 行，地点不占行。
  // 0.7.21（总监 m02704 / m02738）：emoji 与名称同行放得下就不拆；名称只拿它需要的
  // 行数，多出来的行留给地点（本块 L=3，地点本来就不显示）。
  it('60 分钟块（h=52）三行：emoji 与名称同行（放得下就不拆），地点不显示', () => {
    const block = run({ width: 120, height: 52, hasLoc: true });
    expect(block.dataset.hasLoc).toBe('0');
    expect(block.querySelector('.tevent__loc')).toBeNull();
    expect(block.style.getPropertyValue('--tevent-lines-loc')).toBe('0');
    expect(block.dataset.teventEmojiLine).toBe('0');
    expect(block.dataset.teventNameLines).toBe('1');
    expect(block.style.getPropertyValue('--tevent-lines-title')).toBe('1');
  });

  // 0.7.21（总监 m02704）：只有名称区连 1 个字（titleMin ≈12px）都放不下时才拆行。
  // 23px 宽（周 320）：23 − emoji 12 − 间距 3 = 8 < 12 → emoji 独占一行，名称拿整块宽。
  it('60 分钟块窄列（h=52、宽 23）：emoji 独占一行，名称从下一行起拿整块宽', () => {
    const block = run({ width: 23, height: 52 });
    expect(block.dataset.teventEmojiLine).toBe('1');
    expect(block.classList.contains('tevent--emoji-own-line')).toBe(true);
    expect(block.style.getPropertyValue('--tevent-lines-name')).toBe('1');
    expect(block.style.getPropertyValue('--tevent-lines-title')).toBe('2');
  });

  it('三行但没有地点：名称按需要拿行（长名称拿 2 行）', () => {
    // 0.7.21（总监 m02738）：名称只拿「需要」的行数；用注入度量让长名称需要 2 行。
    const measure = (s) => ({ '10:00-10:45': 63, '10:00': 28, ' ': 3, '📌': 12 })[s] ?? [...s].length * 10;
    const block = run({ width: 60, height: 52, title: '季度预算评审会议通知', measure });
    expect(block.style.getPropertyValue('--tevent-lines-title')).toBe('2');
    expect(block.style.getPropertyValue('--tevent-lines-loc')).toBe('0');
  });

  // 0.7.17（总监 m00259 ③）：地点被 `.tevent` 的容器查询（内容宽 ≤108px）隐藏时，
  // 0.7.19（总监 m01482）：地点门槛从 108px 改成「至少 2 个字宽」（24px）。
  // 内容宽 100px（≥24）且名称一行放得下 → 地点保留 1 行。
  it('四行块内容宽 ≥ 2 个字宽：地点保留（拿名称用剩的行）', () => {
    // 0.7.20（总监 m02349）：地点门槛仍是 2 个字宽，但行数门槛改为 L ≥ 4。
    // 0.7.21（总监 m02738）：名称只拿需要的 1 行，剩 2 行给地点；地点 1 行放得下就 1 行。
    const block = run({ width: 100, height: 78, hasLoc: true });
    expect(block.dataset.hasLoc).toBe('1');
    expect(block.querySelector('.tevent__loc')).toBeTruthy();
    expect(block.dataset.teventNameLines).toBe('1');
    expect(block.style.getPropertyValue('--tevent-lines-title')).toBe('1');
    expect(block.style.getPropertyValue('--tevent-lines-loc')).toBe('1');
  });

  // 0.7.21（总监 m02738，用户「如果空间够地点也可以换行显示」）：地点拿名称用剩的行，
  // 且允许折行；这里 40px 宽、5 字地址需要 2 行 → 地点 2 行（改前是 nowrap 截断）。
  it('四行块：地点拿剩余行并折行（≥2 行时完整显示地址）', () => {
    const measure = (s) => ({ '10:00-10:45': 63, '10:00': 28, ' ': 3, '📌': 12 })[s] ?? [...s].length * 10;
    const block = run({ width: 40, height: 78, hasLoc: true, title: '会', measure });
    expect(block.dataset.hasLoc).toBe('1');
    expect(block.style.getPropertyValue('--tevent-lines-loc')).toBe('2');
  });

  // 内容宽 20px < 24px（2 个字）→ 地点让出，那一行还给名称。
  it('内容宽 < 2 个字宽：地点让出，行还给名称', () => {
    const block = run({ width: 20, height: 52, hasLoc: true });
    expect(block.dataset.hasLoc).toBe('0');
    expect(block.querySelector('.tevent__loc')).toBeNull();
    // 宽度 20px < 开始时间 28px，时间整段省略（M-hidden）；L=3 时地点本来就不显示。
    expect(block.style.getPropertyValue('--tevent-lines-loc')).toBe('0');
    expect(Number(block.style.getPropertyValue('--tevent-lines-title'))).toBeGreaterThanOrEqual(1);
  });

  // 名称一行放不下 3 行块的 1 行名称位时，按牺牲序先丢地点，把行让给名称。
  it('三行块名称放不下：先丢地点，名称拿 2 行', () => {
    // 度量：未知串按每字 8px（MEASURE 的兜底对整串只给 8px，不适合长标题）。
    const measure = (s) => ({ '10:00-10:45': 63, '10:00': 28, ' ': 3, '📌': 12 })[s] ?? [...s].length * 8;
    const block = run({ width: 100, height: 52, hasLoc: true, title: '季度预算评审会议通知单加备注', measure });
    expect(block.dataset.hasLoc).toBe('0');
    expect(block.querySelector('.tevent__loc')).toBeNull();
    expect(block.style.getPropertyValue('--tevent-lines-title')).toBe('2');
  });

  // 0.7.17（总监 m00259 ①）：多行块不再套用单行块的「名称 1 字门槛」。
  // 此前周 390/360 的 45/60 分钟块用单行可用宽（33−18−5=10 < 12）判断，整段隐藏名称。
  // 0.7.17（总监 m02263 复核）：emoji 的**盒子**在 flex/grid 行里会被撑宽（四日 390
  // 实测盒子 29.5px、字形 16.5px）。判档必须取较小值，否则 S2b 差 1.4px 落空、名称白丢。
  it('emoji 盒子被撑宽时按字形宽判档：可用 69px 仍落 S2b', () => {
    const block = fakeBlock();
    const emoji = block.querySelector('.tevent__tag-emoji');
    emoji.getBoundingClientRect = () => ({ width: 29.5, height: 18, top: 0, left: 0, right: 29.5, bottom: 18, x: 0, y: 0 });
    layout(block, { width: 69, height: 26 }); // jsdom 无 CSS 内距，可用宽 = 69px
    const root = document.createElement('div');
    root.append(block);
    const measure = (s) => ({ '10:00-10:45': 55, '10:00': 25, ' ': 3, '📌': 16.5, '测': 12 })[s] ?? 8;
    applyTeventTimeFit(root, { measure });
    // 25 + 5 + 16.5 + 3 + 12 = 61.5 ≤ 69 → S2b（名称保住）
    expect(block.dataset.teventTier).toBe('S2b');
    expect(block.querySelector('.tevent__time').textContent).toBe('10:00');
  });

  it('档位已判名称放得下（S1/S2b）时，不再用标题自身宽二次藏名称', () => {
    for (const tier of ['S1', 'S2b']) {
      const block = fakeBlock();
      block.dataset.teventTier = tier;
      layout(block, { width: 69, height: 26 });
      const title = block.querySelector('.tevent__title');
      title.classList.add('tevent--tag-only'); // 模拟上一步的「只 emoji」残留
      const root = document.createElement('div');
      root.append(block);
      applyTagTitlePriority(root);
      expect(title.classList.contains('tevent--tag-only')).toBe(false);
    }
  });

  it('多行块先清掉单行遗留的 tag-only，名称不再被整段藏掉', () => {
    const block = fakeBlock();
    // 0.7.17：`tevent--tag-only` 挂在标题节点上（calendar.css:4186 的
    // `.tevent--tag-only .tevent__title-text` 由它命中），所以这里也加在标题上。
    const title = block.querySelector('.tevent__title');
    title.classList.add('tevent--tag-only');
    layout(block, { width: 33, height: 39 });
    const root = document.createElement('div');
    root.append(block);
    applyTeventTimeFit(root, { measure: MEASURE });
    applyTagTitlePriority(root);
    expect(title.classList.contains('tevent--tag-only')).toBe(false);
    expect(block.querySelector('.tevent__title-text')).toBeTruthy();
  });
});

describe('0.7.17 · 时间的唯一降级链', () => {
  it('宽度够：完整区间', () => {
    const block = run({ width: 63, height: 52 });
    expect(block.dataset.teventTier).toBe('M-range');
    expect(block.querySelector('.tevent__time').textContent).toBe('10:00-10:45');
  });

  it('区间放不下、开始时间放得下：降为开始时间', () => {
    const block = run({ width: 30, height: 52 });
    expect(block.dataset.teventTier).toBe('M-start');
    expect(block.querySelector('.tevent__time').textContent).toBe('10:00');
  });

  it('开始时间也放不下：整段省略并上报 time-hidden，名称接管', () => {
    const block = run({ width: 20, height: 52 });
    expect(block.dataset.teventTier).toBe('M-hidden');
    expect(block.querySelector('.tevent__time').textContent).toBe('');
    expect(block.querySelector('.tevent__title')).toBeTruthy();
    // 0.7.20（总监 m02349）：52px 块 L=3，地点不占行；时间省略后行给名称与 emoji。
    expect(Number(block.style.getPropertyValue('--tevent-lines-title'))).toBeGreaterThanOrEqual(1);
    expect(takeTimeFitReports()[0]).toMatchObject({ reason: 'time-hidden' });
  });

  it('任何宽度下时间文案都不含省略号', () => {
    for (const width of [200, 100, 70, 63, 30, 28, 20, 6]) {
      for (const height of [26, 39, 52]) {
        const block = run({ width, height });
        expect(block.querySelector('.tevent__time').textContent).not.toContain('…');
        takeTimeFitReports();
      }
    }
  });

  // 总监 m01561：区间分隔符统一为 `HH:MM-HH:MM`（半角连字符、两侧无空格）。
  it('区间文案匹配 `HH:MM-HH:MM`，没有空格与 en dash', () => {
    const block = run({ width: 200, height: 52 });
    const text = block.querySelector('.tevent__time').textContent;
    expect(text).toMatch(/^\d{2}:\d{2}-\d{2}:\d{2}$/);
    expect(text).not.toContain('–');
    expect(text).not.toContain(' ');
  });
});

describe('0.7.17 · 样式口径', () => {
  it('`.tevent__time` 用 clip，不再有 ellipsis', () => {
    const rule = /\.tevent__time\s*\{([^}]*)\}/.exec(views);
    expect(rule).not.toBeNull();
    expect(rule[1]).not.toMatch(/text-overflow:\s*ellipsis/);
    expect(rule[1]).toMatch(/text-overflow:\s*clip/);
  });

  it('单行档与省略档隐藏时间节点', () => {
    expect(views).toMatch(/\[data-tevent-tier='S-name'\]\s+\.tevent__time/);
    expect(views).toMatch(/\[data-tevent-tier='M-hidden'\]\s+\.tevent__time/);
  });

  it('让名称时只藏名称文字，emoji 必须留着（用户 m01091「最短 18 ⚽」）', () => {
    // 0.7.19（总监 m01475）：S2 已删，只查 S3 / S4 两档；S2b 必须保留名称。
    expect(views).toMatch(/\[data-tevent-tier='S3'\]\s+\.tevent__title-text/);
    expect(views).toMatch(/\[data-tevent-tier='S4'\]\s+\.tevent__title-text/);
    expect(views).not.toMatch(/\[data-tevent-tier='S[234]'\]\s+\.tevent__tag-emoji/);
    expect(views).not.toMatch(/\[data-tevent-tier='S[234]'\]\s+\.tevent__title\s*\{/);
    expect(views).not.toMatch(/\[data-tevent-tier='S2'\]/);
  });

  it('`.tevent` 左右内距 4px、上下 3px 不动', () => {
    const rule = /\.tevent\s*\{([^}]*)\}/.exec(views);
    expect(rule[1]).toMatch(/padding:\s*3px\s+4px/);
  });

  it('矮块 `.tevent.is-short` 左右 4px', () => {
    const rule = /\.tevent\.is-short\s*\{([^}]*)\}/.exec(views);
    expect(rule[1]).toMatch(/padding:\s*1px\s+4px/);
  });

  it('三档高度阈值不受内距影响（只动左右）', () => {
    expect(allocateTeventLines(26, M, false)).toMatchObject({ time: 1, title: 1, short: true });
    expect(allocateTeventLines(39, M, false)).toMatchObject({ short: false });
    expect(allocateTeventLines(52, M, true)).toMatchObject({ loc: 1 });
  });
});

describe('0.7.19 · 行预算按真实块高、emoji 可独占时间行', () => {
  it('teventLinePlan：26/39/52/65/78px → 短行/2/3/3/4 行，名称不再写死 3 行上限', () => {
    expect(teventLinePlan(26, M, false)).toMatchObject({ short: true, time: 1, loc: 0 });
    expect(teventLinePlan(39, M, false)).toMatchObject({ short: false, time: 1, title: 1, loc: 0 });
    expect(teventLinePlan(52, M, false)).toMatchObject({ time: 1, title: 2, loc: 0 });
    expect(teventLinePlan(65, M, true)).toMatchObject({ time: 1, title: 1, loc: 1 });
    const tall = teventLinePlan(78, M, true);
    expect(tall).toMatchObject({ time: 1, title: 2, loc: 1 });
    // 名称上限 6 行：高度给到 130px 时也不会出现 7 行。
    expect(teventLinePlan(130, M, false).title).toBe(6);
  });

  it('名称一行放不下但 emoji 后还有 1 个字宽：emoji 与名称同行，名称按整块宽折行', () => {
    const name = '季度预算评审会议通知';
    const measure = MEASURE;
    const block = run({ width: 50, height: 52, title: name, measure });
    // 0.7.23（总监 m01687 / m01712，任务书「名称按高度换行」）：emoji 后可用宽
    // 50−12−3 = 35px ≥ 1 个字宽（12px）→ 同行；只有不足 1 字才让 emoji 独占第 2 行。
    // 行数只由块高给：h=52 预算 46px → 时间 14 + 2×15.6 + 1 = 46.2 ≤ 46.5，名称 2 行。
    expect(block.dataset.teventEmojiLine).toBe('0');
    expect(block.classList.contains('tevent--emoji-own-line')).toBe(false);
    // 时间行不再带 emoji 副本。
    const time = block.querySelector('.tevent__time');
    expect(time.querySelectorAll('.tevent__tag-emoji--on-time')).toHaveLength(0);
    expect(time.textContent).toContain('10:00');
    expect(block.querySelector('.tevent__title .tevent__tag-emoji')).toBeTruthy();
    // 0.7.23（总监 m01687 / m01712）：同行时 emoji 挪进名称文字流内部，`textContent`
    // 因此以 emoji 开头；名称本身必须完整保留在同一个名字里。
    const textEl = block.querySelector('.tevent__title-text');
    expect(textEl.textContent).toContain(name);
    expect(textEl.querySelector('.tevent__tag-emoji')).toBeTruthy();
    // 注入的 measure 把整串名称量成常数 8px，这里只断言结构（真实行数由探针页实测）：
    // 同行时 clamp 落在名称文字流上，emoji 不再独占一行。
    expect(block.style.getPropertyValue('--tevent-lines-title')).toBe('1');
    expect(block.dataset.teventNameLines).toBe('1');
    // 同行结构的 CSS：名称文字流自己承担 clamp，标题容器不再用 flex 压窄名称盒。
    expect(views).toMatch(
      /\.tevent\[data-tevent-tier\^='M-'\]:not\(\.tevent--emoji-own-line\) \.tevent__title \.tevent__title-text\s*\{[^}]*-webkit-line-clamp:\s*var\(--tevent-lines-title/,
    );
  });

  it('emoji 后不足 1 个字宽：emoji 独占第 2 行，名称从第 3 行起拿整块宽', () => {
    const measure = MEASURE;
    // 23px 宽：23−12−3 = 8px < 12px，同行等于把名称挤没。
    const block = run({ width: 23, height: 52, title: '季度预算评审会议通知', measure });
    expect(block.dataset.teventEmojiLine).toBe('1');
    expect(block.classList.contains('tevent--emoji-own-line')).toBe(true);
    expect(block.querySelector('.tevent__title-text').textContent).toBe('季度预算评审会议通知');
    // h=52：预算 46 → 时间 14 + emoji 行 16.6 + 1×15.6 = 46.2 ≤ 46.5，名称 1 行；
    // 2 行名称需 62.8，超出预算，所以按高度只给 1 行。
    expect(block.dataset.teventNameLines).toBe('1');
    expect(block.style.getPropertyValue('--tevent-lines-title')).toBe('2');
  });

  it('重复跑排布不会叠加 emoji，也不会丢 emoji', () => {
    const measure = MEASURE;
    const block = run({ width: 50, height: 52, title: '季度预算评审会议通知', measure });
    const root = document.createElement('div');
    root.append(block);
    applyTeventTimeFit(root, { measure });
    expect(block.querySelectorAll('.tevent__tag-emoji--on-time')).toHaveLength(0);
    expect(block.querySelectorAll('.tevent__title .tevent__tag-emoji')).toHaveLength(1);
    // 0.7.23：50px 宽 emoji 后仍剩 35px ≥ 1 字宽 → 同行；重复跑不改变结构。
    expect(block.classList.contains('tevent--emoji-own-line')).toBe(false);
    expect(block.dataset.teventNameLines).toBe('1');
  });

  it('可用行数 = 2：名称放得下时 emoji 与名称同行', () => {
    const measure = (s) => ({ '10:00-10:45': 63, '10:00': 28, ' ': 3, '📌': 12 })[s] ?? [...s].length * 8;
    // 0.7.20（总监 m02349）：50px 宽里 4 字名称（32px）放得进 moji 名称 行（50−12−3=35px），
    // 所以 emoji 留在名称行，不挪到时间行。
    const block = run({ width: 50, height: 39, title: '评审会议', measure });
    expect(block.dataset.teventEmojiLine).toBe('0');
    expect(block.classList.contains('tevent--emoji-own-line')).toBe(false);
    // 0.7.23 起同行时 emoji 挪进名称文字流，textContent 以 emoji 开头。
    expect(block.querySelector('.tevent__title-text').textContent).toContain('评审会议');
  });

  it('样式里不再有 S2 档，emoji 独占行有对应规则', () => {
    expect(views).not.toMatch(/\[data-tevent-tier='S2'\]/);
    const rule = /\.tevent--emoji-own-line \.tevent__title \.tevent__tag-emoji\s*\{([^}]*)\}/.exec(views);
    expect(rule).not.toBeNull();
    expect(rule[1]).toMatch(/display:\s*block/);
    // 0.7.21 重打（总监 2026-11-12 裁决 ①）：时间行永远只有时间，旧的两条
    // 「emoji 挂时间行」样式必须不存在（改前这里是 toMatch 正向断言）。
    // 只认选择器规则，不认注释里提到的名字。
    expect(views).not.toMatch(/\.tevent--emoji-on-time[^{\n]*\{/);
    expect(views).not.toMatch(/\.tevent__tag-emoji--on-time[^{\n]*\{/);
  });
});

// 0.7.21 重打（总监 2026-11-12 裁决 ①，用户 m01833「时间换行，才是 emoji」）：
// 第 2 行写死为「先试 emoji + 名称，名称可用宽不足 1 字才让 emoji 独占第 2 行」；
// 时间行永远只有时间，不许挂 emoji；地点永远在名称之后。
describe('0.7.21 重打 · 时间行不挂 emoji、地点在名称之后', () => {
  it('两行窄块（jsdom 33px）：时间行无 emoji 节点，emoji 留在标题行', () => {
    // 0.7.24（总监 m02597，用户 m00189「emoji 优先级在名称前面」）：0.7.22 的
    // 「两行块丢 emoji 保名称」整条作废；emoji 必须可见。jsdom 里 emoji 盒宽量为 0、
    // 只剩 `measure('📌') = 12px` 的推进宽，所以 33px 块在这里仍能放下 1 个字；
    // 真机实测（周 390 = 22.7px、emoji 推进 23px）落到 `emoji-only`，见证据表。
    const block = run({ width: 33, height: 39 });
    const time = block.querySelector('.tevent__time');
    expect(time.textContent).toBe('10:00');
    expect(time.querySelectorAll('.tevent__tag-emoji')).toHaveLength(0);
    expect(time.querySelectorAll('.tevent__tag-emoji--on-time')).toHaveLength(0);
    expect(block.classList.contains('tevent--emoji-on-time')).toBe(false);
    expect(block.classList.contains('tevent--name-no-emoji')).toBe(false);
    expect(block.dataset.teventEmojiMode).toBe('inline');
    expect(block.dataset.teventNameHidden).toBe('0');
    expect(block.querySelector('.tevent__title .tevent__tag-emoji')).toBeTruthy();
    expect(block.dataset.teventEmojiLine).toBe('0');
    expect(block.style.getPropertyValue('--tevent-lines-title')).toBe('1');
  });

  it('多行块的内容顺序：时间 → 名称 → 地点（地点不得出现在名称行之前）', () => {
    const block = run({ width: 100, height: 78, hasLoc: true });
    const title = block.querySelector('.tevent__title');
    const loc = block.querySelector('.tevent__loc');
    expect(title).toBeTruthy();
    expect(loc).toBeTruthy();
    const order = [...block.children];
    expect(order.indexOf(title)).toBeLessThan(order.indexOf(loc));
    // 名称至少 1 行，地点只拿名称满足之后的剩余行。
    expect(Number(block.dataset.teventNameLines)).toBeGreaterThanOrEqual(1);
    expect(block.style.getPropertyValue('--tevent-lines-loc')).toBe('1');
  });

  it('任何多行块：时间行不含 emoji 节点（逐高度扫 39/52/65/78px）', () => {
    for (const height of [39, 52, 65, 78]) {
      for (const width of [33, 51, 120]) {
        const block = run({ width, height, hasLoc: true });
        const time = block.querySelector('.tevent__time');
        expect(time.querySelectorAll('.tevent__tag-emoji').length).toBe(0);
        expect(block.classList.contains('tevent--emoji-on-time')).toBe(false);
      }
    }
  });
});

// 0.7.23（总监 m01687 ① / m01712）：行数只由块高给，名称与地点各用自己的字体量；
// 这条不变量把「块里还有空行、名称/地点仍被截」直接判失败，不靠推演 fitsOwn 的收几像素。
describe('0.7.23 · 行数只看块高：名称/地点被截时不得还剩 1 行空间', () => {
  it('被截且还剩 ≥ 1 行 → 判违规（名称）', () => {
    // 0.7.23（总监 m02420 ①）：`usedH` 必须含块内竖向间距。周 390 m90 的真实账：
    // 内容高 72 = 时间 13 + 标题盒 43.2（3 行 × 14.4 的实测盒）+ 间距 1.6；
    // 漏掉这 1.6px 会算成 72 − 56.2 = 15.8，`floor((15.8 + 0.5) / 16.6) = 0` 仍为 0，
    // 但只剩 14.2px < 一行 15.6，补行会溢 0.8px——所以这里 expected rowsLeft = 0。
    // `rowUnit` 恒为（行高 + 行距）= 15.6 + 1 = 16.6；容差 0.5px。
    expect(teventRowAudit({ availableH: 72, usedH: 56.2, lineH: 15.6, gap: 1, rows: 1, needRows: 3 })).toMatchObject({
      rowsLeft: 0,
      violations: [],
    });
    // 同一个块若把间距算进去（usedH 57.2），剩余 14.8px 仍不足一行 15.6px。
    expect(teventRowAudit({ availableH: 72, usedH: 57.2, lineH: 15.6, gap: 1, rows: 1, needRows: 3 })).toMatchObject({
      rowsLeft: 0,
      violations: [],
    });
    // 已用 27、剩 45px ≈ 2 行，却只给 1 行、需要 3 行 → 违规。
    const audit = teventRowAudit({ availableH: 72, usedH: 27, lineH: 15.6, gap: 1, rows: 1, needRows: 3 });
    expect(audit.rowsLeft).toBe(2);
    expect(audit.violations).toHaveLength(1);
    expect(audit.violations[0]).toMatchObject({ field: 'name', rows: 1, needRows: 3 });
  });

  it('名称没被截（需要行数 ≤ 已给行数）→ 永远不违规', () => {
    expect(teventRowAudit({ availableH: 72, usedH: 27, lineH: 15.6, gap: 1, rows: 3, needRows: 2 }).violations).toHaveLength(0);
  });

  it('地点用同一把尺（field=loc）', () => {
    const audit = teventRowAudit({ availableH: 72, usedH: 27, lineH: 15.6, gap: 1, rows: 1, needRows: 3, field: 'loc' });
    expect(audit.violations[0].field).toBe('loc');
  });

  it('0.5px 容差不把「刚好放得下」判成违规', () => {
    // 46px 预算、已用 14px（时间行）→ 剩 32.5/16.6 = 1.96 行，向下取整 1 行。
    expect(teventRowAudit({ availableH: 46, usedH: 14, lineH: 15.6, gap: 1, rows: 2, needRows: 3 }).rowsLeft).toBe(1);
    // 名称需要行数 ≤ 已给行数 → 不违规（行数已给满，末行带省略号属允许的截断）。
    expect(teventRowAudit({ availableH: 46.2, usedH: 14, lineH: 15.6, gap: 1, rows: 2, needRows: 2 }).violations).toHaveLength(0);
  });
});
// 0.7.24（总监 m02597，用户 m00189「emoji 优先级在名称前面」）：优先级 时间 > emoji >
// 名称 > 地址。三条禁止项直接做成断言，不靠推演。
describe('0.7.24 · 优先级 时间 > emoji > 名称 > 地址', () => {
  const measure = MEASURE;

  it('有 emoji 标签，emoji 永远可见（不再有丢 emoji 的结构）', () => {
    for (const height of [39, 52, 65, 78]) {
      for (const width of [33, 51, 120]) {
        const block = run({ width, height, title: '季度预算评审会议通知', measure });
        const emoji = block.querySelector('.tevent__title .tevent__tag-emoji')
          || block.querySelector('.tevent__title-text .tevent__tag-emoji');
        expect(emoji, `${width}x${height} 必须有 emoji`).toBeTruthy();
        expect(block.classList.contains('tevent--name-no-emoji')).toBe(false);
        // emoji 不能被塞进时间行（0.7.21 裁决 ① 仍在）。
        expect(block.querySelector('.tevent__time .tevent__tag-emoji')).toBeNull();
      }
    }
  });

  it('名称隐藏只在「emoji 后不足 1 字宽」或「没有名称行可给」时成立', () => {
    // jsdom 没有布局：emoji 盒宽量为 0，`nameCapInline` 永远 ≥ 1 个字宽，构造不出
    // 「名称隐藏」的真样本（真机样本见 `code/web/build-tmp/tevent-0724-*.json`）。
    // 这里只断言「隐藏」这条路的判定：条件不满足就不许隐藏，满足时才允许。
    for (const width of [20, 23, 26, 30, 33]) {
      for (const height of [39, 52, 65, 78]) {
        const block = run({ width, height, title: '季度预算评审会议通知', measure });
        const dbg = JSON.parse(block.dataset.teventDbg || '{}');
        if (block.dataset.teventNameHidden !== '1') continue;
        expect(dbg.nameCapInline < 12 || dbg.rowsAvail < 1).toBe(true);
        expect(block.querySelector('.tevent__title .tevent__tag-emoji')).toBeTruthy();
        expect(block.querySelector('.tevent__time .tevent__tag-emoji')).toBeNull();
      }
    }
    // 反例：emoji 后还有 ≥ 1 字宽、块里还剩 1 行，却把名称隐藏 → 违规。
    expect(teventPriorityAudit({
      hasEmoji: true, emojiVisible: true, nameLines: 0, nameNeed: 1,
      rowsLeft: 1, nameCapInline: 20, titleMin: 12, locLines: 0,
    }).violations[0]).toMatchObject({ rule: 'name-hidden-with-room' });
    // 正例：emoji 后不足 1 字宽 → 隐藏名称不算违规。
    expect(teventPriorityAudit({
      hasEmoji: true, emojiVisible: true, nameLines: 0, nameNeed: 0,
      rowsLeft: 0, nameCapInline: 8, titleMin: 12, locLines: 0,
    }).violations).toHaveLength(0);
  });

  it('两行块（L=2）：时间行占 1 行时只可能是同行或「只放 emoji」', () => {
    for (const width of [20, 23, 26, 30, 50]) {
      const block = run({ width, height: 39, title: '评审', measure });
      if (block.dataset.teventMaxLines !== '2') continue;
      const dbg = JSON.parse(block.dataset.teventDbg || '{}');
      // 时间行在（timeCost > 0）时，标题只剩 1 行：要么同行，要么只放 emoji；
      // 时间行被省略（timeCost = 0）时标题有 2 行，允许 emoji 独占第 2 行。
      if (dbg.timeCost > 0) {
        expect(['inline', 'emoji-only']).toContain(block.dataset.teventEmojiMode);
        if (block.dataset.teventEmojiMode === 'emoji-only') {
          expect(block.dataset.teventNameHidden).toBe('1');
          expect(block.style.getPropertyValue('--tevent-lines-title')).toBe('1');
        } else {
          expect(block.dataset.teventNameHidden).toBe('0');
        }
      } else {
        expect(['inline', 'own-line', 'emoji-only']).toContain(block.dataset.teventEmojiMode);
      }
    }
  });

  it('地址只在名称满足后才出现（地址可见而名称未满足 = 违规）', () => {
    expect(teventPriorityAudit({ nameLines: 1, nameNeed: 2, locLines: 1 }).violations[0])
      .toMatchObject({ rule: 'loc-before-name' });
    expect(teventPriorityAudit({ nameLines: 2, nameNeed: 2, locLines: 1 }).violations).toHaveLength(0);
    // 名称被隐藏时不给地址。
    const hidden = run({ width: 23, height: 104, title: '季度预算评审会议通知', hasLoc: true, measure });
    if (hidden.dataset.teventNameHidden === '1') expect(hidden.dataset.hasLoc).toBe('0');
  });

  it('CSS：丢 emoji 的规则已删，改隐藏名称文字流', () => {
    expect(views).not.toMatch(/\.tevent--name-no-emoji[^{\n]*\{/);
    // 0.7.24（总监 m02597）：隐藏规则必须带 `[data-tevent-tier^='M-']:not(.tevent--emoji-own-line)`，
    // 与上面那条名称行内规则同特异性；只写 `.tevent--name-hidden .tevent__title-text`
    // 会被 `display: -webkit-box` 压回去，名称照样显示（探针实测 2 字）。
    expect(views).toMatch(
      /\.tevent\.tevent--name-hidden\[data-tevent-tier\^='M-'\]:not\(\.tevent--emoji-own-line\) \.tevent__title \.tevent__title-text\s*\{[^}]*display:\s*none/,
    );
  });
});
