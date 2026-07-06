#!/usr/bin/env bash
# 服务器本地签发用户令牌（/root/zen-agent/sign-token.sh，由 deploy-server.sh 随发布同步）。
# 在运行容器内以 ZA_JWT_SECRET 签 30 天 HS256 JWT，输出仅 token 本身，发给用户在扩展选项页粘贴。
# 用法：./sign-token.sh <宿主用户id> [有效天数，默认30]
set -euo pipefail

CONTAINER="zen-agent-zen-agent-1"
HOST_USER_ID="${1:?用法：./sign-token.sh <宿主用户id> [有效天数]}"
DAYS="${2:-30}"

docker exec -e SUB_USER="${HOST_USER_ID}" -e SUB_DAYS="${DAYS}" "${CONTAINER}" node -e '
const { createHmac } = require("node:crypto");
const b64 = (s) => Buffer.from(s).toString("base64").replace(/[+]/g,"-").replace(/[/]/g,"_").replace(/=+$/,"");
// iss 取服务端验签白名单首项（同一容器 env，单一事实源）——签出的 token 必被本服务端接受。
const iss = (process.env.ZA_JWT_ISS_ALLOWLIST ?? "zen-agent").split(",")[0].trim();
const header = b64(JSON.stringify({ alg: "HS256", typ: "JWT" }));
const payload = b64(JSON.stringify({
  sub: "user-" + process.env.SUB_USER,
  tenant: "codeflow",
  roles: ["user"],
  hostUserId: process.env.SUB_USER,
  iss,
  exp: Math.floor(Date.now()/1000) + Number(process.env.SUB_DAYS) * 86400,
}));
const sig = b64(createHmac("sha256", process.env.ZA_JWT_SECRET).update(header + "." + payload).digest());
console.log(header + "." + payload + "." + sig);
'
