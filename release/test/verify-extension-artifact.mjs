import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const manifest = JSON.parse(readFileSync('apps/extension/manifest.json', 'utf8'));
const zip = `release/artifacts/zen-commerce-agent-extension-${manifest.version}.zip`;
const entries = execFileSync('unzip', ['-Z1', zip], { encoding: 'utf8' }).trim().split('\n');
for (const required of ['manifest.json', 'sidepanel.html', 'options.html', 'dist/background.js']) {
  if (!entries.includes(required)) throw new Error(`extension zip missing ${required}`);
}
const background = execFileSync('unzip', ['-p', zip, 'dist/background.js'], { encoding: 'utf8' });
if (!background.includes('https://agent.flash-api.com')) throw new Error('production server URL missing from extension zip');
console.log(`verified ${zip}`);
