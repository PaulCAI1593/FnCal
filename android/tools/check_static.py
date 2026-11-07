#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""FnCal 安卓外壳 v0.2.2 · 静态自检（本机不能编译，只能做这些）。

检查项：
  1. 所有 XML 用 xml.etree 解析；
  2. 所有 PNG 读尺寸并与密度表核对；
  3. Kotlin 文件括号/引号配对（去注释与字符串后），并检查 LF/结尾换行；
  4. 资源引用一致性（@string / @color / @layout / @drawable / @mipmap / @style / @xml / R.*）；
  5. 全局 http(s):// 字面量清单（外链只放行四个更新域名）；
  6. Gradle 关键配置断言（版本、包名、SDK、JVM target、依赖白名单、固定测试签名）；
  7. 主题令牌：浅色 / 深色值只能是范围文档列出的那些；状态栏与导航栏必须透明；
  8. 布局：根容器不得 fitsSystemWindows="true" 或写死 paddingTop；必须有 shell_root；
     卡片 / 按钮 / 排版口径（9dp 卡片、48dp 主按钮、20-13-12sp 字级、页头 6dp、组间 18dp、留白 20dp）；
  9. 确认没有 gradle-wrapper.jar / gradlew，也没有遗留的 GlassSurface.kt。

用法：C:\\Python314\\python.exe projects/CalDAV/android/tools/check_static.py
退出码 0 = 全过；1 = 有失败项。
"""
from __future__ import annotations

import re
import sys
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]          # projects/CalDAV/android
APP = ROOT / "app" / "src" / "main"

EXPECTED_PNG = {
    "mipmap-mdpi/ic_launcher.png": (48, 48),
    "mipmap-mdpi/ic_launcher_round.png": (48, 48),
    "mipmap-mdpi/ic_launcher_foreground.png": (108, 108),
    "mipmap-hdpi/ic_launcher.png": (72, 72),
    "mipmap-hdpi/ic_launcher_round.png": (72, 72),
    "mipmap-hdpi/ic_launcher_foreground.png": (162, 162),
    "mipmap-xhdpi/ic_launcher.png": (96, 96),
    "mipmap-xhdpi/ic_launcher_round.png": (96, 96),
    "mipmap-xhdpi/ic_launcher_foreground.png": (216, 216),
    "mipmap-xxhdpi/ic_launcher.png": (144, 144),
    "mipmap-xxhdpi/ic_launcher_round.png": (144, 144),
    "mipmap-xxhdpi/ic_launcher_foreground.png": (324, 324),
    "mipmap-xxxhdpi/ic_launcher.png": (192, 192),
    "mipmap-xxxhdpi/ic_launcher_round.png": (192, 192),
    "mipmap-xxxhdpi/ic_launcher_foreground.png": (432, 432),
    # 0.3.0（§A1 前置）：地址页标题上方的标志，同源 144×144。
    "drawable-xxhdpi/logo_mark.png": (144, 144),
}

ALLOWED_DEPS = {
    "androidx.core:core-ktx:1.13.1",
    "androidx.appcompat:appcompat:1.7.0",
    # 0.3.0（§A2）：桌面卡片 30 分钟周期刷新。
    "androidx.work:work-runtime-ktx:2.9.0",
}

# 0.3.0（§A3）：五款卡片与它们声明的尺寸 / 目标格。
WIDGET_PROVIDERS = {
    "widget_mini_month_info": ("MiniMonthWidgetProvider", 110, 110, "2x2", "widget_mini_month_label"),
    "widget_day_agenda_info": ("DayAgendaWidgetProvider", 110, 110, "2x2", "widget_day_agenda_label"),
    "widget_month_info": ("MonthWidgetProvider", 250, 250, "4x4", "widget_month_label"),
    "widget_four_day_info": ("FourDayWidgetProvider", 250, 250, "4x4", "widget_four_day_label"),
    "widget_agenda_list_info": ("AgendaListWidgetProvider", 250, 250, "4x4", "widget_agenda_list_label"),
}

failures: list[str] = []


def fail(message: str) -> None:
    failures.append(message)
    print("FAIL " + message)


def ok(message: str) -> None:
    print("ok   " + message)


def strip_kotlin(source: str) -> str:
    """去掉行注释、块注释、字符串与字符字面量，只留结构。"""
    out: list[str] = []
    i = 0
    n = len(source)
    while i < n:
        ch = source[i]
        nxt = source[i + 1] if i + 1 < n else ""
        if ch == "/" and nxt == "/":
            while i < n and source[i] != "\n":
                i += 1
            continue
        if ch == "/" and nxt == "*":
            i += 2
            while i + 1 < n and not (source[i] == "*" and source[i + 1] == "/"):
                i += 1
            i += 2
            continue
        if ch == '"':
            if source.startswith('"""', i):
                i += 3
                while i + 3 <= n and not source.startswith('"""', i):
                    i += 1
                i += 3
            else:
                i += 1
                while i < n:
                    if source[i] == "\\":
                        i += 2
                        continue
                    if source[i] == '"':
                        i += 1
                        break
                    i += 1
            continue
        if ch == "'":
            i += 1
            while i < n:
                if source[i] == "\\":
                    i += 2
                    continue
                if source[i] == "'":
                    i += 1
                    break
                i += 1
            continue
        out.append(ch)
        i += 1
    return "".join(out)


def check_xml() -> None:
    files = sorted(ROOT.rglob("*.xml"))
    for path in files:
        try:
            ET.parse(path)
            ok("xml " + str(path.relative_to(ROOT)))
        except ET.ParseError as exc:
            fail("xml " + str(path.relative_to(ROOT)) + ": " + str(exc))
    print("xml total:", len(files))


def check_png() -> None:
    from PIL import Image

    found = sorted(APP.rglob("*.png"))
    for path in found:
        rel = path.relative_to(APP / "res").as_posix()
        with Image.open(path) as image:
            size = image.size
        expected = EXPECTED_PNG.get(rel)
        if expected is None:
            fail("png unexpected " + rel)
        elif size != expected:
            fail("png " + rel + " size " + str(size) + " expected " + str(expected))
        else:
            ok("png " + rel + " " + str(size))
    missing = set(EXPECTED_PNG) - {p.relative_to(APP / "res").as_posix() for p in found}
    for rel in sorted(missing):
        fail("png missing " + rel)
    print("png total:", len(found))


def check_kotlin() -> None:
    files = sorted(ROOT.rglob("*.kt"))
    pairs = {"(": ")", "[": "]", "{": "}"}
    closing = {v: k for k, v in pairs.items()}
    for path in files:
        raw = path.read_bytes()
        rel = str(path.relative_to(ROOT))
        if b"\r" in raw:
            fail("kt CR found " + rel)
        if not raw.endswith(b"\n"):
            fail("kt no trailing newline " + rel)
        text = raw.decode("utf-8")
        stripped = strip_kotlin(text)
        stack: list[str] = []
        balanced = True
        for ch in stripped:
            if ch in pairs:
                stack.append(ch)
            elif ch in closing:
                if not stack or stack[-1] != closing[ch]:
                    balanced = False
                    break
                stack.pop()
        if stack:
            balanced = False
        if balanced:
            ok("kt balanced " + rel)
        else:
            fail("kt unbalanced " + rel)
    print("kt total:", len(files))


def collect_resources() -> tuple[set[str], set[str], set[str]]:
    strings: set[str] = set()
    colors: set[str] = set()
    styles: set[str] = set()
    for path in sorted((APP / "res" / "values").rglob("*.xml")):
        tree = ET.parse(path)
        for node in tree.getroot():
            name = node.get("name")
            if not name:
                continue
            if node.tag == "string":
                strings.add(name)
            elif node.tag == "color":
                colors.add(name)
            elif node.tag == "style":
                styles.add(name)
    return strings, colors, styles


def check_resources() -> None:
    strings, colors, styles = collect_resources()
    layouts = {p.stem for p in (APP / "res" / "layout").glob("*.xml")}
    # 0.3.0：密度限定目录（drawable-xxhdpi）里的图也算 drawable 引用。
    drawables: set[str] = set()
    for folder in (APP / "res").glob("drawable*"):
        drawables.update(p.stem for p in folder.glob("*"))
    xmls = {p.stem for p in (APP / "res" / "xml").glob("*.xml")}
    mipmaps: set[str] = set()
    for folder in (APP / "res").glob("mipmap-*"):
        mipmaps.update(p.stem for p in folder.glob("*"))
    ids: set[str] = set()
    refs: list[tuple[str, str]] = []

    for path in sorted((APP / "res").rglob("*.xml")):
        text = path.read_text(encoding="utf-8")
        for match in re.finditer(r'@\+id/([A-Za-z_][A-Za-z0-9_]*)', text):
            ids.add(match.group(1))
        refs.extend((str(path.relative_to(ROOT)), m.group(0)) for m in re.finditer(r"@(string|color|layout|drawable|mipmap|style|xml)/([A-Za-z0-9_.]+)", text))

    for rel, ref in refs:
        kind, name = ref[1:].split("/", 1)
        name = name.split(".")[0] if kind != "style" else name
        exists = {
            "string": name in strings,
            "color": name in colors,
            "layout": name in layouts,
            "drawable": name in drawables,
            "mipmap": name in mipmaps,
            "style": name in styles,
            "xml": name in xmls,
        }[kind]
        if not exists:
            fail("res ref " + rel + " -> " + ref)
    print("res refs:", len(refs), "ids:", len(ids), "strings:", len(strings))

    for path in sorted(ROOT.rglob("*.kt")):
        text = path.read_text(encoding="utf-8")
        for match in re.finditer(r"\bR\.(id|string|color|layout|drawable|mipmap|style)\.([A-Za-z0-9_]+)", text):
            kind, name = match.group(1), match.group(2)
            exists = {
                "id": name in ids,
                "string": name in strings,
                "color": name in colors,
                "layout": name in layouts,
                "drawable": name in drawables,
                "mipmap": name in mipmaps,
                "style": name in styles,
            }[kind]
            if not exists:
                fail("R ref " + str(path.relative_to(ROOT)) + " R." + kind + "." + name)
    print("R refs checked")


def check_urls() -> None:
    allowed = {
        # XML 命名空间
        "http://schemas.android.com/apk/res/android",
        "http://schemas.android.com/apk/res-auto",
        # 允许出现的示例地址
        "http://192.168.1.10:5581",
        "http://192.168.1.10:5581。",
        "https://",
        "http://",
    }
    # 0.2.0（§B4）：更新只允许这四个域名，其它外链仍报错。
    # 0.3.4（§11）：新增 GitHub Pages 清单域名 paulcai1593.github.io。
    allowed_hosts = {
        "cdn.jsdelivr.net",
        "raw.githubusercontent.com",
        "gh-proxy.com",
        "github.com",
        "paulcai1593.github.io",
    }
    count = 0
    for path in sorted(ROOT.rglob("*")):
        if not path.is_file() or path.suffix not in {".kt", ".xml", ".js", ".kts", ".md", ".properties", ".py"}:
            continue
        for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            for match in re.finditer(r"https?://[^\s\"'）)，。<>]+", line):
                url = match.group(0)
                count += 1
                if url in allowed or any(url.startswith(a) for a in allowed):
                    continue
                host = url.split("//", 1)[-1].split("/", 1)[0].split(":", 1)[0]
                if host in allowed_hosts:
                    continue
                fail("url " + str(path.relative_to(ROOT)) + ":" + str(number) + " " + url)
    print("url literals:", count)


def check_update_manifest() -> None:
    """0.2.0（§B4）：update.json 必须存在，且版本号与 app/build.gradle.kts 一致。"""
    import json

    path = ROOT / "update.json"
    if not path.is_file():
        fail("update.json missing")
        return
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:  # noqa: BLE001
        fail("update.json parse: " + str(exc))
        return
    app_gradle = (ROOT / "app" / "build.gradle.kts").read_text(encoding="utf-8")
    code = data.get("versionCode")
    name = data.get("versionName")
    apk = data.get("apk")
    notes = data.get("notes")
    if not isinstance(code, int) or ("versionCode = " + str(code)) not in app_gradle:
        fail("update.json versionCode mismatch: " + repr(code))
    else:
        ok("update.json versionCode " + str(code))
    if not isinstance(name, str) or ('versionName = "' + name + '"') not in app_gradle:
        fail("update.json versionName mismatch: " + repr(name))
    else:
        ok("update.json versionName " + name)
    expected_apk = "FnCal-Android-" + str(name) + ".apk"
    if apk != expected_apk:
        fail("update.json apk should be " + expected_apk + ", got " + repr(apk))
    else:
        ok("update.json apk " + apk)
    # 0.3.2 起允许 2 条 notes：本版只有「系统栏底色」「关于页说明」两处改动，
    # 硬凑第三条会写进无关内容。上限仍是 6。
    if not isinstance(notes, list) or not (2 <= len(notes) <= 6) \
            or not all(isinstance(n, str) and n for n in notes):
        fail("update.json notes should be 2-6 non-empty strings")
    else:
        ok("update.json notes " + str(len(notes)))


def check_gradle() -> None:
    app_gradle = (ROOT / "app" / "build.gradle.kts").read_text(encoding="utf-8")
    root_gradle = (ROOT / "build.gradle.kts").read_text(encoding="utf-8")
    props = (ROOT / "gradle.properties").read_text(encoding="utf-8")
    manifest = (APP / "AndroidManifest.xml").read_text(encoding="utf-8")

    checks = {
        'namespace = "com.paulcai1593.fncal.app"': app_gradle,
        'applicationId = "com.paulcai1593.fncal.app"': app_gradle,
        "compileSdk = 34": app_gradle,
        "minSdk = 24": app_gradle,
        "targetSdk = 34": app_gradle,
        "versionCode = 305": app_gradle,
        'versionName = "0.3.5"': app_gradle,
        'resValue("string", "fncal_shell_version", "0.3.5")': app_gradle,
        'jvmTarget = "17"': app_gradle,
        'id("com.android.application") version "8.5.2" apply false': root_gradle,
        'id("org.jetbrains.kotlin.android") version "1.9.24" apply false': root_gradle,
        "android.useAndroidX=true": props,
        "android.nonTransitiveRClass=true": props,
        "org.gradle.jvmargs=-Xmx2048m": props,
        # 0.2.1（§S2-2b）：三页统一 Theme.FnCal（透明状态栏 / 导航栏）。
        'android:name=".AddressActivity"': manifest,
        'android:name=".AboutActivity"': manifest,
        'android:name=".MainActivity"': manifest,
        'create("test")': app_gradle,
        'storeFile = file("../keystore/fncal-test.keystore")': app_gradle,
        'keyAlias = "fncal"': app_gradle,
        'signingConfig = signingConfigs.getByName("test")': app_gradle,
    }
    for needle, haystack in checks.items():
        if needle in haystack:
            ok("gradle " + needle)
        else:
            fail("gradle missing " + needle)

    theme_count = manifest.count('android:theme="@style/Theme.FnCal"')
    if theme_count == 3:
        ok("manifest Theme.FnCal x3")
    else:
        fail("manifest Theme.FnCal count " + str(theme_count))

    keystore = ROOT / "keystore" / "fncal-test.keystore"
    if keystore.is_file() and keystore.stat().st_size > 1000:
        ok("keystore fncal-test.keystore " + str(keystore.stat().st_size) + " bytes")
    else:
        fail("keystore missing or too small: " + str(keystore))

    if "android.permission.REQUEST_INSTALL_PACKAGES" in manifest:
        ok("manifest install permission")
    else:
        fail("manifest missing REQUEST_INSTALL_PACKAGES")
    if 'androidx.core.content.FileProvider' in manifest and 'android:resource="@xml/file_paths"' in manifest:
        ok("manifest file provider")
    else:
        fail("manifest missing FileProvider / file_paths")

    for dep in re.findall(r'implementation\("([^"]+)"\)', app_gradle):
        if dep not in ALLOWED_DEPS:
            fail("gradle dependency not allowed: " + dep)
        else:
            ok("gradle dep " + dep)

    for banned in (
        "gradlew",
        "gradle/wrapper/gradle-wrapper.jar",
        "app/src/main/java/com/paulcai1593/fncal/app/GlassSurface.kt",
    ):
        if (ROOT / banned).exists():
            fail("must not commit " + banned)
    print("gradle checks done")


def check_line_endings() -> None:
    """文本文件必须是 LF（仓库统一口径）：出现 CR 即失败。"""
    text_suffixes = {".kt", ".kts", ".xml", ".js", ".md", ".properties", ".py", ".pro"}
    checked = 0
    for path in sorted(ROOT.rglob("*")):
        if not path.is_file() or path.suffix not in text_suffixes:
            continue
        rel = path.relative_to(ROOT).as_posix()
        if rel in BINARY_ALLOW:
            continue
        checked += 1
        raw = path.read_bytes()
        cr = raw.count(b"\r")
        if cr:
            fail("CRLF " + str(path.relative_to(ROOT)) + " CR=" + str(cr))
            continue
        if not raw.endswith(b"\n"):
            fail("no trailing LF " + str(path.relative_to(ROOT)))
    print("text files (LF check):", checked)


BINARY_ALLOW = {
    # 0.2.1（§S1）：签名 keystore 是二进制，不参与文本检查（LF / URL / 括号配对）。
    "keystore/fncal-test.keystore",
}

# 0.2.2：真源 `code/app/api/approval-page.mjs` 的渐变与玻璃浮层令牌。
# 浅色渐变 #1d73d6 → #1094b7(52%) → #02b497，白光高光 22%；
# 玻璃层 86% 白 + 55% 白描边（无 blur 回退 96%）；深色对应 9% 高光与 82% 深底。
COLOR_TOKENS_LIGHT = {
    "surface_2": "#F5F6F8",
    "surface_3": "#ECEEF2",
    "border": "#E2E5EB",
    "text": "#14161C",
    "text_2": "#4B5162",
    "text_3": "#5F6675",
    "accent": "#2F5E9E",
    "accent_contrast": "#FFFFFF",
    "accent_text": "#2F5E9E",
    "bg_grad_start": "#1D73D6",
    "bg_grad_mid": "#1094B7",
    "bg_grad_end": "#02B497",
    "highlight": "#38FFFFFF",
    "highlight_clear": "#00FFFFFF",
    "glass_fill": "#DBFFFFFF",
    "glass_stroke": "#8CFFFFFF",
    "glass_fill_solid": "#F5FFFFFF",
}
COLOR_TOKENS_NIGHT = {
    "surface_2": "#1A1C24",
    "surface_3": "#21242E",
    "border": "#2A2E3A",
    "text": "#F4F6FA",
    "text_2": "#A7ADBC",
    "text_3": "#8A91A2",
    "accent_text": "#93C5FD",
    "bg_grad_start": "#0D2A45",
    "bg_grad_mid": "#0B3A4D",
    "bg_grad_end": "#083A35",
    "highlight": "#17FFFFFF",
    "highlight_clear": "#00FFFFFF",
    "glass_fill": "#D116181F",
    "glass_stroke": "#1AFFFFFF",
    "glass_fill_solid": "#F516181F",
    "error_red": "#FFB4AB",
}


def parse_color_file(path: Path) -> dict[str, str]:
    colors: dict[str, str] = {}
    for node in ET.parse(path).getroot():
        if node.tag != "color":
            continue
        name = node.get("name")
        if name and node.text:
            colors[name] = node.text.strip()
    return colors


def check_theme_tokens() -> None:
    """0.2.1（§S2 / §S2-2b）：令牌值只允许文档列出的那些；系统栏必须透明。"""
    light = parse_color_file(APP / "res" / "values" / "colors.xml")
    night = parse_color_file(APP / "res" / "values-night" / "colors.xml")

    for name, value in COLOR_TOKENS_LIGHT.items():
        if light.get(name) == value:
            ok("color light " + name + " " + value)
        else:
            fail("color light " + name + " = " + repr(light.get(name)) + " expected " + value)
    for name, value in COLOR_TOKENS_NIGHT.items():
        if night.get(name) == value:
            ok("color night " + name + " " + value)
        else:
            fail("color night " + name + " = " + repr(night.get(name)) + " expected " + value)

    for name in COLOR_TOKENS_NIGHT:
        if name not in light:
            fail("night color not defined in light: " + name)

    transparent = {"@android:color/transparent", "#00000000"}
    for rel in ("values/themes.xml", "values-night/themes.xml"):
        path = APP / "res" / rel
        text = path.read_text(encoding="utf-8")
        if "Theme.FnCal.Glass" in text:
            fail("legacy Theme.FnCal.Glass still in " + rel)
        root = ET.parse(path).getroot()
        style = next((n for n in root if n.tag == "style" and n.get("name") == "Theme.FnCal"), None)
        if style is None:
            fail("style Theme.FnCal missing in " + rel)
            continue
        items = {n.get("name"): (n.text or "").strip() for n in style if n.tag == "item"}
        for attr in ("android:statusBarColor", "android:navigationBarColor"):
            if items.get(attr) in transparent:
                ok("theme " + rel + " " + attr + " transparent")
            else:
                fail("theme " + rel + " " + attr + " must be transparent, got " + repr(items.get(attr)))


def check_layouts() -> None:
    """0.2.1（§S2 / §S2-2b）：布局口径与根容器不得写死系统栏内距。"""
    layouts = APP / "res" / "layout"
    for name in ("activity_address.xml", "activity_about.xml", "activity_main.xml"):
        path = layouts / name
        text = path.read_text(encoding="utf-8")
        # 注释里会提到 fitsSystemWindows（解释口径），判定前先去掉注释。
        markup = re.sub(r"<!--.*?-->", "", text, flags=re.S)
        rel = "layout/" + name
        if "@+id/shell_root" in markup:
            ok("layout shell_root " + rel)
        else:
            fail("layout missing shell_root " + rel)
        if "fitsSystemWindows" in markup:
            fail("layout must not set fitsSystemWindows: " + rel)
        start = markup.find("<FrameLayout")
        if start >= 0:
            end = markup.find(">", start)
            head = markup[start:end]
            if "paddingTop" in head:
                fail("layout root must not hardcode paddingTop: " + rel)
            if "fitsSystemWindows" in head:
                fail("layout root must not set fitsSystemWindows: " + rel)
        if re.search(r"#[0-9A-Fa-f]{6,8}", markup):
            fail("layout has hardcoded color: " + rel)

    for name in ("activity_address.xml", "activity_about.xml"):
        text = (layouts / name).read_text(encoding="utf-8")
        for needle in ('@drawable/bg_card', '48dp', '20sp', '13sp', '12sp'):
            if needle in text:
                ok("layout " + name + " has " + needle)
            else:
                fail("layout " + name + " missing " + needle)

    # 0.2.2 排版口径：页头 / 分组 / 表单 / 留白。逐条断言，防止后续改版悄悄打回旧值。
    TYPE_SCALE = ("20sp", "13sp", "12sp")
    for name in ("activity_address.xml", "activity_about.xml"):
        text = (layouts / name).read_text(encoding="utf-8")
        for size in TYPE_SCALE:
            if 'android:textSize="' + size + '"' in text:
                ok("type scale " + name + " " + size)
            else:
                fail("type scale " + name + " missing " + size)
        # 任何字号不得小于 12sp（用户明确要求：辅助 12 / 正文 13 / 标题 20）。
        sizes = [int(m) for m in re.findall(r'android:textSize="(\d+)sp"', text)]
        if sizes and min(sizes) < 12:
            fail("text size below 12sp in " + name + ": " + repr(min(sizes)))
        else:
            ok("type scale " + name + " all >= 12sp")
        # 标题 / 分组 / 主按钮为 600 字重：API 28+ 走 textFontWeight，24–27 用 bold 兜底。
        weight = text.count('android:textFontWeight="600"')
        if weight >= (2 if name == "activity_address.xml" else 5):
            ok("weight 600 " + name + " count " + str(weight))
        else:
            fail("weight 600 " + name + " too few: " + str(weight))
        for needle in ('android:layout_marginTop="18dp"', 'android:layout_marginBottom="8dp"',
                       'android:paddingLeft="20dp"', 'android:paddingRight="20dp"',
                       'android:paddingBottom="24dp"'):
            if needle in text:
                ok("spacing " + name + " has " + needle)
            else:
                fail("spacing " + name + " missing " + needle)
        for needle in ('android:paddingLeft="14dp"', 'android:paddingTop="12dp"',
                       'android:paddingRight="14dp"', 'android:paddingBottom="12dp"'):
            if needle in text:
                ok("card padding " + name + " has " + needle)
            else:
                fail("card padding " + name + " missing " + needle)

    # 输入框 48dp / 14dp 内距；主按钮全宽 48dp；页头标题 20sp 且与副标题 6dp。
    address = (layouts / "activity_address.xml").read_text(encoding="utf-8")
    for needle in ('android:id="@+id/input_address"', 'android:layout_height="48dp"',
                   'android:paddingLeft="14dp"', 'android:layout_marginTop="6dp"'):
        if needle in address:
            ok("form address has " + needle)
        else:
            fail("form address missing " + needle)
    if re.search(r'id="@\+id/btn_connect".*?android:layout_height="48dp"', address, re.S):
        ok("primary button 48dp address")
    else:
        fail("primary button must be 48dp: address")
    about = (layouts / "activity_about.xml").read_text(encoding="utf-8")
    if re.search(r'id="@\+id/btn_check_update".*?android:layout_height="48dp"', about, re.S):
        ok("primary button 48dp about")
    else:
        fail("primary button must be 48dp: about")
    for group in ("group_service", "group_update", "group_desktop", "group_about"):
        if "@string/" + group in about:
            ok("about group " + group)
        else:
            fail("about group missing " + group)
    if 'android:ellipsize="middle"' in about and 'maxLines="1"' in about and 'android:minHeight="48dp"' in about:
        ok("address row ellipsize middle, single line")
    else:
        fail("address row must ellipsize middle and stay single line")


    # 0.2.2：两页都必须有「一层」玻璃容器与 backdrop 位图；旧的 blur_layer 不许回来。
    for name in ("activity_address.xml", "activity_about.xml"):
        text = (layouts / name).read_text(encoding="utf-8")
        for needle in ('@+id/backdrop', '@+id/glass_card', '@drawable/bg_glass_card'):
            if needle in text:
                ok("glass layout " + name + " has " + needle)
            else:
                fail("glass layout " + name + " missing " + needle)
        if "blur_layer" in text:
            fail("legacy blur_layer still in " + name)
        if text.count('@+id/glass_card') != 1:
            fail("glass container must be exactly one layer in " + name)

    glass = (APP / "res" / "drawable" / "bg_glass_card.xml").read_text(encoding="utf-8")
    for needle in ('android:radius="16dp"', 'android:width="1dp"', "@color/glass_fill", "@color/glass_stroke"):
        if needle in glass:
            ok("glass drawable has " + needle)
        else:
            fail("glass drawable missing " + needle)

    solid = (APP / "res" / "drawable" / "bg_glass_solid.xml").read_text(encoding="utf-8")
    for needle in ('android:radius="16dp"', "@color/glass_fill_solid"):
        if needle in solid:
            ok("glass fallback has " + needle)
        else:
            fail("glass fallback missing " + needle)

    gradient = (APP / "res" / "drawable" / "bg_shell_gradient.xml").read_text(encoding="utf-8")
    for needle in ('android:angle="315"', "@color/bg_grad_start", "@color/bg_grad_mid", "@color/bg_grad_end"):
        if needle in gradient:
            ok("gradient has " + needle)
        else:
            fail("gradient missing " + needle)

    glow = (APP / "res" / "drawable" / "bg_shell_glow.xml").read_text(encoding="utf-8")
    for needle in ('android:centerX="0.62"', 'android:centerY="0.18"', "@color/highlight"):
        if needle in glow:
            ok("highlight has " + needle)
        else:
            fail("highlight missing " + needle)

    card = (APP / "res" / "drawable" / "bg_card.xml").read_text(encoding="utf-8")
    for needle in ('android:radius="9dp"', 'android:width="1dp"', "@color/surface_2", "@color/border"):
        if needle in card:
            ok("card drawable has " + needle)
        else:
            fail("card drawable missing " + needle)

    field = (APP / "res" / "drawable" / "bg_input_field.xml").read_text(encoding="utf-8")
    if "bg_input_focused" in field and "bg_input" in field:
        ok("input field selector")
    else:
        fail("input field selector missing focused/default states")


def check_widgets() -> None:
    """0.3.0（§A1–§A5）：五款桌面卡片、令牌入口、30 分钟刷新、透明系统栏与 72dp 标志。"""
    kt = APP / "java" / "com" / "paulcai1593" / "fncal" / "app"
    manifest = (APP / "AndroidManifest.xml").read_text(encoding="utf-8")
    xml_dir = APP / "res" / "xml"

    # ① 五款 provider：声明的尺寸 / 目标格 / 初始布局，manifest 注册与 meta-data 指向。
    for info, (cls, width, height, cells, label) in WIDGET_PROVIDERS.items():
        path = xml_dir / (info + ".xml")
        if not path.is_file():
            fail("widget info missing " + info)
            continue
        text = path.read_text(encoding="utf-8")
        col, row = cells.split("x")
        for needle in (
            'android:minWidth="%ddp"' % width,
            'android:minHeight="%ddp"' % height,
            'android:targetCellWidth="%s"' % col,
            'android:targetCellHeight="%s"' % row,
            'android:initialLayout="@layout/widget_card"',
            'android:previewImage="@drawable/logo_mark"',
            'android:updatePeriodMillis="0"',
            '@string/widget_description',
        ):
            if needle in text:
                ok("widget info " + info + " has " + needle)
            else:
                fail("widget info " + info + " missing " + needle)
        for needle in (
            'android:name=".' + cls + '"',
            'android:resource="@xml/' + info + '"',
            '@string/' + label,
        ):
            if needle in manifest:
                ok("manifest widget " + cls + " has " + needle)
            else:
                fail("manifest widget " + cls + " missing " + needle)

    # ② 卡片布局：整卡位图 + 可缩放 ImageView，且图片本身对读屏隐藏（文案在外层）。
    card = (APP / "res" / "layout" / "widget_card.xml").read_text(encoding="utf-8")
    for needle in (
        'android:id="@+id/widget_image"',
        'android:scaleType="fitXY"',
        'android:contentDescription="@null"',
        'android:importantForAccessibility="no"',
        'android:contentDescription="@string/widget_description"',
    ):
        if needle in card:
            ok("widget card layout has " + needle)
        else:
            fail("widget card layout missing " + needle)

    # ③ Kotlin 能力：登录 Cookie 取数、刷新周期、范围、五款渲染、点击深链。
    for name in (
        "WidgetPrefs.kt", "WidgetData.kt", "WidgetClient.kt", "WidgetRepository.kt",
        "WidgetRenderer.kt", "WidgetScheduler.kt", "WidgetWorker.kt",
        "WidgetRefreshReceiver.kt", "FnCalWidgetProvider.kt", "DeviceName.kt",
    ):
        if (kt / name).is_file():
            ok("widget kotlin " + name)
        else:
            fail("widget kotlin missing " + name)

    # 0.6.2 §F：不再有第二套凭据——WidgetPrefs 里不许出现令牌与 Keystore 加密。
    prefs = (kt / "WidgetPrefs.kt").read_text(encoding="utf-8")
    for forbidden in ("AES/GCM/NoPadding", "AndroidKeyStore", "fncal_widget_token", "token_enc", "hasToken"):
        if forbidden not in prefs:
            ok("widget prefs has no " + forbidden)
        else:
            fail("widget prefs must not keep a token: " + forbidden)
    for needle in ("cache_json", "cache_etag", "last_updated", "last_error"):
        if needle in prefs:
            ok("widget prefs has " + needle)
        else:
            fail("widget prefs missing " + needle)

    # 卡片取数：从 CookieManager 取会话 Cookie，按 Cookie 头发送，且整段 try/catch。
    client = (kt / "WidgetClient.kt").read_text(encoding="utf-8")
    for needle in (
        "CookieManager.getInstance().getCookie",
        'setRequestProperty("Cookie"',
        'setRequestProperty("User-Agent"',
        "FnCalWidget/",
        "catch (e: Exception)",
    ):
        if needle in client:
            ok("widget client has " + needle)
        else:
            fail("widget client missing " + needle)

    scheduler = (kt / "WidgetScheduler.kt").read_text(encoding="utf-8")
    for needle in (
        "INTERVAL_MINUTES = 30L",
        "PeriodicWorkRequestBuilder",
        "ExistingPeriodicWorkPolicy.UPDATE",
        "NetworkType.CONNECTED",
    ):
        if needle in scheduler:
            ok("widget scheduler has " + needle)
        else:
            fail("widget scheduler missing " + needle)

    repository = (kt / "WidgetRepository.kt").read_text(encoding="utf-8")
    if "RANGE_DAYS = 45" in repository:
        ok("widget range 45 days")
    else:
        fail("widget range must be 45 days")

    renderer = (kt / "WidgetRenderer.kt").read_text(encoding="utf-8")
    for kind in ("MINI_MONTH", "DAY_AGENDA", "MONTH", "FOUR_DAY", "AGENDA_LIST"):
        if kind in renderer:
            ok("widget renderer kind " + kind)
        else:
            fail("widget renderer missing kind " + kind)
    # 正文 10sp / 标题 12sp；0.3.4 §9 起允许四日视图的时间轴刻度用 9sp，
    # §10 起允许日程卡的时间与地点用 9sp（辅助信息，范围文档明确允许）。
    sizes = [float(x) for x in re.findall(r"\bpaint\((\d+(?:\.\d+)?)f", renderer)]
    if sizes and min(sizes) < 9:
        fail("widget text below 9sp: " + repr(min(sizes)))
    else:
        ok("widget text all >= 9sp (ticks/meta) / 10sp body")
    if 'paint(9f, colorText3)' in renderer and "tickPaint" in renderer:
        ok("widget 9sp text is meta/tick colorText3")
    else:
        fail("widget 9sp text must use paint(9f, colorText3)")

    provider = (kt / "FnCalWidgetProvider.kt").read_text(encoding="utf-8")
    for needle in (
        "MiniMonthWidgetProvider", "DayAgendaWidgetProvider", "MonthWidgetProvider",
        "FourDayWidgetProvider", "AgendaListWidgetProvider",
        "OPTION_APPWIDGET_MIN_WIDTH", "FLAG_IMMUTABLE", "ACTION_REFRESH",
    ):
        if needle in provider:
            ok("widget provider has " + needle)
        else:
            fail("widget provider missing " + needle)

    receiver = (kt / "WidgetRefreshReceiver.kt").read_text(encoding="utf-8")
    for action in ("ACTION_BOOT_COMPLETED", "ACTION_TIME_CHANGED", "ACTION_TIMEZONE_CHANGED",
                   "ACTION_MY_PACKAGE_REPLACED"):
        if action in receiver:
            ok("widget receiver action " + action)
        else:
            fail("widget receiver missing " + action)
    if "RECEIVE_BOOT_COMPLETED" in manifest:
        ok("manifest RECEIVE_BOOT_COMPLETED")
    else:
        fail("manifest missing RECEIVE_BOOT_COMPLETED")

    # ④ 0.2.3 并入 0.3.0：系统栏全透明（窗口层 + 主题层），内容仍按 insets 留白。
    chrome = (kt / "ShellChrome.kt").read_text(encoding="utf-8")
    for needle in (
        "setDecorFitsSystemWindows(window, false)",
        "statusBarColor = Color.TRANSPARENT",
        "navigationBarColor = Color.TRANSPARENT",
        "isNavigationBarContrastEnforced = false",
        "isAppearanceLightStatusBars",
        "isAppearanceLightNavigationBars",
    ):
        if needle in chrome:
            ok("chrome has " + needle)
        else:
            fail("chrome missing " + needle)

    # ⑤ 地址页标志：72dp、居中、不新画图形（复用同源 logo_mark.png）。
    address = (APP / "res" / "layout" / "activity_address.xml").read_text(encoding="utf-8")
    logo_block = re.search(r'<ImageView[^>]*@\+id/logo_mark.*?/>', address, re.S)
    if not logo_block:
        fail("address layout missing logo_mark ImageView")
    else:
        block = logo_block.group(0)
        for needle in (
            'android:layout_width="72dp"',
            'android:layout_height="72dp"',
            'android:layout_marginBottom="16dp"',
            'android:scaleType="fitCenter"',
            '@drawable/logo_mark',
        ):
            if needle in block:
                ok("address logo has " + needle)
            else:
                fail("address logo missing " + needle)
        if 'android:contentDescription="@string/logo_content_description"' in block \
                or 'android:importantForAccessibility="no"' in block:
            ok("address logo accessibility")
        else:
            fail("address logo needs contentDescription or importantForAccessibility")

    # ⑥ 关于页：0.6.2 起只显示登录状态 + 手动刷新（令牌入口已删）。
    about_layout = (APP / "res" / "layout" / "activity_about.xml").read_text(encoding="utf-8")
    for needle in (
        'android:id="@+id/widget_login_state"',
        'android:id="@+id/btn_widget_refresh"',
        '@string/about_widget_refresh',
    ):
        if needle in about_layout:
            ok("about widget state has " + needle)
        else:
            fail("about widget state missing " + needle)
    for gone in ('@+id/widget_token"', '@+id/btn_widget_save"', '@+id/btn_widget_clear"'):
        if gone not in about_layout:
            ok("about widget form removed " + gone)
        else:
            fail("about widget form must be removed: " + gone)
    about_kt = (kt / "AboutActivity.kt").read_text(encoding="utf-8")
    for needle in ("WidgetRepository.signedIn", "WidgetRepository.refresh", "btn_widget_refresh"):
        if needle in about_kt:
            ok("about activity has " + needle)
        else:
            fail("about activity missing " + needle)
    for gone in ("WidgetPrefs.setToken", "WidgetRepository.testToday", "fncal_wd_"):
        if gone not in about_kt:
            ok("about activity no token flow " + gone)
        else:
            fail("about activity must not handle tokens: " + gone)

    # ⑦ 点卡片开对应视图：主界面把 hash 交给网页；UA 带机型（0.3.0 §D）。
    main_kt = (kt / "MainActivity.kt").read_text(encoding="utf-8")
    for needle in ('UA_SUFFIX = " FnCalAndroid/0.3.5"', "DeviceName.suffix()", "EXTRA_VIEW", 'fncal-view=', "onNewIntent"):
        if needle in main_kt:
            ok("main activity has " + needle)
        else:
            fail("main activity missing " + needle)
    device = (kt / "DeviceName.kt").read_text(encoding="utf-8")
    for needle in ("Build.MANUFACTURER", "Build.MODEL", "MAX_LENGTH = 40"):
        if needle in device:
            ok("device name has " + needle)
        else:
            fail("device name missing " + needle)
    strings = (APP / "res" / "values" / "strings.xml").read_text(encoding="utf-8")
    if '<string name="widget_no_token">打开 FnCal 登录</string>' in strings:
        ok("widget placeholder asks for login")
    else:
        fail("widget placeholder must ask for login")
    if 'about_widget_status_signed_out' in strings and 'about_widget_status_signed_in' in strings:
        ok("about widget has signed-in / signed-out copy")
    else:
        fail("about widget missing login state copy")

    # ⑧ 发版口径：workflow 的 tag / 资产名跟版本走。0.3.4 起 workflow 由总监单独
    # 改（他正在推 Release 正文），升号过渡期规则见 workflow_version_status()。
    import json

    manifest = json.loads((ROOT / "update.json").read_text(encoding="utf-8"))
    wf_ok, wf_note = workflow_version_status(
        str(manifest.get("versionName", "")), int(manifest.get("versionCode", 0))
    )
    if wf_ok:
        ok("workflow release names (" + wf_note + ")")
    else:
        fail("workflow release names: " + wf_note)


def workflow_version_status(name: str, code: int) -> tuple[bool, str]:
    """0.3.4 起：workflow 版本串自洽性检查（总监单独维护该文件）。

    升号过渡期允许 workflow 停在上一个版本，但要求它自己的 tag / 资产名 /
    badging 三者版本一致，且 (versionName, versionCode) 属于 {当前, 上一版}。
    总监把 workflow 升到当前版本后，过渡分支自动失效。
    """
    workflow = ROOT.parent / ".github" / "workflows" / "android.yml"
    if not workflow.is_file():
        return False, "android.yml missing"
    wf = workflow.read_text(encoding="utf-8")
    allowed = {name: code}
    if name == "0.3.5":
        allowed["0.3.4"] = 304
    tags = set(re.findall(r"TAG=android-v(\d+\.\d+\.\d+)", wf))
    outs = set(re.findall(r"OUT=FnCal-Android-(\d+\.\d+\.\d+)\.apk", wf))
    badges = set(re.findall(r"versionName='(\d+\.\d+\.\d+)'", wf))
    codes = set(re.findall(r"versionCode='(\d+)'", wf))
    if not (len(tags) == 1 and len(outs) == 1 and len(badges) == 1 and len(codes) == 1):
        return False, "workflow strings incomplete or duplicated: %s %s %s %s" % (
            sorted(tags),
            sorted(outs),
            sorted(badges),
            sorted(codes),
        )
    version = tags.pop()
    badge_version = badges.pop()
    out_version = outs.pop()
    wf_code = int(codes.pop())
    if not (version == badge_version == out_version):
        return False, "workflow tag / apk / badging disagree: %s %s %s" % (
            version,
            out_version,
            badge_version,
        )
    if allowed.get(version) != wf_code:
        return False, "workflow version/code %s/%d not in %s" % (
            version,
            wf_code,
            sorted(allowed.items()),
        )
    if version != name:
        return True, "workflow still on " + version + " (pending workflow update by director)"
    return True, "workflow on " + version


def check_shell_surface() -> None:
    """0.3.2（§A）：主界面根容器必须有实体底色，系统栏区域不再露窗口渐变。"""
    main_xml = (APP / "res" / "layout" / "activity_main.xml").read_text(encoding="utf-8")
    if 'android:id="@+id/shell_root"' in main_xml:
        ok("main layout has shell_root")
    else:
        fail("main layout missing shell_root")
    if 'android:background="@color/bg_shell_surface"' in main_xml:
        ok("shell_root uses @color/bg_shell_surface")
    else:
        fail("shell_root must paint @color/bg_shell_surface")

    pattern = re.compile(
        r'<color name="bg_shell_surface">(#[0-9A-Fa-f]{6})</color>')
    surfaces = {}
    for label, rel in (("light", "values/colors.xml"), ("night", "values-night/colors.xml")):
        text = (APP / "res" / rel).read_text(encoding="utf-8")
        found = pattern.search(text)
        if not found:
            fail(rel + " missing bg_shell_surface")
            continue
        surfaces[label] = found.group(1).upper()
    gradients = {}
    for label, rel in (("light", "values/colors.xml"), ("night", "values-night/colors.xml")):
        text = (APP / "res" / rel).read_text(encoding="utf-8")
        found = re.search(r'<color name="bg_grad_start">(#[0-9A-Fa-f]{6,8})</color>', text)
        gradients[label] = found.group(1).upper() if found else ""
    if surfaces.get("light") == "#FFFFFF":
        ok("light shell surface #FFFFFF")
    else:
        fail("light shell surface should be #FFFFFF, got " + repr(surfaces.get("light")))
    if surfaces.get("night") == "#16181F":
        ok("night shell surface #16181F")
    else:
        fail("night shell surface should be #16181F, got " + repr(surfaces.get("night")))
    for label in ("light", "night"):
        if surfaces.get(label) and surfaces.get(label) != gradients.get(label):
            ok("shell surface differs from bg_grad_start (" + label + ")")
        else:
            fail("shell surface must differ from bg_grad_start (" + label + ")")

    # 0.3.5（附）：浮层按钮默认在右下角、底栏上方，不压网页底部视图切换。
    if 'android:layout_gravity="bottom|end"' in main_xml:
        ok("menu button anchored bottom|end")
    else:
        fail("menu button must use layout_gravity bottom|end")
    margin = re.search(r'android:id="@\+id/btn_menu"[\s\S]{0,600}?android:layout_marginBottom="(\d+)dp"', main_xml)
    if margin and 66 <= int(margin.group(1)) <= 80:
        ok("menu button marginBottom " + margin.group(1) + "dp")
    else:
        fail("menu button marginBottom must be 66-80dp, got " + (margin.group(1) if margin else "missing"))
    margin_end = re.search(r'android:id="@\+id/btn_menu"[\s\S]{0,600}?android:layout_marginEnd="(\d+)dp"', main_xml)
    if margin_end and int(margin_end.group(1)) >= 8:
        ok("menu button marginEnd " + margin_end.group(1) + "dp")
    else:
        fail("menu button marginEnd must be >= 8dp, got " + (margin_end.group(1) if margin_end else "missing"))

    # 关于页：卡片说明写实际做法，且不再出现「后续版本」。
    strings = (APP / "res" / "values" / "strings.xml").read_text(encoding="utf-8")
    hint = re.search(r'<string name="about_desktop_hint">(.*?)</string>', strings, re.S)
    if hint and "小部件" in hint.group(1):
        ok("about_desktop_hint mentions 小部件")
    else:
        fail("about_desktop_hint must describe the widget flow (小部件)")
    about_xml = (APP / "res" / "layout" / "activity_about.xml").read_text(encoding="utf-8")
    if re.search(r'about_desktop_hint[\s\S]{0,200}?android:maxLines="4"', about_xml) \
            or re.search(r'android:maxLines="4"[\s\S]{0,200}?about_desktop_hint', about_xml):
        ok("about_desktop_hint allows 4 lines")
    else:
        fail("about_desktop_hint maxLines should be 4")
    stale = []
    for path in list(APP.rglob("*")) + [ROOT / "update.json"]:
        if not path.is_file() or path.suffix.lower() not in (".kt", ".xml", ".json"):
            continue
        if "后续版本" in path.read_text(encoding="utf-8"):
            stale.append(str(path.relative_to(ROOT)))
    if stale:
        fail("stale phrase 后续版本 still present: " + ", ".join(stale))
    else:
        ok("no stale phrase 后续版本")


def check_widget_layout() -> None:
    """0.3.3（§A–§C）：迷你月历圆点、三档尺寸、月视图一行名称。"""
    kt = APP / "java" / "com" / "paulcai1593" / "fncal" / "app"
    renderer = (kt / "WidgetRenderer.kt").read_text(encoding="utf-8")

    # ① 迷你月历：不再按格子高度整体省略圆点。
    if "roomForDot" not in renderer:
        ok("mini month draws dots without roomForDot gate")
    else:
        fail("mini month must not gate dots on roomForDot")

    # ② 圆点直径与卡片高度挂钩；0.3.4 §7.1 起整卡统一预留圆点带，基线与有无事件无关。
    for needle in (
        "val dotDp = roundToOneDecimal",
        "(heightDp - 110f) * 0.025f",
        "coerceIn(2f, 3f)",
        "val dotBand = dp(dotDp + 0.5f)",
        "val baseline = cy + sp(3.6f) - dotBand",
        "top + cellH - dp(dotDp / 2f + 0.5f)",
        # 0.3.3 总监修订：2×2 档不画圆底（会包不住日号），改强调色加粗日号。
        "if (isToday && isSmall) {",
        "paint(10f, colorAccent, mediumWeight = true)",
    ):
        if needle in renderer:
            ok("mini month dot has " + needle)
        else:
            fail("mini month dot missing " + needle)

    # ③ 三档尺寸分支：短边 140 / 220dp，且渲染器按档取内距与字号。
    for needle in (
        "const val TIER_SMALL_MAX_DP = 140f",
        "const val TIER_MEDIUM_MAX_DP = 220f",
        "private fun tierOf(widthPx: Int, heightPx: Int): SizeTier",
        "shortDp <= TIER_SMALL_MAX_DP",
        "shortDp <= TIER_MEDIUM_MAX_DP",
        "enum class SizeTier",
    ):
        if needle in renderer:
            ok("widget tier has " + needle)
        else:
            fail("widget tier missing " + needle)

    # ④ 月视图：单格 ≥28dp 进名称模式，名称单行省略，色条模式与名称模式互斥。
    for needle in (
        "const val MONTH_NAME_MIN_CELL_DP = 28f",
        "val nameMode = cellH >= dp(MONTH_NAME_MIN_CELL_DP)",
        "if (nameMode) {",
        "TextUtils.TruncateAt.END",
        "events.size - 1",
    ):
        if needle in renderer:
            ok("month name mode has " + needle)
        else:
            fail("month name mode missing " + needle)
    if renderer.count("if (nameMode) {") == 1 and "} else {" in renderer:
        ok("month name mode and bars are exclusive branches")
    else:
        fail("month name mode must be one exclusive branch")

    # ⑤ 0.3.4 §7.3：迷你月历不再逐格顶基线；今天圆底随 dotBand 上移；
    # 月视图名称模式色点直径 4dp（半径 2dp），名称起点 6.5dp、宽 cellW - 8dp。
    if "if (hasEvents) dp(dotDp" in renderer:
        fail("mini month must not shift baseline per cell (0.3.4 §7.1)")
    else:
        ok("mini month baseline is uniform (no per-cell shift)")
    for needle in (
        "canvas.drawCircle(cx, cy - dotBand, radius, solid(colorAccent))",
        "minOf(cellW, cellH - dotBand - dp(1f)) / 2f - dp(0.5f)",
    ):
        if needle in renderer:
            ok("mini month today circle has " + needle)
        else:
            fail("mini month today circle missing " + needle)
    name_block = renderer.split("// 名称模式")[-1][:1200]
    for needle in ("left + dp(3.5f)", "dp(2f)", "left + dp(6.5f)", "cellW - dp(7f)"):
        if needle in name_block:
            ok("month name dot 4dp has " + needle)
        else:
            fail("month name dot 4dp missing " + needle)
    # 0.3.4 §7.2（B）：名称宽 25.57dp（cellW - 7dp），按 TextPaint 实测截断。
    if "val nameWidth = cellW - dp(7f)" in renderer:
        ok("month name width is cellW - 7dp (25.57dp at 4x4)")
    else:
        fail("month name width must be cellW - 7dp")
    if "fitLabel(" in name_block and "paint.measureText(candidate) <= maxWidth" in renderer:
        ok("month name truncation measures real glyph width")
    else:
        fail("month name truncation must use measureText")
    if "chars >= 2" in renderer or "length >= 2" in renderer:
        fail("month name must not hard-code a 2-character threshold")
    else:
        ok("month name has no hard-coded character threshold")


def check_update_install() -> None:
    """0.3.4（§A–§E）：下载完成后按实际落盘 URI 安装，失败带原因码，可续装。"""
    kt = APP / "java" / "com" / "paulcai1593" / "fncal" / "app"
    about = (kt / "AboutActivity.kt").read_text(encoding="utf-8")
    markers = (
        # A：读 COLUMN_LOCAL_URI，content:// 复制到缓存再装
        "COLUMN_LOCAL_URI",
        "private fun apkFromLocalUri(localUri: String?): File?",
        "contentResolver.openInputStream(uri)",
        "private fun copyToCache(uri: Uri): File?",
        # B：下载前清同名包；目标已存在时重试一次
        "private fun cleanBeforeDownload(apkName: String)",
        "DM_ERROR_FILE_ALREADY_EXISTS",
        "retriedAfterExists",
        # C：失败带 DownloadManager 原因码
        "private fun finishDownloadWithFailure(reason: Int = 0)",
        "R.string.update_download_failed_reason",
        # D：已有正确包直接装；授权页返回续装一次
        "private fun existingValidApk(apkName: String, versionCode: Int): File?",
        "pendingInstallArmed = true",
        "resumePendingInstall()",
        # E：诊断行
        "R.id.text_update_diag",
        "R.string.update_diag",
    )
    for marker in markers:
        if marker in about:
            ok("update install has " + marker)
        else:
            fail("update install missing " + marker)
    paths = (APP / "res" / "xml" / "file_paths.xml").read_text(encoding="utf-8")
    if 'name="updates_cache"' in paths and 'path="updates/"' in paths:
        ok("file provider shares cache updates dir")
    else:
        fail("file_paths.xml must declare cache-path updates/")
    strings = (APP / "res" / "values" / "strings.xml").read_text(encoding="utf-8")
    for key, text in (
        ("update_download_failed_reason", "下载失败（原因 %1$d），请重试"),
        ("update_diag", "DM 状态 %1$d · 原因 %2$d · 落盘 %3$s"),
    ):
        if ('<string name="' + key + '">' + text + "</string>") in strings:
            ok("strings has " + key)
        else:
            fail("strings missing " + key)
    layout = (APP / "res" / "layout" / "activity_about.xml").read_text(encoding="utf-8")
    if 'android:id="@+id/text_update_diag"' in layout:
        ok("about layout has update diag row")
    else:
        fail("about layout missing update diag row")


def check_server_version_refresh() -> None:
    """0.3.5：关于页不再只读缓存，打开就后台探活并刷新服务端版本。"""
    kt = APP / "java" / "com" / "paulcai1593" / "fncal" / "app"
    probe_path = kt / "HealthProbe.kt"
    if not probe_path.is_file():
        fail("HealthProbe.kt missing (0.3.5)")
        return
    probe = probe_path.read_text(encoding="utf-8")
    for needle in (
        "object HealthProbe",
        "TIMEOUT_MS = 6_000",
        "data class Health",
        "fun probe(baseUrl: String, allowSelfSigned: Boolean): Result<Health>",
        '"/api/health"',
        'optBoolean("ok"',
    ):
        if needle in probe:
            ok("health probe has " + needle)
        else:
            fail("health probe missing " + needle)

    address = (kt / "AddressActivity.kt").read_text(encoding="utf-8")
    if "HealthProbe.probe(" in address and "HttpURLConnection" not in address:
        ok("address activity probes through HealthProbe")
    else:
        fail("address activity must probe through HealthProbe (no inline HttpURLConnection)")
    about = (kt / "AboutActivity.kt").read_text(encoding="utf-8")
    for needle in (
        "HealthProbe.probe(",
        "private fun refreshServerVersion()",
        'thread(name = "fncal-health-refresh")',
        "ShellPrefs.setServerVersionAt",
        "ShellPrefs.setServerVersion(this, version)",
        "SERVER_VERSION_REFRESH_MS = 30_000L",
        "maybeRefreshServerVersion()",
    ):
        if needle in about:
            ok("about activity has " + needle)
        else:
            fail("about activity missing " + needle)
    # 先按缓存渲染、再后台刷新：缓存读取必须还在（不能删成只读网络）。
    if "ShellPrefs.serverVersion(this)" in about:
        ok("about activity still renders cached server version first")
    else:
        fail("about activity must keep rendering the cached server version first")

    prefs = (kt / "ShellPrefs.kt").read_text(encoding="utf-8")
    for needle in ('KEY_SERVER_VERSION_AT = "server_version_at"', "fun serverVersionAt", "fun setServerVersionAt"):
        if needle in prefs:
            ok("shell prefs has " + needle)
        else:
            fail("shell prefs missing " + needle)


def check_widget_week_start() -> None:
    """0.3.4（§8）：卡片跟随网页设置「每周开始日」，不再写死周一。"""
    kt = APP / "java" / "com" / "paulcai1593" / "fncal" / "app"
    client = (kt / "WidgetClient.kt").read_text(encoding="utf-8")
    for needle in (
        # 读 KV 单键 `cal:settings`；失败返回 null，不影响取数。
        '"/api/v1/kv/cal:settings"',
        "fun weekStartsOn(context: Context): Int?",
        'optInt("weekStartsOn", -1)',
        "if (raw == 0 || raw == 1) raw else null",
    ):
        if needle in client:
            ok("week start client has " + needle)
        else:
            fail("week start client missing " + needle)
    prefs = (kt / "WidgetPrefs.kt").read_text(encoding="utf-8")
    for needle in (
        'KEY_WEEK_START = "week_starts_on"',
        "fun weekStartsOn(context: Context): Int",
        "fun saveWeekStartsOn(context: Context, value: Int)",
    ):
        if needle in prefs:
            ok("week start prefs has " + needle)
        else:
            fail("week start prefs missing " + needle)
    data = (kt / "WidgetData.kt").read_text(encoding="utf-8")
    for needle in (
        "val weekStartsOn: Int = 0",
        "fun weekdayIndex(millis: Long, weekStartsOn: Int): Int",
        "fun normalizedWeekStart(value: Int): Int",
        "fun weekLabels(weekStartsOn: Int): Array<String>",
        "fun monthGridStart(monthMillis: Long, weekStartsOn: Int = 0): Long",
        "addDays(first, -weekdayIndex(first, weekStartsOn))",
    ):
        if needle in data:
            ok("week start data has " + needle)
        else:
            fail("week start data missing " + needle)
    # 写死的中文星期数组只允许存在于 CalKit.weekLabels() 的两个分支里。
    mono = data.count('arrayOf("一", "二", "三", "四", "五", "六", "日")')
    sun = data.count('arrayOf("日", "一", "二", "三", "四", "五", "六")')
    if mono == 1 and sun == 1:
        ok("week label arrays live only in CalKit.weekLabels")
    else:
        fail("week label arrays must appear exactly once each in CalKit.weekLabels")
    renderer = (kt / "WidgetRenderer.kt").read_text(encoding="utf-8")
    if 'arrayOf("一"' in renderer or 'arrayOf("日"' in renderer:
        fail("renderer must not hard-code Chinese weekday arrays")
    else:
        ok("renderer has no hard-coded weekday array")
    for needle in (
        "CalKit.weekLabels(snapshot.weekStartsOn)",
        "CalKit.monthGridStart(monthStart, snapshot.weekStartsOn)",
        # 周末底色跟周首走，不能再按列号写死。
        "CalKit.weekdayIndex(dayMillis, snapshot.weekStartsOn) >= 5",
    ):
        if needle in renderer:
            ok("renderer week start has " + needle)
        else:
            fail("renderer week start missing " + needle)
    if renderer.count("CalKit.weekLabels(snapshot.weekStartsOn)") == 2:
        ok("both mini month and month use the same week labels")
    else:
        fail("week labels must be used by mini month and month (exactly 2)")
    repository = (kt / "WidgetRepository.kt").read_text(encoding="utf-8")
    if "WidgetClient.weekStartsOn(context)?.let" in repository:
        ok("repository refreshes week start without failing the summary")
    else:
        fail("repository must refresh week start best-effort")


def check_widget_four_day_gutter() -> None:
    """0.3.4（§9）：四日视图左侧时间轴槽与 6/12/18 刻度。"""
    kt = APP / "java" / "com" / "paulcai1593" / "fncal" / "app"
    renderer = (kt / "WidgetRenderer.kt").read_text(encoding="utf-8")
    for needle in (
        "val gutterW = if (isSmall) 0f else if (isLarge) dp(24f) else dp(20f)",
        "val columnW = (w - pad * 2 - gutterW) / 4f",
        "for (hour in intArrayOf(6, 12, 18))",
        "canvas.drawLine(pad + gutterW, y, w - pad, y, gridLine)",
        "drawTextRight(label, pad + gutterW - dp(2f), y + sp(3.2f), tickPaint)",
        'val label = if (isLarge) "$hour:00" else "$hour"',
        "paint(9f, colorText3)",
        "pad + gutterW + columnW * col",
        "canvas.drawCircle(pad + gutterW + dp(1.5f), y, dp(2f), solid(colorAccent))",
    ):
        if needle in renderer:
            ok("four day gutter has " + needle)
        else:
            fail("four day gutter missing " + needle)


def check_widget_agenda_frames() -> None:
    """0.3.4（§10）：今日日程与日程列表的事件框、圆点、时间列与字号。"""
    kt = APP / "java" / "com" / "paulcai1593" / "fncal" / "app"
    renderer = (kt / "WidgetRenderer.kt").read_text(encoding="utf-8")
    for needle in (
        # 框：6dp 圆角、事件色 alpha 浅色 26 / 深色 20（text_3 对比度 ≥4.5）、无描边。
        "private fun drawEventFrame(",
        "private val darkTheme",
        "alpha = if (darkTheme) 20 else 26",
        "canvas.drawRoundRect(rect, dp(6f), dp(6f), frameFill)",
        # 圆点：4dp 实心，圆心 = 基线 − 3.4sp。
        "val dotR = dp(2f)",
        "canvas.drawCircle(dotCx, dotCy, dotR, solid(eventColor))",
        "val dotCy = baseline - sp(3.4f)",
        # 时间列：2×2 24dp / 3×3 30dp / 4×4 34dp；等宽数字。
        "val timeCol = if (isSmall) dp(24f) else if (isLarge) dp(34f) else dp(30f)",
        "val timeCol = if (isLarge) dp(34f) else dp(30f)",
        'fontFeatureSettings = "tnum"',
        # 地点第二行：标题基线 + 11.5sp。
        "baseline + sp(11.5f)",
        # 行高吸附 1dp；带地点门槛 28dp；溢出「还有 N 条」9sp 右对齐。
        "snapDp(listH / rowsCap)",
        "rowH >= dp(28f)",
        "rowsCap -= 1",
        "drawTextRight(more, w - pad, h - pad - dp(2f), metaPaintNoTnum)",
    ):
        if needle in renderer:
            ok("agenda frame has " + needle)
        else:
            fail("agenda frame missing " + needle)
    # 字号：事件标题 10sp medium，时间/地点 9sp colorText3；两张卡都用。
    if renderer.count("paint(10f, colorText, mediumWeight = true)") >= 2:
        ok("agenda titles are 10sp medium in both cards")
    else:
        fail("agenda titles must be 10sp medium in both cards")
    if renderer.count("paint(9f, colorText3)") >= 2:
        ok("agenda time/location are 9sp colorText3")
    else:
        fail("agenda time/location must be 9sp colorText3")
    # 精致约束：不加阴影/描边。
    if "setShadowLayer" in renderer or "frameFill" in renderer and "STROKE" in renderer.split("frameFill")[1][:400]:
        fail("agenda frame must not add shadow or stroke")
    else:
        ok("agenda frame has no shadow or stroke")


def check_update_fallback() -> None:
    """0.3.4（§11）：三源链 Pages → 国内源 → 直通，以及版本串多处一致。"""
    import json

    kt = APP / "java" / "com" / "paulcai1593" / "fncal" / "app"
    updater = (kt / "UpdateChecker.kt").read_text(encoding="utf-8")
    markers = (
        # 三个清单地址，按优先级出现
        '"https://paulcai1593.github.io/FnCal/update.json"',
        '"https://cdn.jsdelivr.net/gh/PaulCAI1593/FnCal@main/android/update.json"',
        '"https://raw.githubusercontent.com/PaulCAI1593/FnCal/main/android/update.json"',
        # Pages 永远第一；用户选的源只决定 Pages 之后先试谁
        "val checkOrder: List<Source> = listOf(PAGES, CN, DIRECT)",
        "val order = mutableListOf(UpdateSources.Source.PAGES)",
        # 严格按 longVersionCode 比较
        "manifest.versionCode.toLong() > currentVersionCode",
        # 不比当前新就继续下一个源（0.3.1 的 bug 不能重演）
        "不判最新，继续下一个源（§11 关键）",
        # 三源都不新：取版本号最大的候选
        "if (current == null || manifest.versionCode > current.versionCode)",
        # 全失败：报第一个失败原因
        'Outcome.Failure("检查更新失败：" + (firstError ?: "所有更新源都不可用"))',
    )
    for marker in markers:
        if marker in updater:
            ok("update checker has " + marker)
        else:
            fail("update checker missing " + marker)

    # 三个来源文案齐备，关于页的 sourceName 三个分支都在。
    about = (kt / "AboutActivity.kt").read_text(encoding="utf-8")
    strings = (APP / "res" / "values" / "strings.xml").read_text(encoding="utf-8")
    for key in ("update_source_pages", "update_source_cn", "update_source_direct"):
        if key in strings and ("R.string." + key) in about:
            ok("update source label " + key)
        else:
            fail("update source label missing " + key)

    # 地址顺序：Pages 在 jsDelivr 之前，jsDelivr 在 raw 之前。
    pages_at = updater.find("MANIFEST_PAGES = ")
    cn_at = updater.find("MANIFEST_CN = ")
    direct_at = updater.find("MANIFEST_DIRECT =")
    if 0 <= pages_at < cn_at < direct_at:
        ok("manifest sources ordered pages < cn < direct")
    else:
        fail("manifest sources must be ordered pages < cn < direct")

    gradle = (ROOT / "app" / "build.gradle.kts").read_text(encoding="utf-8")
    manifest = json.loads((ROOT / "update.json").read_text(encoding="utf-8"))
    name = str(manifest.get("versionName", ""))
    code = manifest.get("versionCode")
    checks = {
        "gradle versionCode": ("versionCode = " + str(code)) in gradle,
        "gradle versionName": ('versionName = "' + name + '"') in gradle,
        "gradle resValue": ('resValue("string", "fncal_shell_version", "' + name + '")') in gradle,
        "shell UA": ('UA_SUFFIX = " FnCalAndroid/' + name + '"')
        in (kt / "MainActivity.kt").read_text(encoding="utf-8"),
        "widget UA": ('const val VERSION = "' + name + '"')
        in (kt / "WidgetClient.kt").read_text(encoding="utf-8"),
        "update.json apk": manifest.get("apk") == "FnCal-Android-" + name + ".apk",
    }
    for label, good in checks.items():
        if good:
            ok("version string agrees: " + label)
        else:
            fail("version string mismatch: " + label)
    # 0.3.4 起 workflow 由总监单独改：过渡期按自洽性规则检查（见 workflow_version_status）。
    wf_ok, wf_note = workflow_version_status(name, int(code))
    if wf_ok:
        ok("workflow version (" + wf_note + ")")
    else:
        fail("workflow version: " + wf_note)

    # 0.3.4（§11）：docs/update.json 由 Pages 提供，必须与 android/update.json 同步。
    # 0.3.5 起：两份清单必须一致（不再容忍落后）；docs 新于 android 也判失败。
    docs_file = ROOT.parent / "docs" / "update.json"
    if not docs_file.exists():
        fail("docs/update.json missing")
        return
    docs = json.loads(docs_file.read_text(encoding="utf-8"))
    same = (
        docs.get("versionCode") == manifest.get("versionCode")
        and docs.get("versionName") == manifest.get("versionName")
        and docs.get("apk") == manifest.get("apk")
    )
    if same:
        ok("docs/update.json matches android/update.json")
    else:
        fail(
            "docs/update.json not synced: %s/%s/%s vs %s/%s/%s"
            % (
                docs.get("versionName"),
                docs.get("versionCode"),
                docs.get("apk"),
                manifest.get("versionName"),
                manifest.get("versionCode"),
                manifest.get("apk"),
            )
        )


def main() -> int:
    print("root:", ROOT)
    check_xml()
    check_png()
    check_kotlin()
    check_resources()
    check_urls()
    check_update_manifest()
    check_shell_surface()
    check_widget_layout()
    check_widget_week_start()
    check_widget_four_day_gutter()
    check_widget_agenda_frames()
    check_update_fallback()
    check_update_install()
    check_server_version_refresh()
    check_gradle()
    check_theme_tokens()
    check_layouts()
    check_widgets()
    check_line_endings()
    print()
    if failures:
        print("FAILURES:", len(failures))
        for item in failures:
            print(" - " + item)
        return 1
    print("ALL STATIC CHECKS PASSED")
    return 0


if __name__ == "__main__":
    sys.exit(main())
