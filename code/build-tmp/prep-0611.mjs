// 0.6.11 版本串与 CHANGELOG：0.6.10 → 0.6.11（幂等；manifest 与 server.mjs 的 VERSION 已由开发升过）
import { readFileSync, writeFileSync } from 'node:fs';

const root = 'H:/Agent/Server/DSH/bot/projects/CalDAV';
const OLD = '0.6.10';
const NEW = '0.6.11';

function edit(rel) {
  const p = `${root}/${rel}`;
  let text = readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
  const oldCount = text.split(OLD).length - 1;
  if (oldCount > 0) {
    text = text.split(OLD).join(NEW);
    if (text.includes('\r')) throw new Error(`CR: ${rel}`);
    writeFileSync(p, text, 'utf8');
    console.log(`${rel}: 替换 ${oldCount}`);
    return oldCount;
  }
  const newCount = text.split(NEW).length - 1;
  if (newCount === 0) throw new Error(`无命中: ${rel}`);
  console.log(`${rel}: 已是 ${NEW}（${newCount} 处）`);
  return 0;
}

let total = 0;
for (const f of [
  'README.md',
  'DOCKER.md',
  'Dockerfile',
  'docker-compose.yml',
  'skills/fncal-mcp/SKILL.md',
]) {
  total += edit(f);
}
console.log(`version strings replaced: ${total}`);
if (total !== 25) throw new Error(`版本串替换数异常: ${total}（期望 25 = 6+12+4+2+1）`);

const counts = {};
for (const f of [
  'README.md',
  'DOCKER.md',
  'Dockerfile',
  'docker-compose.yml',
  'skills/fncal-mcp/SKILL.md',
  'code/fnos/manifest',
  'code/app/server.mjs',
]) {
  counts[f] = readFileSync(`${root}/${f}`, 'utf8').split(NEW).length - 1;
}
const all = Object.values(counts).reduce((a, b) => a + b, 0);
console.log(Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(' '));
if (all !== 27) throw new Error(`0.6.11 总数异常: ${all}（期望 27）`);

// server.mjs 里必须还剩 1 处 0.6.7（上一版说明性注释，不能被改）。
const server = readFileSync(`${root}/code/app/server.mjs`, 'utf8');
const leftover = server.split('0.6.7').length - 1;
if (leftover !== 1) throw new Error(`server.mjs 的 0.6.7 说明注释异常: ${leftover}（期望 1）`);

const clPath = `${root}/CHANGELOG.md`;
let cl = readFileSync(clPath, 'utf8').replace(/\r\n/g, '\n');
if (cl.includes('## 0.6.11 ')) {
  console.log('CHANGELOG 0.6.11 段已存在，跳过');
} else {
  const section = [
    '## 0.6.11 — 日程列表的节日与节气色、图标，日期行不再折行（2026-11-08）',
    '',
    '### 修复',
    '',
    '- **日程列表日期列也画图标**：节气的名字前补太阳、节日补旗子；此前这一行只有文字，颜色也一律是主题色，所以「小雪」看着和平常节日一样、还少了图标。',
    '- **节日与节气各一套颜色，全部界面统一**：节日用主题色、节气用主题色的互补色；图标只写 `currentColor`，与所属文字必然同色。月视图日号行、周与四日与日的全天条、日程列表日期列、日程列表事件行、事件详情卡六处对齐；详情卡的节日图标此前的灰色改为主题色。',
    '- **日程列表日期列的「周X · M月」不再折行**：这一行固定单行；窄档放不下时降一档字号并收字距，不折「月」、不省月份。',
    '',
    '',
  ].join('\n');
  const marker = '## 0.6.10 — 手机月视图节日、节气名按农历那套缩放（2026-11-08）';
  if (!cl.includes(marker)) throw new Error('找不到 0.6.10 段标题');
  cl = cl.replace(marker, section + marker);
  if (cl.includes('\r')) throw new Error('CHANGELOG CR');
  writeFileSync(clPath, cl, 'utf8');
}

const headers = cl.split('\n').filter((l) => l.startsWith('## ')).slice(0, 5);
console.log(headers.join('\n'));
console.log(`CHANGELOG bytes: ${Buffer.byteLength(cl, 'utf8')}`);
