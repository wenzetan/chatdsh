# 测试用容器编排

本目录只放验收测试与服务联调用的容器编排，与 `runtime/dev/docker/` 的开发环境分开管理。两边的差别：

- 宿主端口全部映射到 50000 以上，与宿主上已经在跑的服务（3080、8642、8889、20128）不冲突；
- 数据卷、镜像、密钥相互独立，测试不会读写任何真实实例的数据；
- 模型网关统一指向宿主机 `http://127.0.0.1:20128`（容器内写 `host.docker.internal:20128`），密钥只从环境变量读。

## 目录

```text
deploy/
├── README.md              本文件
├── .env.example           变量清单（复制成 .env，已被 gitignore）
├── compose.yaml           Hermes、Hindsight、Hindsight 的 Postgres
├── compose.postgres.yaml  独立 Postgres（存储后端联调用）
├── hermes/init.sh         Hermes 容器入口：写模型网关配置后启动
├── hindsight/             预留：Hindsight 的初始化脚本
├── postgres/init.sql      独立 Postgres 的初始化（建库与扩展）
└── data/                  绑定挂载的数据目录，内容不入库
```

## 端口

| 服务 | 容器内 | 宿主映射 |
|---|---|---|
| Hermes `api_server` | 8642 | `127.0.0.1:50011` |
| Hermes `:8642` 的备用实例 | 8642 | `127.0.0.1:50012` |
| Hindsight API | 8889 | `127.0.0.1:50021` |
| Hindsight Postgres | 5432 | `127.0.0.1:50022` |
| 独立 Postgres（存储后端） | 5432 | `127.0.0.1:50031` |
| dsh 运行时（如需真实回环） | 3080 | `127.0.0.1:50041` |

新增服务时沿用同一段位：`5001x` 给 Hermes，`5002x` 给 Hindsight，`5003x` 给 Postgres，`5004x` 给 dsh 与网关，`5005x` 留给以后。

## 使用

```bash
cp deploy/.env.example deploy/.env    # 填密钥；deploy/.env 不入库
docker compose --env-file deploy/.env -f deploy/compose.yaml up -d
docker compose --env-file deploy/.env -f deploy/compose.yaml ps
docker compose --env-file deploy/.env -f deploy/compose.yaml down
```

只起 Hindsight 与它的数据库：

```bash
docker compose --env-file deploy/.env -f deploy/compose.yaml up -d hindsight hindsight-db
```

独立 Postgres（存储后端联调）：

```bash
docker compose --env-file deploy/.env -f deploy/compose.postgres.yaml up -d
```

## 网络

本编排复用宿主已有的桥接网络，缺省是 `chatdsh-dev_default`，可用 `CHATDSH_TEST_NETWORK` 换。这样做的原因是宿主的端口防护只放行固定白名单网段访问 `20128` 这类服务，而 Docker 默认网桥已占满一整个 `/16`，不能在里面再切子网。复用网络只共享网段，容器、数据目录与密钥完全独立。

容器内的 `host.docker.internal` 取 `CHATDSH_TEST_GATEWAY`：部分宿主上 `host-gateway` 会解析成默认网桥，跨子网时连不通宿主网关。该值取目标网络的网关地址：

```bash
docker network inspect "${CHATDSH_TEST_NETWORK:-chatdsh-dev_default}" \
  --format '{{range .IPAM.Config}}{{.Gateway}}{{end}}'
```

首次使用前确认该网络存在：

```bash
docker network inspect "${CHATDSH_TEST_NETWORK:-chatdsh-dev_default}" >/dev/null || \
  docker compose --env-file runtime/dev/.env -f runtime/dev/docker/compose.yaml up -d --no-start
```

## 验收用法

`hermes-adapter` 的联调与 `hindsight-adapter` 的联调都指向这里的端口：

```bash
export HERMES_URL=http://127.0.0.1:50011
export HERMES_API_KEY=$(grep '^HERMES_API_KEY=' deploy/.env | cut -d= -f2-)
node deploy/scripts/hermes-smoke.mjs
```

`HERMES_API_KEY` 每个环境自行生成，例如 `openssl rand -hex 16`。测试容器与真实实例使用不同密钥，避免误连。
