/**
 * 本地服务端口空闲守卫：E2E / 评测起任何本地服务前先探测所需端口，占用即 fail-fast。
 * 就绪探测只看 healthz 是否 200，分不清「自家子进程」与「别的 worktree 正跑着的 gateway」；
 * 先占位探测把这种串台变成开跑前的硬失败。
 */
import { createServer } from 'node:net';

function probe(port, host) {
  return new Promise((resolve) => {
    const server = createServer();
    server.unref();
    server.once('error', (error) => resolve(error.code ?? 'ERROR'));
    server.listen(port, host, () => server.close(() => resolve(null)));
  });
}

/**
 * entries: [{ port, host?, label? }]；host 缺省 127.0.0.1（与各脚本 listen 的绑定地址一致）。
 * 任一端口不可绑定即打印占用清单并以退出码 1 结束进程。
 */
export async function assertPortsFree(entries) {
  const busy = [];
  for (const entry of entries) {
    const host = entry.host ?? '127.0.0.1';
    const code = await probe(entry.port, host);
    if (code !== null) busy.push(`${entry.label ?? 'port'} ${host}:${entry.port}（${code}）`);
  }
  if (busy.length === 0) return;
  console.error(`端口被占用，拒绝开跑（可能另一 worktree 正占用；改用 ZA_E2E_*/ZA_EVAL_* 端口 env 隔离）：\n  ${busy.join('\n  ')}`);
  process.exit(1);
}
