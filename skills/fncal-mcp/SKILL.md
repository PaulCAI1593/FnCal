---
name: fncal-mcp
description: "Use when the user wants to read or change their FnCal calendar through the FnCal MCP server: what is on today/this week, look for a free slot, create or move an event, or confirm a pending AI proposal. Covers FnCal's permission model — invisible calendars behave as if they do not exist, reads are limited to the credential's time window, and writes follow two per-credential switches: create/update (proposal or direct) and delete (proposal, or trash where a deleted event is recoverable for a retention period). When the credential allows agent approval you can also approve or reject your own pending proposals. It can also settle pending proposals, but only after the user picks all-at-once or one-by-one. Do not use for CalDAV client setup, for other calendar services, or for anything outside scheduling."
version: 0.4.19
user-invocable: true
license: MIT
---

# FnCal MCP

FnCal is the user's own calendar (self-hosted on their NAS, local-first, no cloud). This skill teaches you to use its MCP endpoint correctly. The hard part is not the tools — it is the permission model. Read §2 before your first tool call.

## 0 Stay current — upgrade the skill from the repo

This file ships with FnCal but lives in the repository, so it can be updated on its own. When the user asks to upgrade the skill (「升级技能包」「立即更新技能」「拉最新 skill」), or when a tool behaves differently from this document, fetch the current copy and use it:

1. `https://gh-proxy.com/https://raw.githubusercontent.com/PaulCAI1593/FnCal/main/skills/fncal-mcp/SKILL.md`
2. `https://cdn.jsdelivr.net/gh/PaulCAI1593/FnCal@main/skills/fncal-mcp/SKILL.md`
3. `https://raw.githubusercontent.com/PaulCAI1593/FnCal/main/skills/fncal-mcp/SKILL.md` (last resort; unreachable from some networks)

Compare the fetched frontmatter `version` with the local one; use the higher version for the rest of the conversation, and tell the user which address answered and which version you got. Fetch the sibling files the same way when needed: `reference/tools.md`, `reference/setup.md`, `reference/examples.md`. If all three addresses fail, say plainly that the latest skill could not be fetched and carry on with the local copy — never block the conversation.

A skill upgrade changes only these instructions. It does not touch the FnCal server, does not need a restart, and does not require FnCal itself to be updated — and updating FnCal does not require a skill upgrade. Never present a skill upgrade as an app upgrade.

## 1 Connect

The endpoint is the user's FnCal instance, path `/mcp`:

```
https://<host>:<https-port>/mcp
```

It is an MCP server over HTTP with a lightweight session layer:
- `POST /mcp`, JSON-RPC 2.0. Plain requests answer `Content-Type: application/json`; a `tools/call` that needs a confirmation popup answers `text/event-stream` instead.
- `initialize` returns `Mcp-Session-Id`; send it back on later requests. Sessions live in memory: 30-minute idle TTL, at most 500 at a time. A missing or expired session gets HTTP `404` with `code: "session_not_found"` — run `initialize` again.
- Every request still authenticates on its own, so a revoked token fails on the very next call.
- `GET /mcp` opens the SSE channel used for popups (15 s heartbeat); `DELETE /mcp` closes the session.
- Handshake is the normal one: `initialize` → `notifications/initialized` → `tools/list` → `tools/call`. Clients that never send a session header keep working — they just get text confirmations instead of popups.

Auth is a bearer token the user creates in FnCal under **设置 → AI**, shown once:

```
Authorization: Bearer fncal_ai_<32 chars>
```

The scheme word `Bearer` and the space after it are required **when the token goes into a raw HTTP header**. A bare token in a header is rejected with HTTP `401` and the body text "需要 AI 凭据（Bearer）". If you see that 401, fix the header before touching the token.

Where the token goes depends on the client, and this trips people up:

- **Client with its own "Bearer Token" / token input field** (graphical clients, editor plugins, most app-style connectors): put **only the token** `fncal_ai_…` in that field — no `Bearer ` prefix and no address. The client adds the prefix itself. Pasting `Bearer …` or the URL there makes the client's own validation fail with "凭据格式不正确，请检查输入" before any request reaches FnCal.
- **Client where you write the header yourself** (JSON `headers`, `curl -H`, `--header`): the value must be `Bearer ` + space + token.

The token is exactly `fncal_ai_` plus 32 characters: no spaces, no address inside it.

Installing the endpoint (config snippets for Claude Desktop, generic JSON, and env-var based agents, plus the token-field rules above) is in [reference/setup.md](reference/setup.md).

## 2 The permission model — read this first

Each AI credential has, per calendar, one of three levels, plus a time window and a field mask. The server enforces all of it; you cannot talk your way around it.

**Levels**
- `write` — read and change events in that calendar.
- `read` — read only. The write tools are still listed if the credential can write somewhere, so a write aimed at a `read` calendar is refused with its own message: `该日历只有「只读」权限：请在 FnCal 的 AI 凭据里把这个日历改成「读写」后再试。` Report that sentence as-is; do not call it "not found".
- `hidden` — **the calendar does not exist for this credential.** It is absent from `list_calendars`, absent from event lists, and asking for one of its events returns the same "not found" answer as a genuinely unknown uid. Do not treat that as an error to work around, and do not ask the user "is there a calendar I can't see?" — the correct behaviour is that it is not there.
- A credential with `write` on nothing **does not have the write tools at all**: `tools/list` simply will not contain `create_event`, `update_event`, `delete_event`. If you cannot find them, the credential is read-only; do not retry, do not guess other names.

**Time window** (default: past 7 days, future 90 days)
- Events outside the window are also "not found" — same answer as hidden. An old event you know exists may simply be out of the window.
- Writes are restricted to the window too, and say so instead of hiding it: an out-of-window write returns `这个时间在你的凭据时间窗外：请在 FnCal 里放宽这个凭据的时间窗，或换一个窗口内的时间。` Do not retry the same time; widen the window (the user) or pick a time inside it.

**Field mask** (default: `location` visible, `description` and `attendees` withheld)
- Withheld fields are **absent keys**, not empty strings. Absence means "not granted", not "the event has no description". Never report to the user that an event has no description when the field is simply missing.

**Writes — two independent switches, both per credential**
- `writeMode` governs create and update. `proposal` (default) records a pending proposal and returns `applied: false`; the human accepts or rejects it in FnCal. `direct` applies immediately. When a write is still a proposal, say so plainly: "已提交待确认的改动，请在 FnCal 里确认".
- `deleteMode` governs delete only, and is separate from `writeMode`. `proposal` (default) records a pending delete proposal. `trash` deletes **immediately**: the event disappears from the calendar and goes to FnCal's trash for the retention period (default 7 days), where the user can restore it. The result is `{ "applied": true, "deleted": true, "calendarId": … }`.
- **You cannot restore or empty the trash.** Only the user can, in FnCal. In trash mode do not say "deletion is irreversible" — say the event was moved to FnCal's trash and can be restored there until the retention period ends.
- Proposals expire 24 hours after creation; accepting one can fail with an ETag conflict if the event changed in the meantime (another device, CalDAV client, or the web UI).
- **In-conversation proxy approval** (`agentApproval`, off by default per credential): when the user turns it on, you may list your own pending proposals with `list_proposals` and settle them with `approve_proposal` / `reject_proposal` — but only inside the conversation, as the user's proxy. **Always show the proposal summary (title, time, action, effect) and ask the user to approve or reject first; wait for an explicit yes. Never self-approve, never decide on your own, and never batch silently — one proposal per request.** When the switch is off, those calls fail with `凭据未开启 AI 端代办批准，请到 FnCal 设置里打开，或在日历界面批准` — report that sentence and leave the decision to the human.
  **Every `approve_proposal` / `reject_proposal` call must carry `confirmed: true`.** Without it the server answers `confirmation_required` together with a server-built `summary`: show that summary to the user (do not rewrite it), ask once, and only retry with `confirmed: true` after an explicit yes. If the client declares MCP elicitation, FnCal sends `elicitation/create` during the call and the user clicks approve / reject / cancel there — do not ask twice in text, just report the outcome. Decline, cancel and timeout never change calendar data.

**Rate limit** 60 requests/minute per credential, shared with the plain REST API. Over the limit: HTTP `429` with `Retry-After` seconds. Back off by that many seconds; do not hammer.

**Service disabled** — if the admin has the MCP switch off, the whole endpoint answers HTTP `404`. That is not a bug in your config: the feature is off.

## 3 Tools

| Tool | Kind | Required args |
|---|---|---|
| `list_calendars` | read | — |
| `list_events` | read | — (`calendar`, `from`, `to` optional) |
| `get_event` | read | `uid` |
| `find_free_slots` | read | — (`from`, `to`, `minMinutes` optional) |
| `create_event` | write | `calendarId`, plus `title`+start/end or a full `ics` |
| `update_event` | write | `uid` (`ifMatch` optional, for ETag safety) |
| `delete_event` | write | `uid` (proposal or trash — see §2) |
| `list_proposals` | read (needs agent approval) | — |
| `approve_proposal` | decide (needs agent approval + `confirmed: true`) | `id`, `confirmed` |
| `reject_proposal` | decide (needs agent approval) | `id` (`reason` optional) |
| `decide_proposals` | decide (needs agent approval + a mode the user picked) | `action` (`approve`/`reject`), then `scope` (`all`/`single`) + `confirmed: true` (`ids` for single) |

### Ask the mode before settling anything

`decide_proposals` is two-step by design. First call it with no `scope`:

- A client that supports elicitation gets a **popup from FnCal**: 全部批准（N 条）/ 逐条审批 / 取消. The choice comes back in the same call — do not ask again.
- A client without elicitation gets `isError: true`, `code: "mode_required"`, plus `pending` and `deleteCount`. Ask the user in words which they want, then call again with `scope` and `confirmed: true`.

`single` takes exactly one id. `all` settles up to 100 and returns one result per proposal — report the summary, not the raw JSON. When the pending set contains deletes, state the count and that deletion cannot be undone (trash mode: recoverable for N days) before you proceed.

Exact argument and result shapes: [reference/tools.md](reference/tools.md).

Result shape is uniformly `{ content: [{ type: "text", text: "<JSON>" }] }`; a tool-level failure sets `isError: true` with the same text form. Parse the JSON out of `text` before using it. Do not echo raw tool JSON to the user — speak in dates and titles.

## 4 How to work

1. **Orient before writing.** `list_calendars` first (cheap) so you use a real `calendarId` and know which calendars are `write`; guessing ids produces not-found.
2. **Resolve relative dates yourself** against the current date and the user's time zone; the API takes absolute ISO times. Never ask the user for an ISO string.
3. **Check for conflicts** with `find_free_slots` before proposing a meeting, and mention what you avoided ("10:00 你有会，我放在 11:00").
4. **Create with a clear title** (what/who, not "会议"), put the useful context in `description` only if the credential may read/write it — if the field is masked, do not claim you wrote it.
5. **Report the truncated picture honestly.** If you cannot see a calendar or a field, say what you could see; do not invent the rest.
6. **Never claim a change is done when it is a proposal.** Read `applied` in the result.
7. **Never settle a queue on your own initiative.** `decide_proposals` starts by asking the mode; skipping that step is a failure, not a shortcut.

Worked examples (day plan, scheduling a meeting, moving an event, deleting with confirmation, weekly review): [reference/examples.md](reference/examples.md).

## 5 Failure text you will see

| Symptom | Meaning | Do |
|---|---|---|
| tool `isError`, "未找到该事件：它可能不存在、不在你的时间窗口内，或对你的凭据不可见。" | on a **read**: hidden from this credential, absent, or outside the window — deliberately indistinguishable | stop; do not enumerate alternatives |
| tool `isError`, "未找到该日历：它可能不存在，或对你的凭据不可见。" | on a **write**: the target calendar is hidden from this credential or does not exist | stop; ask which calendar they mean only once, from `list_calendars` |
| tool `isError`, "该日历只有「只读」权限：请在 FnCal 的 AI 凭据里把这个日历改成「读写」后再试。" | the calendar is readable but the credential's level is `read`, so the write cannot be accepted | report that sentence as-is; the user raises the level in 设置 → AI, then you retry |
| tool `isError`, "这个时间在你的凭据时间窗外：请在 FnCal 里放宽这个凭据的时间窗，或换一个窗口内的时间。" | the calendar is writable; the time is outside the credential's window | choose a time inside the window, or ask the user to widen it |
| tool `isError`, "结束时间必须晚于开始时间。" | `end` is not later than `start` (all-day events are exempt; zero-length events are allowed) | fix the times, then retry once |
| `409` / `reason: stale` on accept | the event changed since the proposal | re-read and re-propose |
| `202`/`applied:false` | proposal created, waiting for the human | say so, do not retry |
| tool `isError`, "删除失败：回收站写入失败，日程未删除" | trash mode, but writing the trash entry failed — the event was **not** deleted | tell the user nothing was deleted; retry later or ask them to use proposal mode |
| tool `isError`, "删除失败：回收站不可用，日程未删除" | trash storage unavailable on this instance — the event was **not** deleted | report; nothing changed |
| tool `isError`, `code: "mode_required"` | you called `decide_proposals` before the user picked a mode | show `prompt`, ask all-or-one-by-one in words, then retry with `scope` + `confirmed: true` |
| tool `isError`, "凭据未开启 AI 端批准，请到 FnCal 设置里打开，或在日历界面批准" | this credential may not settle proposals from your side | report as-is; the human approves in FnCal or turns the switch on in 设置 → AI |
| tool `isError`, "未找到该提案：它可能不存在、已被处理，或不属于你的凭据。" | approval tool: wrong id, already settled, or another credential's proposal | stop; re-list with `list_proposals` once at most |
| HTTP `401` | token wrong, revoked, or expired by rotation | ask the user for a new credential |
| HTTP `401` with "需要 AI 凭据（Bearer）" | the header value is the bare token; the `Bearer ` scheme is missing | send `Authorization: Bearer <token>`, do not change the token |
| HTTP `403` with body `browser_signature_banned` | a proxy in front (usually Cloudflare) blocked the client's default User-Agent, such as `python-urllib/3.x` | set a normal custom User-Agent in the client; retrying the same request changes nothing |
| HTTP `404` on everything | MCP switch is off on that instance | tell the user to enable it under 设置 → AI |
| HTTP `429` | rate limited | wait `Retry-After` seconds |

## 6 Boundaries

- Schedule only. Do not use FnCal as a note store or a contact database.
- Do not attempt to discover hidden calendars by probing ids, titles, or timing.
- This endpoint is inbound only: FnCal never calls out. The only outbound request you make on its behalf is fetching a newer copy of this skill from §0. Do not promise notifications, reminders sent by e-mail, or integrations it does not have.
- Never promise a trash restore: recovery happens only in the FnCal interface, by the user.
- The token is a secret. Never print it, log it, or put it in a file the user might share; if the user pastes it in chat, tell them to rotate it in 设置 → AI.
