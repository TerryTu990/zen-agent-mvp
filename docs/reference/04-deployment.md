# 部署参考（Docker）

> 参考型文档：服务端容器化部署的权威导览。产物权威：根 `Dockerfile` / `docker-compose.yml` / `.dockerignore`；env 语义见 `03-configuration.md` §4。
> 客户端（Chrome 扩展）不在本文范围——它经企业策略/商店分发，只需把 `za.serverBaseUrl` 指向部署地址。

## 1. 设计原则

1. **站点包不进镜像**：快照根以只读卷挂入（`ZA_SNAPSHOT_ROOT=/app/snapshot`）。换站点配置 = 替换宿主机目录内容后重启容器，无需重建镜像——这是 U4（改配置=发新版本）在部署面的体现，也为标准版"配置中心发布"预留了同构接缝（届时只是换快照目录的生产端）。
2. **secret 只走运行时 env**：`ZA_JWT_SECRET` / `ZA_SIGNING_SECRET` / `ZA_LLM_API_KEY` / `ZA_CRED_*` 经环境注入（compose `${VAR:?required}` / K8s Secret），MUST NOT bake 进镜像层或写入 compose 文件。
3. **日志双通道，不可混淆**：
   - **容器日志（stdout/stderr）**= 运维排障流：启动信息、请求异常、LLM 上游错误、fail-open 告警（均已脱敏，SEC-04）；交给容器平台采集（`docker logs` / Loki / CloudWatch）。
   - **审计文件（`/data/za/events.jsonl`）**= 治理证据流：C5 schema、record-only、落盘前脱敏；**必须落持久卷**，否则容器重建即丢审计。二者语义不同，勿把审计导到 stdout、也勿指望容器日志替代审计。
4. **数据可写卷**：`/data/za`（审计 + 会话持久化）挂 named volume / PV，容器重建会话可恢复。

## 2. 镜像构成（根 `Dockerfile`）

多阶段构建，要点：

- **builder**：`node:22-slim` + corepack 固定 `pnpm@10.32.1` → `pnpm install --frozen-lockfile --filter @zen-agent/server...`（含 workspace 依赖拓扑）→ 递归 build → **`pnpm deploy` 收敛生产依赖**。
  - 为什么必须 `pnpm deploy`：workspace `workspace:*` 是软链，直接拷 `node_modules` 不可移植；且 `packages/contracts/schemas/*.json` 是**运行时** `require.resolve` 读取的非 dist 资产，deploy 会把它们随包实体带入——只拷 `dist/` 的天真多阶段构建会在启动期崩。
- **runtime**：`node:22-slim`，仅含 deploy 产物 + 镜像自带的 `assets/system-prompt.md` 副本（可被 `ZA_SYSTEM_PROMPT_PATH` 挂卷覆盖）；以 `node` 非 root 用户运行。
- 镜像内默认 env：`ZA_HOST=0.0.0.0`（容器内必须对外，否则端口发布后外部不可达）、数据路径固定绝对路径 `/data/za/*`（规避"相对 cwd"陷阱——本机 `pnpm start` 的 cwd 是 `apps/server`，`.za/` 会落在意外位置）。
- `HEALTHCHECK`：内置 `GET /healthz`（无鉴权存活探针，仅证明进程在监听；其余路径一律先过验签——`GET /` 返回 401 是预期而非故障）。

## 3. 快速开始（compose）

```bash
# 1) 准备快照根（宿主机目录，含 manifest.json + packs/*）
export ZA_SNAPSHOT_HOST_DIR=$PWD/examples/acceptance

# 2) 注入 secret 与 LLM 上游（生产走 secret 管理，不写文件）
export ZA_JWT_SECRET=…  ZA_SIGNING_SECRET=…
export ZA_LLM_BASE_URL=…  ZA_LLM_API_KEY=…  ZA_LLM_MODEL=…

# 3) 启动
docker compose up -d --build

# 4) 验证
curl -fsS http://127.0.0.1:8787/healthz    # → {"ok":true}
```

`docker-compose.yml` 已声明：快照只读卷（`:ro`）、`za-data` 数据卷、必填变量 `${VAR:?required}` 缺失即拒启（与服务端 `requireEnv` fail-fast 语义一致）。

## 4. 环境变量清单（容器视角）

完整语义见 `03-configuration.md` §4；容器部署最小集：

| 类别 | 变量 | 说明 |
|---|---|---|
| 必填 secret | `ZA_JWT_SECRET` `ZA_SIGNING_SECRET` | 运行时注入，勿进镜像/compose 文件 |
| LLM 上游 | `ZA_LLM_BASE_URL` `ZA_LLM_API_KEY` `ZA_LLM_MODEL` | openai 兼容端点 |
| 快照 | `ZA_SNAPSHOT_ROOT=/app/snapshot` | 指向只读卷挂载点 |
| 已在镜像固化（可覆盖） | `ZA_HOST=0.0.0.0` `ZA_PORT=8787` `ZA_AUDIT_SINK=/data/za/events.jsonl` `ZA_SESSION_DIR=/data/za/sessions` `ZA_SYSTEM_PROMPT_PATH=/app/assets/system-prompt.md` | 绝对路径，规避 cwd 陷阱 |
| 按需 | `ZA_CORS_ORIGIN` `ZA_JWT_ISS_ALLOWLIST` `ZA_MAX_TURN_ROUNDS` `ZA_CRED_*` | 见配置参考 |
| 禁用于生产 | `ZA_DEMO_TOKEN_ENABLED` | 自签 token 端点仅演示环境 |

## 5. 站点配置的发布与回滚

快照不可变（U4）在容器部署下的操作语义：

- **发布新站点/改配置**：在宿主机准备新版本快照目录（升 `manifest.json` 的 `version`）→ 原子替换挂载目录内容（或切换挂载指向新目录）→ 重启容器。装配器启动期 fail-fast：坏配置容器起不来（`快照拒载：…`），旧容器可继续跑——天然的发布安全阀。
- **回滚**：切回旧版本目录 → 重启。审计事件里的 `snapshotVersion` 可核对每轮对话用的是哪个版本。
- **勿做**：exec 进容器改快照文件（违反 U4，且下次重建即丢）。

## 6. 运维检查单

- [ ] `/healthz` 探活接入编排（compose 已带 HEALTHCHECK；K8s 用 liveness/readiness 指向它）
- [ ] `za-data` 卷有备份策略（审计是治理证据；会话含对话内容，按敏感数据对待）
- [ ] 反向代理透传 SSE（`GET /v1/sessions/:id/events`）：禁用响应缓冲、read timeout 放宽（心跳默认 15s）
- [ ] `ZA_CORS_ORIGIN` 按扩展来源收敛（默认 `*` 仅适合内网）
- [ ] secret 轮换流程覆盖 `ZA_JWT_SECRET`（轮换即全部在途 token 失效，需与签发方协同）
- [ ] 容器日志采集与审计卷采集分开配置（§1 原则 3）
