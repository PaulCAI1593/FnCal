# 中文化 TODO（M3.7 交付时点）

本轮（M3.7）只完成**外壳**字典化，术语与文案规范见
项目内部的《中文术语表与文案规范》（未随源码发布）。以下清单如实记录尚未
迁移的位点，供 M3.6 中文化排期直接使用；不要在 M3.7 报告里当作已完成。

## 已接入 i18n（`t()`）

| 区域 | 文件 | 说明 |
|---|---|---|
| 登录 / 加载 / 启动错误 | `src/main.js` | 用户名、密码、登录、错误、会话过期、离线提示 |
| 主界面工具栏 | `src/js/app.js` | 今天/上一页/下一页/搜索/账号/视图切换、账号菜单（主题、周首日、24 小时制、第二时区、公共假日、夏令时、导入导出、登出） |
| 侧栏 | `src/js/sidebar.js` | 导航、新建、上下月、分类、重命名、折叠提示 |
| 视图标题与空态 | `src/js/app.js`、`src/js/views/agenda.js`、`src/js/search.js` | 视图名（年/月/周/四天/日/日程）、日程视图空态（含分类筛选说明）、搜索占位与空态 |
| 错误提示 | `src/js/api-client.js` | 401/403/404/405/409/412/413/423/429/5xx、网络错误、冲突 |
| 事件编辑器（部分） | `src/js/modal.js` | 标题、全天、开始/结束、重复、提醒、地点、参与者、描述、颜色、保存/取消/删除、详情卡标题 |
| 分类重命名 | `src/js/category-dialog.js` | 标题、占位、提示、按钮 |
| 分类颜色名 | `src/js/colors.js` | 蓝色/靛蓝/紫色/粉色/红色/橙色/绿色/青色/石墨 |
| 离线 | `src/js/offline.js` | 横幅、离线页、写保护提示 |

## 未迁移（M3.6）

1. **日期/时间显示仍是英文**：`src/js/date-utils.js` 的 `formatMonthYear`、
   `formatWeekRange`、`formatDayTitle`、`WEEKDAYS_NARROW` 等仍按 `en-US`
   输出（`October 2026`、`Mon`）。术语表要求 `YYYY年M月D日`、`周一`、24 小时制、
   周一为周首日。这是界面最显眼的残留，必须在 M3.6 统一改 `Intl.DateTimeFormat('zh-CN')`，
   并同步更新 `tests/date-utils.test.js` 的期望值。
2. **默认设置与中文习惯不一致**：`store.js` 的 `DEFAULT_SETTINGS.weekStartsOn = 0`
   （周日）、`hour12 = true`。本轮按「商店一行不改」约束未动，M3.6 改默认值并
   迁移已存设置。
3. **公共假日**：`src/js/holidays.js` 只有 10 国规则、国家名为英文、中国大陆
   法定节假日/调休数据缺失；详情卡里的国家名、`dst.js` 的时区城市名同样未中文化。
4. **事件编辑器长尾**：`reminders.js`（提醒预设 `10 minutes before`）、
   `recurrence.js` / `recurrence-dialog.js`（重复规则描述与自定义弹窗）、
   `time-field.js`（时长标签 `1 hour 30 minutes`）、`data-io.js`（导入导出
   对话框与进度/错误）、`file-drop.js`、`toast.js` 的成功/失败文案、
   `views/*` 内的事件 chip aria-label。
5. **上下文菜单**：`app.js` 里的「New event / New all-day event / New task /
   New out of office / Edit / Duplicate / Delete / Restore」仍是英文。
6. **英文残留扫描脚本**：M3.6 需补 `scripts/audit-i18n.mjs`（术语表 §7 的扫描口径），
   本轮未交付。
7. **节假日/城市名**：`holidays.js` 的 `countryName()` 与 `date-utils.js` 的
   `tzPickerGroups()` 城市名英文；属数据而非词条，M3.6 决定是否维护中文映射表。

## 约定

- 不要在 JS 里直接写界面中文；一律进 `src/i18n/zh-CN.js`，键名
  `模块.对象.动作`。
- 新增文案遵守术语表 §2：短句、不用感叹号、动词开头、人称用「你」、错误提示
  三段式（发生了什么。为什么。怎么办。）。
- 迁移完一块，删掉本文件对应条目，并在 M3.6 报告中记录覆盖数量。
