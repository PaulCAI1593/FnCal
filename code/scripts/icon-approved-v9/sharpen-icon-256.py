# 0.2.34 / 图标 v9：在 v8 的 256 大图标上做「轻微锐化」（形状零变化）。
#
# 背景：飞牛应用中心详情页把 ICON_256.PNG（256×256）放大到约 245 CSS px，
# 用户在 2x 屏上看到的是 ~490 设备像素 —— 等于把 256 放大约 1.9 倍，必然偏软。
# fnOS 图标规范只收 ICON.PNG(64) 与 ICON_256.PNG(256)（≤1024 KB），无法直接给 512，
# 因此用户拍板走「只做轻微锐化」。本脚本即 v9 的唯一差异来源。
#
# 算法（刻意保守，保证「形状不变 + 无光晕」）：
#   1. 在 **premultiplied RGB** 上做 unsharp mask（radius=1.0, percent=160）——
#      先乘 alpha 再锐化，避免透明/半透明边缘被锐化出暗边。
#   2. 把结果钳制到「原图 3×3 邻域 RGB 极值」区间内 —— **零过冲**：
#      不产生亮/暗光晕（实测 ring_px=0, worst=0.00/255），只把被上采样放大的柔边变陡。
#   3. 完全透明的像素保持原样。
#   4. **alpha 通道逐字节不变**（不重采样、不重画，剪影与 v8 完全一致）。
#
# 实测：边缘能量（平均 |Laplacian|，仅不透明区）0.02246 → 0.02583（+15.0%）；
#       相对 v8 的 RMSE（不透明区）= 6.2/255；ring_px(>1/255)=0。
# 用法（cwd 任意）：
#   python code/scripts/icon-approved-v9/sharpen-icon-256.py
import numpy as np
from PIL import Image, ImageFilter
import pathlib

HERE = pathlib.Path(__file__).resolve().parent
SRC = HERE.parent / "icon-approved-v8" / "icon-256.png"   # 输入永远是冻结的 v8
OUT = HERE / "icon-256.png"

RADIUS = 1.0
PERCENT = 160


def local_bounds(a):
    """原图 3×3 邻域（不含中心）的最小/最大值，边界复制。"""
    h, w = a.shape
    pad = np.pad(a, 1, mode="edge")
    mn = np.full_like(a, np.inf)
    mx = np.full_like(a, -np.inf)
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            if dy == 0 and dx == 0:
                continue
            sl = pad[1 + dy:1 + dy + h, 1 + dx:1 + dx + w]
            mn = np.minimum(mn, sl)
            mx = np.maximum(mx, sl)
    return mn, mx


def main():
    src = Image.open(SRC).convert("RGBA")
    orig = np.asarray(src).astype(np.float32) / 255.0
    rgb, alpha = orig[..., :3], orig[..., 3:4]

    # 1. premultiplied 上做 unsharp
    prem = rgb * alpha
    pimg = Image.fromarray(np.clip(np.round(prem * 255), 0, 255).astype(np.uint8), "RGB")
    blur = pimg.filter(ImageFilter.GaussianBlur(RADIUS))
    p = np.asarray(pimg).astype(np.float32) / 255.0
    b = np.asarray(blur).astype(np.float32) / 255.0
    out_prem = np.clip(p + (p - b) * (PERCENT / 100.0), 0.0, 1.0)
    cand = np.clip(out_prem / np.clip(alpha, 1e-6, 1.0), 0.0, 1.0)

    # 2. 钳制到原图邻域极值（零过冲 / 无光晕）
    clamped = cand.copy()
    for c in range(3):
        mn, mx = local_bounds(rgb[..., c])
        clamped[..., c] = np.clip(cand[..., c], mn, mx)

    # 3. 全透明像素保持原样
    clamped = np.where(alpha > 0.002, clamped, rgb)

    res = np.concatenate([clamped, alpha], axis=-1)
    out = Image.fromarray(np.clip(np.round(res * 255), 0, 255).astype(np.uint8), "RGBA")
    out.save(OUT, "PNG", optimize=True)

    same_alpha = np.array_equal(np.asarray(out)[..., 3], np.asarray(src)[..., 3])
    print(f"[ok] {OUT} {OUT.stat().st_size} B (v8: {SRC.stat().st_size} B) alpha_identical={same_alpha}")
    if not same_alpha:
        raise SystemExit("[fail] alpha 通道被改动，剪影必须与 v8 完全一致")


if __name__ == "__main__":
    main()
