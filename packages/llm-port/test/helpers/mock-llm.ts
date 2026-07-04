import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export interface MockLlmHandle {
  port: number;
  close(): Promise<void>;
}

/**
 * 以独立子进程拉起 mock LLM（与 E2E 编排同形态；U2 禁跨包 import，进程边界不受此限）。
 * MOCK_LLM_PORT=0 → 随机端口，从 stdout 的监听公告解析实际端口。
 */
export async function startMockLlmProcess(): Promise<MockLlmHandle> {
  const scriptPath = fileURLToPath(
    new URL('../../../../scripts/mock-llm/server.mjs', import.meta.url),
  );
  const child = spawn(process.execPath, [scriptPath], {
    env: { ...process.env, MOCK_LLM_PORT: '0' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const port = await new Promise<number>((resolve, reject) => {
    let out = '';
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString();
      const match = out.match(/127\.0\.0\.1:(\d+)/);
      if (match?.[1] !== undefined) resolve(Number(match[1]));
    });
    child.once('exit', (code) => reject(new Error(`mock-llm 提前退出（code=${code}）`)));
    child.once('error', reject);
  });
  return {
    port,
    close: () =>
      new Promise<void>((resolve) => {
        child.once('exit', () => resolve());
        child.kill();
      }),
  };
}
