/**
 * 快照根物化：把 registry 夹具复制到工作目录，文本内容按 replacements 逐对替换。
 * 夹具里的站点 origin 以默认端口书写（如 http://127.0.0.1:4173）；端口经 env 改动时装配的 origin 围栏
 * 必须跟着改，否则 pack 不命中。默认端口下替换对为恒等，物化即原样复制。
 */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function materializeSnapshot(srcDir, dstDir, replacements = []) {
  mkdirSync(dstDir, { recursive: true });
  for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
    const src = join(srcDir, entry.name);
    const dst = join(dstDir, entry.name);
    if (entry.isDirectory()) {
      materializeSnapshot(src, dst, replacements);
      continue;
    }
    let text = readFileSync(src, 'utf8');
    for (const [from, to] of replacements) text = text.replaceAll(from, to);
    writeFileSync(dst, text);
  }
}

/** 站点 origin 的端口替换对：[[默认端口, 实际端口], …] → [['127.0.0.1:默认', '127.0.0.1:实际'], …]。 */
export function hostPortReplacements(pairs) {
  return pairs.map(([from, to]) => [`127.0.0.1:${from}`, `127.0.0.1:${to}`]);
}
