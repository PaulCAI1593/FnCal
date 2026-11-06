/**
 * 0.5.9（`product/M5-0.5.9-范围与验收.md`）：
 *   S1 手机（≤520px）月视图跨天事件画**连续长条**——0.2.17 B1「窄屏只做 4px 圆角文字块」
 *      的口径变更（用户 2026-11-06「手机上月视图，没有多日、跨日的长条」）。
 *   S2 长条不可折叠、单日 chip 仍每格 2 条上限、横滑排除表不变。
 *   S3（backlog B-07）「打开下载页」任何结果态都可点。
 *
 * 这里只锁「口径与常量」这类静态事实；几何（段宽/缝隙 px）由复现台实测并写进记录
 * （jsdom 没有布局，offsetWidth/getBoundingClientRect 全 0，量不出段宽）。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const READ = (rel) => readFileSync(path.join(HERE, '..', rel), 'utf8');

const monthJs = READ('src/js/views/month.js');
const agendaJs = READ('src/js/views/agenda.js');
const dateUtilsJs = READ('src/js/date-utils.js');
const viewsCss = READ('src/styles/views.css');
const swipeJs = READ('src/js/swipe-nav.js');
const updateJs = READ('src/js/update-dialog.js');

/** 取某个媒体块（按 `{` 配对，取完整块）；出现多段时取包含 marker 的那段。 */
function mediaBlock(css, header, marker) {
  let from = 0;
  for (;;) {
    const at = css.indexOf(header, from);
    expect(at).toBeGreaterThan(-1);
    let depth = 0;
    for (let i = css.indexOf('{', at); i < css.length; i += 1) {
      if (css[i] === '{') depth += 1;
      else if (css[i] === '}') {
        depth -= 1;
        if (depth === 0) {
          const block = css.slice(at, i + 1);
          if (!marker || block.includes(marker)) return block;
          from = i + 1;
          break;
        }
      }
    }
  }
}

describe('0.5.9 S1 手机月视图：跨天连续长条', () => {
  const compactCss = mediaBlock(viewsCss, '@media (max-width: 520px) {', '.chip--span-start');
  const monthBlock = mediaBlock(viewsCss, '@media (max-width: 520px) {', '.month__events {');

  it('紧凑档不再提前 return：几何段 monthBarBoxes 在紧凑标记之后无条件执行', () => {
    const compactAt = monthJs.indexOf('const compact = isCompactScreen();');
    const boxAt = monthJs.indexOf('monthBarBoxes(');
    expect(compactAt).toBeGreaterThan(-1);
    expect(boxAt).toBeGreaterThan(compactAt);
    // 同一套几何函数只写一处：手机不另写负外边距/段宽常量
    expect(monthJs).not.toMatch(/compact[^\n]{0,60}cellWidth\s*[-+*/]/);
    expect(monthJs.match(/monthBarBoxes\(/g)).toHaveLength(1);
  });

  it('CSS：手机档段为无圆角实色块、事件区不裁（缝隙交给同一套几何）', () => {
    expect(compactCss).toMatch(
      /\.chip\.chip--span-start,\s*\.chip\.chip--span-mid,\s*\.chip\.chip--span-end \{[\s\S]{0,180}border-radius: 0;/,
    );
    expect(compactCss).toMatch(
      /\.month__events \{[\s\S]{0,180}flex-direction: column;[\s\S]{0,180}overflow: visible;/,
    );
    // 连续条是整块底色，左侧 3px 日历色条只留给单日 chip
    expect(compactCss).toMatch(/\.chip\.chip--span-start::after,[\s\S]{0,220}display: none;/);
    // 手机档不得再把跨格条拆成横向滚动/裁切容器（那会在跨格处留缝）
    expect(compactCss).not.toMatch(/\.month__events \{[\s\S]{0,180}overflow-x: auto/);
    // 单日 chip 的 4px 圆角 + 3px 色条仍在（S2 不回归）
    expect(compactCss).toMatch(/\.chip \{[\s\S]{0,220}border-radius: var\(--r-xs\);/);
    expect(compactCss).toMatch(/\.chip::after \{[\s\S]{0,220}width: 3px;/);
  });

  it('条高与单日 chip 同口径：都不写死高度，沿用 --month-chip-h 实测值', () => {
    // 0.5.9（S4）口径变更：段规则现在带实色底（.chip.chip--span-* { background … }），
    // 旧断言「段选择器后不得出现 height」会把整条规则一刀切掉，改成逐条看规则体里有没有
    // 写高度——段高必须跟单日 chip 走，不允许出现第二种高度来源。
    const spanRules = [
      ...compactCss.matchAll(/[^{}]*chip--span-(?:start|mid|end)[^{}]*\{([^}]*)\}/g),
    ].map((m) => m[1]);
    expect(spanRules.length).toBeGreaterThan(0);
    for (const body of spanRules) {
      expect(body).not.toMatch(/(^|;)\s*(min-)?height\s*:/);
    }
    // 两种芯片共用的高度口径：.chip 的 26px（min-height）+ 12px 行高
    expect(compactCss).toMatch(/\.chip \{[\s\S]{0,160}min-height: 26px/);
    expect(monthJs).toContain("root.style.setProperty('--month-chip-h'");
  });
});

describe('0.5.9 S2 手机月视图：长条不折叠、单日仍 2 条上限、横滑不劫持', () => {
  it('手机档长条永不折叠：compact 分支把 visibleBars 拉回全部条', () => {
    expect(monthJs).toMatch(/if \(compact\) \{\s*visibleBars = barNodes\.length;/);
    expect(monthJs).toMatch(/visibleLaneNodes = laneNodes\.length;/);
    expect(monthJs).toMatch(/visibleOthers = compactOthersCap;/);
    // 容量再不够也只收单日，不让条出去
    expect(monthJs).toMatch(/else if \(!compact && visibleBars > 0\)/);
  });

  it('单日 chip 上限仍为 2 条（口径 0.2.17 B1 不变）', () => {
    expect(monthJs).toMatch(/const compactOthersCap = compact \? Math\.min\(2, otherNodes\.length\)/);
  });

  it('长条落在 .month__events 内，该容器仍在横滑排除表里（A7）', () => {
    expect(monthJs).toContain('month__events');
    expect(swipeJs).toContain("'.month__events'");
    expect(swipeJs).not.toMatch(/ALLOWED_SELECTOR[^\n]*month__events/);
  });
});

describe('0.5.9 S3（B-07）：打开下载页任何状态都可点', () => {
  it('链接设置集中在一处：href 优先 detail.url，否则按当前源回落 FALLBACK_URLS', () => {
    expect(updateJs).toMatch(/function setOpenLink\(url\)/);
    expect(updateJs).toMatch(/setOpenLink\(detail\.url \|\| FALLBACK_URLS\[via\]\)/);
    expect(updateJs).toContain("openEl.setAttribute('target', '_blank')");
    expect(updateJs).toContain("openEl.setAttribute('rel', 'noopener noreferrer')");
  });

  it('检查中也可点：按用户当前选的源回落', () => {
    expect(updateJs).toMatch(/setOpenLink\(FALLBACK_URLS\[currentVia\]\)/);
    expect(updateJs).toMatch(/const currentVia = source === 'github' \? 'github' : 'mirror'/);
  });

  it('失败且结果没带 via 时，也按当前源回落（不默认 mirror）', () => {
    expect(updateJs).toMatch(/detail\.via === 'github' \|\| \(!detail\.via && source === 'github'\)/);
  });

  it('状态文案与检查逻辑不动（只改链接可用性）', () => {
    expect(updateJs).toContain("t('update.upToDate')");
    expect(updateJs).toContain("t('update.failed')");
    expect(updateJs).toContain("t('update.rateLimited')");
    expect(updateJs).toContain("t('update.available'");
    expect(updateJs).toContain('async function runCheck()');
  });
});

describe('0.5.9 S4：大屏看得见的信息，手机也要看得见（不许「手机版少信息」）', () => {
  const bigBlock = mediaBlock(viewsCss, '@media (max-width: 520px) {', '.month__events {');

  it('月视图农历不再隐藏：≤520 段最后一条把 .month__lunar 拉回 flex（覆盖旧 display:none）', () => {
    const at = viewsCss.lastIndexOf('.month__lunar {');
    expect(at).toBeGreaterThan(viewsCss.indexOf('@media (max-width: 520px) {'));
    const seg = viewsCss.slice(at, at + 260);
    expect(seg).toMatch(/display:\s*flex/);
    // 旧「窄屏不显示农历」的规则不再单独生效：末尾那条在同一媒体查询里且优先级相同、位置更后
    expect(bigBlock).toMatch(/\.month__lunar {[^}]*display:\s*flex/);
  });

  it('周/四日/日表头农历不再隐藏（≤720 无 .timegrid__lunar{display:none}）', () => {
    expect(viewsCss).not.toMatch(/\.timegrid__lunar\s*\{[^}]*display:\s*none/);
  });

  it('节假日名与农历同一行（0.5.10 S1；0.5.11 S1 改为不省略号）', () => {
    // 0.5.10（用户 2026-11-06）：「节日不需要再有图标和『节』字，节省空间」、
    // 「农历日期直接和公历日期一行」。0.5.9 的「节假日独占整格一行（flex:1 1 100%）、
    // 旗子 + 全名」口径作废——节日名与农历共用日号行左侧，日号仍靠右。
    // 0.5.11（用户 m02171）：节日名一律不显示省略号，窄格先缩字号、再减到 1 个完整汉字。
    expect(bigBlock).toMatch(/\.month__dayhead {[^}]*flex-wrap:\s*nowrap/);
    expect(bigBlock).toMatch(/\.month__holiday {[^}]*flex:\s*0 1 auto/);
    expect(bigBlock).toMatch(/\.month__holiday-icon {\s*display:\s*none;/);
    expect(bigBlock).toMatch(/\.month__holiday-name {[^}]*text-overflow:\s*clip/);
    expect(bigBlock).not.toMatch(/\.month__holiday-name {[^}]*text-overflow:\s*ellipsis/);
    expect(bigBlock).toMatch(/\.month__holiday-name {[^}]*white-space:\s*nowrap/);
    // 农历并进日号行（左），日号行仍是整格宽、只有一行
    expect(bigBlock).toMatch(/\.month__lunar--inline {[^}]*flex:\s*1 1 auto/);
    expect(bigBlock).toMatch(/\.month__dayhead {[^}]*width:\s*100%[^}]*max-width:\s*100%/);
  });

  it('单日 chip 两行：标题一行、时间一行，且与长条同高 26px（信息不被挤掉）', () => {
    expect(bigBlock).toMatch(/\.chip {[^}]*min-height:\s*26px[^}]*line-height:\s*12px/);
    expect(bigBlock).toMatch(
      /\.chip:not\(\.chip--span-start\):not\(\.chip--span-mid\):not\(\.chip--span-end\):not\(\.chip--task\)\s*\.chip__title {[^}]*order:\s*1/,
    );
    expect(bigBlock).toMatch(
      /\.chip:not\(\.chip--span-start\):not\(\.chip--span-mid\):not\(\.chip--span-end\):not\(\.chip--task\)\s*\.chip__time {[^}]*order:\s*2[^}]*line-height:\s*12px/,
    );
  });

  it('任务勾选与「外出」图标不再在手机档隐藏（只藏左侧重复的色点）', () => {
    const hideRule = bigBlock.match(/\.chip__dot[^{]*\{[^}]*display:\s*none/);
    expect(hideRule).not.toBeNull();
    const hidden = [...bigBlock.matchAll(/([^{}]*)\{\s*display:\s*none;?\s*\}/g)]
      .map((m) => m[1])
      .join('|');
    expect(hidden).not.toContain('chip__check');
    expect(hidden).not.toContain('chip__ooo-icon');
    expect(hidden).toContain('chip__dot');
  });

  it('「还有 N 个」用满整格宽，并在 320 档降 10px 让尾字不被截（数字必须看得见）', () => {
    expect(bigBlock).toMatch(/\.month__more {[^}]*margin:\s*0 -4px[^}]*padding:\s*0;/);
    const tiny = mediaBlock(viewsCss, '@media (max-width: 360px) {', '.month__more');
    expect(tiny).toMatch(/\.month__more {\s*font-size:\s*10px;/);
  });

  it('日程行：≤520 标注换到标题下一行、标题最多两行；≤360 收紧日期/时间列', () => {
    const agendaBlock = mediaBlock(viewsCss, '@media (max-width: 520px) {', '.agenda__event-main {');
    expect(agendaBlock).toMatch(/\.agenda__event-main {\s*grid-template-columns:\s*minmax\(0, 1fr\);/);
    expect(agendaBlock).toMatch(/\.agenda__event-daypart {[^}]*grid-column:\s*1;[^}]*grid-row:\s*2/);
    expect(agendaBlock).toMatch(/\.agenda__event-title {[^}]*-webkit-line-clamp:\s*2/);
    const tiny = mediaBlock(viewsCss, '@media (max-width: 360px) {', '.agenda__event-time');
    expect(tiny).toMatch(/\.agenda__day {\s*grid-template-columns:\s*60px minmax\(0, 1fr\)/);
    expect(tiny).toMatch(/\.agenda__event-time {\s*width:\s*68px/);
  });
});

describe('0.5.9（F1/F2）：手机档时间显示不被切字、不在词内断行', () => {
  const compactCss = mediaBlock(viewsCss, '@media (max-width: 520px) {', '.chip--span-start');
  const agendaBlock = mediaBlock(viewsCss, '@media (max-width: 520px) {', '.agenda__event-main {');

  it('短格式 24 小时制是 date-utils 的独立导出，不改全局 formatTime', () => {
    expect(dateUtilsJs).toMatch(/export function formatTimeShort24\(date\)/);
    expect(dateUtilsJs).toMatch(/return `\$\{pad2\(d\.getHours\(\)\)\}:\$\{pad2\(d\.getMinutes\(\)\)\}`/);
    // 全局 formatTime 的签名与行为不动（桌面/平板仍按用户 hour12 设置）
    expect(dateUtilsJs).toMatch(/export function formatTime\(date, \{ hour12 = true \} = \{\}\)/);
  });

  it('月视图 chip：≤520 用短格式，完整 12 小时文案保留在 title 与 aria-label', () => {
    expect(monthJs).toContain('formatTimeShort24(shownStartDate)');
    expect(monthJs).toMatch(
      /const timeText = compactChip && !event\.allDay \? formatTimeShort24\(shownStartDate\) : timeTextFull;/,
    );
    // 完整文案仍走 formatTime，并进 aria-label 与 title
    expect(monthJs).toMatch(
      /const timeTextFull = event\.allDay\s*\?\s*''\s*:\s*formatTime\(shownStartDate, \{ hour12: ctx\.settings\.hour12 \}\);/,
    );
    expect(monthJs).toMatch(/'aria-label':[^\n]*formatTime\(shownStartDate, \{ hour12: ctx\.settings\.hour12 \}\)/);
    expect(monthJs).toMatch(/title: compactChip && !event\.allDay \? `\$\{chipTitle\}，\$\{timeTextFull\}` : chipTitle/);
    // chip__time 渲染的是上面的 timeText，不再内联 formatTime
    expect(monthJs).toMatch(/class: 'chip__time',\s*text: timeText,/);
  });

  it('月视图 CSS：.chip__time 单行 + 省略号兜底（chip 是 overflow:hidden，不能切数字）', () => {
    const rule = compactCss.match(/\.chip__time \{([^}]*)\}/);
    expect(rule).not.toBeNull();
    expect(rule[1]).toMatch(/white-space:\s*nowrap;/);
    expect(rule[1]).toMatch(/overflow:\s*hidden;/);
    expect(rule[1]).toMatch(/text-overflow:\s*ellipsis;/);
    expect(rule[1]).toMatch(/max-width:\s*100%;/);
  });

  it('日程时间列：≤520 用短格式区间，两个片段各自 nowrap、放不下整段换行', () => {
    expect(agendaJs).toContain('formatTimeShort24');
    expect(agendaJs).toMatch(/function compactRangeParts\(start, end, dayStart\)/);
    expect(agendaJs).toMatch(/return \{ start: `\$\{startText\}–`, end: formatTimeShort24\(new Date\(end\)\) \};/);
    expect(agendaJs).toMatch(/class: 'agenda__event-time agenda__event-time--compact'/);
    expect(agendaJs).toMatch(/class: 'agenda__event-time-start', text: parts\.start/);
    expect(agendaJs).toMatch(/class: 'agenda__event-time-end', text: parts\.end/);
    const css = agendaBlock.match(/\.agenda__event-time--compact \{([^}]*)\}/);
    expect(css).not.toBeNull();
    expect(css[1]).toMatch(/display:\s*flex;/);
    expect(css[1]).toMatch(/flex-wrap:\s*wrap;/);
    expect(agendaBlock).toMatch(/\.agenda__event-time--compact > span \{\s*white-space:\s*nowrap;/);
    // 完整 12 小时文案仍进 aria-label
    expect(agendaJs).toMatch(/'aria-label':[^\n]*\$\{timeText\}/);
  });

  it('>520 桌面/平板不进手机档：两条短格式路径都由 isCompact 判定守护', () => {
    expect(monthJs).toMatch(/const compactChip = isCompactScreen\(\);/);
    expect(agendaJs).toMatch(/if \(isCompactAgenda\(\) && !event\.allDay\)/);
    expect(agendaJs).toMatch(/function isCompactAgenda\(\) \{[\s\S]{0,260}max-width: 520px/);
  });
});