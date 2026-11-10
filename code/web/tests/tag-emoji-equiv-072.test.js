/**
 * 0.7.2（用户，m01073）：客户端保存前归一标题 emoji，必须与服务端
 * `applyTagToSummary` **逐字符一致**，否则「先本地 set、后服务端写」会出现
 * 两次不同结果（详情卡丢 emoji 的根因）。
 *
 * 这里直接 import 服务端纯函数做同输入对照；任何一条不一致都说明两份实现
 * 漂移了。
 */
import { describe, it, expect } from 'vitest';
import { withTagEmoji } from '../src/js/tag-display.js';
import { applyTagToSummary } from '../../app/lib/tags.mjs';

const SOCCER = { id: 'tag_soccer', emoji: '⚽', name: '运动' };
const ROCKET = { id: 'tag_rocket', emoji: '🚀', name: '旅行' };
const PLAIN = { id: 'tag_plain', emoji: '', name: '工作' };

const CASES = [
  { name: '无标签 → 加标签：前置 emoji + 空格', prev: null, next: SOCCER, title: '台球', want: '⚽ 台球' },
  { name: '重复保存幂等', prev: SOCCER, next: SOCCER, title: '⚽ 台球', want: '⚽ 台球' },
  { name: '同 emoji、空白归一为一个半角空格', prev: SOCCER, next: SOCCER, title: '⚽\u3000台球', want: '⚽ 台球' },
  { name: '换标签：原位换 emoji', prev: SOCCER, next: ROCKET, title: '⚽ 台球', want: '🚀 台球' },
  { name: '取消标签：删 emoji 与其后空白', prev: SOCCER, next: null, title: '⚽ 台球', want: '台球' },
  { name: '取消标签：连续两个同 emoji 一起清掉（避免残留）', prev: SOCCER, next: null, title: '⚽⚽ 台球', want: '台球' },
  { name: '取消标签：全角空格也删', prev: SOCCER, next: null, title: '⚽　台球', want: '台球' },
  { name: '手写其它 emoji：不叠加、不删除', prev: null, next: SOCCER, title: '🎯 台球', want: '🎯 台球' },
  { name: '标题中间 emoji 不动', prev: null, next: SOCCER, title: '洛阳 🚀 旅行', want: '⚽ 洛阳 🚀 旅行' },
  { name: '空标题只补 emoji', prev: null, next: SOCCER, title: '', want: '⚽' },
  { name: '无 emoji 的标签：标题不动', prev: null, next: PLAIN, title: '周报', want: '周报' },
];

describe('0.7.2：客户端 withTagEmoji 与服务端 applyTagToSummary 字符级一致', () => {
  for (const item of CASES) {
    it(item.name, () => {
      const client = withTagEmoji(item.prev, item.next, item.title);
      const server = applyTagToSummary(item.title, item.next, item.prev);
      expect(client).toBe(server);
      expect(client).toBe(item.want);
    });
  }

  it('两次实现都按首字素处理：连续两个 emoji 只动第一个', () => {
    const input = '⚽⚽ 台球';
    const client = withTagEmoji(SOCCER, ROCKET, input);
    const server = applyTagToSummary(input, ROCKET, SOCCER);
    expect(client).toBe(server);
    expect(client).toBe('🚀 ⚽ 台球');
  });
});
