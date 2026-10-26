#!/usr/bin/env bash
# build-fnos.sh —— 在 Linux / WSL 上打正式 .fpk（Windows 产物不用于安装）
#
# 用法：
#   EXPECTED_VERSION=0.1.0 ./scripts/build-fnos.sh
#   FNPACK_BIN=/opt/fnpack EXPECTED_VERSION=0.1.0 ./scripts/build-fnos.sh
#
# 为什么必须在 Linux 上打：fnpack 会原样保留文件模式，Windows/NTFS 上 cmd/*
# 只有 0666、没有执行位；fnOS 会直接执行 cmd/main 等生命周期脚本，缺执行位
# 会导致安装/启停钩子失败。Windows 上打出来的包只能当 test 包，不能进发布。
#
# 退出码：0 成功；非 0 失败。每条断言失败都会打印 A<N> 与原因；即使 fnpack
# 自身 exit 0，也用 stdout 断言兜底（已知 fnpack 失败也可能返回 0）。
#
# 断言清单（A1–A15，详见 M4-正式包构建说明.md）：
#   A1  Linux 平台            A2  fnpack 可执行
#   A3  LF 行尾               A4  cmd/* 已加执行位
#   A5  bash -n 语法          A6  预检 0 blocker / 0 high
#   A7  EXPECTED_VERSION 提供 A8  项目 manifest 版本 == EXPECTED_VERSION
#   A9  fnpack build exit 0   A10 stdout 含 "Packing successfully"
#   A11 .fpk 产物存在         A12 解包 cmd/* 权限 == 0755
#   A13 包内 manifest 版本 == EXPECTED_VERSION（并落 dist/FnCal-<version>.fpk）
#   A14 lifecycle 静态审计（install_init 只读/目录缺失容错，0.1.3 安装修复）
#   A15 lifecycle 模拟（Linux 沙箱按 fnOS 顺序跑 9 个脚本）
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CODE_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
PROJECT_DIR="${CODE_DIR}/fnos"
DIST_DIR="${PROJECT_DIR}/dist"
VALIDATOR="${CODE_DIR}/../.refs/fnos-developer-skill/scripts/validate_fnos_project.py"
EXPECTED_VERSION="${EXPECTED_VERSION:-${1:-}}"
FNPACK_BIN="${FNPACK_BIN:-}"
PYTHON_BIN="${PYTHON_BIN:-python3}"
LOG_DIR="$(mktemp -d)"
trap 'rm -rf "$LOG_DIR"' EXIT

die() { printf 'BUILD FAILED [%s]: %s\n' "$1" "$2" >&2; exit 1; }
ok() { printf '  [%s] OK: %s\n' "$1" "$2"; }
info() { printf '%s\n' "$1"; }
manifest_value() { grep -E "^$1[[:space:]]*=" "$PROJECT_DIR/manifest" 2>/dev/null | head -n 1 | cut -d= -f2- | tr -d '[:space:]' || true; }

info '== FnCal 正式包构建（Linux）=='

# A1 平台
case "$(uname -s)" in
  Linux*) ok A1 "Linux 平台（$(uname -s)）" ;;
  *) die A1 "请在 Linux/WSL 上运行（当前：$(uname -s)）；Windows 产物缺少 cmd/* 执行位，只能当 test 包" ;;
esac

# A2 fnpack 可执行
if [ -z "$FNPACK_BIN" ] && [ -x "${CODE_DIR}/tools/fnpack" ]; then FNPACK_BIN="${CODE_DIR}/tools/fnpack"; fi
if [ -z "$FNPACK_BIN" ] && command -v fnpack >/dev/null 2>&1; then FNPACK_BIN="$(command -v fnpack)"; fi
[ -n "$FNPACK_BIN" ] && [ -x "$FNPACK_BIN" ] || die A2 "找不到可执行的 fnpack；设置 FNPACK_BIN 指向 Linux 版（需 fnpack 1.2.3）"
ok A2 "fnpack：$FNPACK_BIN"
[ -d "$PROJECT_DIR" ] || die A2 "找不到包工程目录：${PROJECT_DIR}"

# A3 LF 行尾
if grep -RlU $'\r' "${PROJECT_DIR}/cmd" "${PROJECT_DIR}/manifest" "${PROJECT_DIR}/config" "${PROJECT_DIR}/wizard" >/dev/null 2>&1; then
  die A3 "检测到 CRLF 行尾（cmd/manifest/config/wizard）；请用 LF 重新导出"
fi
ok A3 '文本文件均为 LF'

# A4 cmd/* 执行位
chmod +x "${PROJECT_DIR}"/cmd/* || die A4 "chmod +x cmd/* 失败"
for script in "${PROJECT_DIR}"/cmd/*; do
  [ -x "$script" ] || die A4 "缺少执行位：$script"
done
ok A4 "cmd/* 已 chmod +x（$(ls -1 "${PROJECT_DIR}/cmd" | wc -l | tr -d ' ') 个脚本）"

# A5 bash -n
for script in "${PROJECT_DIR}"/cmd/*; do
  bash -n "$script" || die A5 "bash 语法检查失败：$script"
done
ok A5 'cmd/* 通过 bash -n'

# A6 静态预检 0 blocker / 0 high（medium=Windows 执行位噪音，Linux 上应消失）
[ -f "$VALIDATOR" ] || die A6 "找不到预检脚本：$VALIDATOR"
command -v "$PYTHON_BIN" >/dev/null 2>&1 || die A6 "找不到 $PYTHON_BIN，无法执行预检"
VALIDATOR_LOG="${LOG_DIR}/validator.log"
"$PYTHON_BIN" "$VALIDATOR" "$PROJECT_DIR" >"$VALIDATOR_LOG" 2>&1 || die A6 "validate_fnos_project.py 返回非 0"
if grep -qE '^[[:space:]]*\[(BLOCKER|HIGH)[[:space:]]*\]' "$VALIDATOR_LOG"; then
  die A6 "预检出现 blocker/high：$(grep -E '^[[:space:]]*\[(BLOCKER|HIGH)' "$VALIDATOR_LOG" | head -n 1)"
fi
BLOCKERS="$(grep -oE 'blocker=[0-9]+' "$VALIDATOR_LOG" | head -n 1 | cut -d= -f2 || true)"
HIGHS="$(grep -oE 'high=[0-9]+' "$VALIDATOR_LOG" | head -n 1 | cut -d= -f2 || true)"
[ "${BLOCKERS:-0}" = "0" ] || die A6 "预检 blocker=${BLOCKERS}（应为 0）"
[ "${HIGHS:-0}" = "0" ] || die A6 "预检 high=${HIGHS}（应为 0）"
VALIDATOR_SUMMARY="$(grep -E '^Summary:' "$VALIDATOR_LOG" | tail -n 1 || echo 'Summary: 无 blocker/high')"
ok A6 "预检 0 blocker / 0 high（${VALIDATOR_SUMMARY}）"

# A7 EXPECTED_VERSION 必须提供（CI 显式传入，避免误发版本）
[ -n "$EXPECTED_VERSION" ] || die A7 "必须提供 EXPECTED_VERSION（例如 EXPECTED_VERSION=0.1.0 ./scripts/build-fnos.sh）"
ok A7 "EXPECTED_VERSION=${EXPECTED_VERSION}"

# A8 项目 manifest 版本
MANIFEST_VERSION="$(manifest_value version)"
[ -n "$MANIFEST_VERSION" ] || die A8 "manifest 缺少 version="
[ "$MANIFEST_VERSION" = "$EXPECTED_VERSION" ] || die A8 "manifest version=${MANIFEST_VERSION} 与 EXPECTED_VERSION=${EXPECTED_VERSION} 不一致"
ok A8 "项目 manifest version=${MANIFEST_VERSION}"

# A14 生命周期静态审计（0.1.3 安装阻断修复：install_init 只读、目录缺失容错）
NODE_BIN="${NODE_BIN:-node}"
command -v "$NODE_BIN" >/dev/null 2>&1 || die A14 "找不到 node，无法运行 audit-lifecycle.mjs"
AUDIT_LOG="${LOG_DIR}/audit-lifecycle.log"
"$NODE_BIN" "${CODE_DIR}/scripts/audit-lifecycle.mjs" --static >"$AUDIT_LOG" 2>&1 \
  || die A14 "生命周期静态审计失败：$(tail -n 3 "$AUDIT_LOG" | tr '\n' ' ')"
grep -q 'SUMMARY: checks=[0-9]* hits=0' "$AUDIT_LOG" || die A14 "静态审计未报告 hits=0：$(tail -n 2 "$AUDIT_LOG" | tr '\n' ' ')"
ok A14 "生命周期静态审计通过（$(grep 'SUMMARY:' "$AUDIT_LOG" | tail -n 1)）"

# A15 生命周期模拟（按 fnOS 顺序跑 9 个脚本；真实行为以此为准）
[ -f "${CODE_DIR}/scripts/lifecycle-sim.sh" ] || die A15 "缺少 scripts/lifecycle-sim.sh"
SIM_LOG="${LOG_DIR}/lifecycle-sim.log"
sh "${CODE_DIR}/scripts/lifecycle-sim.sh" >"$SIM_LOG" 2>&1 \
  || die A15 "生命周期模拟失败：$(tail -n 5 "$SIM_LOG" | tr '\n' ' ')"
grep -q 'SUMMARY: pass=[0-9]* fail=0' "$SIM_LOG" || die A15 "生命周期模拟未全部通过：$(grep 'SUMMARY:' "$SIM_LOG" | tail -n 1)"
ok A15 "生命周期模拟通过（$(grep 'SUMMARY:' "$SIM_LOG" | tail -n 1)）"

# A9/A10 打包并断言 stdout（fnpack 失败也可能 exit 0）
mkdir -p "$DIST_DIR"
BUILD_LOG="${LOG_DIR}/fnpack.log"
( cd "$PROJECT_DIR" && "$FNPACK_BIN" build 2>&1 | tee "$BUILD_LOG" ) || die A9 "fnpack build 返回非 0"
ok A9 'fnpack build exit 0'
grep -q 'Packing successfully' "$BUILD_LOG" || die A10 "fnpack 输出未包含 'Packing successfully'（构建未真正成功）"
ok A10 "stdout 含 'Packing successfully'"

# A11 .fpk 产物存在（优先 appname 命名的 FnCal.fpk，其次最新 .fpk）
FPK_SRC="${PROJECT_DIR}/FnCal.fpk"
if [ ! -f "$FPK_SRC" ]; then
  FPK_SRC="$(ls -1t "${PROJECT_DIR}"/*.fpk 2>/dev/null | head -n 1 || true)"
fi
[ -n "$FPK_SRC" ] && [ -f "$FPK_SRC" ] || die A11 '未找到 .fpk 产物'
ok A11 "产物：${FPK_SRC}"

# A12 解包核对 cmd/* 权限为 0755（tar 内 -rwxr-xr-x）
command -v tar >/dev/null 2>&1 || die A12 '缺少 tar，无法核对包内 cmd/* 权限'
TAR_LIST="${LOG_DIR}/fpk-list.txt"
tar -tvf "$FPK_SRC" >"$TAR_LIST" 2>/dev/null || die A12 '无法读取 .fpk（tar -tvf 失败）'
for script in "${PROJECT_DIR}"/cmd/*; do
  name="$(basename "$script")"
  line="$(grep -E "(^| )\.?/?cmd/${name}$" "$TAR_LIST" | head -n 1 || true)"
  [ -n "$line" ] || die A12 "包内缺少 cmd/${name}"
  mode="${line%% *}"
  [ "$mode" = '-rwxr-xr-x' ] || die A12 "包内 cmd/${name} 权限为 ${mode}（应为 -rwxr-xr-x / 0755）"
done
ok A12 '包内 cmd/* 权限均为 0755'

# A13 包内 manifest 版本 == EXPECTED_VERSION，并落到 dist/FnCal-<version>.fpk
PACKED_MANIFEST="$(tar -xOf "$FPK_SRC" manifest 2>/dev/null | tr -d '\r' || true)"
[ -n "$PACKED_MANIFEST" ] || die A13 '包内缺少 manifest'
PACKED_VERSION="$(printf '%s\n' "$PACKED_MANIFEST" | grep -E '^version[[:space:]]*=' | head -n 1 | cut -d= -f2- | tr -d '[:space:]' || true)"
[ "$PACKED_VERSION" = "$EXPECTED_VERSION" ] || die A13 "包内 manifest version=${PACKED_VERSION:-(空)} 与 EXPECTED_VERSION=${EXPECTED_VERSION} 不一致"
TARGET="${DIST_DIR}/FnCal-${EXPECTED_VERSION}.fpk"
rm -f "$TARGET"
mv -f "$FPK_SRC" "$TARGET" || die A13 "移动产物到 ${TARGET} 失败"
[ -f "$TARGET" ] || die A13 "目标产物不存在：${TARGET}"
ok A13 "包内 manifest version=${PACKED_VERSION}；产物 → ${TARGET}"

info ''
info "OK: ${TARGET}（$(du -h "$TARGET" | cut -f1)）"
info '提示：Windows 上打出来的是 test 包（如 dist/FnCal-<version>-test.fpk），只作测试、不进发布。'
