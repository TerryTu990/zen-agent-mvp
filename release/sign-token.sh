#!/usr/bin/env bash
# 管理员签发用户 token：在 lingm2 运行容器内以 ZA_JWT_SECRET 签 HS256 JWT（secret 不出服务器）。
# 输出仅 token 本身；将它发给用户，用户在扩展选项页粘贴保存即可使用。
# 用法：release/sign-token.sh -u <hostUserId> [-t tenant] [-d 有效天数]
set -euo pipefail

HOST="lingm2"
CONTAINER="zen-agent-zen-agent-1"
HOST_USER_ID=""
TENANT="codeflow"
DAYS="30"

while getopts "u:t:d:" opt; do
  case "$opt" in
    u) HOST_USER_ID="$OPTARG" ;;
    t) TENANT="$OPTARG" ;;
    d) DAYS="$OPTARG" ;;
    *) echo "用法：$0 -u <hostUserId> [-t tenant] [-d 天数]" >&2; exit 1 ;;
  esac
done
[[ -n "${HOST_USER_ID}" ]] || { echo "必须以 -u 指定宿主用户 id（该用户在宿主系统的标识）" >&2; exit 1; }

ssh "${HOST}" "docker exec -e SUB_USER='${HOST_USER_ID}' -e SUB_TENANT='${TENANT}' -e SUB_DAYS='${DAYS}' ${CONTAINER} node -e '
const { createHmac } = require(\"node:crypto\");
const b64 = (s) => Buffer.from(s).toString(\"base64\").replace(/[+]/g,\"-\").replace(/[/]/g,\"_\").replace(/=+\$/,\"\");
const header = b64(JSON.stringify({ alg: \"HS256\", typ: \"JWT\" }));
const payload = b64(JSON.stringify({
  sub: \"user-\" + process.env.SUB_USER,
  tenant: process.env.SUB_TENANT,
  roles: [\"user\"],
  hostUserId: process.env.SUB_USER,
  iss: \"zen-agent\",
  exp: Math.floor(Date.now()/1000) + Number(process.env.SUB_DAYS) * 86400,
}));
const sig = b64(createHmac(\"sha256\", process.env.ZA_JWT_SECRET).update(header + \".\" + payload).digest());
console.log(header + \".\" + payload + \".\" + sig);
'"
