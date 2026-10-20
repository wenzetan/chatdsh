# ChatDSH 开发环境的 dsh 运行时镜像。
#
# 镜像只提供运行时本身：node 24、pnpm、@deepseek-ai/dsh 与基础工具。
# 仓库代码不进镜像，运行时由 compose 以只读方式挂入容器再复制到容器内的可写目录。

FROM node:24-bookworm-slim

ARG DSH_VERSION=0.2.1-rc.2
ARG PNPM_VERSION=10.33.0
ARG NPM_REGISTRY=https://registry.npmmirror.com

ENV DEBIAN_FRONTEND=noninteractive \
    DSH_VERSION=${DSH_VERSION} \
    PNPM_VERSION=${PNPM_VERSION} \
    NPM_CONFIG_REGISTRY=${NPM_REGISTRY}

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl git procps \
 && rm -rf /var/lib/apt/lists/*

RUN npm install -g "pnpm@${PNPM_VERSION}" \
 && npm install -g "@deepseek-ai/dsh@${DSH_VERSION}" \
 && npm cache clean --force

COPY dsh-entrypoint.sh /usr/local/bin/dsh-entrypoint
RUN chmod +x /usr/local/bin/dsh-entrypoint

WORKDIR /work

ENTRYPOINT ["/usr/local/bin/dsh-entrypoint"]
