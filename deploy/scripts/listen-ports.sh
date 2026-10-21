#!/usr/bin/env sh
# 列出 deploy 编排占用的宿主端口，并与宿主机已占端口对照。
set -eu

echo 'deploy 约定的宿主端口：'
echo '  50011  Hermes api_server'
echo '  50021  Hindsight API'
echo '  50022  Hindsight Postgres'
echo '  50031  独立 Postgres'
echo
echo '当前监听：'
ss -ltn 2>/dev/null | awk 'NR>1{print $4}' | grep -E ':(500[0-9]{2})$' || echo '  （没有 50000 以上的 deploy 端口在监听）'
