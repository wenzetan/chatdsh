#!/usr/bin/env python3
"""本机个人身份闭集比对。

两种模式：
  （无参数）        扫描暂存区内容，供 pre-commit 调用
  --range <范围>    扫描提交范围里的新增行，供 pre-push 调用

把本机 git 身份、hostname、tailnet 后缀等真实值组成闭集，逐一查找。
这一层补 gitleaks 覆盖不到的部分：姓名、账号名、主机名这类没有固定形状的值。
闭集来自本机，不写进仓库；取不到的项跳过，不因此阻断。
"""

import json
import os
import re
import socket
import subprocess
import sys

# 少于这个长度的值不参与比对，避免把常见短词当成身份
MIN_LEN = 3


def git(*args, binary=False):
    try:
        out = subprocess.run(["git", *args], capture_output=True, check=True)
        return out.stdout if binary else out.stdout.decode("utf-8", "replace")
    except (subprocess.CalledProcessError, FileNotFoundError):
        return b"" if binary else ""


def read_magicdns_suffix():
    """尝试从 tailscale status 读取 MagicDNS 后缀，失败返回空。"""
    try:
        out = subprocess.run(
            ["tailscale", "status", "--json"], capture_output=True, check=True, timeout=5,
        )
    except (subprocess.CalledProcessError, FileNotFoundError, subprocess.TimeoutExpired):
        return ""
    try:
        data = json.loads(out.stdout)
    except json.JSONDecodeError:
        return ""
    suffix = data.get("MagicDNSSuffix") or (data.get("CurrentTailnet") or {}).get("MagicDNSSuffix") or ""
    return suffix if suffix and suffix != "example.ts.net" else ""


def collect_identities():
    """收集本机真实身份，返回 (值, 说明) 列表。值本身不回显。"""
    items = []

    name = git("config", "--get", "user.name").strip()
    if name:
        items.append((name, "git 用户名"))

    email = git("config", "--get", "user.email").strip()
    if email:
        items.append((email, "git 邮箱"))
        local = email.split("@", 1)[0]
        if len(local) >= MIN_LEN:
            items.append((local, "git 邮箱前缀"))

    host = socket.gethostname()
    if host:
        items.append((host, "本机主机名"))
        short = host.split(".", 1)[0]
        if short != host and len(short) >= MIN_LEN:
            items.append((short, "本机短主机名"))

    suffix = read_magicdns_suffix()
    if suffix:
        items.append((suffix, "tailnet 后缀"))

    home = os.path.basename(os.path.expanduser("~"))
    if home and home not in ("root", "home") and len(home) >= MIN_LEN:
        items.append((home, "家目录名"))

    # 去重，保留首次出现的说明
    seen = set()
    unique = []
    for value, label in items:
        if value in seen:
            continue
        seen.add(value)
        unique.append((value, label))
    return unique


def mask_public_repo_urls(text, username):
    """仅对本仓库公开 GitHub 资源前缀做精确脱敏，其余任意位置的用户名仍照常拦截。"""
    escaped = re.escape(username)
    pattern = re.compile(
        rf"(?:https://(?:raw\.githubusercontent|github)\.com/{escaped}/chatdsh\b"
        rf"|ghcr\.io/{escaped}/chatdsh-relay\b"
        rf"|CHATDSH_GITHUB_REPO:-{escaped}/chatdsh\b)"
    )
    return pattern.sub(lambda m: " " * len(m.group(0)), text)


def scan_text(path, text, identities, hits):
    for value, label in identities:
        haystack = mask_public_repo_urls(text, value) if label == "git 用户名" else text
        if value not in haystack:
            continue
        line = haystack[: haystack.index(value)].count("\n") + 1
        hits.append((path, line, label))


def staged_texts():
    names = git("diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z")
    for path in names.split("\0"):
        if not path:
            continue
        blob = git("show", f":{path}", binary=True)
        if not blob or b"\0" in blob[:8000]:
            continue
        yield path, blob.decode("utf-8", "replace")


def range_texts(spec):
    """取提交范围的新增行，按文件归并。spec 为 A..B 或 --all。"""
    args = ["log", "-p", "--no-color", "--format=commit %H"]
    if spec == "--all":
        args.append("--all")
    else:
        args.append(spec)
    raw = git(*args)
    current = "(历史提交)"
    path = ""
    for line in raw.splitlines():
        if line.startswith("commit "):
            current = line[len("commit "):][:12]
            continue
        if line.startswith("+++ b/"):
            path = line[len("+++ b/"):]
            continue
        if line.startswith("+") and not line.startswith("+++"):
            yield f"{path}@{current}", line[1:]


def main():
    range_spec = None
    if len(sys.argv) >= 3 and sys.argv[1] == "--range":
        range_spec = sys.argv[2]

    identities = collect_identities()
    if not identities:
        return 0

    hits = []
    if range_spec:
        for path, text in range_texts(range_spec):
            scan_text(path, text, identities, hits)
    else:
        for path, text in staged_texts():
            scan_text(path, text, identities, hits)

    if not hits:
        return 0

    # 同一位置只报一次，避免逐行刷屏
    deduped = []
    seen = set()
    for path, line, label in hits:
        key = (path, label)
        if key in seen:
            continue
        seen.add(key)
        deduped.append((path, line, label))

    print("", file=sys.stderr)
    print("隐私防护：内容包含本机个人身份信息", file=sys.stderr)
    for path, line, label in deduped:
        print(f"    {path}:{line}  命中「{label}」", file=sys.stderr)
    print("", file=sys.stderr)
    print("  处理办法：把该值改成文档约定的通用写法（主机名写 node-a，", file=sys.stderr)
    print("  身份写 user，tailnet 名写 example.ts.net）。", file=sys.stderr)
    print("", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
