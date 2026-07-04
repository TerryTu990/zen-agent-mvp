/**
 * 确定性 mock LLM（OpenAI chat completions 兼容，仅 stream:true）。
 * 供 llm-port 集成测试与 E2E 编排使用：按规则对 (system 拼接, 最后 user) 产出固定回复。
 * R5（引导）优先于 R1-R4：命中定位问句且请求带 guide_highlight 工具 + facts 登记锚点时，
 * 产出 OpenAI tool_calls 流式 delta（arguments 分片，与 llm-port 增量聚合契约对齐）；
 * 否则产出文本，内容拆 ≥3 个 SSE chunk 下发以覆盖流式分片路径。纯 node 内建，无依赖。
 */
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

const REPLY_R1_HIT = '根据本功能事实：已完成订单不可取消（其取消按钮为禁用态）。';
const REPLY_R2_DETAIL = '这是订单详情页：展示订单号、状态与金额，可通过返回链接回到订单列表。';
const REPLY_R2_LIST = '这是订单列表页：可查看订单、进入详情、取消未发货订单。';
const REPLY_R3_REFUSE = '这超出了我的职责范围：我只辅助你使用当前系统，无法回答与系统无关的问题。';

const GUIDE_TOOL = 'guide_highlight';
const GUIDE_LOCATE_RE = /在哪|哪里|哪儿|怎么找|如何找到|定位/;

/** 请求 tools 是否携带 built-in 引导工具（OpenAI function 形态或裸 name）。 */
function hasGuideTool(body) {
  return (
    Array.isArray(body?.tools) &&
    body.tools.some((t) => t?.function?.name === GUIDE_TOOL || t?.name === GUIDE_TOOL)
  );
}

/**
 * 返回 { text } 或 { toolCall:{ name, arguments } }。
 * R5 先判：定位问句时，仅当请求带引导工具、facts 登记了 #btn-export、且问句确指该锚点（问"导出"）
 * 才产出引导 tool_call；否则退化为文本 MOCK-NO-ANCHOR。
 * 问句锚点相关性（`导出`）是必要项：order-list 的 facts 恒含 #btn-export，仅凭 sys 含锚点
 * 无法把"打印发票"这类无登记锚点的定位问句判为降级——它是失配/降级路径唯一可判据。
 */
function decide(sys, u, guideAvailable) {
  if (GUIDE_LOCATE_RE.test(u)) {
    if (guideAvailable && sys.includes('#btn-export') && u.includes('导出')) {
      // 故障注入：问句含"越界"哨兵 → 产出越界 action（'click'）的引导 tool_call，作为真实 LLM
      // 幻觉非法引导参数的确定性替身，驱动服务端 guideFrame 闭集校验的降级路径。
      const action = u.includes('越界') ? 'click' : 'highlight';
      return {
        toolCall: {
          name: GUIDE_TOOL,
          arguments: JSON.stringify({
            action,
            selector: '#btn-export',
            message: '导出按钮在订单列表页的操作区',
          }),
        },
      };
    }
    return { text: 'MOCK-NO-ANCHOR' };
  }
  return { text: pickReply(sys, u) };
}

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
    const decision = decide(sys, u, hasGuideTool(body));

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
    if (decision.toolCall) {
      const fragments = splitInThree(decision.toolCall.arguments);
      fragments.forEach((arguments_, i) => {
        const tc =
          i === 0
            ? {
                index: 0,
                id: 'call_guide',
                type: 'function',
                function: { name: decision.toolCall.name, arguments: arguments_ },
              }
            : { index: 0, function: { arguments: arguments_ } };
        send({ index: 0, delta: { tool_calls: [tc] }, finish_reason: null });
      });
      send({ index: 0, delta: {}, finish_reason: 'tool_calls' });
    } else {
      for (const part of splitInThree(decision.text)) {
        send({ index: 0, delta: { content: part }, finish_reason: null });
      }
      send({ index: 0, delta: {}, finish_reason: 'stop' });
    }
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
