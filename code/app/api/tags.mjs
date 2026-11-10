/**
 * 0.7.0 标签注册表 REST；0.7.1 加分组与排序。
 *
 * - GET    `/api/v1/tags?counts=1` → `{ ok, version, groups, tags }`
 * - POST   `/api/v1/tags` `{ emoji, name, groupId? }` → 201 + `{ ok, tag }`
 * - PATCH  `/api/v1/tags/<id>` `{ emoji?, name?, groupId? }` → `{ ok, tag }`
 * - DELETE `/api/v1/tags/<id>` → `{ ok, removed: { id, name } }`
 * - PATCH  `/api/v1/tags/order` `{ groups: [{ id, order }], tags: [{ id, groupId, order }] }`
 *   批量原子排序；先校验后写，失败磁盘不变。
 * - POST   `/api/v1/tag-groups` `{ name }` → 201 + `{ ok, group }`
 * - PATCH  `/api/v1/tag-groups/<id>` `{ name }` → `{ ok, group }`
 * - DELETE `/api/v1/tag-groups/<id>` → `{ ok, removed, moved }`（标签移到「未分组」）
 *
 * 鉴权与会话/CSRF 判定在 `api/index.mjs` 的 `handleTags` 里完成，这里只做业务。
 */

const MAX_BODY_BYTES = 64 * 1024;
const TAGS_PREFIX = '/api/v1/tags';
const GROUPS_PREFIX = '/api/v1/tag-groups';

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(text);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('body too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) return resolve({});
      try {
        const parsed = JSON.parse(text);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
        resolve(parsed);
      } catch {
        reject(Object.assign(new Error('invalid json'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function fail(res, err) {
  const status = Number(err && err.status) || 500;
  return sendJson(res, status, {
    ok: false,
    code: (err && err.code) || (status === 500 ? 'tags_failed' : 'invalid'),
    message: String((err && err.message) || err),
  });
}

function restOf(pathname, prefix) {
  if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) return null;
  return pathname.slice(prefix.length).replace(/^\/+/, '');
}

export function createTagsApi({ tags }) {
  async function handleTags(req, res, url) {
    const rest = restOf(url.pathname, TAGS_PREFIX);
    if (rest === null) return sendJson(res, 404, { ok: false, code: 'not_found' });
    const id = rest ? decodeURIComponent(rest.split('/')[0]) : '';

    if (!rest) {
      if (req.method === 'GET') {
        try {
          const withCounts = url.searchParams.get('counts') !== '0';
          return sendJson(res, 200, { ok: true, ...(await tags.list({ withCounts })) });
        } catch (err) {
          return fail(res, err);
        }
      }
      if (req.method === 'POST') {
        try {
          const body = await readJsonBody(req);
          const tag = await tags.create({ emoji: body.emoji, name: body.name, groupId: body.groupId });
          return sendJson(res, 201, { ok: true, tag });
        } catch (err) {
          return fail(res, err);
        }
      }
      return sendJson(res, 405, { ok: false, code: 'method_not_allowed' });
    }

    // `/api/v1/tags/order` 必须排在 `/:id` 之前，否则会被当成标签 id。
    if (id === 'order' && !rest.slice('order'.length).replace(/^\/+/, '')) {
      if (req.method !== 'PATCH' && req.method !== 'PUT') {
        return sendJson(res, 405, { ok: false, code: 'method_not_allowed' });
      }
      try {
        const body = await readJsonBody(req);
        const next = await tags.reorder({ groups: body.groups, tags: body.tags });
        return sendJson(res, 200, { ok: true, ...next });
      } catch (err) {
        return fail(res, err);
      }
    }

    // `/api/v1/tags/apply-from-titles`（0.7.1 D 项）也要排在 `/:id` 之前。
    if (id === 'apply-from-titles' && !rest.slice('apply-from-titles'.length).replace(/^\/+/, '')) {
      if (req.method !== 'POST') {
        return sendJson(res, 405, { ok: false, code: 'method_not_allowed' });
      }
      try {
        const body = await readJsonBody(req);
        if (!String(body.tagId ?? '').trim()) {
          return sendJson(res, 400, { ok: false, code: 'TAG_ID_REQUIRED', message: '缺少 tagId' });
        }
        const result = await tags.applyFromTitles({ tagId: body.tagId, dryRun: body.dryRun !== false });
        return sendJson(res, 200, { ok: true, ...result });
      } catch (err) {
        return fail(res, err);
      }
    }

    if (!id) return sendJson(res, 404, { ok: false, code: 'not_found' });
    if (req.method === 'PATCH' || req.method === 'PUT') {
      try {
        const body = await readJsonBody(req);
        const patch = {};
        if (body.name !== undefined) patch.name = body.name;
        if (body.emoji !== undefined) patch.emoji = body.emoji;
        if (body.groupId !== undefined) patch.groupId = body.groupId;
        const tag = await tags.update(id, patch);
        return sendJson(res, 200, { ok: true, tag });
      } catch (err) {
        return fail(res, err);
      }
    }
    if (req.method === 'DELETE') {
      try {
        const removed = await tags.remove(id);
        return sendJson(res, 200, { ok: true, removed: { id: removed.id, name: removed.name } });
      } catch (err) {
        return fail(res, err);
      }
    }
    return sendJson(res, 405, { ok: false, code: 'method_not_allowed' });
  }

  async function handleGroups(req, res, url) {
    const rest = restOf(url.pathname, GROUPS_PREFIX);
    if (rest === null) return sendJson(res, 404, { ok: false, code: 'not_found' });
    const id = rest ? decodeURIComponent(rest.split('/')[0]) : '';

    if (!rest) {
      if (req.method === 'POST') {
        try {
          const body = await readJsonBody(req);
          const group = await tags.createGroup({ name: body.name });
          return sendJson(res, 201, { ok: true, group });
        } catch (err) {
          return fail(res, err);
        }
      }
      return sendJson(res, 405, { ok: false, code: 'method_not_allowed' });
    }

    if (!id) return sendJson(res, 404, { ok: false, code: 'not_found' });
    if (req.method === 'PATCH' || req.method === 'PUT') {
      try {
        const body = await readJsonBody(req);
        const group = await tags.updateGroup(id, { name: body.name });
        return sendJson(res, 200, { ok: true, group });
      } catch (err) {
        return fail(res, err);
      }
    }
    if (req.method === 'DELETE') {
      try {
        const removed = await tags.removeGroup(id);
        return sendJson(res, 200, {
          ok: true,
          removed: { id: removed.group.id, name: removed.group.name },
          moved: removed.moved,
        });
      } catch (err) {
        return fail(res, err);
      }
    }
    return sendJson(res, 405, { ok: false, code: 'method_not_allowed' });
  }

  async function handle(req, res, url) {
    if (url.pathname === GROUPS_PREFIX || url.pathname.startsWith(`${GROUPS_PREFIX}/`)) {
      return handleGroups(req, res, url);
    }
    return handleTags(req, res, url);
  }

  return { handle };
}
