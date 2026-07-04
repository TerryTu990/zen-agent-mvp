/**
 * 确定性 mock LLM（OpenAI chat completions 兼容，仅 stream:true）。
 * 供 llm-port 集成测试与 M1 E2E 编排使用：按 R1-R4 规则对 (system 拼接, 最后 user) 产出固定回复，
 * 内容拆 ≥3 个 SSE chunk 下发以覆盖流式分片路径。纯 node 内建，无依赖。
 */
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

const REPLY_R1_HIT = '根据本功能事实：已完成订单不可取消（其取消按钮为禁用态）。';
const REPLY_R2_DETAIL = '这是订单详情页：展示订单号、状态与金额，可通过返回链接回到订单列表。';
const REPLY_R2_LIST = '这是订单列表页：可查看订单、进入详情、取消未发货订单。';
const REPLY_R3_REFUSE = '这超出了我的职责范围：我只辅助你使用当前系统，无法回答与系统无关的问题。';

function pickReply(sys, u) {
  if (u.includes('能取消')) {
    return sys.includes('已完成') && sys.includes('不可取消') ? REPLY_R1_HIT : 'MOCK-MISSING-FACTS';
  }
  if (u.includes('显示的是什么') || u.includes('做什么用')) {
    if (sys.includes('订单详情') && sys.includes('#order-id')) return REPLY_R2_DETAIL;
    if (sys.includes('订单列表') && sys.includes('#order-table')) return REPLY_R2_LIST;
    return 'MOCK-NO-FEATURE';
  }
  if (/天气|写.*诗/.test(u)) {
    return sys.includes('拒答') ? REPLY_R3_REFUSE : 'MOCK-BASE-MISSING';
  }
  return 'MOCK-DEFAULT';
}

function splitInThree(text) {
  const chars = Array.from(text);
  const step = Math.ceil(chars.length / 3);
  const parts = [];
  for (let i = 0; i < chars.length; i += step) parts.push(chars.slice(i, i + step).join(''));
  while (parts.length < 3) parts.push('');
  return parts;
}

function sendError(res, status, message) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: { message, type: 'invalid_request_error' } }));
}

function handleChat(req, res) {
  let raw = '';
  req.on('data', (chunk) => {
    raw += chunk;
  });
  req.on('end', () => {
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      sendError(res, 400, 'invalid JSON body');
      return;
    }
    if (!Array.isArray(body?.messages)) {
      sendError(res, 400, 'messages must be an array');
      return;
    }
    if (body.stream !== true) {
      sendError(res, 400, 'only stream:true is supported');
      return;
    }
    const sys = body.messages
      .filter((m) => m?.role === 'system')
      .map((m) => String(m.content ?? ''))
      .join('\n');
    const lastUser = [...body.messages].reverse().find((m) => m?.role === 'user');
    const u = String(lastUser?.content ?? '');
    const reply = pickReply(sys, u);

    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    const base = {
      id: 'chatcmpl-mock',
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model: typeof body.model === 'string' ? body.model : 'mock-model',
    };
    const send = (choice) => {
      res.write(`data: ${JSON.stringify({ ...base, choices: [choice] })}\n\n`);
    };
    send({ index: 0, delta: { role: 'assistant' }, finish_reason: null });
    for (const part of splitInThree(reply)) {
      send({ index: 0, delta: { content: part }, finish_reason: null });
    }
    send({ index: 0, delta: {}, finish_reason: 'stop' });
    res.write('data: [DONE]\n\n');
    res.end();
  });
}

export function startMockLlm({ port = Number(process.env.MOCK_LLM_PORT ?? 8788) } = {}) {
  const server = createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      handleChat(req, res);
      return;
    }
    sendError(res, 404, 'not found');
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      resolve({
        port: server.address().port,
        close: () =>
          new Promise((res2, rej2) => server.close((err) => (err ? rej2(err) : res2()))),
      });
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startMockLlm().then(
    ({ port }) => console.log(`mock-llm listening on http://127.0.0.1:${port}/v1`),
    (err) => {
      console.error(`mock-llm 启动失败：${err.message}`);
      process.exit(1);
    },
  );
}
