#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""FnCal 安卓外壳 v0.1.0：从网页端 icon-512.png 生成安卓启动图标。

用法（仓库根目录）：
    C:\\Python314\\python.exe projects/CalDAV/android/tools/make_icons.py

生成：
  mipmap-{mdpi,hdpi,xhdpi,xxhdpi,xxxhdpi}/ic_launcher.png        48/72/96/144/192
  mipmap-{...}/ic_launcher_round.png                              同上，圆形裁切
  mipmap-{...}/ic_launcher_foreground.png                         108dp 自适应前景（图标 66%）
  mipmap-anydpi-v26/ic_launcher.xml / ic_launcher_round.xml       自适应图标描述
"""
from __future__ import annotations

import io
import os
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).resolve().parents[1]          # projects/CalDAV/android
SRC = ROOT.parent / "code" / "web" / "public" / "icon-512.png"
RES = ROOT / "app" / "src" / "main" / "res"

# density -> (ic_launcher px, foreground px = 108dp)
DENSITIES = {
    "mdpi": (48, 108),
    "hdpi": (72, 162),
    "xhdpi": (96, 216),
    "xxhdpi": (144, 324),
    "xxxhdpi": (192, 432),
}

ADAPTIVE_XML = """<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@drawable/ic_launcher_background" />
    <foreground android:drawable="@mipmap/ic_launcher_foreground" />
</adaptive-icon>
"""

# 0.4.1（总监 m02019）：自适应图标的底改成渐变 drawable，方向与 icon-512-maskable.png 一致
# （左上 #1E72D6 → 右下 #01B597；Android 的 angle=315 正是左上到右下）。
GRADIENT_A = (30, 114, 214)   # #1E72D6
GRADIENT_B = (1, 181, 151)    # #01B597
BACKGROUND_XML = """<?xml version="1.0" encoding="utf-8"?>
<shape xmlns:android="http://schemas.android.com/apk/res/android"
    android:shape="rectangle">
    <gradient
        android:angle="315"
        android:endColor="#01B597"
        android:startColor="#1E72D6"
        android:type="linear" />
</shape>
"""
FOREGROUND_RATIO = 0.66


def rounded(source: Image.Image, size: int) -> Image.Image:
    """圆形图标：保留中间圆，圆外透明。"""
    base = source.resize((size, size), Image.LANCZOS)
    mask = Image.new("L", (size, size), 0)
    draw = ImageDraw.Draw(mask)
    draw.ellipse((0, 0, size - 1, size - 1), fill=255)
    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    out.paste(base, (0, 0), mask)
    return out


def extract_mark(source: Image.Image) -> Image.Image:
    """从整张图标里抠出「标记本体」：白描边、两个挂环、浅色面板与六个格子。

    做法：整张图标 = 对角渐变底 + 标记 + 外阴影。标记比底亮、阴影比底暗，
    所以只取「比渐变底更亮」的像素，再 3×3 腐蚀-膨胀清掉圆角外的抗锯齿亮边。
    """
    width, height = source.size
    pixels = source.load()
    mark = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    out = mark.load()
    denominator = 2 * (width - 1)
    for y in range(height):
        for x in range(width):
            r, g, b, a = pixels[x, y]
            if a == 0:
                continue
            t = (x + y) / denominator
            bg = [GRADIENT_A[i] + (GRADIENT_B[i] - GRADIENT_A[i]) * t for i in range(3)]
            light = max(r - bg[0], g - bg[1], b - bg[2])
            coverage = max(0.0, min(1.0, (light - 6.0) / 28.0)) * (a / 255.0)
            if coverage <= 0.01:
                continue
            out[x, y] = (r, g, b, int(round(coverage * 255)))

    solid = mark.split()[3].point(lambda v: 255 if v > 40 else 0)
    solid = solid.filter(ImageFilter.MinFilter(3)).filter(ImageFilter.MaxFilter(3))
    mark.putalpha(Image.composite(mark.split()[3], Image.new("L", (width, height), 0), solid))
    box = mark.split()[3].point(lambda v: 255 if v > 8 else 0).getbbox()
    if box is None:
        raise RuntimeError("图标里找不到标记本体")
    return mark.crop(box)


def foreground(mark: Image.Image, canvas: int) -> Image.Image:
    """自适应前景：标记本体占画布 66%，居中，周边全透明。"""
    out = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
    inner = int(round(canvas * FOREGROUND_RATIO))
    width, height = mark.size
    scale = min(inner / width, inner / height)
    size = (max(1, int(round(width * scale))), max(1, int(round(height * scale))))
    icon = mark.resize(size, Image.LANCZOS)
    out.paste(icon, ((canvas - size[0]) // 2, (canvas - size[1]) // 2), icon)
    return out


def logo_mark(source: Image.Image, size: int = 144) -> Image.Image:
    """0.3.0 地址页 logo：同源图标，方形底板 22% 圆角。

    与启动图标用的是同一张 icon-512.png（不新画图形）。72dp 显示尺寸在 xxhdpi
    需要 216px，这里生成 144px 的 2x 规格（drawable-xxhdpi），再由系统按密度
    缩放；比直接引用带 108dp 画布留白的自适应前景更清晰，也不会显得小。
    """
    base = source.resize((size, size), Image.LANCZOS)
    mask = Image.new("L", (size, size), 0)
    draw = ImageDraw.Draw(mask)
    radius = int(round(size * 0.22))
    draw.rounded_rectangle((0, 0, size - 1, size - 1), radius=radius, fill=255)
    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    out.paste(base, (0, 0), mask)
    return out


def main() -> int:
    if not SRC.is_file():
        print("缺少源图:", SRC)
        return 1

    src = Image.open(SRC).convert("RGBA")
    print("源图:", SRC.name, src.size)
    mark_set = extract_mark(src)
    print("标记本体:", mark_set.size)

    for density, (launcher_px, fg_px) in DENSITIES.items():
        out_dir = RES / f"mipmap-{density}"
        out_dir.mkdir(parents=True, exist_ok=True)

        launcher = src.resize((launcher_px, launcher_px), Image.LANCZOS)
        launcher.save(out_dir / "ic_launcher.png", optimize=True)
        print(f"mipmap-{density}/ic_launcher.png {launcher.size}")

        round_icon = rounded(src, launcher_px)
        round_icon.save(out_dir / "ic_launcher_round.png", optimize=True)
        print(f"mipmap-{density}/ic_launcher_round.png {round_icon.size}")

        fg = foreground(mark_set, fg_px)
        fg.save(out_dir / "ic_launcher_foreground.png", optimize=True)
        print(f"mipmap-{density}/ic_launcher_foreground.png {fg.size}")

    drawable = RES / "drawable"
    drawable.mkdir(parents=True, exist_ok=True)
    io.open(drawable / "ic_launcher_background.xml", "w", encoding="utf-8", newline="\n").write(BACKGROUND_XML)
    print("drawable/ic_launcher_background.xml（#1E72D6 → #01B597，angle 315）")

    anydpi = RES / "mipmap-anydpi-v26"
    anydpi.mkdir(parents=True, exist_ok=True)
    io.open(anydpi / "ic_launcher.xml", "w", encoding="utf-8", newline="\n").write(ADAPTIVE_XML)
    io.open(anydpi / "ic_launcher_round.xml", "w", encoding="utf-8", newline="\n").write(ADAPTIVE_XML)
    print("mipmap-anydpi-v26/ic_launcher.xml, ic_launcher_round.xml")

    # 0.3.0（0.2.3 并入）：地址页标题上方的 72dp logo。
    drawable_xxhdpi = RES / "drawable-xxhdpi"
    drawable_xxhdpi.mkdir(parents=True, exist_ok=True)
    mark = logo_mark(src, 144)
    mark.save(drawable_xxhdpi / "logo_mark.png", optimize=True)
    print("drawable-xxhdpi/logo_mark.png", mark.size)
    return 0


if __name__ == "__main__":
    sys.exit(main())
