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

/**
 * 站点 origin 的端口替换对：[[默认端口, 实际端口], …] → 每对同时给出字面形态 `127.0.0.1:端口`
 * （site.origin / 场景 URL）与 pack.json featureIdRules.urlPattern 的正则转义形态——JSON 文本里
 * 反斜杠成对出现，替换对按其落盘写法 `127\\\\.0\\\\.0\\\\.1:端口` 匹配；两种形态都不改写则 origin 围栏
 * 命中而 featureId 解析失配。
 */
export function hostPortReplacements(pairs) {
  return pairs.flatMap(([from, to]) => [
    [`127.0.0.1:${from}`, `127.0.0.1:${to}`],
    [`127\\\\.0\\\\.0\\\\.1:${from}`, `127\\\\.0\\\\.0\\\\.1:${to}`],
  ]);
}
