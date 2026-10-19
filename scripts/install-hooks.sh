#!/usr/bin/env bash
# 启用随仓库分发的钩子。core.hooksPath 是本地配置，克隆仓库后需要执行一次。
set -euo pipefail

root="$(git rev-parse --show-toplevel)"
cd "$root"

git config core.hooksPath .githooks
chmod +x .githooks/pre-commit .githooks/pre-push .githooks/prepare-commit-msg \
	.githooks/check-filenames.py .githooks/check-identity.py

echo "已启用版本控制的钩子：core.hooksPath=.githooks"
echo "  pre-commit：凭据文件名黑名单 + gitleaks 暂存扫描 + 本机身份闭集比对"
echo "  pre-push：gitleaks 待推送提交扫描 + 本机身份闭集比对"
echo "  prepare-commit-msg：按本机 harness.coauthor 配置追加协作者声明"
echo
echo "依赖检查："
if command -v gitleaks >/dev/null 2>&1; then
	echo "  gitleaks $(gitleaks version 2>/dev/null || echo '已安装')"
else
	echo "  gitleaks 未安装，钩子会拒绝执行。安装：https://github.com/gitleaks/gitleaks#installing"
fi
if command -v python3 >/dev/null 2>&1; then
	echo "  python3 $(python3 -V 2>&1 | awk '{print $2}')"
else
	echo "  python3 未安装，钩子会拒绝执行。"
fi
