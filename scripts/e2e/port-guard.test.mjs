/**
 * 端口守卫自检：占用端口须以抛错（而非退出进程）表达，消息指明端口与占用提示；空闲端口放行。
 * 运行：node --test scripts/e2e/port-guard.test.mjs（家族 runner 开跑前也会执行）。
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { test } from 'node:test';
import { PortsBusyError, assertPortsFree } from './port-guard.mjs';

function occupy() {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function closeServer(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

test('被占用的端口：抛 PortsBusyError，消息含端口与「另一 worktree」提示，进程不退出', async () => {
  const holder = await occupy();
  const { port } = holder.address();
  const exitCalls = [];
  const originalExit = process.exit;
  process.exit = (code) => {
    exitCalls.push(code);
  };
  try {
    await assert.rejects(
      () => assertPortsFree([{ port, label: 'gateway' }]),
      (error) =>
        error instanceof PortsBusyError
        && error.message.includes(`gateway 127.0.0.1:${port}`)
        && error.message.includes('另一 worktree'),
    );
    assert.deepEqual(exitCalls, []);
  } finally {
    process.exit = originalExit;
    await closeServer(holder);
  }
});

test('空闲端口：正常返回', async () => {
  const holder = await occupy();
  const { port } = holder.address();
  await closeServer(holder);
  await assertPortsFree([{ port, label: 'gateway' }]);
});
