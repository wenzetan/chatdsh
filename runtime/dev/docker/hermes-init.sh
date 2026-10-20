#!/usr/bin/env bash
# hermes 容器入口：把模型网关写进 hermes 配置，然后启动 gateway。
#
# gateway 的 api_server 监听 8642，宿主侧映射到 18642。
# 模型配置写在 hermes 自己的数据目录里（容器内的卷），键来自环境变量。
set -euo pipefail

GATEWAY_URL="${CHATDSH_TEST_GATEWAY_URL:-}"
GATEWAY_KEY="${CHATDSH_TEST_GATEWAY_API_KEY:-}"
GATEWAY_MODEL="${CHATDSH_TEST_GATEWAY_MODEL:-}"

log() { printf '[hermes-init][%s] %s\n' "$1" "$2"; }

configure_model() {
	if [ -z "$GATEWAY_URL" ] || [ -z "$GATEWAY_MODEL" ]; then
		log model "未设置 CHATDSH_TEST_GATEWAY_URL 或 CHATDSH_TEST_GATEWAY_MODEL，跳过模型配置"
		return
	fi
	log model "配置模型网关：$GATEWAY_URL"
	hermes config set model.provider custom
	hermes config set model.base_url "$GATEWAY_URL"
	hermes config set model.default "$GATEWAY_MODEL"
	if [ -n "$GATEWAY_KEY" ]; then
		hermes config set model.api_key "$GATEWAY_KEY"
	fi
}

configure_model

log start "启动 hermes gateway"
exec hermes gateway run
