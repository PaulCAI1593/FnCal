# 已批准图标集（logo v9 = v8 + 256 大图标轻微锐化，2026-10-27 负责人核过 sha，用于 0.2.34）

本目录是 **0.2.34 起采用的图标集**，也是 **2026-11-03 起唯一保留的图标目录**（v6 / v7 / v8 与
0.2.3 留档目录已按用户口径删除）。历史关系只有一处：

- **`icon-256.png` 换成轻微锐化版**（形状、剪影、配色、渐变全不变；alpha 通道逐字节相同）；
- 其余文件（64 / 128 / 192 / 512 / maskable / favicon 16-32-48 / favicon.ico / apple-touch-icon /
  source-1024）**逐字节复制自 v8，未做任何改动**。

## 为什么要这一版

飞牛应用中心详情页把 `ICON_256.PNG`（256×256，规范只收 64 与 256）放大到约 245 CSS px，
用户在 2x 屏上看到的是 ~490 设备像素，等于把 256 放大约 1.9 倍，所以观感偏软。
用户 2026-10-27 拍板「只做轻微锐化」——不改 logo 造型、只提升边缘清晰度。

生成脚本就是本目录的 `sharpen-icon-256.py`（读 `../icon-approved-v8/icon-256.png`，
在 premultiplied RGB 上 unsharp radius=1.0 percent=160，再把结果钳制到原图 3×3 邻域极值内）。
**注意**：`../icon-approved-v8/` 已于 2026-11-03 删除，该脚本现在跑不了（输入图不在）。
脚本留作历史记录与复现方法说明；要重跑先从 tag `v0.4.0` 取出 v8 目录。
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

- 2026-11-03 起：旧图目录 `icon-approved-v6/`、`icon-approved-v7/`、`icon-approved-v8/`、
  `icon-baseline-0.2.3/` 全部删除，`scripts/` 下只留本目录（v9）。
- 随之移除：`check-icons.mjs` 的旧图反向断言（原先运行时读取 v6 ∪ v7 的 22 个 sha），
  以及「v9 相对 v8」的四条精确前置断言（v8 目录已不在）。
- **代价（已接受）**：以后若误把旧图放进包，`check-icons.mjs` 不会再拦截；判旧图只能用
  git 历史（tag `v0.4.0` 及更早）逐字节比对。保留的断言：与 v9 逐字节一致、尺寸与色彩类型、
  `favicon.ico` 16/32/48 三层、favicon / apple-touch 与 `icon-64` 同色系。
- favicon / apple-touch 与 `icon-64` 的同色系（同源母版）色板断言保留，未受影响。

## 后续

只保留 v9 这一套（造型冻结）。**若以后要换造型或做同造型微调**：新建 `icon-approved-vN/`，
把 `check-icons.mjs` 的 `DESIGN` 指向新目录，并把生成脚本与输入图一起放进新目录（输入图不要再
依赖被删的旧目录）。是否恢复「旧图反向断言」按那时的需要定；恢复时要把旧集合固化成常量或
重新冻结目录，不能依赖已删除的目录。
