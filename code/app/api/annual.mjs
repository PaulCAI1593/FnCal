// 0.8.0：年度总结只读聚合。
//
//   GET /api/v1/annual-summary?year=YYYY&calendars=<id,id,...>
//     -> 200 { ok, data: <buildAnnualReviewData 的返回值> }
//
// 口径（任务书 §八/§十）：
//   - 只统计 `calendars` 里列出的日历（前端只传当前开启的）；列表为空或缺省时
//     返回空结果，**不回落全量**——否则隐藏日历的条数会泄露到图上；
//   - 只统计该年 1/1 00:00 – 次年 1/1 00:00 之间**开始**的事件；跨年不拆分；
//   - 重复事件先展开成当年实例再统计；
//   - 只返回聚合结果（月份/日历/分类计数），不含任何事件标题、正文、地点。
//
// 统计与文案只有一份实现：`lib/annual-review.mjs`（由 shared/annual-review.mjs 同步），
// 网页 canvas、MCP PNG、本接口共用。

import { collectAnnualEvents, yearRange, MAX_EVENTS, YEAR_MIN, YEAR_MAX } from '../lib/annual-collect.mjs';
import { buildAnnualReviewData, CARD_WIDTH, CARD_HEIGHT, DEFAULT_ACCENT, normalizeAccentColor, normalizeGroupOrder } from '../lib/annual-review.mjs';
import { currentContext, runWithContext } from '../lib/request-context.mjs';

const PATHS = ['/api/annual-summary', '/api/v1/annual-summary'];
function json(res, status, body) {
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': payload.length,
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

/** `calendars=a,b` → ['a','b']；缺省或空串返回 []（= 空结果）。 */
function parseCalendars(url) {
  const raw = url.searchParams.get('calendars');
  if (!raw) return [];
  return [...new Set(
    String(raw)
      .split(',')
      .map((part) => part.trim())
      .filter((part) => /^[A-Za-z0-9._-]{1,128}$/.test(part)),
  )];
}

function parseYear(url, now) {
  const raw = url.searchParams.get('year');
  if (!raw) return now.getFullYear();
  const year = Number(raw);
  if (!Number.isInteger(year) || year < YEAR_MIN || year > YEAR_MAX) return null;
  return year;
}

export function createAnnualApi({ store, tags = null, auth }) {
  let expanderPromise = null;

  /** 重复事件展开器与 DAV 侧共用同一份 vendor 模块。 */
  function loadExpander() {
    if (!expanderPromise) {
      expanderPromise = import(new URL('../vendor/ical/recurrence.js', import.meta.url))
        .then((mod) => mod.expandOccurrences)
        .catch(() => null);
    }
    return expanderPromise;
  }

  /** 标签解析与网页一致：tagId 优先，其次 categories[0] 必须是注册表中的标签名。
   *  同时带上分组名与组序（组色 = 组序在 6 色板里取，见 `shared/annual-review.mjs`）。 */
  async function buildTagOf() {
    if (!tags) return { tagOf: () => null, groups: [] };
    let state;
    try {
      state = await tags.list();
    } catch {
      return { tagOf: () => null, groups: [] };
    }
    const list = Array.isArray(state && state.tags) ? state.tags : [];
    const groups = new Map();
    (Array.isArray(state && state.groups) ? state.groups : []).forEach((group, index) => {
      groups.set(group.id, {
        name: group.name || '',
        order: Number.isInteger(group.order) ? group.order : index,
      });
    });
    const shape = (tag) => {
      const group = groups.get(tag.groupId) || null;
      return {
        name: tag.name,
        emoji: tag.emoji || '',
        group: group ? group.name : '',
        groupOrder: group ? normalizeGroupOrder(group.order) : -1,
      };
    };
    const byId = new Map(list.map((tag) => [tag.id, tag]));
    const groupList = [...groups.values()].map((group) => ({ name: group.name, order: group.order }));
    const byName = new Map(list.map((tag) => [tag.name, tag]));
    const tagOf = (record) => {
      const id = record && typeof record.tagId === 'string' ? record.tagId : '';
      if (id && byId.has(id)) return shape(byId.get(id));
      const first = record && Array.isArray(record.categories) ? record.categories[0] : '';
      const name = first ? String(first).trim() : '';
      if (!name) return null;
      const hit = byName.get(name);
      return hit ? shape(hit) : null;
    };
    // 图例要保留分母为 0 的分组，所以把「全部已配置分组」一起给数据层。
    return { tagOf, groups: groupList };
  }

  /** 卡片重点色取用户的主题色设置（与网页同一份 settings）。读不到/非法 → 默认深蓝。
   *  一周从哪天开始也取同一份设置（`weekStartsOn` 0=周日 / 1=周一），
   *  否则卡片「一周节奏」会和日历视图差一天。 */
  async function readSettings() {
    try {
      const settings = await store.readUserData('settings');
      return {
        accent: normalizeAccentColor(settings && settings.accentColor),
        weekStartsOn: settings && settings.weekStartsOn === 1 ? 1 : 0,
      };
    } catch {
      return { accent: DEFAULT_ACCENT, weekStartsOn: 0 };
    }
  }

  async function handle(req, res, url) {
    if (req.method !== 'GET') return json(res, 405, { ok: false, code: 'method_not_allowed' });
    if (!auth) return json(res, 503, { ok: false, code: 'unavailable', message: '服务未就绪' });
    const identity = await auth.authenticate(req);
    if (!identity.ok || !identity.account) {
      return json(res, 401, { ok: false, code: 'unauthorized', message: '请先登录' });
    }
    const userId = identity.account.id;

    // 存储层按账号分区（store 从请求上下文取 userId）。API 请求的外层上下文
    // userId 是 null，这里按其他 REST 模块同样的做法填上账号。
    const respond = async () => {
      const now = new Date();
      const year = parseYear(url, now);
      if (year === null) {
        return json(res, 400, { ok: false, code: 'bad_year', message: `年份需在 ${YEAR_MIN}–${YEAR_MAX} 之间` });
      }

      const requested = parseCalendars(url);
      const { from, to } = yearRange(year);

      let metas = [];
      if (requested.length) {
        const existing = new Map();
        try {
          for (const meta of await store.listCalendarMetas()) existing.set(meta.id, meta);
        } catch {
          /* 没有日历目录：按空处理 */
        }
        // 顺序沿用侧栏顺序（并列冠军取靠前者）
        metas = requested.filter((id) => existing.has(id)).map((id) => {
          const meta = existing.get(id);
          return { id: meta.id, name: meta.displayName || meta.name || meta.id, color: meta.color || '' };
        });
      }

      // 收集逻辑只有一份：`lib/annual-collect.mjs`（MCP 工具走同一个函数）。
      const expander = await loadExpander();
      const { events } = metas.length
        ? await collectAnnualEvents({
            calendarIds: metas.map((meta) => meta.id),
            listObjects: (calendarId) => store.listEvents(calendarId),
            expand: (event, rangeFrom, rangeTo) => {
              if (typeof expander !== 'function') return [];
              return expander(event, rangeFrom, rangeTo);
            },
            from,
            to,
          })
        : { events: [] };

      const { tagOf, groups: tagGroups } = await buildTagOf();
      const { accent, weekStartsOn } = await readSettings();
      const data = buildAnnualReviewData({ events, calendars: metas, tagOf, groups: tagGroups, year, now: now.getTime(), accent, weekStartsOn });
      return json(res, 200, {
        ok: true,
        card: { width: CARD_WIDTH, height: CARD_HEIGHT },
        data,
      });
    };

    const context = currentContext();
    if (context) {
      context.userId = userId;
      return respond();
    }
    return runWithContext({ userId }, respond);
  }

  return { paths: PATHS, handle };
}
