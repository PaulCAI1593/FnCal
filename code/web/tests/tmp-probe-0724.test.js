import { describe, it } from 'vitest';
import { applyTeventTimeFit } from '../src/js/views/timegrid.js';
import { DEFAULT_SETTINGS, setTagRegistry } from '../src/js/store.js';

setTagRegistry([{ id: 't1', name: '工作', emoji: '📌', color: '#3b82f6' }]);
const MEASURE = (s) => ({ '10:00-10:45': 63, '10:00': 28, ' ': 3, '📌': 12, '测': 12 })[s] ?? [...s].length * 8;
function run({ width, height, title = '季度预算评审会议通知' }) {
  const block = document.createElement('div');
  block.className = 'tevent';
  block.dataset.focusKey = 'k';
  block.innerHTML = '<div class="tevent__time">10:00</div><div class="tevent__title"><span class="tevent__tag-emoji">📌</span><span class="tag-gap"> </span><span class="tevent__title-text"></span></div>';
  block.querySelector('.tevent__title-text').textContent = title;
  Object.defineProperty(block, 'clientWidth', { value: width, configurable: true });
  block.getBoundingClientRect = () => ({ width, height, top: 0, left: 0, right: width, bottom: height, x: 0, y: 0, toJSON() {} });
  document.body.append(block);
  const root = document.createElement('div');
  root.append(block);
  applyTeventTimeFit(root, { measure: MEASURE });
  return block;
}
describe('probe', () => {
  it('heights', () => {
    for (const h of [26, 39, 52, 65, 78, 104]) {
      const b = run({ width: 33, height: h });
      console.log(h, 'L', b.dataset.teventMaxLines, 'mode', b.dataset.teventEmojiMode, 'hidden', b.dataset.teventNameHidden, 'nameLines', b.dataset.teventNameLines, 'title', b.style.getPropertyValue('--tevent-lines-title'), b.dataset.teventDbg);
    }
  });
});
