#!/usr/bin/env bash
# dsh-runtime 容器入口：准备容器内的工作副本与依赖，然后启动 dsh 运行时。
#
# 宿主仓库以只读方式挂在 /src，容器内的可写副本在 /work：
# profile 目录里的 link: 依赖按同级关系解析，runtime 与 dsh-adapter 在仓库根下同级，
# 复制时保持这个层级，链接才解析得到。
#
# DSH_HOME 指向 /work/.dsh，位于容器内的可写卷里，不指向宿主目录。
set -euo pipefail

SRC_ROOT=/src
WORK_ROOT=/work
REPO_DIR="$WORK_ROOT/runtime"
ADAPTER_DIR="$WORK_ROOT/dsh-adapter"
PROFILE=chatdsh-web

export DSH_HOME="$WORK_ROOT/.dsh"

log() { printf '[dsh-runtime][%s] %s\n' "$1" "$2"; }

# 把宿主仓库复制到容器内的可写目录。排除依赖目录、构建缓存与版本库，
# 依赖由容器内的 pnpm install 重新安装。
prepare_workspace() {
	log prepare "复制仓库到 $WORK_ROOT"
	mkdir -p "$WORK_ROOT"
	tar -C "$SRC_ROOT" -cf - \
		--exclude='*/node_modules' \
		--exclude='*/.git' \
		--exclude='*/.run' \
		--exclude='*/.tmp' \
		--exclude='*/.verify' \
		--exclude='*/.dsh-deps' \
		--exclude='*/ui-explore' \
		--exclude='./refer_repos' \
		. | tar -C "$WORK_ROOT" -xf -
	log prepare "仓库副本就绪：$REPO_DIR"
}

# profile 目录有独立的 lockfile，依赖全部指向仓库内的 link: 目标。
install_profile() {
	log install "安装 profile $PROFILE 的依赖"
	cd "$REPO_DIR/profiles/$PROFILE"
	pnpm install --no-frozen-lockfile
}

# 工作区的依赖（typescript、esbuild 等）供构建使用。
install_workspace() {
	log install "安装工作区依赖"
	cd "$REPO_DIR"
	pnpm install --no-frozen-lockfile
}

# 把 DSH 安装内的依赖投影到 .dsh-deps，供类型检查与 tsconfig 的 paths 解析。
link_dsh_deps() {
	log link "建立 .dsh-deps 链接"
	cd "$REPO_DIR"
	node scripts/link-dsh-deps.mjs
}

# dsh-adapter 与 runtime 同级，自带类型声明与构建脚本。
# 自建包的类型检查要读它的声明文件，因此先把它构建出来。
build_adapter() {
	log build "构建 dsh-adapter"
	cd "$ADAPTER_DIR"
	node scripts/link-dsh-deps.mjs
	pnpm install --no-frozen-lockfile --config.auto-install-peers=false
	pnpm build
}

# 构建自建包与浏览器侧产物。
build_packages() {
	log build "构建自建包"
	cd "$REPO_DIR"
	pnpm build
	log build "打包浏览器侧产物"
	pnpm build:client
}

# DSH 按名在 $DSH_HOME/profiles 下寻找 profile，仓库里的 profile 通过符号链接接进去。
link_profiles() {
	log link "把仓库 profile 接到 $DSH_HOME"
	cd "$REPO_DIR"
	node scripts/sync-profiles.mjs
}

# DSH 的 web 服务只接受具体的绑定地址，通配地址被拒绝。
# 容器内的回环地址对宿主不可见，因此绑定容器自己的地址，宿主侧的端口映射才连得上。
resolve_bind_host() {
	if [ -n "${DSH_BIND_HOST:-}" ]; then
		printf '%s' "$DSH_BIND_HOST"
		return
	fi
	hostname -i | awk '{print $1}'
}

prepare_workspace
install_profile
install_workspace
link_dsh_deps
build_adapter
build_packages
link_profiles

if [ "$#" -gt 0 ]; then
	log start "执行传入的命令：$*"
	exec "$@"
fi

BIND_HOST="$(resolve_bind_host)"
log start "启动 dsh 运行时（profile $PROFILE，绑定 $BIND_HOST:${DSH_PORT:-3080}）"
exec dsh --profile "$PROFILE" --host "$BIND_HOST" --port "${DSH_PORT:-3080}" --no-open
