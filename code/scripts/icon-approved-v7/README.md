# 已批准图标集（logo v7，2026-10-24 负责人核过 sha，用于 0.2.5）

本目录是 **0.2.5 采用的 logo v7** 的逐字节副本，来源 = 负责人给出的 v7 sha256 清单
（`design/logo-fn/` 当时那套，`bad=0`）。用户要求：`Cal` 字标再大、再宽；背景为
蓝绿渐变 + 深蓝页头带 + 白页 + 阴影。

```
source-1024.png        DC6F8A3B09BF
icon-512.png           6AB141F601F3
icon-256.png           EE7B93A29400
icon-192.png           05CD99E92A74
icon-128.png           F1F59E461369
icon-64.png            6F7665E5A0E6
icon-192-maskable.png  9C84F0D4C073
icon-512-maskable.png  F9564C02C116
favicon-48x48.png      5009E5B4A0FF
favicon-32x32.png      E255E0C81998
favicon-16x16.png      A7345CAFA223
favicon.ico            60BD1E3FC2BF   (16/32/48 三层)
apple-touch-icon.png   C79C4CE7281C
```

进包的 11 个：icon-64、icon-256、icon-192、icon-512、icon-192-maskable、
icon-512-maskable、favicon-16/32/48、favicon.ico、apple-touch-icon（`icon-128`
与 `source-1024` 仅留档，不进包）。

## 与上一版（v6）的关系

- **旧图反向基线换成 v6**：`scripts/icon-approved-v6/`（0.2.4 用的那套）。
  `check-icons.mjs` 断言包内每个图标都与 v6 **不同 sha**，**无例外**——
  含 favicon-16/32 与 `favicon.ico` 三层。
- 0.2.3 那套（`scripts/icon-baseline-0.2.3/`）仅作历史留档，不再作主基线。
- favicon / apple-touch 与 `icon-64` 的**同色系（同源母版）色板断言保留**。

**0.2.6 起本目录的角色**：logo 改为 **v11**（`Cal` 底部对齐）后，本目录（v7）成为
`check-icons.mjs` 的**旧图反向基线**——包内每个图标都必须与 v6、v7 都不同 sha
（无例外，含 favicon-16/32 与 `favicon.ico` 三层）。注意：**0.2.5（v7）是中间构建，未交付**，
最终图标版为 0.2.6。

**后续要换图**：需负责人重新给完整 sha 清单 → 新建 `icon-approved-vN/` →
把上一版设为旧图基线 → 重打新版本（0.2.7+）。
