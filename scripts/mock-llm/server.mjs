/**
 * 确定性 mock LLM（OpenAI chat completions 兼容，仅 stream:true）。
 * 供 llm-port 集成测试与 E2E 编排使用：按规则对 (system 拼接, 最后 user) 产出固定回复。
 * 判定优先级（更具体优先）：存在 role:tool 观察 → 代执行回喂轮，据 observation 产出总结文本；
 * 否则按关键词 + 工具可见性触发代执行 tool_call（取消/刷新/清空）；再判 R5 引导；末位 R1-R4 文本。
 * tool_call 产出 OpenAI tool_calls 流式 delta（arguments 分片，与 llm-port 增量聚合契约对齐）；
 * 文本内容拆 ≥3 个 SSE chunk 下发以覆盖流式分片路径。纯 node 内建，无依赖。
 */
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

const REPLY_R1_HIT = '根据本功能事实：已完成订单不可取消（其取消按钮为禁用态）。';
const REPLY_R2_DETAIL = '这是订单详情页：展示订单号、状态与金额，可通过返回链接回到订单列表。';
const REPLY_R2_LIST = '这是订单列表页：可查看订单、进入详情、取消未发货订单。';
const REPLY_R3_REFUSE = '这超出了我的职责范围：我只辅助你使用当前系统，无法回答与系统无关的问题。';

const GUIDE_TOOL = 'guide_highlight';
const GUIDE_LOCATE_RE = /在哪|哪里|哪儿|怎么找|如何找到|定位/;

const TOOL_CANCEL = 'order-list.cancel-order';
const TOOL_REFRESH = 'order-list.refresh-orders';
const TOOL_PURGE = 'order-list.purge-orders';

/** 请求 tools 是否携带指定 name 的工具（OpenAI function 形态或裸 name）。 */
function hasTool(body, name) {
  return (
    Array.isArray(body?.tools) &&
    body.tools.some((t) => t?.function?.name === name || t?.name === name)
  );
}

/**
 * 最后一条 role:tool 观察的文本内容——代执行回喂轮才存在（服务端把 observation 追加为 role:tool）；
 * 非 null 即"第二轮"，据此产出总结文本而非再次触发工具。
 */
function lastToolObs(body) {
  const msgs = Array.isArray(body?.messages) ? body.messages : [];
  const obs = [...msgs].reverse().find((m) => m?.role === 'tool');
  return obs ? String(obs.content ?? '') : null;
}

/** 首轮工具触发：按关键词 + 工具可见性产出 tool_call；无命中返回 null。 */
function pickToolCall(u, body) {
  const ord = u.match(/ORD-\d+/);
  if (u.includes('取消') && ord && hasTool(body, TOOL_CANCEL)) {
    return { id: 'call_cancel', name: TOOL_CANCEL, arguments: JSON.stringify({ orderId: ord[0] }) };
  }
  if (u.includes('刷新') && hasTool(body, TOOL_REFRESH)) {
    return { id: 'call_refresh', name: TOOL_REFRESH, arguments: JSON.stringify({}) };
  }
  if ((u.includes('清空') || u.includes('删除所有')) && hasTool(body, TOOL_PURGE)) {
    return { id: 'call_purge', name: TOOL_PURGE, arguments: JSON.stringify({}) };
  }
  return null;
}

/**
 * 回喂轮总结：obs 是服务端回喂的 observation 内容串（成功=body 的 JSON，失败={"error":...}）。
 * 更具体（成功带 orderId/count）优先于失败类别，失败类别再兜底 MOCK-OBS-DEFAULT。
 */
function summarizeObs(obs) {
  const ok = obs.includes('"ok":true');
  if (ok && /orderId/.test(obs)) {
    const ord = obs.match(/ORD-\d+/);
    return `已为你取消订单 ${ord ? ord[0] : ''}。`;
  }
  if (ok && /count/.test(obs)) {
    const c = obs.match(/"count":\s*(\d+)/);
    return `已刷新，当前 ${c ? c[1] : ''} 笔订单。`;
  }
  if (obs.includes('user-rejected')) return '已取消该操作，未做任何更改。';
  if (obs.includes('forbidden')) return '抱歉，该操作不被允许执行。';
  if (/invalid-result|exec-failed|timeout|replayed/.test(obs)) return '操作未成功完成。';
  return 'MOCK-OBS-DEFAULT';
}

/**
 * 返回 { text } 或 { toolCall:{ name, arguments } }。
 * R5 先判：定位问句时，仅当请求带引导工具、facts 登记了 #btn-export、且问句确指该锚点（问"导出"）
 * 才产出引导 tool_call；否则退化为文本 MOCK-NO-ANCHOR。
 * 问句锚点相关性（`导出`）是必要项：order-list 的 facts 恒含 #btn-export，仅凭 sys 含锚点
 * 无法把"打印发票"这类无登记锚点的定位问句判为降级——它是失配/降级路径唯一可判据。
 */
function decide(sys, u, body) {
  const obs = lastToolObs(body);
  if (obs !== null) return { text: summarizeObs(obs) };

  const toolCall = pickToolCall(u, body);
  if (toolCall) return { toolCall };

  if (GUIDE_LOCATE_RE.test(u)) {
    if (hasTool(body, GUIDE_TOOL) && sys.includes('#btn-export') && u.includes('导出')) {
      // 故障注入：问句含"越界"哨兵 → 产出越界 action（'click'）的引导 tool_call，作为真实 LLM
      // 幻觉非法引导参数的确定性替身，驱动服务端 guideFrame 闭集校验的降级路径。
      const action = u.includes('越界') ? 'click' : 'highlight';
      return {
        toolCall: {
          id: 'call_guide',
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
    const decision = decide(sys, u, body);

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
                id: decision.toolCall.id ?? 'call_guide',
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
