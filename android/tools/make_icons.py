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

import os
import sys
from pathlib import Path

from PIL import Image, ImageDraw

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
    <background android:drawable="@color/ic_launcher_background" />
    <foreground android:drawable="@mipmap/ic_launcher_foreground" />
</adaptive-icon>
"""


def rounded(source: Image.Image, size: int) -> Image.Image:
    """圆形图标：保留中间圆，圆外透明。"""
    base = source.resize((size, size), Image.LANCZOS)
    mask = Image.new("L", (size, size), 0)
    draw = ImageDraw.Draw(mask)
    draw.ellipse((0, 0, size - 1, size - 1), fill=255)
    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    out.paste(base, (0, 0), mask)
    return out


def foreground(source: Image.Image, canvas: int) -> Image.Image:
    """自适应前景：图标占画布 66%，居中，其余透明。"""
    out = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
    inner = int(round(canvas * 0.66))
    icon = source.resize((inner, inner), Image.LANCZOS)
    offset = (canvas - inner) // 2
    out.paste(icon, (offset, offset), icon)
    return out


def main() -> int:
    if not SRC.is_file():
        print("缺少源图:", SRC)
        return 1

    src = Image.open(SRC).convert("RGBA")
    print("源图:", SRC.name, src.size)

    for density, (launcher_px, fg_px) in DENSITIES.items():
        out_dir = RES / f"mipmap-{density}"
        out_dir.mkdir(parents=True, exist_ok=True)

        launcher = src.resize((launcher_px, launcher_px), Image.LANCZOS)
        launcher.save(out_dir / "ic_launcher.png", optimize=True)
        print(f"mipmap-{density}/ic_launcher.png {launcher.size}")

        round_icon = rounded(src, launcher_px)
        round_icon.save(out_dir / "ic_launcher_round.png", optimize=True)
        print(f"mipmap-{density}/ic_launcher_round.png {round_icon.size}")

        fg = foreground(src, fg_px)
        fg.save(out_dir / "ic_launcher_foreground.png", optimize=True)
        print(f"mipmap-{density}/ic_launcher_foreground.png {fg.size}")

    anydpi = RES / "mipmap-anydpi-v26"
    anydpi.mkdir(parents=True, exist_ok=True)
    (anydpi / "ic_launcher.xml").write_text(ADAPTIVE_XML, encoding="utf-8")
    (anydpi / "ic_launcher_round.xml").write_text(ADAPTIVE_XML, encoding="utf-8")
    print("mipmap-anydpi-v26/ic_launcher.xml, ic_launcher_round.xml")
    return 0


if __name__ == "__main__":
    sys.exit(main())
