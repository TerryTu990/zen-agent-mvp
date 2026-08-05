/**
 * E2E harness 侧的匿名身份工具（adr-022）：脚本自己要直连服务端 API 时，走与插件同一条
 * POST /v1/activation 换取令牌，不再自签测试 JWT——身份派生与有效期全部以服务端为准，
 * 派生规则漂移时脚本会直接失败而非按镜像实现假通过。
 *
 * 安装 id 是持有型凭证：一律用 randomUUID() 现生成，不写死在仓库里（SEC-01）。
 */

import { createHash } from 'node:crypto';

/** 匿名身份的固定 tenant（adr-022 D3）：激活响应只回 hostUserId，subject 归属键还需要它。 */
export const ANON_TENANT = 'anon';

/**
 * 服务端派生规则的手抄镜像（apps/server/src/activation.ts deriveHostUserId）：
 * 只在「服务端尚未起、又必须先按该身份预置数据」时用；能拿到激活响应时一律以响应为准。
 * 规则漂移会让依赖它的用例直接失败（预置数据挂不到实际 subject 上），不会假通过。
 */
export function anonHostUserId(installId) {
  return `anon-${createHash('sha256').update(installId, 'utf8').digest('base64url')}`;
}

/** 换身份 = 换 installId。返回服务端签发的 { token, expiresAt, hostUserId }。 */
export async function activate(baseUrl, installId) {
  const response = await fetch(`${baseUrl}/v1/activation`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ installId }),
  });
  if (!response.ok) throw new Error(`匿名激活失败：HTTP ${response.status}`);
  return response.json();
}
