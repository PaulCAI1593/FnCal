#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Kotlin 交叉引用自检（本机没有 Android SDK / Gradle / kotlinc，用它兜住低级错）。

不做类型检查，只查这四类「一编就红」的错：

  1. 括号/花括号/方括号是否配平（跳过注释、字符串、字符字面量与 `${...}` 模板）；
  2. 代码里用到的 `R.string.x` / `R.color.x` / `R.id.x` / `R.layout.x` / `R.xml.x` 是否真的存在；
  3. `WidgetTokens.xxx` / `WidgetStats.xxx` / `CalKit.xxx` / `WidgetPrefs.xxx` 这些跨文件调用
     是否在被调用文件里声明过（常量、fun、data class、object 均可）；
  4. 文件里不许留 `TODO` / `FIXME` / `后续版本` 之类的占位。

用法：python projects/FnCal/android/tools/check_kotlin_refs.py
退出码 0 = 全过。
"""
import io
import os
import re
import sys
import xml.etree.ElementTree as ET

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "app", "src", "main", "java", "com", "paulcai1593", "fncal", "app")
TEST_SRC = os.path.join(ROOT, "app", "src", "test", "java", "com", "paulcai1593", "fncal", "app")
RES = os.path.join(ROOT, "app", "src", "main", "res")

FAILS = []


def fail(message):
    FAILS.append(message)
    print("FAIL " + message)


def ok(message):
    print("ok   " + message)


def read(path):
    with io.open(path, encoding="utf-8", newline="") as handle:
        return handle.read()


def strip_code(source):
    """去掉注释、字符串与字符字面量，但保留 `${...}` 里的表达式。"""
    out = []
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
            depth = 1
            i += 2
            while i < n and depth:
                if source.startswith("/*", i):
                    depth += 1
                    i += 2
                    continue
                if source.startswith("*/", i):
                    depth -= 1
                    i += 2
                    continue
                i += 1
            continue
        if source.startswith('"""', i):
            i += 3
            while i < n and not source.startswith('"""', i):
                i += 1
            i += 3
            continue
        if ch == '"':
            i += 1
            while i < n:
                if source[i] == "\\":
                    i += 2
                    continue
                if source[i] == '"':
                    i += 1
                    break
                if source.startswith("${", i):
                    depth = 1
                    i += 2
                    start = i
                    while i < n and depth:
                        if source[i] == "{":
                            depth += 1
                        elif source[i] == "}":
                            depth -= 1
                        i += 1
                    out.append(source[start:i - 1])
                    continue
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


def check_balance(name, code):
    pairs = {")": "(", "]": "[", "}": "{"}
    stack = []
    for index, ch in enumerate(code):
        if ch in "([{":
            stack.append(ch)
        elif ch in pairs:
            if not stack or stack[-1] != pairs[ch]:
                line = code.count("\n", 0, index) + 1
                fail("%s:%d 括号不配平（遇到 %s）" % (name, line, ch))
                return
            stack.pop()
    if stack:
        fail("%s 结尾还有 %d 个未闭合的 %s" % (name, len(stack), "".join(stack[-3:])))
    else:
        ok("%s 括号配平" % name)


def collect_decls(paths):
    decls = set()
    pattern = re.compile(r"(?:fun|val|var|const val|class|object|enum class|data class)\s+([A-Za-z_][A-Za-z0-9_]*)")
    for path in paths:
        for name in pattern.findall(read(path)):
            decls.add(name)
    return decls


def check_refs(name, code, prefix, decls):
    used = set(re.findall(r"\b" + prefix + r"\.([A-Za-z_][A-Za-z0-9_]*)", code))
    missing = sorted(item for item in used if item not in decls)
    if missing:
        fail("%s 用到 %s.%s 但没找到声明" % (name, prefix, "、".join(missing)))
    else:
        ok("%s 的 %s.* 引用都能对上（%d 个）" % (name, prefix, len(used)))


def resource_names(kind, tag, attribute="name"):
    directory = os.path.join(RES, kind)
    names = set()
    if not os.path.isdir(directory):
        return names
    for entry in sorted(os.listdir(directory)):
        if not entry.endswith(".xml"):
            continue
        text = read(os.path.join(directory, entry))
        for value in re.findall(r'<' + tag + r'[^>]*\b' + attribute + r'="([^"]+)"', text):
            names.add(value)
        names.add(os.path.splitext(entry)[0])
    return names


def main():
    kt_files = sorted(
        os.path.join(SRC, name) for name in os.listdir(SRC) if name.endswith(".kt")
    )
    test_files = sorted(
        os.path.join(TEST_SRC, name) for name in os.listdir(TEST_SRC) if name.endswith(".kt")
    ) if os.path.isdir(TEST_SRC) else []
    print("kotlin files:", len(kt_files), "test files:", len(test_files))

    sources = {}
    for path in kt_files + test_files:
        name = os.path.basename(path)
        raw = read(path)
        code = strip_code(raw)
        sources[name] = code
        check_balance(name, code)
        for bad in ("TODO", "FIXME", "后续版本"):
            if bad in code:
                fail("%s 里还有占位 %s" % (name, bad))

    # R.* 资源引用
    string_names = set()
    strings_xml = os.path.join(RES, "values", "strings.xml")
    for node in ET.parse(strings_xml).getroot():
        if node.get("name"):
            string_names.add(node.get("name"))
    color_names = resource_names("values", "color")
    for entry in ("values-night",):
        color_names |= resource_names(entry, "color")
    id_names = set()
    id_file = os.path.join(RES, "values", "ids.xml")
    if os.path.isfile(id_file):
        for node in ET.parse(id_file).getroot():
            if node.get("name"):
                id_names.add(node.get("name"))
    layout_names = set()
    layout_dir = os.path.join(RES, "layout")
    for entry in os.listdir(layout_dir):
        if entry.endswith(".xml"):
            layout_names.add(os.path.splitext(entry)[0])
            text = read(os.path.join(layout_dir, entry))
            for value in re.findall(r'android:id="@\+id/([A-Za-z0-9_]+)"', text):
                id_names.add(value)
    xml_names = set()
    xml_dir = os.path.join(RES, "xml")
    for entry in os.listdir(xml_dir):
        if entry.endswith(".xml"):
            xml_names.add(os.path.splitext(entry)[0])

    tables = {
        "string": string_names,
        "color": color_names,
        "id": id_names,
        "layout": layout_names,
        "xml": xml_names,
    }
    for name, code in sources.items():
        for kind, known in tables.items():
            used = set(re.findall(r"R\." + kind + r"\.([A-Za-z0-9_]+)", code))
            missing = sorted(item for item in used if item not in known)
            if missing:
                fail("%s 引用不存在的 R.%s.%s" % (name, kind, "、".join(missing)))
            elif used:
                ok("%s 的 R.%s.* 都存在（%d 个）" % (name, kind, len(used)))

    # 跨文件引用：WidgetTokens / WidgetStats / CalKit / WidgetPrefs / WidgetCards041
    targets = {
        "WidgetTokens": ["WidgetTokens.kt"],
        "WidgetStats": ["WidgetStats.kt"],
        "CalKit": ["WidgetData.kt"],
        "WidgetPrefs": ["WidgetPrefs.kt"],
        "WidgetClient": ["WidgetClient.kt"],
    }
    for prefix, files in targets.items():
        paths = [os.path.join(SRC, item) for item in files]
        missing_files = [item for item in files if not os.path.isfile(os.path.join(SRC, item))]
        if missing_files:
            fail("找不到 %s 的声明文件 %s" % (prefix, "、".join(missing_files)))
            continue
        decls = collect_decls(paths)
        for name, code in sources.items():
            if name in files:
                continue
            check_refs(name, code, prefix, decls)

    print()
    if FAILS:
        print("FAILURES:", len(FAILS))
        for item in FAILS:
            print(" - " + item)
        return 1
    print("ALL KOTLIN REFERENCE CHECKS PASSED")
    return 0


if __name__ == "__main__":
    sys.exit(main())
