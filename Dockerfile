# zen-agent 服务端镜像（apps/server）。
# 多阶段：builder 全量安装+构建 → pnpm deploy 收敛 server 生产依赖 → 极小运行层。
# 站点包快照与 .za 数据不进镜像：快照根以只读卷挂入（ZA_SNAPSHOT_ROOT），审计/会话挂可写卷。

FROM node:22-slim AS builder
RUN corepack enable && corepack prepare pnpm@10.32.1 --activate
WORKDIR /build
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages ./packages
COPY apps/server ./apps/server
RUN pnpm install --frozen-lockfile --filter @zen-agent/server... \
  && pnpm --filter @zen-agent/server... -r build \
  # pnpm deploy 产出自包含目录：dist + 收敛的 node_modules（workspace 软链落为实体，
  # 含 contracts/schemas/*.json——运行时 require.resolve 读取，不在 dist 内）。
  && pnpm --filter @zen-agent/server --prod deploy --legacy /deploy

FROM node:22-slim
ENV NODE_ENV=production
# 基座提示默认从镜像自带副本读取；挂卷覆盖 ZA_SYSTEM_PROMPT_PATH 可换。
COPY assets/system-prompt.md /app/assets/system-prompt.md
COPY --from=builder /deploy /app/server
WORKDIR /app/server
# 容器内默认对外监听 + 数据落 /data（外挂卷）；一切可被运行时 env 覆盖。
ENV ZA_HOST=0.0.0.0 \
    ZA_PORT=8787 \
    ZA_SYSTEM_PROMPT_PATH=/app/assets/system-prompt.md \
    ZA_AUDIT_SINK=/data/za/events.jsonl \
    ZA_SESSION_DIR=/data/za/sessions
# 镜像内预建数据目录并授 node 属主：named volume 首挂继承该属主，
# 否则挂载点归 root、非 root 进程不可写 → 审计/会话 fail-open 静默丢数据。
RUN mkdir -p /data/za && chown -R node:node /data/za
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s \
  CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.ZA_PORT??8787}/healthz`).then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "dist/main.js"]
