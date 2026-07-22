# 飞书运行与资源操作

## 适用范围

Zen Commerce Agent 首期只使用一张私有飞书多维表作为卡密库存账本。运行时代码位于 `packages/card-inventory`；不依赖外部工作目录，也不建设第二套 OAuth 或通用飞书 SDK。

## 固定边界

- 飞书应用：`agent-general`。
- `lark-cli` profile：`general`；每次调用必须显式指定。
- 私有 Base、Drive、Wiki 默认使用用户身份 `--as user`。
- 重要写入前必须执行 `lark-cli --profile general whoami` 并确认 user identity。
- 写入成功必须以 CLI `ok == true` 且按业务键回读一致为准。
- 不得切换、删除、覆盖或重命名 profile。
- profile、App Secret、Access Token 与 Refresh Token 只保存在服务器受控认证卷，不进仓库、镜像、模型、审计、日志或命令输出。
- 不得自动修改资源分享范围、owner 或组织外协作者。

## 生产认证目录

服务器目录 `/root/zen-agent/lark-cli` 只由管理员和服务容器使用，权限固定 `0700`、属主 UID/GID 1000；认证文件按 `umask 077` 创建。compose 将其挂载为 `/data/lark-cli`，并设置 `LARKSUITE_CLI_CONFIG_DIR=/data/lark-cli`。目录必须允许容器 `node` 用户读取并在 token 刷新时写回，容器重建不得清空。

首次授权属于人工运维步骤：在服务器目标容器内初始化 `general` profile 并完成浏览器登录。认证完成后执行脱敏 `whoami` 和 Base field-list/只读投影检查；不得把完整身份响应或任何 token 复制回开发会话。

## Base 最小字段

首期库存表只要求 `card_id`、`product_key`、`card_secret`、`status`、`order_id`、`note`。运行冒烟只查询字段定义或不含 `card_secret` 的投影；真实库存读取只发生在服务端端口内，底层 stdout/stderr 不进入日志。

## 后续资源锚点

客服辅助阶段启动时，再为商品资料、话术和规则规划 Doc/Drive/Wiki 的权威来源与版本发布；在该阶段之前不复制完整飞书 skills，也不把在线知识直接注入生产 agent。
