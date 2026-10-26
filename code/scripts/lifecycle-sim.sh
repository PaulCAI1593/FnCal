#!/bin/sh
# lifecycle-sim.sh —— 在 Linux 上用临时沙箱模拟 fnOS 生命周期顺序，验证 0.1.3
# 「install_init 不再把数据目录缺失当失败」的安装阻断修复。
#
# 由 build-fnos.sh 的 A15 调用；也可单独运行：
#   sh code/scripts/lifecycle-sim.sh
#   CMD_DIR=/path/to/fnos/cmd bash code/scripts/lifecycle-sim.sh
#
# 覆盖：
#   a) 全新安装：VAR 不存在、父目录可写 → install_init 退出 0 且**不创建 VAR**
#      → install_callback 退出 0 并建好子目录 → main status=3、main stop=0；
#   b) VAR 不存在且父路径是普通文件（mkdir 必失败）→ install_init 退出 0（关键
#      回归项）；install_callback 非 0 且输出带诊断；
#   c) 已有 VAR（config.json/secret.key）→ 两个初始化脚本退出 0 且配置不被覆盖；
#   d) 目录缺失时 upgrade_init / config_init / uninstall_init / uninstall_callback
#      （keep 分支）全部退出 0；
#   e) 非 root 下 VAR 存在但不可写 → install_init 只警告并退出 0（root 下跳过，
#      因为 root 无视权限位，改由静态审计覆盖）；
#   g) 安装向导自定义端口（0.1.4）；
#   h) config_callback 改端口语义（0.1.4）；
#   i) 安装向导管理员密码（0.1.6）；
#   j) 0.2.7 覆盖升级：旧版本 server.mjs 仍在运行（pid 文件已丢失）→ main stop 按
#      「自家进程」标记回收；upgrade_init 会先停旧进程再备份（真机 5581 端口占用的回归项）。
#
# 输出末行固定 `SUMMARY: pass=N fail=M`；失败退出 1。
#
# 本机限制：Windows 沙箱内 Git Bash fork 报 Win32 error 5、WSL E_ACCESSDENIED，
# 因此本脚本只能在 Linux/CI 或真机 shell 中真跑；Windows 本机只跑
# audit-lifecycle.mjs（静态）。
set -u

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
CODE_DIR=$(CDPATH= cd -- "${SCRIPT_DIR}/.." && pwd)
CMD_DIR="${CMD_DIR:-${CODE_DIR}/fnos/cmd}"
BASH_BIN="${BASH_BIN:-bash}"
PASS=0
FAIL=0

say() { printf '%s\n' "$1"; }
pass() { PASS=$((PASS + 1)); printf '[PASS] %s\n' "$1"; }
fail() { FAIL=$((FAIL + 1)); printf '[FAIL] %s\n' "$1"; }

check_status() {
  name="$1"; expected="$2"; actual="$3"
  if [ "$expected" = "$actual" ]; then pass "$name（exit=$actual）"; else fail "$name（expected=$expected actual=$actual）"; fi
}
check_contains() {
  name="$1"; needle="$2"; haystack="$3"
  case "$haystack" in
    *"$needle"*) pass "$name" ;;
    *) fail "$name（输出缺少「$needle」）" ;;
  esac
}
check_dir() {
  name="$1"; dir="$2"
  if [ -d "$dir" ]; then pass "$name"; else fail "$name（目录不存在：$dir）"; fi
}
file_hash() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" 2>/dev/null | cut -d' ' -f1
  else
    cksum "$1" 2>/dev/null | cut -d' ' -f1-2
  fi
}

RUN_OUT=""
RUN_STATUS=0
run_script() {
  script="$1"
  shift
  RUN_OUT=$("$BASH_BIN" "${CMD_DIR}/${script}" "$@" 2>&1)
  RUN_STATUS=$?
}

if ! command -v "$BASH_BIN" >/dev/null 2>&1; then
  say "SUMMARY: pass=0 fail=1"
  say "缺少 bash：生命周期脚本以 #!/bin/bash 编写，请在 Linux/CI（已安装 bash）运行。"
  exit 1
fi
if [ ! -d "$CMD_DIR" ]; then
  say "SUMMARY: pass=0 fail=1"
  say "找不到生命周期脚本目录：${CMD_DIR}（先运行 assemble.mjs）"
  exit 1
fi

BASE=$(mktemp -d "${TMPDIR:-/tmp}/fncal-lifecycle.XXXXXX") || { say "无法创建临时目录"; exit 1; }
cleanup() {
  if [ -n "${FAKE_PID:-}" ] && kill -0 "$FAKE_PID" 2>/dev/null; then
    kill -TERM "$FAKE_PID" 2>/dev/null || true
    kill -KILL "$FAKE_PID" 2>/dev/null || true
  fi
  rm -rf "$BASE"
}
trap cleanup EXIT INT TERM

say "fnOS 生命周期模拟（uid=$(id -u 2>/dev/null || echo '?') user=$(id -un 2>/dev/null || echo '?')）"
say "CMD_DIR=${CMD_DIR}"
if [ "$(id -u)" -eq 0 ]; then
  say "NOTE: 当前以 root 运行；CI 应以普通用户运行（等价包用户视角）。权限差异用例将跳过。"
else
  say "以普通用户运行（等价于 fnOS run-as=package 的包用户视角）。"
fi

# 统一的模拟环境（等价于应用中心注入的 TRIM_* 变量）
export TRIM_APPDEST="$BASE/app"
export TRIM_TEMP_LOGFILE="$BASE/install.log"
export TRIM_APPNAME=FnCal
export TRIM_APPVER=0.1.3
export TRIM_USERNAME="$(id -un 2>/dev/null || echo caldav)"
export TRIM_GROUPNAME="$(id -gn 2>/dev/null || id -un 2>/dev/null || echo caldav)"
unset TRIM_PKGETC TRIM_PKGHOME TRIM_OLD_APPVER 2>/dev/null || true
unset wizard_keep_data wizard_admin_username wizard_log_level 2>/dev/null || true
unset wizard_port wizard_admin_password wizard_admin_password_confirm CALDAV_ADMIN_PASSWORD 2>/dev/null || true

# ---------------------------------------------------------------- a) 全新安装
say ''
say '== a) 全新安装：VAR 不存在、父目录可写 =='
mkdir -p "$BASE/vol1/@appdata"
export TRIM_PKGVAR="$BASE/vol1/@appdata/FnCal"

run_script install_init
check_status 'a1 install_init 在 VAR 缺失时退出 0' 0 "$RUN_STATUS"
check_contains 'a1 记录「数据目录尚未创建」' '数据目录尚未创建' "$RUN_OUT"
if [ -e "$TRIM_PKGVAR" ]; then
  fail 'a2 install_init 不得创建 VAR（只读预检）'
else
  pass 'a2 install_init 未创建 VAR'
fi

run_script install_callback
check_status 'a3 install_callback 创建目录并退出 0' 0 "$RUN_STATUS"
for sub in logs run calendars backups; do
  check_dir "a4 子目录 ${sub} 已创建" "$TRIM_PKGVAR/$sub"
done
if [ -s "$TRIM_PKGVAR/config.json" ]; then pass 'a5 config.json 已生成'; else fail 'a5 config.json 缺失'; fi
if [ -s "$TRIM_PKGVAR/secret.key" ]; then pass 'a6 secret.key 已生成'; else fail 'a6 secret.key 缺失'; fi

run_script main status
check_status 'a7 main status（未运行）应为 3' 3 "$RUN_STATUS"
run_script main stop
check_status 'a8 main stop（未运行）应为 0' 0 "$RUN_STATUS"

# ------------------------------------- b) 父路径是普通文件（mkdir 必然失败）
say ''
say '== b) VAR 不存在且父路径是普通文件 =='
: >"$BASE/blocked"
export TRIM_PKGVAR="$BASE/blocked/FnCal"

run_script install_init
check_status 'b1 install_init 仍退出 0（关键回归项）' 0 "$RUN_STATUS"
run_script install_callback
if [ "$RUN_STATUS" -ne 0 ]; then
  pass "b2 install_callback 非 0（预期失败，exit=$RUN_STATUS）"
else
  fail 'b2 install_callback 应失败但返回 0'
fi
check_contains 'b3 失败输出含诊断标题' '诊断信息' "$RUN_OUT"
check_contains 'b4 诊断含 uid' 'uid=' "$RUN_OUT"
check_contains 'b5 失败原因中文可读' '无法创建应用数据目录' "$RUN_OUT"

# ------------------------------------------------ c) 已有数据：幂等、不覆盖
say ''
say '== c) 已有 VAR（config.json/secret.key）→ 幂等 =='
export TRIM_PKGVAR="$BASE/vol1/@appdata/FnCal"
CONFIG_BEFORE=$(file_hash "$TRIM_PKGVAR/config.json")
SECRET_BEFORE=$(file_hash "$TRIM_PKGVAR/secret.key")

run_script install_init
check_status 'c1 install_init（VAR 已存在）退出 0' 0 "$RUN_STATUS"
run_script install_callback
check_status 'c2 install_callback（VAR 已存在）退出 0' 0 "$RUN_STATUS"
CONFIG_AFTER=$(file_hash "$TRIM_PKGVAR/config.json")
SECRET_AFTER=$(file_hash "$TRIM_PKGVAR/secret.key")
if [ "$CONFIG_BEFORE" = "$CONFIG_AFTER" ]; then
  pass 'c3 config.json 未被覆盖'
else
  fail 'c3 config.json 被改写了'
fi
if [ "$SECRET_BEFORE" = "$SECRET_AFTER" ]; then
  pass 'c4 secret.key 未被覆盖'
else
  fail 'c4 secret.key 被改写了'
fi

# ------------------------------------- d) 只读阶段：目录缺失一律 exit 0
say ''
say '== d) 目录缺失时的只读/卸载阶段 =='
export TRIM_PKGVAR="$BASE/vol1/@appdata/Missing/FnCal"
for pair in 'upgrade_init:d1' 'config_init:d2' 'uninstall_init:d3' 'uninstall_callback:d4'; do
  script=${pair%%:*}
  label=${pair##*:}
  run_script "$script"
  check_status "${label} ${script} 退出 0" 0 "$RUN_STATUS"
done

# ------------------------- f) TRIM_APPDEST 未注入 → 仍 exit 0（0.1.3 复核）
say ''
say '== f) TRIM_APPDEST 未注入 =='
unset TRIM_APPDEST
export TRIM_PKGVAR="$BASE/vol1/@appdata/NoAppdest/FnCal"
run_script install_init
check_status 'f1 APPDEST 未注入时 install_init 退出 0' 0 "$RUN_STATUS"
check_contains 'f2 输出「TRIM_APPDEST 未注入」' 'TRIM_APPDEST 未注入' "$RUN_OUT"
export TRIM_APPDEST="$BASE/app"

# ------------------------------- e) 非 root：VAR 存在但不可写 → 只警告
say ''
if [ "$(id -u)" -ne 0 ]; then
  say '== e) 非 root：VAR 存在但不可写 =='
  mkdir -p "$BASE/readonly/FnCal"
  chmod 555 "$BASE/readonly/FnCal"
  export TRIM_PKGVAR="$BASE/readonly/FnCal"
  run_script install_init
  check_status 'e1 不可写时 install_init 仍退出 0' 0 "$RUN_STATUS"
  check_contains 'e2 输出只读警告' '不可写' "$RUN_OUT"
  chmod 755 "$BASE/readonly/FnCal" 2>/dev/null || true
else
  say '== e) 跳过：root 下权限位不生效（静态审计 audit-lifecycle.mjs 覆盖该路径）=='
fi

# ------------------------------- g) 安装向导自定义端口（0.1.4）
say ''
say '== g) 安装向导 wizard_port =='
for spec in '5290:g1' '80:g2' 'abc:g3'; do
  val=${spec%%:*}
  label=${spec##*:}
  export TRIM_PKGVAR="$BASE/port-${label}/FnCal"
  rm -rf "$BASE/port-${label}" 2>/dev/null || true
  export wizard_port="$val"
  run_script install_callback
  check_status "${label} wizard_port=${val} 安装继续（exit 0）" 0 "$RUN_STATUS"
  if [ "$val" = '5290' ]; then
    expected_port=5290
  else
    expected_port=5280
    check_contains "${label} 非法端口回退并记日志" '回退 5280' "$RUN_OUT"
  fi
  if grep -q "\"port\": ${expected_port}" "$TRIM_PKGVAR/config.json" 2>/dev/null; then
    pass "${label} config.json port=${expected_port}"
  else
    fail "${label} config.json 未写入 port=${expected_port}"
  fi
done
unset wizard_port 2>/dev/null || true

# --------------- h) 安装后改端口：未变化不重启 / 非法则失败且配置不变
say ''
say '== h) config_callback 改端口语义（0.1.4）=='
export TRIM_PKGVAR="$BASE/vol1/@appdata/FnCal"
unset wizard_log_level 2>/dev/null || true
main_status_before=0
run_script main status || true
main_status_before=$RUN_STATUS
CONFIG_HASH_BEFORE=$(file_hash "$TRIM_PKGVAR/config.json")

export wizard_port=5280
run_script config_callback
check_status 'h1 端口未变化 → exit 0' 0 "$RUN_STATUS"
check_contains 'h2 端口未变化 → 提示且不重启' '端口未变化' "$RUN_OUT"
CONFIG_HASH_AFTER=$(file_hash "$TRIM_PKGVAR/config.json")
if [ "$CONFIG_HASH_BEFORE" = "$CONFIG_HASH_AFTER" ]; then
  pass 'h3 端口未变化 → config.json 未被改写'
else
  fail 'h3 端口未变化却改写了 config.json'
fi
run_script main status || true
check_status 'h4 端口未变化 → 服务仍未运行（main status=3，未触发重启）' "$main_status_before" "$RUN_STATUS"

export wizard_port=80
run_script config_callback
if [ "$RUN_STATUS" -ne 0 ]; then
  pass "h5 端口非法 → 非 0 退出（exit=$RUN_STATUS）"
else
  fail 'h5 端口非法却返回 0'
fi
check_contains 'h6 端口非法 → 中文报错' '端口必须是 1024' "$RUN_OUT"
CONFIG_HASH_AFTER=$(file_hash "$TRIM_PKGVAR/config.json")
if [ "$CONFIG_HASH_BEFORE" = "$CONFIG_HASH_AFTER" ]; then
  pass 'h7 端口非法 → config.json 不变'
else
  fail 'h7 端口非法却改写了 config.json'
fi

export wizard_port=abc
run_script config_callback
if [ "$RUN_STATUS" -ne 0 ]; then
  pass "h8 端口非数字 → 非 0 退出（exit=$RUN_STATUS）"
else
  fail 'h8 端口非数字却返回 0'
fi
unset wizard_port 2>/dev/null || true

# ------------------- i) 安装时设置管理员密码（0.1.6）
say ''
say '== i) 安装向导管理员密码 =='
# i1 两次一致 → 写 admin-password.init 0600
export TRIM_PKGVAR="$BASE/pwd-ok/FnCal"
rm -rf "$BASE/pwd-ok" 2>/dev/null || true
export wizard_admin_password='Passw0rd-123'
export wizard_admin_password_confirm='Passw0rd-123'
run_script install_callback
check_status 'i1 密码一致 → install_callback 退出 0' 0 "$RUN_STATUS"
if [ -f "$TRIM_PKGVAR/admin-password.init" ]; then
  pass 'i2 已写入 admin-password.init'
else
  fail 'i2 admin-password.init 缺失'
fi
PWD_MODE=$(stat -c '%a' "$TRIM_PKGVAR/admin-password.init" 2>/dev/null || echo '?')
if [ "$PWD_MODE" = '600' ]; then
  pass 'i3 admin-password.init 权限 0600'
else
  fail "i3 admin-password.init 权限为 ${PWD_MODE}（应为 600）"
fi
if [ "$(cat "$TRIM_PKGVAR/admin-password.init" 2>/dev/null)" = "$wizard_admin_password" ]; then
  pass 'i4 文件内容与安装时输入一致'
else
  fail 'i4 文件内容与安装时输入不一致'
fi

# i2 两次不一致 → 中文报错且中止
export TRIM_PKGVAR="$BASE/pwd-bad/FnCal"
rm -rf "$BASE/pwd-bad" 2>/dev/null || true
export wizard_admin_password_confirm='Different-123'
run_script install_callback
if [ "$RUN_STATUS" -ne 0 ]; then
  pass "i5 两次不一致 → 非 0 退出（exit=$RUN_STATUS）"
else
  fail 'i5 两次不一致却返回 0'
fi
check_contains 'i6 两次不一致 → 中文报错' '两次输入的管理员密码不一致' "$RUN_OUT"

# i3 密码过短 → 中文报错且中止
export TRIM_PKGVAR="$BASE/pwd-short/FnCal"
rm -rf "$BASE/pwd-short" 2>/dev/null || true
export wizard_admin_password='short'
export wizard_admin_password_confirm='short'
run_script install_callback
if [ "$RUN_STATUS" -ne 0 ]; then
  pass "i7 密码过短 → 非 0 退出（exit=$RUN_STATUS）"
else
  fail 'i7 密码过短却返回 0'
fi
check_contains 'i8 密码过短 → 中文报错' '至少 8 位' "$RUN_OUT"

# i4 空密码 → 随机兜底，不写一次性文件
export TRIM_PKGVAR="$BASE/pwd-empty/FnCal"
rm -rf "$BASE/pwd-empty" 2>/dev/null || true
unset wizard_admin_password wizard_admin_password_confirm 2>/dev/null || true
run_script install_callback
check_status 'i9 空密码 → 安装继续（exit 0）' 0 "$RUN_STATUS"
if [ -f "$TRIM_PKGVAR/admin-password.init" ]; then
  fail 'i10 空密码不应写 admin-password.init'
else
  pass 'i10 空密码 → 走随机兜底（无一次性密码文件）'
fi

# --------------- j) 0.2.7 覆盖升级：旧版本进程仍在运行（真机 5581 端口占用回归项）
say ''
say '== j) 覆盖升级：旧版本 server.mjs 仍在运行（pid 文件已丢失）=='
export TRIM_PKGVAR="$BASE/vol1/@appdata/FnCal"
export TRIM_APPDEST="$BASE/app"
export TRIM_APPVER=0.2.7
mkdir -p "$BASE/fake" "$TRIM_PKGVAR/run" 2>/dev/null || true

# 伪造「旧版本 server.mjs」：cmdline 含 server.mjs，environ 带本应用的 TRIM_PKGVAR，
# 与 cmd/main 的「自家进程」判定口径一致（真实场景是 node .../server/server.mjs）。
cat >"$BASE/fake/server.mjs" <<'FAKE_SERVER'
#!/bin/sh
while :; do sleep 1; done
FAKE_SERVER
chmod +x "$BASE/fake/server.mjs" 2>/dev/null || true

start_fake_old() {
  FAKE_PID=""
  TRIM_PKGVAR="$TRIM_PKGVAR" TRIM_APPDEST="$TRIM_APPDEST" TRIM_APPVER="${TRIM_OLD_APPVER:-0.2.6}" \
    "$BASH_BIN" "$BASE/fake/server.mjs" >/dev/null 2>&1 &
  FAKE_PID=$!
  sleep 1
}

# j1/j2/j3：pid 文件缺失 → main stop 仍按自家标记回收
rm -f "$TRIM_PKGVAR/run/service.pid" 2>/dev/null || true
start_fake_old
if kill -0 "$FAKE_PID" 2>/dev/null; then
  pass 'j1 模拟旧版本进程已启动（pid 文件不存在）'
else
  fail 'j1 模拟旧版本进程未启动'
fi
run_script main stop
check_status 'j2 pid 文件缺失时 main stop 仍退出 0' 0 "$RUN_STATUS"
if kill -0 "$FAKE_PID" 2>/dev/null; then
  fail 'j3 残留的本应用进程未被回收（真实场景就是端口被永久占住）'
else
  pass 'j3 pid 文件缺失时按自家标记回收了残留进程'
fi
check_contains 'j4 日志说明回收了残留进程' '残留进程' "$RUN_OUT"

# j5/j6/j7：upgrade_init 必须先停旧进程再备份
start_fake_old
run_script upgrade_init
check_status 'j5 upgrade_init 在旧进程运行时退出 0' 0 "$RUN_STATUS"
if kill -0 "$FAKE_PID" 2>/dev/null; then
  fail 'j6 upgrade_init 未停掉旧版本进程（覆盖升级会报端口占用）'
else
  pass 'j6 upgrade_init 已停掉旧版本进程'
fi
check_contains 'j7 upgrade_init 记录「已停止旧版本服务」' '已停止旧版本服务' "$RUN_OUT"

# j8：无残留时 main stop 幂等（不得因为 /proc 扫描报错）
FAKE_PID=""
run_script main stop
check_status 'j8 无残留进程时 main stop 幂等（exit 0）' 0 "$RUN_STATUS"

say ''
say "SUMMARY: pass=${PASS} fail=${FAIL}"
if [ "$FAIL" -ne 0 ]; then exit 1; fi
exit 0
