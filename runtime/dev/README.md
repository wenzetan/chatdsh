# ChatDSH 开发环境

这套环境把 ChatDSH 调试时需要的三类进程放进独立的容器：dsh 运行时、Hermes、Hindsight。
宿主上已经在跑的实例不受影响，容器侧的端口全部换到另一段回环端口，两边可以同时存在，
调试时不必停掉宿主上的服务，也不必担心容器里的依赖、缓存与数据根弄脏宿主环境。

## 目录结构

```text
dev/
├── .env.example          环境变量清单，复制成 .env 后填写
├── README.md             本文件
└── docker/
    ├── compose.yaml      四个服务：dsh-runtime、hermes、hindsight、hindsight-db
    ├── Dockerfile        dsh 运行时镜像：node 24、pnpm、@deepseek-ai/dsh
    ├── dsh-entrypoint.sh dsh 运行时容器入口
    └── hermes-init.sh    hermes 容器入口
```

## 准备 .env

```bash
cp dev/.env.example dev/.env
```

`dev/.env` 已被版本管理忽略，不会被提交。需要填写的几类变量：

- `CHATDSH_TEST_GATEWAY_URL`、`CHATDSH_TEST_GATEWAY_API_KEY`、`CHATDSH_TEST_GATEWAY_MODEL`：
  模型网关的地址、密钥与默认模型。容器内访问宿主上的网关用 `http://host.docker.internal:20128/v1`。
- `CHATDSH_PROVIDER_URL`、`CHATDSH_PROVIDER_API_KEY`、`CHATDSH_PROVIDER_MODEL`：
  自建模型提供方的 OpenAI 兼容基地址（含 `/v1`）、密钥与模型 id。三项都给出时，
  Web/桌面客户端直接使用它；留空则仍走控制平面的模型网关。
- `HERMES_API_KEY`：hermes 的 api_server 密钥，宿主侧用它访问 18642 端口。
- `HINDSIGHT_LLM_*`、`HINDSIGHT_EMBEDDINGS_*`：hindsight 做记忆抽取与向量检索时用的模型与密钥。
- `HINDSIGHT_DB_PASSWORD`：hindsight 的 Postgres 密码，容器内的连接串由它拼出。

密钥不写进 compose 文件，也不写进仓库里的任何文件。

## 启动

```bash
docker compose --env-file dev/.env -f dev/docker/compose.yaml up -d
```

第一次启动时，dsh 运行时容器会在容器内完成这些事：把宿主仓库复制到容器内的可写目录、
安装 profile 与工作区的依赖、投影 DSH 的依赖链接、构建同级目录 `dsh-adapter` 与自建包、
打包浏览器侧产物、把仓库的 profile 接到容器内的数据根，最后启动 dsh。
这一段大约需要几分钟，日志里能看到每一步的进度。

```bash
docker compose --env-file dev/.env -f dev/docker/compose.yaml ps
```

四个服务都变成 healthy 之后，dsh 运行时的 Web 界面在 http://127.0.0.1:13080/ ，
访问时需要带上启动日志里打印的 token（形如 `http://127.0.0.1:13080/?token=...`）。

## 看日志

```bash
docker compose --env-file dev/.env -f dev/docker/compose.yaml logs -f dsh-runtime
docker compose --env-file dev/.env -f dev/docker/compose.yaml logs -f hermes
docker compose --env-file dev/.env -f dev/docker/compose.yaml logs -f hindsight
```

## 关停

```bash
docker compose --env-file dev/.env -f dev/docker/compose.yaml down
```

连同数据卷一起删除（dsh 的数据根、hermes 的数据目录、hindsight 的数据库都会清空）：

```bash
docker compose --env-file dev/.env -f dev/docker/compose.yaml down -v
```

## 端口对照表

| 服务 | 容器内端口 | 宿主回环端口 | 说明 |
| --- | --- | --- | --- |
| dsh-runtime | 3080 | 13080 | dsh 的 Web 界面，访问需要 token |
| hermes | 8642 | 18642 | hermes 的 api_server，`/health` 与 `/v1` |
| hindsight | 8889 | 18889 | hindsight 的记忆 API，`/health` 与 `/docs` |
| hindsight-db | 5432 | 不映射 | vchord 的 Postgres，只在 compose 网络内可达 |
| 宿主上的模型网关 | 20128 | 20128 | 容器内用 `host.docker.internal:20128` 访问 |

宿主上已经在跑的 dsh（3080）、hermes（8642）、hindsight（8889）与模型网关（20128）
都不映射到容器，两套环境并行运行。

## 已知限制

- dsh 的 Web 服务只接受具体的绑定地址，通配地址被拒绝。容器入口因此绑定容器自己的地址，
  宿主侧的端口映射才能连得上。`DSH_BIND_HOST` 可以覆盖这个地址。
- 容器里的 dsh 数据根在 `/work/.dsh`，hermes 的数据目录在 `/opt/data`，两处都在容器卷里，
  宿主上看不到，也没有同步回宿主。
- dsh 运行时的模型配置由 DSH 自己的设置文件决定，位置是容器内的 `/work/.dsh/settings.yaml`。
  compose 把模型网关的地址、密钥与模型名以环境变量的形式传进容器，便于调试时引用。
- 仓库代码在容器内被复制到 `/work`，容器里的改动不会回到宿主。宿主上删除文件后，
  容器里的旧副本仍在，需要 `docker compose down -v` 后重新启动才会同步。
- 同级目录 `dsh-adapter` 在容器内单独构建。它的构建产物是自建包类型检查的依赖，
  宿主上改动 `dsh-adapter` 之后需要重启容器才会生效。
- 容器内的包管理器用 `https://registry.npmmirror.com`，与 `runtime` 根目录的 `.npmrc` 一致；
  换源时用 `NPM_REGISTRY` 覆盖。
