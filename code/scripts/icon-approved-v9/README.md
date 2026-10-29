# 已批准图标集（logo v9 = v8 + 256 大图标轻微锐化，2026-10-27 负责人核过 sha，用于 0.2.34）

本目录是 **0.2.34 起采用的图标集**。与 `icon-approved-v8/` 的关系只有一处：

- **`icon-256.png` 换成轻微锐化版**（形状、剪影、配色、渐变全不变；alpha 通道逐字节相同）；
- 其余文件（64 / 128 / 192 / 512 / maskable / favicon 16-32-48 / favicon.ico / apple-touch-icon /
  source-1024）**逐字节复制自 v8，未做任何改动**。

## 为什么要这一版

飞牛应用中心详情页把 `ICON_256.PNG`（256×256，规范只收 64 与 256）放大到约 245 CSS px，
用户在 2x 屏上看到的是 ~490 设备像素，等于把 256 放大约 1.9 倍，所以观感偏软。
用户 2026-10-27 拍板「只做轻微锐化」——不改 logo 造型、只提升边缘清晰度。

生成脚本就是本目录的 `sharpen-icon-256.py`（读 `../icon-approved-v8/icon-256.png`，
在 premultiplied RGB 上 unsharp radius=1.0 percent=160，再把结果钳制到原图 3×3 邻域极值内）。
钳制的意义：**零过冲**，不会在深蓝页头/白页的交界上产生亮暗光晕。

实测（仅不透明区）：
- 边缘能量（平均 |Laplacian|）0.02246 → 0.02583（**+15.0%**）；
- 相对 v8 的 RMSE = 6.2/255；过冲像素（>1/255）**0 个**，最坏过冲 **0.00/255**；
- **alpha 通道逐字节相同** → 剪影零变化；尺寸仍 256×256、色彩类型仍 RGBA、18,258 B。

```
source-1024.png        D5DBB99664DC
icon-512.png           B456C6DB2601
icon-256.png           B0F693006D55   ← 本版唯一变化（v8 为 6D2105AC01E8）
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

- **旧图反向基线仍是 v6 ∪ v7**（`check-icons.mjs` 运行时读取 `scripts/icon-approved-v6/`、
  `scripts/icon-approved-v7/`）。v8 不加入旧图基线——v9 与 v8 是**同一套 logo**，
  只是 256 更锐；把 v8 当「旧图」会让 64/192/512 这些**故意未改**的文件全部误报。
- 取而代之的是 `check-icons.mjs` 里新增的**精确前置断言**（比 sha 全等更严格）：
  1. `icon-256.png` 与 v8 **sha 必须不同**（证明锐化真的进了包）；
  2. `icon-256.png` 与 v8 的 **alpha 通道逐字节相同**（证明剪影/形状零变化）；
  3. 与 v8 的逐像素最大通道差 ≤ 90/255、变化像素占比 ≤ 60%（证明是「轻微锐化」而非重画）；
  4. 其余 11 个文件与 v8 **逐字节相同**（证明只动了 256 这一处）。
- favicon / apple-touch 与 `icon-64` 的同色系（同源母版）色板断言保留，未受影响。

## 后续

v8 仍然冻结（造型不动）。**若以后要换造型**：新建 `icon-approved-vN/` + 把 v9 加入旧图基线集合
（那时 64/192/512 也会变，加基线才成立）。只做「同造型的渲染/锐化微调」时，沿用 v9 的做法：
新建目录、留 `sharpen-icon-256.py` 式的生成脚本、在 `check-icons.mjs` 写精确前置断言。
