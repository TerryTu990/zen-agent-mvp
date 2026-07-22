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
for (const marker of ['await port.listSites()', 'await port.allTools()', 'current-release', 'flock -x']) {
  if (!deploy.includes(marker)) throw new Error(`deploy preflight/atomicity marker missing: ${marker}`);
}
console.log('release static contracts passed');
