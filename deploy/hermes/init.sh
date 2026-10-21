#!/usr/bin/env sh
# Hermes 测试容器入口：把测试用的模型网关写进配置，再启动 gateway。
#
# 密钥与地址只从环境变量读，不写进任何文件；容器数据目录是绑定挂载的 deploy/data/hermes。
set -eu

log() { printf '[hermes-init][%s] %s\n' "$1" "$2"; }

if [ -n "${CHATDSH_TEST_GATEWAY_URL:-}" ] && [ -n "${CHATDSH_TEST_GATEWAY_MODEL:-}" ]; then
  log model "配置模型网关 ${CHATDSH_TEST_GATEWAY_URL} 模型 ${CHATDSH_TEST_GATEWAY_MODEL}"
  hermes config set model.provider custom
  hermes config set model.base_url "$CHATDSH_TEST_GATEWAY_URL"
  hermes config set model.default "$CHATDSH_TEST_GATEWAY_MODEL"
  if [ -n "${CHATDSH_TEST_GATEWAY_API_KEY:-}" ]; then
    hermes config set model.api_key "$CHATDSH_TEST_GATEWAY_API_KEY"
  fi
else
  log model "未设置模型网关，沿用容器内已有配置"
fi

log start "启动 hermes gateway"
exec hermes gateway run
