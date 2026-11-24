#!/usr/bin/env node
/**
 * beta 前缀续写探针（issue #117）
 *
 * 目的：用真实请求确定官方 `POST /beta/chat/completions` + `prefix: true` 在
 * 思考模式下的四件事——预填位置（content / reasoning_content）、首块是否回显
 * 预填内容、finish_reason、正文是否以预填内容开头。
 *
 * 用法：
 *   DEEPSEEK_API_KEY=sk-xxxx DEEPSEEK_MODEL=deepseek-flash \
 *     node docs/research/2026-11-22-beta-prefix-probe.mjs
 *
 * 环境变量：
 *   DEEPSEEK_API_KEY   必填，DeepSeek 官方 sk- 开头的 Key
 *   DEEPSEEK_MODEL     可选，默认 deepseek-flash
 *   DEEPSEEK_BETA_BASE 可选，默认 https://api.deepseek.com/beta
 *
 * 依赖：Node 18+ 原生 fetch，无第三方依赖。
 * 注意：本仓 ~/.env.local 里的 VITE_TEST_API_KEY 是百度千帆的 bce-v3/ 密钥，
 * 不是 DeepSeek 的 sk- Key，不能用来跑本脚本。
 */

const API_KEY = (process.env.DEEPSEEK_API_KEY ?? '').trim();
const MODEL = (process.env.DEEPSEEK_MODEL ?? 'deepseek-flash').trim() || 'deepseek-flash';
const BETA_BASE = (process.env.DEEPSEEK_BETA_BASE ?? 'https://api.deepseek.com/beta')
  .trim()
  .replace(/\/+$/, '');
const ENDPOINT = `${BETA_BASE}/chat/completions`;

if (!API_KEY) {
  console.log(
    '未设置 DEEPSEEK_API_KEY，已跳过真实请求。设置后重跑：DEEPSEEK_API_KEY=sk-xxx node docs/research/2026-11-22-beta-prefix-probe.mjs',
  );
  process.exit(0);
}

// ---- 预填素材 -------------------------------------------------------------
// 中文小说场景：场景起手 + 半句对话，故意停在标点之后、句子中间，
// 让「是否回显」可以被 startsWith 精确判定。
const PREFILL_CONTENT = '雨还没停。他抬起头，看见';
const PREFILL_REASONING = '这一段的视角应该落在主角身上，先给一个环境细节再推进动作。';

const USER_PROMPT = [
  '你是中文小说写作引擎。请接着已有的开头继续写，只输出续写的正文，不要解释，不要加标题，不要复述已有内容。',
  '',
  '【已有开头】',
  `「${PREFILL_CONTENT}」`,
].join('\n');

// ---- 四种组合 -------------------------------------------------------------
// content × reasoning_content 的四种预填组合，外加一条思考关闭的对照。
const CASES = [
  {
    id: 'A-content-only',
    label: '只预填 content',
    thinking: { type: 'enabled' },
    reasoningEffort: 'high',
    assistant: { content: PREFILL_CONTENT },
  },
  {
    id: 'B-reasoning-only',
    label: '只预填 reasoning_content',
    thinking: { type: 'enabled' },
    reasoningEffort: 'high',
    assistant: { content: '', reasoningContent: PREFILL_REASONING },
  },
  {
    id: 'C-both',
    label: 'content 与 reasoning_content 都预填',
    thinking: { type: 'enabled' },
    reasoningEffort: 'high',
    assistant: { content: PREFILL_CONTENT, reasoningContent: PREFILL_REASONING },
  },
  {
    id: 'D-empty-prefix',
    label: 'prefix: true 但两个字段都空（对照组）',
    thinking: { type: 'enabled' },
    reasoningEffort: 'high',
    assistant: { content: '' },
  },
  {
    id: 'E-thinking-off-content',
    label: '附加对照：thinking disabled + 只预填 content',
    thinking: { type: 'disabled' },
    reasoningEffort: 'none',
    assistant: { content: PREFILL_CONTENT },
  },
];

// ---- 请求体 ---------------------------------------------------------------
function buildBody(probeCase) {
  /** @type {Record<string, unknown>} */
  const lastMessage = { role: 'assistant', content: probeCase.assistant.content, prefix: true };
  if (probeCase.assistant.reasoningContent !== undefined) {
    lastMessage.reasoning_content = probeCase.assistant.reasoningContent;
  }
  return {
    model: MODEL,
    messages: [{ role: 'user', content: USER_PROMPT }, lastMessage],
    stream: true,
    thinking: probeCase.thinking,
    reasoning_effort: probeCase.reasoningEffort,
    // 故意不发 stop / temperature / top_p / seed / safety_check / tools：
    // 与 sse.ts 的 buildOpenAiChatRequest 保持一致，避免引入额外互斥条件。
  };
}

// ---- SSE 读取 -------------------------------------------------------------
function splitSseEvents(buffer) {
  // 返回 [完整事件数组, 剩余未闭合缓冲]
  const events = [];
  let rest = buffer;
  while (true) {
    const match = rest.match(/\r?\n\r?\n/);
    if (!match || match.index === undefined) break;
    const raw = rest.slice(0, match.index);
    rest = rest.slice(match.index + match[0].length);
    const dataLines = raw
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => (line[5] === ' ' ? line.slice(6) : line.slice(5)));
    if (dataLines.length > 0) events.push(dataLines.join('\n'));
  }
  return [events, rest];
}

async function runCase(probeCase) {
  const body = buildBody(probeCase);
  const expectContentEcho = probeCase.assistant.content;
  const expectReasoningEcho = probeCase.assistant.reasoningContent ?? '';

  console.log('');
  console.log('='.repeat(78));
  console.log(`用例 ${probeCase.id} — ${probeCase.label}`);
  console.log('-'.repeat(78));
  console.log(`model=${MODEL}  thinking=${JSON.stringify(probeCase.thinking)}  reasoning_effort=${probeCase.reasoningEffort}`);
  console.log(`末条消息：${JSON.stringify(body.messages[body.messages.length - 1])}`);

  let response;
  try {
    response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        Authorization: `Bearer ${API_KEY}`,
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    console.log(`HTTP 状态: 请求失败（网络层）${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  console.log(`HTTP 状态: ${response.status} ${response.statusText}`);
  console.log('CORS 回显 Access-Control-Allow-Origin: ' + (response.headers.get('access-control-allow-origin') ?? '(无)'));

  if (!response.ok) {
    let detail = '';
    try {
      detail = (await response.text()).slice(0, 600);
    } catch {
      detail = '(读取错误响应体失败)';
    }
    console.log('错误响应体: ' + detail);
    console.log('结论: 该组合被拒绝。');
    return;
  }

  if (!response.body) {
    console.log('响应体为空，无法判定流式契约。');
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let eventCount = 0;
  const printedChunks = [];
  let content = '';
  let reasoning = '';
  let finishReason = null;
  let done = false;

  while (!done) {
    const { done: streamDone, value } = await reader.read();
    if (streamDone) break;
    buffer += decoder.decode(value, { stream: true });
    const [events, rest] = splitSseEvents(buffer);
    buffer = rest;
    for (const payload of events) {
      if (payload.trim() === '[DONE]') {
        done = true;
        break;
      }
      let parsed;
      try {
        parsed = JSON.parse(payload);
      } catch {
        continue;
      }
      eventCount += 1;
      if (printedChunks.length < 3) {
        printedChunks.push(payload.trim());
      }
      const choice = parsed.choices?.[0];
      if (!choice) continue;
      if (choice.finish_reason != null) finishReason = choice.finish_reason;
      const delta = choice.delta ?? {};
      if (typeof delta.reasoning_content === 'string') reasoning += delta.reasoning_content;
      if (typeof delta.content === 'string') content += delta.content;
    }
  }
  try {
    reader.releaseLock();
  } catch {
    /* ignore */
  }

  // 收尾：流结束时若还有未以空行闭合的完整事件，一并计入。
  buffer += decoder.decode(undefined, { stream: false });
  const [tailEvents] = splitSseEvents(`${buffer}\n\n`);
  for (const payload of tailEvents) {
    if (payload.trim() === '[DONE]') continue;
    let parsed;
    try {
      parsed = JSON.parse(payload);
    } catch {
      continue;
    }
    eventCount += 1;
    if (printedChunks.length < 3) printedChunks.push(payload.trim());
    const choice = parsed.choices?.[0];
    if (!choice) continue;
    if (choice.finish_reason != null) finishReason = choice.finish_reason;
    const delta = choice.delta ?? {};
    if (typeof delta.reasoning_content === 'string') reasoning += delta.reasoning_content;
    if (typeof delta.content === 'string') content += delta.content;
  }

  console.log(`SSE 事件数: ${eventCount}`);
  console.log('前 3 个 SSE chunk 原始 JSON:');
  printedChunks.forEach((chunk, index) => {
    console.log(`  [${index + 1}] ${chunk.length > 900 ? `${chunk.slice(0, 900)}…(截断)` : chunk}`);
  });
  console.log(`finish_reason: ${finishReason === null ? '(未出现)' : finishReason}`);
  console.log(`正文累计长度: ${content.length}；思维链累计长度: ${reasoning.length}`);

  const contentPreviews = content.slice(0, 120);
  const reasoningPreviews = reasoning.slice(0, 120);
  console.log(`正文前 120 字: ${JSON.stringify(contentPreviews)}`);
  console.log(`思维链前 120 字: ${JSON.stringify(reasoningPreviews)}`);

  // 回显判定：累计流是否以预填内容开头
  const contentEchoed = expectContentEcho !== '' && content.startsWith(expectContentEcho);
  const contentContainsEcho = expectContentEcho !== '' && content.includes(expectContentEcho);
  const reasoningEchoed = expectReasoningEcho !== '' && reasoning.startsWith(expectReasoningEcho);
  const reasoningContainsEcho = expectReasoningEcho !== '' && reasoning.includes(expectReasoningEcho);

  console.log('回显判定:');
  console.log(`  正文是否以预填 content 开头: ${expectContentEcho === '' ? '(本用例无 content 预填)' : contentEchoed}`);
  console.log(`  正文是否包含预填 content: ${expectContentEcho === '' ? '(本用例无 content 预填)' : contentContainsEcho}`);
  console.log(`  思维链是否以预填 reasoning_content 开头: ${expectReasoningEcho === '' ? '(本用例无 reasoning 预填)' : reasoningEchoed}`);
  console.log(`  思维链是否包含预填 reasoning_content: ${expectReasoningEcho === '' ? '(本用例无 reasoning 预填)' : reasoningContainsEcho}`);

  if (!contentEchoed && expectContentEcho !== '') {
    console.log('  → 若「开头」为 false、「包含」也为 false，说明服务端只回了新增部分，客户端必须自行前置预填。');
  }
  if (reasoning.length > 0 && content.length > 0) {
    console.log('  → 本用例同时收到思维链与正文：注意两者的先后顺序是否始终为「先思维链后正文」。');
  }
}

console.log('beta 前缀续写探针（issue #117）');
console.log(`端点: ${ENDPOINT}`);
console.log(`模型: ${MODEL}`);
console.log(`时间: ${new Date().toISOString()}`);
console.log(`Node: ${process.version}`);

for (const probeCase of CASES) {
  await runCase(probeCase);
}

console.log('');
console.log('='.repeat(78));
console.log('探针结束。把上面的输出贴回 docs/research/2026-11-22-beta-prefix-feasibility.md 的「待实测」小节。');
