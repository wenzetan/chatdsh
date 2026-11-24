#!/usr/bin/env bash
# 中继服务端配对审批脚本。
#
# 在中继宿主机执行，通过 `docker compose exec` 在中继容器内部经回环地址完成审批，
# 配对口令与设备令牌不会出现在宿主机命令行或终端输出中。
#
# 用法：
#   bash ~/.chatdsh/relay/relay-approve.sh list [--all]
#   bash ~/.chatdsh/relay/relay-approve.sh approve <requestId>
#   bash ~/.chatdsh/relay/relay-approve.sh reject <requestId>

set -euo pipefail

SCRIPT_SOURCE="${BASH_SOURCE[0]:-}"
DEFAULT_WORK_DIR="${CHATDSH_RELAY_DIR:-${HOME}/.chatdsh/relay}"
if [ -n "$SCRIPT_SOURCE" ] && [ -f "$SCRIPT_SOURCE" ]; then
  SCRIPT_DIR="$(cd "$(dirname "$SCRIPT_SOURCE")" && pwd)"
  if [ -f "${SCRIPT_DIR}/../docker-compose.yml" ]; then
    DEFAULT_WORK_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
  elif [ -f "${SCRIPT_DIR}/docker-compose.yml" ]; then
    DEFAULT_WORK_DIR="$SCRIPT_DIR"
  fi
fi

print_help() {
  cat <<'EOF'
用法：bash relay-approve.sh [选项] <命令>

命令：
  list [--all]           列出待审批的配对申请（加 --all 查看全部状态）
  approve <requestId>    批准指定配对申请并签发设备凭据
  reject <requestId>     拒绝指定配对申请

选项：
  --dir <目录>           指定中继部署目录（默认自动定位或 ~/.chatdsh/relay）
  --config <路径>        指定环境变量文件路径（默认 <部署目录>/.env）
  -h, --help             显示帮助信息
EOF
}

main() {
  local work_dir="$DEFAULT_WORK_DIR"
  local env_file=""
  local args=()

  while [ "$#" -gt 0 ]; do
    case "$1" in
      -h|--help)
        print_help
        return 0
        ;;
      --dir)
        if [ "$#" -lt 2 ]; then
          printf '%s\n' '--dir 缺少参数' >&2
          return 1
        fi
        work_dir="$2"
        shift 2
        ;;
      --dir=*)
        work_dir="${1#--dir=}"
        shift
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

  local compose_file="${work_dir}/docker-compose.yml"
  if [ ! -f "$compose_file" ]; then
    printf '未找到 %s，请先运行 relay-up.sh 部署中继或传入 --dir <部署目录>\n' "$compose_file" >&2
    return 1
  fi
  if [ -z "$env_file" ]; then
    env_file="${work_dir}/.env"
  fi

  local compose_project="${COMPOSE_PROJECT_NAME:-${CHATDSH_COMPOSE_PROJECT:-chatdsh}}"
  local compose_args=(compose -p "$compose_project" -f "$compose_file")
  if [ -f "$env_file" ]; then
    compose_args=(compose -p "$compose_project" --env-file "$env_file" -f "$compose_file")
  fi

  (cd "$work_dir" && docker "${compose_args[@]}" exec -T relay node gateway/lib/pairing-admin.js "${args[@]}")
}

main "$@"
