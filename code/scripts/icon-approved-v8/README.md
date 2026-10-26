# 已批准图标集（logo v8，最终版，2026-10-24 项目核过 sha，用于 0.2.6）

本目录是 **0.2.6 采用的 logo v8** 的逐字节副本——**用户最终确认版**（`Cal` 入框、页头加宽、
挂环跨回带上沿）。项目用 `make_preview_v8.py` 同一套渲染生成正式全套，并与
`preview-v8-512.png` 做过像素比对：内部区域逐像素零差异，仅外圈 alpha 圆角为正式图标所需。

```
source-1024.png        D5DBB99664DC
icon-512.png           B456C6DB2601
icon-256.png           6D2105AC01E8
icon-192.png           703DECADA0C9
icon-128.png           4C5471FD25ED
icon-64.png            FEF8D739E6FC
icon-192-maskable.png  2CD4B40836B2
icon-512-maskable.png  09D72E07ABB8
favicon-48x48.png      F183B518F573
favicon-32x32.png      E3F676D798B1
favicon-16x16.png      1A3FA9107536
favicon.ico            0972783749C0   (16/32/48 三层)
apple-touch-icon.png   901E6F9D58E4
```

进包的 11 个：icon-64、icon-256、icon-192、icon-512、icon-192-maskable、icon-512-maskable、
favicon-16/32/48、favicon.ico、apple-touch-icon（`icon-128` 与 `source-1024` 仅留档，不进包）。

## 与旧图的关系

- **旧图反向基线 = v6 ∪ v7 合集**：`scripts/icon-approved-v6/`、`scripts/icon-approved-v7/`
  （`check-icons.mjs` 运行时读取两个目录，共 22 个 sha）。包内每个图标——
  **含 favicon-16/32 与 `favicon.ico` 三层**——都必须与两套都不同 sha，**无例外**。
- 0.2.3 那套（`scripts/icon-baseline-0.2.3/`）仅作历史留档。
- favicon / apple-touch 与 `icon-64` 的**同色系（同源母版）色板断言保留**。
- 注意：v8 的 `apple-touch-icon.png` 是**不透明 RGB**（colorType=2），`check-icons` 已支持该格式解码。

## 后续

用户已明确「v8 是对的」，0.2.6 出包后**冻结，不再换 logo**。
若以后仍要换图：项目给新 sha 清单 → 新建 `icon-approved-vN/` → 把 v8 加入旧图基线集合 → 重打新版本。

## 0.2.34 起：本目录降为「锐化前基线」（造型仍然冻结）

用户 2026-10-27 报「大图标有点糊」，并拍板**只做轻微锐化、不改造型**。落地方式见
`scripts/icon-approved-v9/`：

- `icon-approved-v9/icon-256.png` = 本目录 `icon-256.png` 的轻微锐化版（alpha 逐字节相同，
  逐像素最大通道差 80/255，变化像素 9.2%）；
- v9 其余 11 个文件逐字节复制自本目录，**本目录文件一个都没改**（原始 sha 清单仍见上表）；
- 本目录**不加入旧图反向基线**（v6/v7 才是造型旧图）；v9 与 v8 的关系由 `check-icons.mjs`
  的「v9 相对 v8」四条精确断言锁定。

若以后要**换造型**：新建 `icon-approved-v10/`，那时把 v9（或 v8）加入旧图基线集合。

