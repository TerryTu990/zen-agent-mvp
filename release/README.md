# release/ — 发布产物与脚本

> 发布形态与目标环境的权威描述。部署面语义见 `docs/reference/04-deployment.md`；
> 发布流程由 `/release` skill 驱动（`.claude/skills/release/SKILL.md`）。

## 目标环境（当前唯一：lingm2）

| 项 | 值 |
|---|---|
| 登录 | `ssh lingm2`（x86_64，Docker + compose v2） |
| 对外入口 | `https://agent.flash-api.com`（1panel 反代 → `http://127.0.0.1:9010`） |
| 服务器目录 | `/root/zen-agent`（compose/env/快照/数据/日志全在此，容器只挂载不自持） |
| 端口 | 宿主 `127.0.0.1:9010` → 容器 `8787` |

## 目录

```
release/
├── README.md                  # 本文件
├── build-server-image.sh      # 构建 linux/amd64 服务端镜像（tag=git short SHA）
├── build-extension.sh         # 打包 Chrome 插件 zip → release/artifacts/
├── deploy-server.sh           # 镜像 save|ssh|load + 同步 compose/快照 + up -d + 冒烟
├── remote/
│   ├── docker-compose.yml     # 服务器侧 compose（/root/zen-agent 挂载布局）
│   └── env.example            # 服务器侧 .env 模板（真值只在服务器上填）
└── artifacts/                 # 本地产物输出（gitignore）
    ├── zen-commerce-agent-extension-<version>.zip
    └── zen-agent-server-<tag>.tar.gz   # deploy 脚本临时产物
```

## 服务器目录布局（/root/zen-agent）

```
/root/zen-agent/
├── docker-compose.yml   # 由 deploy-server.sh 同步
├── .env                 # secret 与环境参数（手工维护，不入仓、不经本机传输）
├── deployment.env      # 当前镜像 tag 与快照版本目录（无 secret）
├── snapshots/          # 不可变版本目录；至少保留当前和上一版
│   └── <version>/
│       ├── manifest.json
│       └── packs/…
├── lark-cli/           # 飞书 general profile 与 token 刷新状态（受控持久目录）
└── data/za/             # 审计 events.jsonl + 会话 sessions/（可写挂载，容器重建不丢）
```

## 发布形态

| 形态 | 产物 | 分发 |
|---|---|---|
| 服务端 | docker 镜像 `zen-agent-server:<git-sha>` | `deploy-server.sh` 到 lingm2 |
| Chrome 插件 | `artifacts/zen-commerce-agent-extension-<version>.zip`（生产服务端地址已烤入缺省值） | 手工分发/企业策略/商店 |
| 嵌入 SDK / 浏览器壳 | （未有产物） | 锚点：S3 多形态客户端落地时补 `build-sdk.sh` 等 |

## 用户认证（当前形态：管理员签发令牌）

平台不建账号；用户须持管理员签发的短期 JWT 方可使用（服务端验签 fail-closed）。宿主 SSO 接入是终局形态，届时由其签发、本流程退场。

签发脚本随发布同步到服务器（`remote/sign-token.sh` → `/root/zen-agent/sign-token.sh`），在服务器上执行：

```bash
ssh lingm2
cd /root/zen-agent && ./sign-token.sh <宿主用户id>        # 默认 30 天；第二参数可改天数
```
把输出的令牌发给用户 → 用户在扩展**选项页**（chrome://extensions → zen-agent → 扩展选项）粘贴保存。
令牌过期重签重配；`/demo-token` 自签端点在生产保持关闭。

## 快速发布

```bash
release/build-server-image.sh          # 1. 构建 amd64 镜像
release/deploy-server.sh --snapshot assets # 2. 上传版本快照 + 校验 + 成对切换 + 冒烟
release/build-extension.sh             # 3. （插件有变更时）打 zip
release/sign-token.sh -u <用户id>      # 4. 给新用户签发访问令牌
```

首次部署前提（人工，一次性）：服务器 `/root/zen-agent/.env` 按 `remote/env.example` 填好真值；
飞书启用时在受控 `lark-cli/` 卷完成 `general` profile 授权；1panel 反代已指向
`127.0.0.1:9010`（SSE 需关闭响应缓冲，见 04-deployment §6）。
