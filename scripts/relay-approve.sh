#!/usr/bin/env bash
# 中继服务端配对审批脚本。
#
# 在中继宿主机执行，通过 `docker compose exec` 在中继容器内部经回环地址完成审批，
# 配对口令与设备令牌不会出现在宿主机命令行或终端输出中。
#
# 用法：
#   bash scripts/relay-approve.sh list [--all]
#   bash scripts/relay-approve.sh approve <requestId>
#   bash scripts/relay-approve.sh reject <requestId>

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
DEFAULT_ENV_FILE="${REPO_ROOT}/.env"
COMPOSE_FILE="${REPO_ROOT}/docker-compose.yml"

print_help() {
  cat <<'EOF'
用法：bash scripts/relay-approve.sh [选项] <命令>

命令：
  list [--all]           列出待审批的配对申请（加 --all 查看全部状态）
  approve <requestId>    批准指定配对申请并签发设备凭据
  reject <requestId>     拒绝指定配对申请

选项：
  --config <路径>        指定环境变量文件路径（默认仓库根目录 .env）
  -h, --help             显示帮助信息
EOF
}

main() {
  local env_file="$DEFAULT_ENV_FILE"
  local args=()

  while [ "$#" -gt 0 ]; do
    case "$1" in
      -h|--help)
        print_help
        return 0
        ;;
      --config)
        if [ "$#" -lt 2 ]; then
          printf '%s\n' '--config 缺少参数' >&2
          return 1
        fi
        env_file="$2"
        shift 2
        ;;
      --config=*)
        env_file="${1#--config=}"
        shift
        ;;
      *)
        args+=("$1")
        shift
        ;;
    esac
  done

  if [ "${#args[@]}" -eq 0 ]; then
    print_help
    return 1
  fi

  local compose_args=(compose -f "$COMPOSE_FILE")
  if [ -f "$env_file" ]; then
    compose_args=(compose --env-file "$env_file" -f "$COMPOSE_FILE")
  fi

  (cd "$REPO_ROOT" && docker "${compose_args[@]}" exec -T relay node gateway/lib/pairing-admin.js "${args[@]}")
}

main "$@"
