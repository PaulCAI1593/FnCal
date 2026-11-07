# impeccable 结论：安卓壳 0.3.6（两源：Gitee 镜像 + GitHub 直通）

日期：2026-11-08
范围：`UpdateChecker.kt`、`AboutActivity.kt`、`ShellPrefs.kt`、`strings.xml`、`activity_about.xml`
引擎：**未跑**（原生 Android 界面，impeccable 不适用）；本文件为静态结论 + 人工审查清单。

## 一、detect 结果

`impeccable.cmd detect --json` 对五个改动文件 → `[]`，`EXIT=0`。

## 二、人工审查（8 项）

1. **层级**：关于页信息从上到下 = 版本 → 服务器 → 桌面卡片 → 更新；删掉「更新源」单选后，更新区只剩「检查更新」按钮、进度条、状态与诊断行，按钮仍是该区唯一主操作。
2. **文案**：`update_note` 说清顺序（先 Gitee、再 GitHub）；来源行用「Gitee 镜像」/「GitHub 直通」，与诊断行标签一致。
3. **状态完整**：检查中（按钮禁用 + 「检查中」）、有新版本（弹窗）、已是最新（含最大候选版本号）、失败（首错原因）；下载中（进度 + 取消）、两次都失败（原因码）。
4. **无死控件**：`ShellPrefs` 的更新源 key、字符串、布局节点同批删除；`check_static` 用 17 个 token 反向检查残留。
5. **深浅色**：未新增颜色与自绘视图，全部用既有 `TextView` / `Button` / `ProgressBar` 与主题色；删控件后 `text_update_note` 上边距归 0，无空洞。
6. **无障碍**：删掉的两个 `RadioButton` 带标签；保留的「检查更新」「取消下载」仍有可读文本；动态诊断行是普通文本，读屏可读。
7. **错误可读**：`shortStatus()` 把异常压成「证书 / 超时 / DNS / HTTP 404 / 消息前 18 字」，诊断行一行内可读，不暴露堆栈。
8. **数字一致**：版本号、UA、workflow、两份清单四处一致，由 `check_static` 断言（`ok=515 fail=0`）。

## 三、未验证

1. 未编译、未真机，观感与间距只能由代码推演。
2. 诊断行在窄屏（320dp）是否换行未确认；当前文案 `更新源：Gitee 200 · GitHub 未试` 约 24 字符，按既有宽度预计单行。
3. 深浅色对比度未实测（沿用既有主题令牌，未新增颜色）。
