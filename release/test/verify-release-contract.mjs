import { readFileSync } from 'node:fs';

const read = (path) => readFileSync(path, 'utf8');
const compose = read('release/remote/docker-compose.yml');
const dockerfile = read('Dockerfile');
const envExample = read('release/remote/env.example');
const deploy = read('release/deploy-server.sh');

if (!compose.includes('ZA_SYSTEM_PROMPT_PATH: /app/snapshot/system-prompt.md')) {
  throw new Error('production compose must bind prompt to the immutable snapshot');
}
if (!dockerfile.includes('ZA_SYSTEM_PROMPT_PATH=/app/snapshot/system-prompt.md')) {
  throw new Error('runtime prompt default must point at the snapshot');
}
if (envExample.includes('ZA_FEISHU_CARD_GUIDE_URL') || !envExample.includes('ZA_FULFILLMENT_GUIDE_URL')) {
  throw new Error('Feishu guide env contract drifted from server configuration');
}
for (const marker of [
  'await port.listSites()',
  'await port.allTools()',
  'current-release',
  'flock -x',
  'cp -p ${REMOTE_DIR}/docker-compose.yml',
  'register-legacy-release.sh',
  'test -f ${REMOTE_DIR}/docker-compose.yml',
]) {
  if (!deploy.includes(marker)) throw new Error(`deploy preflight/atomicity marker missing: ${marker}`);
}
const registerLegacy = read('release/remote/register-legacy-release.sh');
if (
  !registerLegacy.includes('flock -x 9') ||
  !registerLegacy.includes('已有 current-release') ||
  !registerLegacy.includes('descriptor_cid')
) {
  throw new Error('legacy baseline registration must use the activation lock and compare-and-set');
}
if (!read('release/remote/activate-release.sh').includes('/data/za/.release-write-probe-')) {
  throw new Error('activation must verify the non-root data bind with a write/read/delete probe');
}
console.log('release static contracts passed');
