# 已批准图标集（logo v6，2026-10-24 00:06 负责人核过 sha）

本目录是 **0.2.4 最终采用的 logo v6** 的逐字节副本，来源 = 负责人 2026-10-24 00:06
给出的 sha256 清单（`design/logo-fn/` 当时那套）：

```
icon-64.png            85BE67EDA43A
icon-256.png           788669869241
icon-192.png           B64B6AD2DEDB
icon-512.png           190C46C71C3F
icon-192-maskable.png  1D5C1A1C4FCF
icon-512-maskable.png  5BB12257FB3F
favicon-16x16.png      05270E387E06
favicon-32x32.png      0E651BFA0C23
favicon-48x48.png      9C10A0848EC0
favicon.ico            024E060C1BC3
apple-touch-icon.png   8A1787D977C9
```

（`icon-128.png` / `source-1024.png` 不进包，未收录。）

## 为什么冻结而不是直接对 `design/logo-fn/`

收到 v6 清单后，`design/logo-fn/` 又在 00:12 被改动（icon-64/256、favicon 等 sha
全部变化），与清单不再一致。为避免把未复核的新图带进最终 0.2.4，构建核对目标
冻结为本目录；`check-icons.mjs` 的 0.2.3 旧图反向基线仍是
`scripts/icon-baseline-0.2.3/`（全部尺寸含 16/32 都必须不同，无例外）。

**0.2.5 起本目录的角色**：v7 定稿后，本目录（v6）成为 `check-icons.mjs` 的**旧图反向基线**——包内每个图标都必须与 v6 不同 sha（无例外，含 favicon 16/32 与 `favicon.ico` 三层）。0.2.4 包已冻结不再重打。

**后续要换图**：负责人给新 sha 清单 → 新建 `icon-approved-vN/` → 把上一版设为旧图基线 → 重打新版本。
