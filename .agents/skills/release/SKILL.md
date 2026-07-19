---
name: release
description: 发布 zen-agent——构建服务端镜像/插件 zip，部署到 lingm2（agent.flash-api.com），冒烟与回滚。用户说"发布/上线/部署到服务器/deploy"时使用。
---

# release — 发布流程

产物与脚本在 `release/`（事实权威：`release/README.md`）；部署面语义见 `docs/reference/04-deployment.md`。
目标环境唯一：`ssh lingm2`，对外 `https://agent.flash-api.com`（1panel 反代 → `127.0.0.1:9010`），服务器目录 `/root/zen-agent`。

## 流程（服务端）

1. **预检**：工作区必须干净（发布构建自已提交代码，脏树 build 脚本会拒绝）；确认要发布的 HEAD 是否已含目标改动；全量验证已过（`pnpm -r build` + 串行测试）——未验证不发布。
2. **构建**：`release/build-server-image.sh`（linux/amd64，tag=git short SHA + latest）。
3. **部署**：`release/deploy-server.sh`（可选 `--snapshot <本地快照根>` 同步站点包）。脚本自含：镜像 ssh 传输、compose 同步、`.env` 的 `ZA_IMAGE_TAG` 置当次 SHA、`up -d`、healthz 冒烟（15×2s 重试）。
4. **域名侧验证**：`curl -fsS https://agent.flash-api.com/healthz` 应返回 `{"ok":true}`。SSE 长连接验证（可选）：反代若缓冲响应会导致下行不流式——见下方 1panel 人工项。
5. **汇报**：如实附冒烟输出与镜像 tag；冒烟失败按脚本提示看远端 `docker compose logs`，勿盲目重试（HOW-06）。

## 流程（Chrome 插件）

1. `release/build-extension.sh` → `release/artifacts/zen-agent-extension-<version>.zip`（版本取 manifest.json；生产服务端地址经 esbuild define 烤入缺省值，可用 `ZA_SERVER_BASE_URL` env 覆盖）。
2. 版本升级记得先改 `apps/extension/manifest.json` 的 `version` 并提交。

## 用户接入（管理员签发令牌）

1. `release/sign-token.sh -u <宿主用户id> [-d 天数]` 在服务器容器内签发（secret 不出服务器，输出仅 token）。
2. 令牌发给用户 → 用户在扩展选项页粘贴保存 → 打开宿主站点点图标即用。
3. 过期重签重配；`/demo-token` 端点生产保持关闭；宿主 SSO 接入后本流程退场。

## 回滚（服务端）

```bash
ssh lingm2 "cd /root/zen-agent && sed -i 's/^ZA_IMAGE_TAG=.*/ZA_IMAGE_TAG=<旧SHA>/' .env && docker compose up -d"
```
旧镜像仍在服务器 docker 里（历史 load 过的 tag 都可用 `ssh lingm2 docker images zen-agent-server` 查）。
站点配置回滚 = 换回旧快照目录内容 + `docker compose restart`（U4：审计事件的 snapshotVersion 可核对）。

## 人工项（Codex 无法操作，须请 Terry 在 1panel/服务器做）

- **首次**：服务器 `/root/zen-agent/.env` 按 `release/remote/env.example` 填真值（secret 不经开发机传输）。
- **1panel 反代**：`agent.flash-api.com:443 → 127.0.0.1:9010` 已配；若 SSE 不流式（对话卡顿到整段出现），需在 1panel 该站点关闭响应缓冲（proxy_buffering off）并放宽 read timeout（心跳 15s）。
- secret 轮换、证书续期。
- sign-token.sh 触发生产容器 exec，auto 模式会被拦——由 Terry 亲自跑或逐次放行。

## 红线

- 发布镜像 MUST 构建自已提交代码（脚本已硬卡脏树）。
- `.env` 真值 MUST NOT 入仓/经本机中转/出现在输出里（ZA-C-SEC-01/02）。
- 未过验证（build+测试）不发布；冒烟未过不宣称发布完成（ZA-C-WHEN-02 / HOW-07）。
