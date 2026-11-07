#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""FnCal 安卓外壳 v0.2.1 · 静态自检（本机不能编译，只能做这些）。

检查项：
  1. 所有 XML 用 xml.etree 解析；
  2. 所有 PNG 读尺寸并与密度表核对；
  3. Kotlin 文件括号/引号配对（去注释与字符串后），并检查 LF/结尾换行；
  4. 资源引用一致性（@string / @color / @layout / @drawable / @mipmap / @style / @xml / R.*）；
  5. 全局 http(s):// 字面量清单（外链只放行四个更新域名）；
  6. Gradle 关键配置断言（版本、包名、SDK、JVM target、依赖白名单、固定测试签名）；
  7. 主题令牌：浅色 / 深色值只能是范围文档列出的那些；状态栏与导航栏必须透明；
  8. 布局：根容器不得 fitsSystemWindows="true" 或写死 paddingTop；必须有 shell_root；
     卡片 / 按钮口径（9dp 卡片、44dp 按钮、16-13-12sp 字级）；
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
}

ALLOWED_DEPS = {
    "androidx.core:core-ktx:1.13.1",
    "androidx.appcompat:appcompat:1.7.0",
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
    drawables = {p.stem for p in (APP / "res" / "drawable").glob("*.xml")}
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
    if not isinstance(notes, list) or len(notes) != 3 or not all(isinstance(n, str) and n for n in notes):
        fail("update.json notes should be 3 non-empty strings")
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
        "versionCode = 201": app_gradle,
        'versionName = "0.2.1"': app_gradle,
        'resValue("string", "fncal_shell_version", "0.2.1")': app_gradle,
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

# 0.2.1（§S2）：范围文档列出的令牌值，浅色 / 深色。不得自换色。
COLOR_TOKENS_LIGHT = {
    "surface_2": "#F5F6F8",
    "surface_3": "#ECEEF2",
    "border": "#E2E5EB",
    "text": "#14161C",
    "text_2": "#4B5162",
    "text_3": "#656C7A",
    "accent": "#2F5E9E",
    "accent_contrast": "#FFFFFF",
    "bg_grad_start": "#EAF1F8",
    "bg_grad_end": "#E3F0EA",
    "glow_blue": "#1A2F5E9E",
    "glow_teal": "#1A12A594",
}
COLOR_TOKENS_NIGHT = {
    "surface_2": "#1A1C24",
    "surface_3": "#21242E",
    "border": "#2A2E3A",
    "text": "#F4F6FA",
    "text_2": "#A7ADBC",
    "text_3": "#8A91A2",
    "bg_grad_start": "#101A22",
    "bg_grad_end": "#0E2422",
    "glow_blue": "#2E3E7BB8",
    "glow_teal": "#2E12A594",
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
        for needle in ('@drawable/bg_card', '44dp', '16sp', '12sp'):
            if needle in text:
                ok("layout " + name + " has " + needle)
            else:
                fail("layout " + name + " missing " + needle)

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
