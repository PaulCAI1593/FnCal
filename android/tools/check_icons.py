#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""0.4.3（总监）：安卓自适应图标自检 + 预览图。0.4.1 起建，0.4.2 加前景尺寸校验，0.4.3 改 48%。

检查：
  1. 五档 `ic_launcher_foreground.png` 四角 alpha = 0；
  2. 前景内容全部落在居中 66% 安全区内（含 1px 抗锯齿容差）；
  2b. 前景内容宽度 = 48% ±1%（0.4.3 定稿；54% 时用户仍觉偏大，48% 占 51.8dp）；
  3. `ic_launcher.png` / `logo_mark.png` 与 `code/web/public/icon-512.png` 同源（尺寸链一致）；
  4. `mipmap-anydpi-v26/ic_launcher*.xml` 用渐变 drawable 作底，`drawable/ic_launcher_background.xml` 是 #1E72D6 → #01B597。

用法（仓库根目录）：`C:\\Python314\\python.exe projects/FnCal/android/tools/check_icons.py`
产出预览：`projects/FnCal/design/app-icon/ic-adaptive-preview-0.4.3.png`
（左：圆形遮罩，中：方形圆角遮罩，右：66% 安全区 + 48% 内容框示意）
"""
from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
RES = ROOT / "app" / "src" / "main" / "res"
SRC = ROOT.parent / "code" / "web" / "public" / "icon-512.png"
PREVIEW = ROOT.parent / "design" / "app-icon" / "ic-adaptive-preview-0.4.3.png"

DENSITIES = {"mdpi": 108, "hdpi": 162, "xhdpi": 216, "xxhdpi": 324, "xxxhdpi": 432}
RATIO = 0.66        # 自适应图标安全区：108dp 画布的居中 72dp
LOGO_RATIO = 0.48   # 0.4.3：前景内容占画布比例（51.8dp）
A = (30, 114, 214)
B = (1, 181, 151)

failed: list[str] = []


def check(label: str, ok: bool, detail: str = "") -> None:
    if ok:
        print(f"PASS {label}")
        return
    failed.append(label)
    print(f"FAIL {label} {detail}")


def gradient(size: int) -> Image.Image:
    img = Image.new("RGBA", (size, size), (0, 0, 0, 255))
    px = img.load()
    for y in range(size):
        for x in range(size):
            t = (x + y) / (2 * (size - 1))
            px[x, y] = tuple(round(A[i] + (B[i] - A[i]) * t) for i in range(3)) + (255,)
    return img


def masked(icon: Image.Image, mask: Image.Image) -> Image.Image:
    out = Image.new("RGBA", icon.size, (0, 0, 0, 0))
    out.paste(icon, (0, 0), mask)
    return out


def main() -> int:
    if not SRC.is_file():
        print("缺少源图:", SRC)
        return 1
    src = Image.open(SRC).convert("RGBA")

    preview_icons = []
    for density, canvas in DENSITIES.items():
        path = RES / f"mipmap-{density}" / "ic_launcher_foreground.png"
        fg = Image.open(path).convert("RGBA")
        check(f"{density} 前景尺寸 {canvas}", fg.size == (canvas, canvas), str(fg.size))
        corners = [fg.getpixel((0, 0))[3], fg.getpixel((canvas - 1, 0))[3],
                   fg.getpixel((0, canvas - 1))[3], fg.getpixel((canvas - 1, canvas - 1))[3]]
        check(f"{density} 四角 alpha = 0", all(a == 0 for a in corners), str(corners))
        box = fg.split()[3].point(lambda v: 255 if v > 8 else 0).getbbox()
        inner = canvas * RATIO
        margin = (canvas - inner) / 2
        tol = 1.5
        inside = (box is not None
                  and box[0] >= margin - tol and box[1] >= margin - tol
                  and box[2] <= canvas - margin + tol and box[3] <= canvas - margin + tol)
        check(f"{density} 内容在 66% 安全区内", inside, f"bbox={box} 期望 {margin:.1f}..{canvas - margin:.1f}")
        if box is not None:
            got_ratio = (box[2] - box[0]) / canvas
            check(f"{density} 内容宽度 = 48% ±1%", abs(got_ratio - LOGO_RATIO) <= 0.01,
                  f"实测 {got_ratio:.3f}")
        if density == "xxxhdpi":
            preview_icons.append((canvas, fg))

    # 启动图标仍与网页 icon-512.png 同源：整图缩放到各档后与生成文件逐像素接近
    for density, launcher in (("xxxhdpi", 192), ("xxhdpi", 144)):
        path = RES / f"mipmap-{density}" / "ic_launcher.png"
        got = Image.open(path).convert("RGBA")
        want = src.resize((launcher, launcher), Image.LANCZOS)
        diff = 0
        gp, wp = got.load(), want.load()
        for y in range(launcher):
            for x in range(launcher):
                if sum(abs(gp[x, y][i] - wp[x, y][i]) for i in range(3)) > 12:
                    diff += 1
        check(f"{density} ic_launcher 与 icon-512 同源", diff == 0, f"差异像素 {diff}")

    # logo_mark 是「同源图标 + 22% 圆角」：只比中央区域，四角应当被裁掉。
    mark = Image.open(RES / "drawable-xxhdpi" / "logo_mark.png").convert("RGBA")
    want_mark = src.resize((144, 144), Image.LANCZOS)
    diff = 0
    mp, wp = mark.load(), want_mark.load()
    for y in range(144):
        for x in range(144):
            if 40 <= x <= 103 and 40 <= y <= 103:
                if sum(abs(mp[x, y][i] - wp[x, y][i]) for i in range(3)) > 12:
                    diff += 1
    corners = [mark.getpixel((0, 0))[3], mark.getpixel((143, 0))[3],
               mark.getpixel((0, 143))[3], mark.getpixel((143, 143))[3]]
    check("logo_mark 与 icon-512 同源（中央区域）", diff == 0, f"差异像素 {diff}")
    check("logo_mark 四角被圆角裁掉", all(a == 0 for a in corners), str(corners))

    bg_xml = (RES / "drawable" / "ic_launcher_background.xml").read_text(encoding="utf-8")
    check("背景 drawable 是渐变 #1E72D6 → #01B597", "#1E72D6" in bg_xml and "#01B597" in bg_xml
          and 'android:angle="315"' in bg_xml, bg_xml.replace("\n", " ")[:80])
    for name in ("ic_launcher.xml", "ic_launcher_round.xml"):
        text = (RES / "mipmap-anydpi-v26" / name).read_text(encoding="utf-8")
        check(f"{name} 底用 @drawable/ic_launcher_background", "@drawable/ic_launcher_background" in text, text[:60])

    # 预览：圆形遮罩 / 方形圆角遮罩 / 安全区示意
    if preview_icons:
        canvas, fg = preview_icons[0]
        base = gradient(canvas)
        base.alpha_composite(fg)
        circle = Image.new("L", (canvas, canvas), 0)
        ImageDraw.Draw(circle).ellipse((0, 0, canvas - 1, canvas - 1), fill=255)
        squircle = Image.new("L", (canvas, canvas), 0)
        ImageDraw.Draw(squircle).rounded_rectangle((0, 0, canvas - 1, canvas - 1), radius=int(canvas * 0.22), fill=255)
        zone = base.copy()
        d = ImageDraw.Draw(zone)
        inner = canvas * RATIO
        margin = (canvas - inner) / 2
        d.rectangle((margin, margin, canvas - margin, canvas - margin), outline=(255, 255, 255, 200), width=2)
        inner2 = canvas * LOGO_RATIO
        margin2 = (canvas - inner2) / 2
        d.rectangle((margin2, margin2, canvas - margin2, canvas - margin2), outline=(255, 255, 255, 110), width=1)
        tiles = [masked(base, circle), masked(base, squircle), zone]
        gap = 24
        sheet = Image.new("RGBA", (canvas * 3 + gap * 4, canvas + gap * 2), (237, 241, 247, 255))
        for index, tile in enumerate(tiles):
            sheet.alpha_composite(tile, (gap + index * (canvas + gap), gap))
        PREVIEW.parent.mkdir(parents=True, exist_ok=True)
        sheet.save(PREVIEW, optimize=True)
        print("预览:", PREVIEW)

    print(f"\n{'ALL ICON CHECKS PASSED' if not failed else 'ICON CHECKS FAILED: ' + ', '.join(failed)}")
    return 0 if not failed else 1


if __name__ == "__main__":
    sys.exit(main())
