import hashlib, os, shutil

root = r"H:\Agent\Server\DSH\bot\projects\CalDAV"
dist = os.path.join(root, "dist")
obs = os.path.join(dist, "obsolete")

fpk = os.path.join(dist, "FnCal-0.6.11.fpk")
skill = os.path.join(dist, "FnCal-MCP-Skill-0.6.11.zip")

def sha(p):
    h = hashlib.sha256()
    with open(p, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest().upper()

fpk_b, fpk_s = os.path.getsize(fpk), sha(fpk)
sk_b, sk_s = os.path.getsize(skill), sha(skill)
print("fpk", fpk_b, fpk_s)
print("skill", sk_b, sk_s)

sums = f"{fpk_s}  FnCal-0.6.11.fpk\n{sk_s}  FnCal-MCP-Skill-0.6.11.zip\n"
sp = os.path.join(dist, "SHA256SUMS.txt")
with open(sp, "w", encoding="utf-8", newline="\n") as f:
    f.write(sums)
print("SHA256SUMS", os.path.getsize(sp), sha(sp))

rp = os.path.join(root, "README.md")
txt = open(rp, encoding="utf-8").read()
old_sha = "5834AB4D36382E594CAB00A25320AFF7B5C5BFB99CCB022CF53327F1FDE7E863"
assert txt.count(old_sha) == 1, txt.count(old_sha)
txt = txt.replace(old_sha, fpk_s, 1)
assert "\r" not in txt
open(rp, "w", encoding="utf-8", newline="\n").write(txt)
print("README", os.path.getsize(rp), sha(rp))

for name in ("FnCal-0.6.10.fpk", "FnCal-MCP-Skill-0.6.10.zip"):
    src = os.path.join(dist, name)
    if os.path.exists(src):
        shutil.move(src, os.path.join(obs, name))
        print("archived", name)

op = os.path.join(obs, "README.txt")
t = open(op, encoding="utf-8").read().replace("\r\n", "\n")

entry = (
    "0.6.10（测试包，未对外发布，不要安装）：\n"
    "  737300 B / SHA-256 5834AB4D36382E594CAB00A25320AFF7B5C5BFB99CCB022CF53327F1FDE7E863\n"
    "  技能包 FnCal-MCP-Skill-0.6.10.zip 26174 B / SHA-256 D2231DA229FE3F1E17B6DE8E3E648EC6FF4DFCF3096B1E2B78E2E6F81337B877。\n"
    "  内容：手机月视图节日、节气名与农历走同一条缩放与截断链路，名字不再只剩一个字。\n"
    "  已被 0.6.11 取代（0.6.11 修日程列表节气色与图标、日期行折行）；请直接安装 0.6.11。\n"
    "  指纹 75283bf4-hsw3o，Service Worker 缓存名 fncal-shell-0.6.10-75283bf4-hsw3o。\n"
)
anchor = "安装前：若装过 0.2.44 或更早的测试包"
assert t.count(anchor) == 1, t.count(anchor)
t = t.replace(anchor, entry + anchor, 1)

old_list = "/ 0.6.8 / 0.6.9 / 1.1.0）。"
new_list = "/ 0.6.8 / 0.6.9 / 0.6.10 / 1.1.0）。"
assert t.count(old_list) == 1, t.count(old_list)
t = t.replace(old_list, new_list, 1)

assert t.count("版本号是否为 0.6.10") == 1, t.count("版本号是否为 0.6.10")
t = t.replace("版本号是否为 0.6.10", "版本号是否为 0.6.11", 1)

old_ptr = (
    "最新有效发布候选只放在上级 dist/ 目录：\n"
    "FnCal-0.6.10.fpk（0.6.10 测试包，737300 B；SHA-256 5834AB4D36382E594CAB00A25320AFF7B5C5BFB99CCB022CF53327F1FDE7E863）。\n"
    "FnCal-MCP-Skill-0.6.10.zip（26174 B；SHA-256 D2231DA229FE3F1E17B6DE8E3E648EC6FF4DFCF3096B1E2B78E2E6F81337B877）。\n"
)
new_ptr = (
    "最新有效发布候选只放在上级 dist/ 目录：\n"
    f"FnCal-0.6.11.fpk（0.6.11 测试包，{fpk_b} B；SHA-256 {fpk_s}）。\n"
    f"FnCal-MCP-Skill-0.6.11.zip（{sk_b} B；SHA-256 {sk_s}）。\n"
)
assert t.count(old_ptr) == 1, t.count(old_ptr)
t = t.replace(old_ptr, new_ptr, 1)

assert "\r" not in t
open(op, "w", encoding="utf-8", newline="\n").write(t)
print("obsolete README", os.path.getsize(op), sha(op))
