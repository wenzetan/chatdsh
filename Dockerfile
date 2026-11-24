FROM node:24-alpine AS builder

ARG NPM_REGISTRY=

WORKDIR /app
RUN corepack enable && corepack prepare pnpm@11.21.0 --activate

COPY dsh-adapter/package.json ./dsh-adapter/package.json
COPY runtime/package.json runtime/pnpm-workspace.yaml runtime/pnpm-lock.yaml runtime/.npmrc ./runtime/
COPY runtime/tsconfig.base.json ./runtime/
COPY runtime/gateway/package.json runtime/gateway/tsconfig.json ./runtime/gateway/
COPY runtime/packages/core/contracts/package.json runtime/packages/core/contracts/tsconfig.json ./runtime/packages/core/contracts/
COPY runtime/packages/core/diagnostics/package.json runtime/packages/core/diagnostics/tsconfig.json ./runtime/packages/core/diagnostics/
COPY runtime/packages/client/pwa/package.json runtime/packages/client/pwa/tsconfig.json ./runtime/packages/client/pwa/

WORKDIR /app/runtime
RUN if [ -n "$NPM_REGISTRY" ]; then \
      pnpm --config.registry="$NPM_REGISTRY" --filter . --filter @chatdsh/gateway... --filter @chatdsh/client-pwa install --no-frozen-lockfile --ignore-scripts; \
    else \
      pnpm --filter . --filter @chatdsh/gateway... --filter @chatdsh/client-pwa install --no-frozen-lockfile --ignore-scripts; \
    fi

COPY runtime/packages/core/contracts/src ./packages/core/contracts/src
COPY runtime/packages/core/diagnostics/src ./packages/core/diagnostics/src
COPY runtime/packages/client/pwa/src ./packages/client/pwa/src
COPY runtime/packages/client/pwa/assets ./packages/client/pwa/assets
COPY runtime/gateway/src ./gateway/src

RUN mkdir -p .dsh-deps \
  && ln -s ../node_modules/@types .dsh-deps/@types \
  && ln -s ../gateway/node_modules/zod .dsh-deps/zod \
  && ln -s ../packages/core/diagnostics/node_modules/@opentelemetry .dsh-deps/@opentelemetry \
  && ./node_modules/.bin/tsc -b packages/core/contracts packages/core/diagnostics packages/client/pwa gateway \
  && rm -rf .dsh-deps \
  && CI=true pnpm --filter @chatdsh/gateway... --filter @chatdsh/client-pwa install --prod --no-frozen-lockfile --ignore-scripts --offline

FROM node:24-alpine AS runner

LABEL org.opencontainers.image.title="ChatDSH Relay" \
      org.opencontainers.image.description="Lightweight self-hosted relay server for ChatDSH" \
      org.opencontainers.image.source="https://github.com/wenzetan/chatdsh" \
      org.opencontainers.image.licenses="MIT"

WORKDIR /app/runtime

RUN mkdir -p /data && chown -R node:node /data

COPY --from=builder /app/runtime/package.json ./package.json
COPY --from=builder /app/runtime/node_modules ./node_modules
COPY --from=builder /app/runtime/packages/core/contracts/package.json ./packages/core/contracts/package.json
COPY --from=builder /app/runtime/packages/core/contracts/lib ./packages/core/contracts/lib
COPY --from=builder /app/runtime/packages/core/contracts/node_modules ./packages/core/contracts/node_modules
COPY --from=builder /app/runtime/packages/core/diagnostics/package.json ./packages/core/diagnostics/package.json
COPY --from=builder /app/runtime/packages/core/diagnostics/lib ./packages/core/diagnostics/lib
COPY --from=builder /app/runtime/packages/core/diagnostics/node_modules ./packages/core/diagnostics/node_modules
COPY --from=builder /app/runtime/packages/client/pwa/package.json ./packages/client/pwa/package.json
COPY --from=builder /app/runtime/packages/client/pwa/lib ./packages/client/pwa/lib
COPY --from=builder /app/runtime/packages/client/pwa/assets ./packages/client/pwa/assets
COPY --from=builder /app/runtime/gateway/package.json ./gateway/package.json
COPY --from=builder /app/runtime/gateway/lib ./gateway/lib
COPY --from=builder /app/runtime/gateway/node_modules ./gateway/node_modules

ENV NODE_ENV=production \
    DSH_HOME=/data \
    CHATDSH_GATEWAY_HOST=0.0.0.0 \
    CHATDSH_GATEWAY_PORT=3170

USER node
EXPOSE 3170
VOLUME ["/data"]

HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.CHATDSH_GATEWAY_PORT || '3170') + '/healthz').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "gateway/lib/main.js"]
