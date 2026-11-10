# impeccable 结论 —— 0.7.12「标签权限两行 + 日历与标签之间的分隔线」

状态：已完成（设计判断 + 真布局实测 + 检测器结果）；证据页 `code/web/build-tmp/tags-0712-shots/settings-0712.html`。

## 1. 技能调用

| 步骤 | 命令（workdir `projects/CalDAV/code`） | 结果 |
| --- | --- | --- |
| context | `impeccable.cmd context` | EXIT=0；报 `NO_PRODUCT_MD` / `PRODUCT_INIT_REQUIRED`（本仓无 PRODUCT.md，不阻塞） |
| detect | `impeccable.cmd detect --json code/web/src/js/ai-settings.js code/web/src/styles/calendar.css code/web/src/i18n/zh-CN.js`（workdir `projects/CalDAV`） | `[]`、EXIT=0 |

首次用错相对路径（在 `code/` 下写 `code/web/...`）得到 3 条 `cannot access` 与 EXIT=1；改用正确路径后为 `[]`、EXIT=0。此条只作过程记录。

## 2. 设计判断

1. **位置**：标签块留在「操作方式」之后、「对话内代办批准」之前 —— 与 0.7.11 一致，用户只要求与日历权限并排对齐，不要求换位置。
2. **分组语义**：日历是「新建、修改」+「删除」，标签也应是「新建与编辑」+「删除」；这是用户「新建和编辑还是在一起和日历权限一致」的直接落点。两行各自独立、默认提案。
3. **控件复用**：沿用 `segmentedRadioGroup`（`role=radiogroup` + `role=radio`、roving tabindex）与 `.settings__row.ai-mode-row`，选项顺序与日历两组一致（直接通过 → 提案），不新造组件。
4. **分隔线**：只画 1px、颜色用既有 `--border`、`aria-hidden="true"`；不写 margin，上下 24px 由 `.ai-editor__body` 既有 flex `gap: var(--sp-6)` 提供：
   - 若另加 20–24px margin，会与 gap 叠加成 ~48px，把两个块推得过远；
   - 元素高度 0 + `border-top`，不参与 flex 尺寸分配以外的布局，不改变块间距语义。
5. **配色**：浅色 `rgb(226,229,235)`、深色 `rgb(42,46,58)`，与卡片底对比 1.17 / 1.25。分隔线是装饰性元素，取「看得见一条、但不与标题争视线」的强度；提高到 3:1 会变成一条高对比线，违背「加个分隔符」的轻量意图。
6. **不用伪元素**：分隔线是真实 `div` 节点，便于测试断言 DOM 顺序与无障碍（`aria-hidden`），也避免与 `.ai-block` 的边框/伪元素冲突。

## 3. 真布局实测

证据页挂真实 `createAiSettingsPage`（非复制 DOM），stub `fetch`，点「编辑」打开已有凭据；数字由页面自报（`getBoundingClientRect` / `getComputedStyle`）。

| 视口 / 主题 | 行布局 | 行宽（行/单选组） | 标题↔组垂直距 | 重叠 | 分段溢出 | 分隔线 | 上下间距 | 横向溢出 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 390 浅色 | 两行 stacked | 360.00 / 360.00 | 12.00 | 否 | 0.00 | 1px `rgb(226,229,235)`，对比 1.17 | 24.00 / 24.00 | 0.00 |
| 320 浅色 | 两行 stacked | 290.00 / 290.00 | 12.00 | 否 | 0.00 | 同 390 | 24.00 / 24.00 | 0.00 |
| 390 深色 | 两行 stacked | 360.00 / 360.00 | 12.00 | 否 | 0.00 | 1px `rgb(42,46,58)`，对比 1.25 | 24.00 / 24.00 | 0.00 |

块顺序实测：`名称 / 日历授权 / 可读时间窗 / 字段开关 / 操作方式 / 标签权限 / 对话内代办批准 / 令牌 / 删除凭据`；`prevIsOperation=true`、`nextIsTags=true`（分隔线的直接前驱/后继）。
320 档「删除」行高 105.88 vs「新建与编辑」86.69，差异来自说明文案换行；两行单选组右缘都等于行右缘，未越界。

## 4. 视觉与工具核查

- `look_design`（390 深色，元素截图 `.ai-editor__body`）：操作方式块 → 分隔线 → 「标签权限」标题与两行，层次清楚；分隔线可见、弱于标题。
- `check_design`（390 浅色 / 320 浅色 / 390 深色）：新增两行与分隔线无截断、无重叠、无超出屏幕。既有 5 条与本版无关：两处 13×13 勾选框、`pre.ai-mcp-json code` 11px、两处「不限制」11px。
- `impeccable detect`：`[]`。

## 5. 偏差

1. 删除行标题「删除」（派单口径），不是「删除标签」；说明文案仍讲清会清掉所有引用。
2. 分隔线上下 24px 走既有 flex gap，不额外写 margin（避免叠加成 48px）。
3. 390/320 为堆叠布局（日历两组同款，既有窄屏行为），不是左右并排；已验不挤不叠。
4. 分隔线对比 1.17 / 1.25，按「不抢眼」取装饰强度。

## 6. 未验证

1. 真机强光/低亮度屏下分隔线的可见度。
2. 系统深色（`prefers-color-scheme`，无 `data-theme`）路径未单独截图；共用同一组变量。
3. 320 以下不在支持范围，未验。
