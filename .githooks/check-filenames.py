#!/usr/bin/env python3
"""提交前第 1 层：凭据文件名黑名单。

命中与内容无关，只看路径。模板与示例文件按后缀放行，真实值应放在被忽略的文件里。
路径片段写进 .secret-guard-allow 可以放行，每行一条，`#` 开头为注释。
"""

import re
import subprocess
import sys
from pathlib import Path

# 模板与示例文件是给人抄的骨架，本身不含真实值
TEMPLATE = re.compile(
    r"\.(?:example|sample|template|dist|schema)$|(?:^|/)\.env\.(?:example|sample|template|dist)$",
    re.I,
)

CREDENTIAL = [
    r"(^|/)\.env(\.[^/]+)?$",
    r"(^|/)\.envrc$",
    r"(^|/)dev\.vars$",
    r"(^|/)\.dev\.vars$",
    r"(^|/)\.flaskenv$",
    r"(^|/)(?:config|settings|credentials|secrets|auth)\.local\.[A-Za-z0-9]+$",
    r"(^|/)\.netrc$",
    r"(^|/)_netrc$",
    r"(^|/)\.npmrc$",
    r"(^|/)\.yarnrc(\.yml)?$",
    r"(^|/)\.pypirc$",
    r"(^|/)\.git-credentials$",
    r"(^|/)\.htpasswd$",
    r"(^|/)\.gem/credentials$",
    r"(^|/)\.config/gcloud/",
    r"(^|/)\.aws/credentials$",
    r"(^|/)\.docker/config\.json$",
    r"(^|/)\.kube/config$",
    r"(^|/)\.ssh/",
    r"(^|/)id_(?:rsa|dsa|ecdsa|ed25519)$",
    r"\.(?:pem|key|p12|pfx|jks|keystore|ppk|keytab|ovpn|mobileconfig|der)$",
    r"(^|/)credentials?\.json$",
    r"(^|/)[^/]*service[-_]?account[^/]*\.json$",
    r"(^|/)secrets?\.(?:json|ya?ml|toml|txt|ini|properties)$",
    r"(^|/)[^/]*\.secrets?\.(?:json|ya?ml|toml)$",
    r"(^|/)[^/]*(?:secrets?|credentials?|passwords?|passwd|api[-_]?keys?|access[-_]?keys?|private[-_]?keys?|tokens?|auth)\.(?:json|ya?ml|toml|ini|properties|txt|env)$",
    r"(^|/)terraform\.tfstate(?:\.backup)?$",
    r"\.tfvars(?:\.json)?$",
    r"(^|/)\.terraform/",
    r"(^|/)cookies\.txt$",
    r"(^|/)[^/]*\.session$",
    # 本机的 Tailscale 状态导出包含真实节点身份
    r"(^|/)tailscale-status[^/]*\.json$",
    r"(^|/)tmp-ts\.json$",
]
CREDENTIAL_RE = [re.compile(p, re.I) for p in CREDENTIAL]


def load_allow():
    path = Path(".secret-guard-allow")
    if not path.exists():
        return []
    entries = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if line and not line.startswith("#"):
            entries.append(line)
    return entries


def staged_paths():
    out = subprocess.run(
        ["git", "diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"],
        check=True, capture_output=True,
    ).stdout
    return [p.decode("utf-8", "surrogateescape") for p in out.split(b"\0") if p]


def main():
    allow = load_allow()
    hits = []
    for path in staged_paths():
        if any(path == a or path.startswith(a) for a in allow):
            continue
        if TEMPLATE.search(path):
            continue
        if any(r.search(path) for r in CREDENTIAL_RE):
            hits.append(path)

    if not hits:
        return 0

    print("", file=sys.stderr)
    print("隐私防护：本次提交包含凭据类或本地数据文件", file=sys.stderr)
    for path in hits:
        print(f"    {path}", file=sys.stderr)
    print("", file=sys.stderr)
    print("  处理办法", file=sys.stderr)
    print("    - 确认不是凭据：把路径片段写进 .secret-guard-allow，每行一条", file=sys.stderr)
    print("    - 确认是凭据：git restore --staged <文件>，改为从环境变量读取", file=sys.stderr)
    print("", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
