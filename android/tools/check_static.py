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
    allowed_hosts = {
        "cdn.jsdelivr.net",
        "raw.githubusercontent.com",
        "gh-proxy.com",
        "github.com",
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
    if not isinstance(notes, list) or not (3 <= len(notes) <= 6) \
            or not all(isinstance(n, str) and n for n in notes):
        fail("update.json notes should be 3-6 non-empty strings")
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
        "versionCode = 300": app_gradle,
        'versionName = "0.3.0"': app_gradle,
        'resValue("string", "fncal_shell_version", "0.3.0")': app_gradle,
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
    # 正文 10sp / 标题 12sp；任何绘制字号都不得低于 10sp（用户要求不许裁一半、不许更小）。
    sizes = [float(x) for x in re.findall(r"\bpaint\((\d+(?:\.\d+)?)f", renderer)]
    if sizes and min(sizes) < 10:
        fail("widget text below 10sp: " + repr(min(sizes)))
    else:
        ok("widget text all >= 10sp")

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
    for needle in ('UA_SUFFIX = " FnCalAndroid/0.3.0"', "DeviceName.suffix()", "EXTRA_VIEW", 'fncal-view=', "onNewIntent"):
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

    # ⑧ 发版口径：workflow 的 tag / 资产名跟版本走。
    workflow = ROOT.parent / ".github" / "workflows" / "android.yml"
    wf = workflow.read_text(encoding="utf-8") if workflow.is_file() else ""
    for needle in ("TAG=android-v0.3.0", "OUT=FnCal-Android-0.3.0.apk", "versionCode='300'", "versionName='0.3.0'"):
        if needle in wf:
            ok("workflow has " + needle)
        else:
            fail("workflow missing " + needle)


def main() -> int:
    print("root:", ROOT)
    check_xml()
    check_png()
    check_kotlin()
    check_resources()
    check_urls()
    check_update_manifest()
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
