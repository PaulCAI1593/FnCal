# FnCal MCP tool contracts

Transport: `POST /mcp`, JSON-RPC 2.0, stateless, `Authorization: Bearer fncal_ai_…`.
Every result comes back as `{ "content": [{ "type": "text", "text": "<JSON string>" }] }`. Parse `text` as JSON. Tool-level failure adds `"isError": true` and the same text shape.

All times are ISO 8601 strings. Send offsets (`2026-10-29T14:00:00+08:00`) or UTC; do not send a bare local wall time.

## list_calendars

No arguments.

```json
{ "calendars": [ { "id": "my-calendar", "name": "我的日历", "color": "#4f7cff", "access": "write" } ] }
```

- Only calendars at `read` or `write` appear. `hidden` calendars are absent entirely — no placeholder, no count.
- `access` is `"read"` or `"write"`. Use it to decide whether a write tool call is even worth attempting.

## list_tags

No arguments.

```json
{ "tags": [ { "id": "tag_1a2b3c4d", "name": "出行", "emoji": "🚄", "group": "旅行", "count": 12 } ] }
```

- `count` is how many events and tasks use the tag, limited to calendars this credential can read. A tag used only in calendars this credential cannot see reports `0`.
- `group` is the group name the user filed the tag under (`未分组` when it has none). Groups are managed in FnCal only.
- One tag per event. `emoji` may be an empty string for a tag created while importing a calendar whose CATEGORIES had no matching tag.
- `id` and `name` are interchangeable wherever a tool takes `tag` or `tags`.
- **What FnCal writes:** the tag's emoji goes into the **title** as `emoji 名称` (one half-width space, e.g. `🚄 出行`); `CATEGORIES` gets the bare tag name (`出行`), never the emoji. FnCal prepends the emoji itself — send a plain title and do not double it. Reading accepts `CATEGORIES:🚄 出行`, `🚄出行` and `出行`.

## create_tag

| arg | type | notes |
|---|---|---|
| `name` | string | required, 1–12 characters (the registry's limit; code points, whitespace collapsed) |
| `emoji` | string | one grapheme; optional on create, FnCal does not invent one |
| `groupId` | string | optional; omitted = the default group |

Governed by `tagWriteMode` — the same switch as `update_tag` (`proposal` by default, `direct` optional), independent of the calendar grants.

```json
// direct
{ "ok": true, "mode": "direct", "tag": { "id": "tag_1a2b3c4d", "name": "旅行", "emoji": "🧳", "group": "未分组" } }
// proposal — the registry is unchanged
{ "ok": true, "applied": false, "mode": "proposal",
  "proposal": { "id": "p_…", "action": "tag_create", "summary": "新建标签 🧳 旅行" } }
```

## update_tag

| arg | type | notes |
|---|---|---|
| `tag` | string | required; id or name |
| `emoji` | string | optional |
| `name` | string | optional, 1–12 characters |
| `groupId` | string | optional |

Governed by `tagWriteMode`, the same switch as `create_tag`. Result mirrors `create_tag`, with `tag` holding the updated tag. The proposal carries `tagId`, `before` and `after`; accepting it fails with `tag_changed` when the tag changed in the meantime.

## delete_tag

| arg | type | notes |
|---|---|---|
| `tag` | string | required; id or name |

Governed by `tagDeleteMode`. Deleting removes the tag from the registry **and clears it from every event and task that carried it, including calendars this credential cannot see** — the registry is global.

```json
{ "ok": true, "mode": "direct", "removed": { "id": "tag_1a2b3c4d", "name": "旅行" }, "affected": 12 }
```

- `affected` is the number of events and tasks whose tag was cleared.
- The proposal carries `tagId`, `before` and `affected`; the count the user sees is that number.
- `tag_exists` (name collision on create/update) → 409; `tag_not_found` (unknown tag or group) → 404. Tags are global, so neither answer depends on which calendars the credential can read.

## list_events

| arg | type | notes |
|---|---|---|
| `from` | string | ISO 8601, inclusive; omitted = start of the credential's window |
| `to` | string | ISO 8601, exclusive; omitted = end of the window |
| `calendar` | string | calendar id; omitted = all readable calendars |
| `tags` | string or string[] | optional; a tag name or id; several values mean **union** (match any), combined with the other filters as AND |

```json
{ "from": "…", "to": "…",
  "events": [ { "uid": "…", "calendarId": "…", "title": "…", "start": "…", "end": "…",
                "allDay": false, "allDayDate": null, "allDayEndDate": null,
                "status": "confirmed", "recurring": false, "busy": true,
                "location": "…",
                "tag": { "id": "tag_1a2b3c4d", "name": "出行", "emoji": "🚄" } } ] }
```

- The returned range is the **intersection** of your `from`/`to` and the credential's window. Do not assume you got what you asked for; use the returned `from`/`to`.
- Recurring events are expanded to the occurrences inside the range, so a weekly event that started last year still appears.
- `location`, `description`, `attendees` appear **only** if the credential's field mask allows them. A missing key means "not granted".
- A calendar id that is hidden or unknown → not-found (not an empty list).
- `tag` is `null` when the event has none; it is not filtered by the field mask.

## get_event

| arg | type | notes |
|---|---|---|
| `uid` | string | **required** |
| `calendarId` | string | optional; disambiguates when the same uid exists in several calendars |

```json
{ "event": { "uid": "…", "calendarId": "…", "title": "…", "start": "…", "end": "…", "location": "…" } }
```

Same not-found answer for: hidden calendar, outside the window, no such uid, another user's calendar. The text is identical on purpose — never infer which case you hit.

## find_free_slots

| arg | type | notes |
|---|---|---|
| `from` | string | ISO 8601; omitted = now |
| `to` | string | ISO 8601; omitted = next 7 days |
| `minMinutes` | number | minimum slot length, default 30 (5–1440) |

```json
{ "from": "…", "to": "…", "minMinutes": 30,
  "slots": [ { "start": "…", "end": "…" } ] }
```

- Free time only, computed across every readable+visible calendar. No titles, no calendar ids of busy blocks — that is deliberate.
- At most 200 slots are returned; if you got 200, narrow the range instead of assuming that is all.

## create_event

| arg | type | notes |
|---|---|---|
| `calendarId` | string | **required**, must be `access: "write"` |
| `title` | string | required unless `ics` is given |
| `start` | string | ISO 8601 |
| `end` | string | optional, defaults to start + 1 h |
| `allDay` | bool | all-day event |
| `location` | string | optional |
| `description` | string | optional |
| `ics` | string | full iCalendar text, alternative to the structured fields |
| `uid` | string | optional, auto-generated; must equal the `UID:` inside `ics` if both are given |
| `note` | string | short explanation shown to the human on the proposal |
| `tag` | string | optional; tag name or id, must already exist; one tag per event |

```json
// direct mode
{ "applied": true, "etag": "…", "calendarId": "…", "event": { … } }
// proposal mode (default)
{ "applied": false, "proposal": { "id": "…", "action": "create", "status": "pending", … }, "note": "…" }
```

- Outside the credential's window → not-found. All-day events get a 24 h tolerance at the window edge.
- In proposal mode nothing is written until the human accepts. If the client has no elicitation popup and the credential has agent approval on, the same result also carries `approvalUrl` / `pinRequired` / `expiresIn` (0.4.27): hand the link to the user directly, no extra `decide_proposals` call is needed.
- Writing (create or update): a `read`-level target says so explicitly (`该日历只有「只读」权限…`); a time outside the window says so explicitly (`这个时间在你的凭据时间窗外…`); `end` earlier than `start` → `结束时间必须晚于开始时间。` Only a hidden or absent calendar uses the calendar not-found text.

## update_event

| arg | type | notes |
|---|---|---|
| `uid` | string | **required** |
| `calendarId` | string | optional |
| `title` `start` `end` `allDay` `location` `description` | | only the fields you pass change |
| `ifMatch` | string | ETag you last saw; mismatch → conflict instead of overwriting |
| `tag` | string | tag name or id; an empty string clears the tag; omitted leaves it unchanged |
| `note` | string | proposal explanation |

Same result shape as `create_event`, including `approvalUrl` in proposal mode for clients without elicitation. Changing the UID is rejected (`400` class) — cancel and create instead.

Pass `ifMatch` whenever you read the event first; it turns a silent overwrite into a `409 stale` you can recover from.

## delete_event

| arg | type | notes |
|---|---|---|
| `uid` | string | **required** |
| `calendarId` | string | optional |
| `note` | string | why you are deleting |

Result depends on the credential's **delete mode** (separate from `writeMode`):

```json
// deleteMode: proposal (default)
{ "applied": false, "proposal": { "id": "…", "action": "delete", "status": "pending", … } }

// deleteMode: trash — applied immediately
{ "applied": true, "deleted": true, "calendarId": "…" }
```

- **proposal** (default): nothing is deleted until the human accepts; tell them a confirmation is waiting in FnCal. The proposal result itself carries `approvalUrl` when the credential has agent approval on and the client has no elicitation popup (0.4.27) — hand that link to the user; no extra call is needed. To mint a fresh link for a pending delete (for example after the old one expired), call `decide_proposals` with the proposal's id and `action: "approve"`: without elicitation it returns `approval_requires_ui` plus `approvalUrl` and settles nothing. The delete keeps waiting until the user settles it on that page or in FnCal.
- **trash**: the event is deleted at once and stored in FnCal's trash for the retention period (default 7 days). The user can restore it **only** in the FnCal interface; you have no restore or empty tool. Say "已移到 FnCal 回收站，可在保留期内恢复", not "无法撤销".
- Either way a failed trash write leaves the event in place: `删除失败：回收站写入失败，日程未删除` / `删除失败：回收站不可用，日程未删除`.

## list_proposals

No arguments. Requires the credential to have **agent approval** enabled; otherwise the call fails with `凭据未开启 AI 端批准，请到 FnCal 设置里打开，或在日历界面批准`.

```json
{ "proposals": [ { "id": "…", "action": "create|update|delete", "calendarId": "…", "status": "pending",
                  "createdAt": "…", "expiresAt": "…", "title": "…", "start": "…", "end": "…",
                  "allDay": false, "location": "…" } ] }
```

- Only **your own credential's** pending proposals, only calendars it can still read. No iCalendar text is returned.
- An empty list means nothing is waiting; do not go looking in other calendars.

## approve_proposal / reject_proposal

| arg | type | notes |
|---|---|---|
| `id` | string | **required**, from `list_proposals` |
| `confirmed` | boolean | **deprecated**: the server only accepts the popup click; passing `true` is refused with `approval_requires_ui` |
| `reason` | string | `reject_proposal` only, optional, ≤200 chars |

```json
// approve_proposal
{ "approved": true, "proposal": { … } }
// reject_proposal
{ "rejected": true, "proposal": { … } }
```

- Same in-conversation proxy gate as `list_proposals`: **show the proposal summary and get the user's explicit approval or rejection before calling; one proposal at a time.**
- **Approval is only possible through FnCal's popup.** With MCP elicitation the call answers as `text/event-stream` and emits `elicitation/create`; the user clicks approve / reject / cancel — `{approved:true}` / `{declined:true}` / `{cancelled:true}`, timeout gives `{code:"confirmation_timeout"}`. Decline, cancel and timeout never change data.
- **No elicitation capability → `isError: true`, `code: "approval_requires_ui"`, zero execution.** A chat "yes" is not authorization, and `confirmed` is deprecated and refused. Relay the `message`, the `summary` and the `approvalUrl`; the user settles them on that page — per-card 批准 / 拒绝, 全部批准 / 全部拒绝 when 2+ remain, 刷新; 10 minutes, each proposal once (PIN if the credential has one).
- A client that declares elicitation but whose popup stream cannot be written also gets `approval_requires_ui` (`reason: "stream_unavailable"`) plus `approvalUrl`. There is no text fallback: the link page is the only other path.
- Approval re-checks the calendar: if it is no longer visible or writable to this credential, the call is refused instead of applied.
- A settled, expired, or someone else's proposal → `未找到该提案：它可能不存在、已被处理，或不属于你的凭据。`
- Approving a `delete` proposal deletes the event (in trash mode it lands in the trash; in proposal mode it is a real deletion). Never approve a delete the user did not ask for.

## decide_proposals

The entry point for settling proposals. Mode-first only when 2+ are pending (0.4.20); with exactly one it is a single confirmation. `approve_proposal` / `reject_proposal` stay available for one-off decisions.

| arg | type | notes |
|---|---|---|
| `action` | string | **required**: `approve` or `reject` |
| `scope` | string | `all` or `single`. Omit it when exactly one is pending (single confirmation) or to get the mode question when 2+ are pending |
| `ids` | string[] | optional; with `all` it narrows the set, with `single` it must hold exactly one id |
| `confirmed` | boolean | **deprecated**: the server only accepts the popup click; passing `true` is refused with `approval_requires_ui` |
| `reason` | string | reject only, optional, ≤200 chars |

Call it with `action` first (no `scope`); what comes back depends on the client capability and the pending count:

1. **No elicitation capability (any pending count).** `isError: true`, `code: "approval_requires_ui"`, zero execution — `total`, `deleteCount` when it applies, `message`, `approvalUrl`, `pinRequired`, `expiresIn`, `ui: { panel: "proposals" }`. Relay the `message` and the link; the user settles the batch there (per-card, or 全部批准 / 全部拒绝, 刷新). Do not retry and do not pass `confirmed`. `pinRequired` is true only when the credential has agent approval on, at least one write mode set to proposal, and a PIN saved.
2. **Nothing pending.** `{ code: "no_proposals", action, total: 0 }`; nothing to ask, nothing settled.
3. **One pending, with elicitation.** No mode question: one `elicitation/create` popup — 批准 / 拒绝 / 取消 — then the call continues.
4. **Two or more pending, with elicitation.** One popup — 全部批准（N 条）/ 逐条审批 / 取消 — then the call continues. The `scope` you pass does not decide anything; the click does.

Never pick the mode yourself: no default `all`, no batch on a vague "ok".

```json
// no elicitation capability (any pending count)
{ "code": "approval_requires_ui", "tool": "decide_proposals", "reason": "no_elicitation",
  "total": 5, "deleteCount": 1,
  "message": "请在浏览器打开上面的链接确认；未确认前未执行。",
  "approvalUrl": "http://<host>/a/<token>", "pinRequired": false, "expiresIn": 600,
  "ui": { "panel": "proposals" } }
// nothing pending
{ "code": "no_proposals", "action": "approve", "total": 0 }
// result (after the user clicked in the popup)
{ "action": "approve", "mode": "all", "total": 5, "ok": 4, "failed": 1,
  "results": [ { "id": "…", "ok": true }, { "id": "…", "ok": false, "code": "expired", "message": "已过期" } ] }
```

- `all` settles at most 100 proposals in one call and keeps going when one fails; report the summary in words, with the Chinese failure reasons.
- `single` is the same gate as `approve_proposal` / `reject_proposal`: one id, calendar re-checked before applying.
- Delete proposals in an `all` set must be announced by count before proceeding: permanent deletion in proposal mode, recoverable for N days in trash mode.
- Cancel, decline, timeout and a dropped popup all leave data unchanged and write an audit entry. A refused approval writes `proposal-agent-approval-blocked` (`reason: "no_elicitation"` / `"stream_unavailable"`) and no decision audit.
- Never choose the mode for the user; with exactly one pending never ask for a mode either. Without elicitation, the conversation cannot settle anything at all.

## wait_for_approval

Waits for the user's decision on already-issued approval links. Requires agent approval on the credential. Call it after handing the user an `approvalUrl`; do not loop or poll with it.

| arg | type | notes |
|---|---|---|
| `timeoutSeconds` | integer | optional, default `60`, range `5`–`120`; outside the range is a JSON-RPC `-32602` |
| `proposalIds` | string[] | optional; only these proposals wake the wait. Omit to accept any proposal of this credential |

```json
{ "decided": [ { "proposalId": "…", "action": "accept", "ok": true, "decidedAt": "2026-11-06T03:20:00.000Z" } ],
  "pending": [ "…" ], "timedOut": false }
```

- Resolves as soon as one matching decision arrives; a timeout returns `{ "decided": [], "pending": [ … ], "timedOut": true }` with the ids still pending.
- A receipt returned by `wait_for_approval` is marked delivered: it will not appear again in `receipts`.
- Waiting is off the request path — other tool calls and HTTP requests keep working. Never call it repeatedly in a tight loop; one wait per link is enough.

## Approval receipts and push notifications

Every settlement on the FnCal approval page produces a hidden receipt retained for 24 hours (dropped with a log entry when it expires undelivered). Three ways to receive it:

1. **Push (open SSE stream).** While the client holds a `GET /mcp` event stream for this credential, the server writes a JSON-RPC notification:

   ```json
   { "jsonrpc": "2.0", "method": "notifications/fncal/approval-decision",
     "params": { "proposalId": "…", "action": "accept", "ok": true,
                 "decidedAt": "2026-11-06T03:20:00.000Z", "credentialId": "…" } }
   ```

   `action` is `accept` or `reject`; `ok` is false when that row failed to apply. The notification contains no approval link, token or PIN. With no open stream nothing is pushed — the page decision still succeeds and the server writes `mcp-approval-push-failed` in its log.

2. **`wait_for_approval`** — blocks (bounded) until a matching decision, see above.

3. **`receipts` piggyback.** Any successful tool reply carries `receipts` when undelivered receipts exist, at most 20 per reply, fields `proposalId`, `action`, `ok`, `decidedAt`; they are marked delivered and the field is absent when there is nothing to deliver. Treat a receipt as a report of what already happened — never as a reason to re-approve or re-submit.

## Error classes

- Tool level (`isError: true`): not-found (hidden/absent), `read`-level write refusal, out-of-window write refusal, bad time range (`结束时间必须晚于开始时间。`), validation, conflict. Reads keep one identical not-found text for hidden/absent/out-of-window; **writes** separate the three causes so the human can act on the message.
- HTTP level (outside JSON-RPC): `401` bad/revoked/missing token, `404` MCP disabled or HTTPS required (also `code: "session_not_found"` for a missing or expired `Mcp-Session-Id`), `429` rate limited (+`Retry-After`), `413` body over 256 KB, `405` for methods other than `POST` / `GET` / `DELETE`.
- Proxy approval gate: `list_proposals` / `approve_proposal` / `reject_proposal` / `decide_proposals` answer `凭据未开启 AI 端代办批准，请到 FnCal 设置里打开，或在日历界面批准` (`isError`, code `agent_approval_disabled`) when the credential has the switch off. Even with the switch on, approval requires the FnCal popup click; without elicitation the tools answer `approval_requires_ui` and execute nothing.
- JSON-RPC errors: `-32700` bad JSON, `-32600` malformed request, `-32601` unknown method, `-32602` invalid params — including **calling a write tool the credential does not have**, which is indistinguishable from a typo on purpose.
