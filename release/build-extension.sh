#!/usr/bin/env bash
# 打包 Chrome 插件发布 zip：manifest + Side Panel/选项页 + dist + icons（不含 src/test/node_modules）。
# 生产服务端地址经 esbuild --define 烤入包内缺省值——用户装完零配置；
# 可用 ZA_SERVER_BASE_URL 环境变量覆盖目标地址。版本取 manifest.json 的 version。
set -euo pipefail
cd "$(dirname "$0")/.."

SERVER_BASE_URL="${ZA_SERVER_BASE_URL:-https://agent.flash-api.com}"

# 先走常规构建（含 tsc --noEmit 类型门禁与 content.js），再以生产地址重打 background.js。
pnpm --filter @zen-agent/extension build >/dev/null
(cd apps/extension && pnpm exec esbuild src/background.ts --bundle --format=esm \
  --define:__ZA_SERVER_BASE_URL__="\"${SERVER_BASE_URL}\"" --outfile=dist/background.js >/dev/null)

VERSION="$(node -p "JSON.parse(require('fs').readFileSync('apps/extension/manifest.json','utf8')).version")"
OUT_DIR="release/artifacts"
OUT="${OUT_DIR}/zen-commerce-agent-extension-${VERSION}.zip"
mkdir -p "${OUT_DIR}"
rm -f "${OUT}"

(cd apps/extension && zip -qr "../../${OUT}" manifest.json options.html sidepanel.html sidepanel.css dist icons)
# 打包后把 dist 恢复为开发构建，避免生产地址残留在工作区影响本机调试。
pnpm --filter @zen-agent/extension build >/dev/null

echo "已打包 ${OUT}（服务端缺省地址：${SERVER_BASE_URL}）"
echo "用户流程：装扩展 → 扩展选项页粘贴管理员签发的令牌（release/sign-token.sh）→ 打开宿主站点点图标即用"
