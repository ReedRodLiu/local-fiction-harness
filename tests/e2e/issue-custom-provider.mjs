import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { strToU8, zipSync } from 'fflate';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const viteBinary = path.join(path.dirname(require.resolve('vite/package.json')), 'bin/vite.js');
const playwrightCorePath =
  process.env.PLAYWRIGHT_CORE_PATH ||
  path.join(process.env.HOME || '', '.npm-global/lib/node_modules/@playwright/cli/node_modules/playwright-core');
const { chromium } = require(playwrightCorePath);

const PORT = Number(process.env.LFH_E2E_CUSTOM_PROVIDER_PORT || 4197);
const BROWSER_CANDIDATES = [
  process.env.E2E_BROWSER_PATH,
  path.join(process.env.HOME || '', 'Library/Caches/ms-playwright/chromium-1248/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'),
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
].filter(Boolean);

const CUSTOM_BASE_URL = 'https://custom-relay.example/v1';
const CUSTOM_API_KEY = 'sk-custom-secret-key-111';
const DEEPSEEK_API_KEY = 'sk-ds-official-222';
const TAVILY_API_KEY = 'tvly-e2e-search-key-333';
const OPENAI_API_KEY = 'sk-openai-e2e-444';
const ANTHROPIC_API_KEY = 'sk-ant-e2e-555';
const GEMINI_API_KEY = 'AIza-gemini-e2e-666';
const CUSTOM_FETCHED_MODELS = ['fetched-model-a', 'fetched-model-b'];
const CUSTOM_MANUAL_MODEL = 'manual-story-model-x';

function resolveBrowserExecutable() {
  const executablePath = BROWSER_CANDIDATES.find((candidate) => fs.existsSync(candidate));
  if (!executablePath) throw new Error('No pre-installed Chromium or Edge binary found.');
  return executablePath;
}

async function startViteServer() {
  const server = spawn(process.execPath, [viteBinary, '--port', String(PORT), '--strictPort'], {
    cwd: repoRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  await new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      server.kill('SIGTERM');
      reject(error);
    };
    const timer = setTimeout(() => fail(new Error('Vite dev server timeout')), 15000);
    server.stdout.on('data', (chunk) => {
      if (settled || !chunk.toString().includes(String(PORT))) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    });
    server.stderr.on('data', (chunk) => process.stderr.write(chunk));
    server.once('error', (error) => {
      clearTimeout(timer);
      fail(error);
    });
    server.once('exit', (code) => {
      clearTimeout(timer);
      fail(new Error(`Vite exited before startup with code ${code ?? 'unknown'}.`));
    });
  });
  return server;
}

function responsesSseResponse(content, options = {}) {
  const chunks = [];
  if (options.reasoning) {
    chunks.push(
      `event: response.reasoning_summary_text.delta\ndata: ${JSON.stringify({
        type: 'response.reasoning_summary_text.delta',
        delta: options.reasoning,
      })}\n\n`,
    );
  }
  chunks.push(
    `event: response.output_text.delta\ndata: ${JSON.stringify({
      type: 'response.output_text.delta',
      delta: content,
    })}\n\n`,
  );
  chunks.push(
    `event: response.completed\ndata: ${JSON.stringify({
      type: 'response.completed',
      response: {
        status: 'completed',
        usage: options.usage ?? {
          input_tokens: 120,
          output_tokens: 30,
          total_tokens: 150,
        },
      },
    })}\n\n`,
  );
  return chunks.join('');
}

function anthropicSseResponse(content, options = {}) {
  const chunks = [
    `event: message_start\ndata: ${JSON.stringify({
      type: 'message_start',
      message: { usage: { input_tokens: 100, cache_read_input_tokens: 40 } },
    })}\n\n`,
  ];
  if (options.reasoning) {
    chunks.push(
      `event: content_block_delta\ndata: ${JSON.stringify({
        type: 'content_block_delta',
        delta: { type: 'thinking_delta', thinking: options.reasoning },
      })}\n\n`,
    );
  }
  chunks.push(
    `event: content_block_delta\ndata: ${JSON.stringify({
      type: 'content_block_delta',
      delta: { type: 'text_delta', text: content },
    })}\n\n`,
  );
  chunks.push(
    `event: message_delta\ndata: ${JSON.stringify({
      type: 'message_delta',
      delta: { stop_reason: 'end_turn' },
      usage: { output_tokens: 25 },
    })}\n\n`,
  );
  chunks.push(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`);
  return chunks.join('');
}

function geminiSseResponse(content, options = {}) {
  const chunks = [];
  if (options.reasoning) {
    chunks.push(
      `data: ${JSON.stringify({
        candidates: [{ content: { parts: [{ text: options.reasoning, thought: true }] } }],
      })}\n\n`,
    );
  }
  chunks.push(
    `data: ${JSON.stringify({
      candidates: [{ content: { parts: [{ text: content }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 90, candidatesTokenCount: 20, totalTokenCount: 110 },
    })}\n\n`,
  );
  return chunks.join('');
}

function sseResponse(content, options = {}) {
  const chunks = [];
  if (options.reasoning) {
    chunks.push(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: options.reasoning } }] })}\n\n`);
  }
  chunks.push(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: 'stop' }] })}\n\n`);
  if (options.usage) {
    chunks.push(`data: ${JSON.stringify({ choices: [], usage: options.usage })}\n\n`);
  }
  chunks.push('data: [DONE]\n\n');
  return chunks.join('');
}

function routeReply({ mode, title, settingMarkdown, body }) {
  return [
    '```lfh-route',
    `mode: ${mode}`,
    `title: ${title}`,
    '---',
    settingMarkdown,
    '```',
    body,
  ].join('\n');
}

function buildAmbiguousImportZip() {
  const messages = [
    { id: 1, parent_id: null, role: 'USER', status: 'FINISHED', inserted_at: '2026-11-16T08:00:00Z', fragments: [{ type: 'REQUEST', content: '你好呀' }] },
    { id: 2, parent_id: 1, role: 'ASSISTANT', status: 'FINISHED', inserted_at: '2026-11-16T08:01:00Z', fragments: [{ type: 'RESPONSE', content: '你好，请发剧本。' }] },
    { id: 3, parent_id: 2, role: 'USER', status: 'FINISHED', inserted_at: '2026-11-16T08:02:00Z', fragments: [{ type: 'REQUEST', content: '【自定义导入剧本】主角：陆行舟。规则：每轮输出状态栏。' }] },
    { id: 4, parent_id: 3, role: 'ASSISTANT', status: 'FINISHED', inserted_at: '2026-11-16T08:03:00Z', fragments: [{ type: 'RESPONSE', content: '第一幕开始：码头雾浓。' }] },
  ];
  return zipSync({
    'manifest.json': strToU8(JSON.stringify({ export_format_version: 3 })),
    'chat_sessions/ds-custom-import.json': strToU8(
      JSON.stringify({
        id: 'ds-custom-import',
        title: '自定义服务商导入档',
        current_message_id: 4,
        inserted_at: '2026-11-16T08:00:00Z',
        updated_at: '2026-11-16T08:03:00Z',
        messages,
      }),
    ),
  });
}

async function openSettings(page) {
  if (await page.getByTestId('settings-page').isVisible().catch(() => false)) return;
  const desktopBtn = page.getByTestId('desktop-settings-open');
  if (await desktopBtn.isVisible().catch(() => false)) {
    await desktopBtn.click();
  } else {
    await page.getByTestId('library-drawer-trigger').click();
    await page.getByTestId('mobile-library-dialog').waitFor({ state: 'visible' });
    await page.getByTestId('mobile-settings-open').click();
  }
  const settingsPage = page.getByTestId('settings-page');
  await settingsPage.waitFor({ state: 'visible' });
  await settingsPage.evaluate((el) =>
    Promise.all((el.closest('.app-overlay-stage') ?? el).getAnimations({ subtree: true }).map((a) => a.finished.catch(() => {}))),
  );
}

async function closeSettings(page) {
  const settingsPage = page.getByTestId('settings-page');
  if (await settingsPage.isVisible().catch(() => false)) {
    await settingsPage.getByRole('button', { name: '返回' }).click();
    await settingsPage.waitFor({ state: 'detached' });
  }
}

async function openStoryCompanionSettings(page) {
  await page.getByTestId('open-story-tree').click();
  const sheet = page.getByTestId('story-tree-sheet');
  await sheet.waitFor({ state: 'visible' });
  await sheet.getByTestId('companion-tab-settings').click();
  await sheet.getByTestId('session-usage-card').waitFor({ state: 'visible' });
  return sheet;
}

async function closeStoryCompanion(page) {
  const sheet = page.getByTestId('story-tree-sheet');
  if (await sheet.isVisible().catch(() => false)) {
    await page.keyboard.press('Escape');
    await sheet.waitFor({ state: 'hidden' });
  }
}

async function deleteAllVisibleStories(page) {
  for (let i = 0; i < 10; i += 1) {
    const rows = page.getByTestId('desktop-library').getByTestId('story-list-item');
    const count = await rows.count();
    if (count === 0) break;
    await rows.first().getByTestId('story-menu-trigger').click();
    await page.getByTestId('story-overflow-menu').getByRole('menuitem', { name: '删除故事' }).click();
    const confirm = page.getByRole('dialog', { name: '确认删除' });
    await confirm.waitFor({ state: 'visible' });
    await confirm.getByRole('button', { name: '确认删除' }).click();
    await confirm.waitFor({ state: 'hidden' });
    await page.waitForFunction(
      (expected) => document.querySelectorAll('[data-testid="desktop-library"] [data-testid="story-list-item"]').length === expected,
      count - 1,
    );
  }
}

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lfh-e2e-custom-provider-'));
  const server = await startViteServer();
  const browser = await chromium.launch({
    headless: true,
    executablePath: resolveBrowserExecutable(),
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    acceptDownloads: true,
    serviceWorkers: 'block',
  });
  context.setDefaultTimeout(15000);
  await context.addInitScript(() => {
    localStorage.setItem('folio.tutorial.mainDone', 'true');
    localStorage.setItem('folio.tutorial.settingsDone', 'true');
  });
  await context.route('**/*', (route) => {
    const url = new URL(route.request().url());
    return url.origin === `http://localhost:${PORT}`
      ? route.continue()
      : route.abort('internetdisconnected');
  });

  const page = await context.newPage();

  const customRequests = [];
  const deepSeekRequests = [];
  const tavilyRequests = [];
  const openaiRequests = [];
  const anthropicRequests = [];
  const geminiRequests = [];
  let prefillProbeSupported = false;
  let forceNextMainPartialRefusal = false;
  let customReplySeq = 0;

  await page.route('https://custom-relay.example/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const auth = req.headers().authorization || '';
    if (url.pathname === '/v1/models') {
      assert.equal(auth, `Bearer ${CUSTOM_API_KEY}`, 'Custom /models request must send custom API key');
      await route.fulfill({
        status: 200,
        json: { data: CUSTOM_FETCHED_MODELS.map((id) => ({ id })) },
      });
      return;
    }
    if (url.pathname === '/v1/chat/completions') {
      const body = req.postDataJSON();
      customRequests.push({ url: req.url(), auth, body });

      // Prefill compatibility probe (Scenario 5)
      if (body.stream === false && body.max_tokens === 16) {
        if (!prefillProbeSupported) {
          await route.fulfill({
            status: 400,
            json: { error: { message: 'Assistant prefill message is not supported' } },
          });
        } else {
          await route.fulfill({
            status: 200,
            json: { choices: [{ message: { role: 'assistant', content: '落在了青石板上。' } }] },
          });
        }
        return;
      }

      const sysText = (body.messages || [])
        .filter((m) => m.role === 'system')
        .map((m) => m.content)
        .join('\n');
      const lastUser = [...(body.messages || [])].reverse().find((m) => m.role === 'user')?.content || '';

      const usage = {
        prompt_tokens: 1500,
        completion_tokens: 220,
        total_tokens: 1720,
        prompt_tokens_details: { cached_tokens: 1000 },
      };

      if (sysText.includes('互动叙事文游识别助手')) {
        await route.fulfill({
          status: 200,
          contentType: 'text/event-stream',
          body: sseResponse(JSON.stringify({ fictionSessionIds: ['ds-custom-import'] }), { usage }),
        });
        return;
      }

      if (sysText.includes('剧本边界定位')) {
        const items = JSON.parse(lastUser || '[]');
        const scriptNode = items.find((i) => String(i.snippet || '').includes('自定义导入剧本'));
        const playNode = items.find((i) => String(i.snippet || '').includes('第一幕开始'));
        await route.fulfill({
          status: 200,
          contentType: 'text/event-stream',
          body: sseResponse(
            JSON.stringify({
              scriptMessageIds: scriptNode ? [scriptNode.nodeId] : [],
              firstPlayMessageId: playNode?.nodeId ?? null,
            }),
            { usage },
          ),
        });
        return;
      }

      if (sysText.includes('公开角色资料提炼器')) {
        await route.fulfill({
          status: 200,
          contentType: 'text/event-stream',
          body: sseResponse('### 爱德华·艾尔利克\n- 称呼弟弟为「阿尔」，情绪急躁时语速较快。', { usage }),
        });
        return;
      }

      if (sysText.includes('剧情摘要压缩')) {
        await route.fulfill({
          status: 200,
          contentType: 'text/event-stream',
          body: sseResponse('【压缩摘要】主角与同伴在长夜调查中推进了核心线索。', {
            usage: {
              prompt_tokens: 300,
              completion_tokens: 60,
              total_tokens: 360,
              prompt_tokens_details: { cached_tokens: 100 },
            },
          }),
        });
        return;
      }

      if (sysText.includes('自然语言第一入口助手')) {
        const isFma = lastUser.includes('钢之炼金术师');
        const isFog = lastUser.includes('雾港');
        const title = isFma ? '钢炼自定义检索测试' : isFog ? '雾港计费测试' : '雨夜旅馆';
        const setting = isFma
          ? '原作：《钢之炼金术师》\n版本：2003 动画版\n剧情时点：第 51 集后\n角色：爱德华·艾尔利克'
          : '主角林雾在雨夜抵达旧旅馆。';
        const content = routeReply({
          mode: 'story',
          title,
          settingMarkdown: setting,
          body: `自定义服务商首幕回执：${title}。` + '夜色微凉，檐角滴水声清晰可辨。'.repeat(5),
        });
        await route.fulfill({
          status: 200,
          contentType: 'text/event-stream',
          body: sseResponse(content, { usage }),
        });
        return;
      }

      if (forceNextMainPartialRefusal) {
        forceNextMainPartialRefusal = false;
        const longPrefix =
          '雨声压低了旅馆门前的石阶，林雾把铜钥匙放在柜台边缘，抬眼望向楼梯转角尚未熄灭的那盏壁灯，指节微微收紧。' +
          '木地板在潮湿空气里发出轻响，窗外的霓虹把水迹映成暗红色。';
        await route.fulfill({
          status: 200,
          contentType: 'text/event-stream',
          body: sseResponse(`${longPrefix}抱歉，我不能继续写更具体的内容。`, { usage }),
        });
        return;
      }

      if (lastUser.includes('请紧接上一句自然续写后续正文')) {
        await route.fulfill({
          status: 200,
          contentType: 'text/event-stream',
          body: sseResponse('\n\n楼梯口传来轻缓的脚步声，掌柜拎着煤油灯走了下来。', { usage }),
        });
        return;
      }

      customReplySeq += 1;
      const longPad = lastUser.includes('长段推进')
        ? `\n\n${'长夜细雨敲打着旧码头的铁皮屋顶，远处灯塔的光束一次次扫过积水路面，众人沿潮湿石阶排查线索。'.repeat(110)}`
        : '';
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: sseResponse(`自定义回复#${customReplySeq}：${lastUser}${longPad}`, {
          reasoning: body.reasoning_effort ? '自定义推理链条' : undefined,
          usage: lastUser.includes('长段推进')
            ? {
                prompt_tokens: 3000,
                completion_tokens: 220,
                total_tokens: 3220,
                prompt_tokens_details: { cached_tokens: 1800 },
              }
            : usage,
        }),
      });
      return;
    }
    await route.abort('failed');
  });

  await page.route('https://api.deepseek.com/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const auth = req.headers().authorization || '';
    const postData = req.postData() || '';
    deepSeekRequests.push({ url: req.url(), auth, postData });
    assert.equal(auth.includes(CUSTOM_API_KEY), false, 'api.deepseek.com must NEVER receive third-party API key');
    assert.equal(postData.includes(CUSTOM_API_KEY), false, 'api.deepseek.com body must NEVER contain third-party API key');
    assert.equal(auth.includes(TAVILY_API_KEY), false, 'api.deepseek.com must NEVER receive Tavily key');

    if (url.pathname === '/models') {
      await route.fulfill({
        status: 200,
        json: { data: [{ id: 'deepseek-flash' }, { id: 'deepseek-v4-pro' }] },
      });
      return;
    }
    if (url.pathname === '/chat/completions') {
      const body = req.postDataJSON();
      const sysText = (body.messages || []).filter((m) => m.role === 'system').map((m) => m.content).join('\n');
      const lastUser = [...(body.messages || [])].reverse().find((m) => m.role === 'user')?.content || '';
      const content = sysText.includes('自然语言第一入口助手')
        ? routeReply({
            mode: 'story',
            title: '深海潜艇',
            settingMarkdown: '深海潜艇测试设定。',
            body: 'DeepSeek 官方首幕：声呐屏幕亮起微光。',
          })
        : `DeepSeek回复：${lastUser}`;
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: sseResponse(content),
      });
      return;
    }
    await route.fulfill({ status: 200, json: { results: [] } });
  });

  await page.route('https://api.tavily.com/search', async (route) => {
    const req = route.request();
    const auth = req.headers().authorization || '';
    const body = req.postDataJSON();
    tavilyRequests.push({ auth, body });
    await route.fulfill({
      status: 200,
      json: {
        results: [
          {
            title: 'FMA 2003 Wiki',
            url: 'https://fma.example/2003-ed',
            content: '爱德华·艾尔利克在 2003 动画版第 51 集后与阿尔冯斯分离，性格直率重情。',
          },
        ],
      },
    });
  });

  await page.route('https://api.openai.com/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const auth = req.headers().authorization || '';
    assert.equal(auth, `Bearer ${OPENAI_API_KEY}`, 'OpenAI endpoint must send OpenAI API key');
    if (url.pathname === '/v1/models') {
      await route.fulfill({
        status: 200,
        json: { data: [{ id: 'gpt-4.1' }, { id: 'gpt-4o-mini' }] },
      });
      return;
    }
    if (url.pathname === '/v1/responses') {
      const body = req.postDataJSON();
      openaiRequests.push({ url: req.url(), auth, body });
      const instructions = String(body.instructions || '');
      const lastUser = [...(body.input || [])].reverse().find((m) => m.role === 'user')?.content || '';
      const content = instructions.includes('自然语言第一入口助手')
        ? routeReply({
            mode: 'story',
            title: '雪夜山庄',
            settingMarkdown: '暴风雪封锁了山庄木门。',
            body: 'Responses首幕：雪夜山庄壁炉余烬未熄。',
          })
        : `Responses回复：${lastUser}`;
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: responsesSseResponse(content, {
          reasoning: body.reasoning ? 'Responses推理摘要' : undefined,
        }),
      });
      return;
    }
    await route.abort('failed');
  });

  await page.route('https://api.anthropic.com/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const headers = req.headers();
    assert.equal(headers['x-api-key'], ANTHROPIC_API_KEY, 'Anthropic endpoint must send x-api-key');
    assert.equal(headers['anthropic-version'], '2023-06-01', 'Anthropic endpoint must send anthropic-version');
    assert.equal(
      headers['anthropic-dangerous-direct-browser-access'],
      'true',
      'Anthropic Web request must send browser-access header',
    );
    if (url.pathname === '/v1/models') {
      await route.fulfill({
        status: 200,
        json: { data: [{ id: 'claude-sonnet-4-5' }, { id: 'claude-haiku-4-5' }] },
      });
      return;
    }
    if (url.pathname === '/v1/messages') {
      const body = req.postDataJSON();
      anthropicRequests.push({ url: req.url(), headers, body });
      const lastUser = [...(body.messages || [])].reverse().find((m) => m.role === 'user')?.content || '';
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: anthropicSseResponse(`Anthropic回复：${lastUser}`, {
          reasoning: body.thinking?.type === 'enabled' ? 'Claude思考过程' : undefined,
        }),
      });
      return;
    }
    await route.abort('failed');
  });

  await page.route('https://generativelanguage.googleapis.com/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const headers = req.headers();
    assert.equal(headers['x-goog-api-key'], GEMINI_API_KEY, 'Gemini endpoint must send x-goog-api-key');
    assert.equal(url.searchParams.has('key'), false, 'Gemini URL must NEVER expose API key in query string');
    if (url.pathname === '/v1beta/models') {
      await route.fulfill({
        status: 200,
        json: {
          models: [
            { name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] },
            { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] },
          ],
        },
      });
      return;
    }
    if (url.pathname.endsWith(':streamGenerateContent')) {
      assert.equal(url.searchParams.get('alt'), 'sse');
      const body = req.postDataJSON();
      geminiRequests.push({ url: req.url(), headers, body });
      const sysText = (body.systemInstruction?.parts || []).map((p) => p.text || '').join('\n');
      const lastUser = [...(body.contents || [])].reverse().find((c) => c.role === 'user')?.parts?.[0]?.text || '';
      const content = sysText.includes('自然语言第一入口助手')
        ? routeReply({
            mode: 'story',
            title: '星际航站楼',
            settingMarkdown: '第十二星区中转站正值换班时刻。',
            body: 'Gemini原生首幕：星际航站楼全息告示牌闪烁蓝光。',
          })
        : `Gemini原生回复：${lastUser}`;
      await route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: geminiSseResponse(content, {
          reasoning: body.generationConfig?.thinkingConfig?.includeThoughts ? 'Gemini思考链' : undefined,
        }),
      });
      return;
    }
    await route.abort('failed');
  });

  try {
    await page.goto(`http://localhost:${PORT}`, { waitUntil: 'networkidle' });
    await page.getByTestId('welcome-view').waitFor();

    // =========================================================================
    // Scenario 1: Unified wizard custom preset + /models fetch + manual model
    //             + default thinking OFF (omits thinking & reasoning_effort)
    //             + thinking ON (sends reasoning_effort without thinking)
    // =========================================================================
    await openSettings(page);
    await page.getByTestId('open-setup-wizard-btn').click();
    const wizard = page.getByTestId('deepseek-setup-wizard');
    await wizard.waitFor({ state: 'visible' });

    // Onboarding mode starts with preset picker collapsed
    const pickerTrigger = wizard.getByTestId('provider-preset-picker-trigger');
    assert.equal(await pickerTrigger.getAttribute('aria-expanded'), 'false');
    assert.equal(await wizard.getByTestId('provider-preset-picker-panel').count(), 0);

    // Expanding shows search input, 4 categories, and all 21 presets
    await pickerTrigger.click();
    const pickerPanel = wizard.getByTestId('provider-preset-picker-panel');
    await pickerPanel.waitFor({ state: 'visible' });
    assert.equal(await pickerTrigger.getAttribute('aria-expanded'), 'true');
    for (const groupLabel of ['推荐与内置', '国内大模型', '海外大模型', '聚合・本地・自定义']) {
      await pickerPanel.getByRole('heading', { name: groupLabel }).waitFor();
    }
    assert.equal(await pickerPanel.locator('button[data-testid^="provider-preset-"]').count(), 30);

    // Search filter narrows by Chinese/English alias and resets cleanly
    const presetSearchInput = wizard.getByTestId('provider-preset-search-input');
    await presetSearchInput.fill('Kimi');
    await pickerPanel.getByTestId('provider-preset-moonshot').waitFor({ state: 'visible' });
    assert.equal(await pickerPanel.getByTestId('provider-preset-openai').count(), 0);
    await presetSearchInput.fill('');

    await wizard.getByTestId('provider-preset-custom').click();
    await pickerPanel.waitFor({ state: 'detached' });
    assert.equal(await pickerTrigger.getAttribute('aria-expanded'), 'false');
    await wizard.getByTestId('provider-name-input').fill('我的中转站');
    await wizard.getByTestId('provider-base-url-input').fill(CUSTOM_BASE_URL);
    await wizard.locator('#byok-api-key').fill(CUSTOM_API_KEY);
    await wizard.getByTestId('provider-fetch-models-btn').click();
    await wizard.getByRole('button', { name: 'fetched-model-a' }).waitFor();
    await wizard.getByRole('button', { name: 'fetched-model-b' }).waitFor();
    await wizard.getByTestId('provider-model-input').fill(CUSTOM_MANUAL_MODEL);
    await wizard.getByTestId('wizard-verify-save-btn').click();
    await wizard.waitFor({ state: 'detached' });

    const customItem = page.locator('[data-testid^="provider-profile-item-"]', { hasText: '我的中转站' });
    await customItem.waitFor();
    const customProfileTestId = await customItem.getAttribute('data-testid');
    assert.ok(customProfileTestId, 'Missing custom provider profile list item');
    const customProfileId = customProfileTestId.replace('provider-profile-item-', '');

    // Verify settings-thinking-toggle starts OFF and toggles cleanly
    const settingsThinkingToggle = page.getByTestId('settings-thinking-toggle');
    assert.equal(await settingsThinkingToggle.isChecked(), false, 'Global default thinking must start OFF');
    await settingsThinkingToggle.click();
    assert.equal(await settingsThinkingToggle.isChecked(), true, 'settings-thinking-toggle should turn ON');
    await settingsThinkingToggle.click();
    assert.equal(await settingsThinkingToggle.isChecked(), false, 'settings-thinking-toggle should return OFF');
    await closeSettings(page);

    await page.fill('#turn-input', '开一个原创雨夜旅馆的文游，主角是林雾。');
    await page.getByRole('button', { name: '发送行动', exact: true }).click();
    await page.getByTestId('story-timeline').getByText('自定义服务商首幕回执：雨夜旅馆', { exact: false }).waitFor();

    const firstChatReq = customRequests.at(-1)?.body;
    assert.ok(firstChatReq, 'Expected first custom provider chat request');
    assert.equal(firstChatReq.model, CUSTOM_MANUAL_MODEL);
    assert.equal('thinking' in firstChatReq, false, 'Third-party default thinking OFF must omit `thinking`');
    assert.equal('reasoning_effort' in firstChatReq, false, 'Third-party default thinking OFF must omit `reasoning_effort`');

    const composerThinkingToggle = page.getByTestId('composer-thinking-toggle');
    assert.equal(await composerThinkingToggle.getAttribute('aria-pressed'), 'false');
    await composerThinkingToggle.click();
    assert.equal(await composerThinkingToggle.getAttribute('aria-pressed'), 'true');

    await page.fill('#turn-input', '推开旅馆木门');
    await page.getByRole('button', { name: '发送行动', exact: true }).click();
    await page.getByTestId('story-timeline').getByText('自定义回复#1：推开旅馆木门', { exact: false }).waitFor();

    const thinkingOnReq = customRequests.at(-1)?.body;
    assert.ok(thinkingOnReq, 'Expected second custom provider request with thinking ON');
    assert.equal('thinking' in thinkingOnReq, false, 'Third-party thinking ON must NOT send `thinking`');
    assert.ok(
      ['low', 'medium', 'high'].includes(thinkingOnReq.reasoning_effort),
      `Third-party thinking ON must send standard reasoning_effort, got: ${thinkingOnReq.reasoning_effort}`,
    );
    await composerThinkingToggle.click();
    assert.equal(await composerThinkingToggle.getAttribute('aria-pressed'), 'false');
    console.log('CUSTOM_PROVIDER_SCENARIO_1_PASSED');

    // =========================================================================
    // Scenario 2: Multi-profile switching (DeepSeek + custom) + per-story
    //             providerId + model override via composer-provider-model-trigger
    //             + page.reload() persistence
    // =========================================================================
    await openSettings(page);
    await page.getByTestId('add-provider-profile-btn').click();
    await wizard.waitFor({ state: 'visible' });
    // Add mode starts with preset picker expanded
    assert.equal(await wizard.getByTestId('provider-preset-picker-trigger').getAttribute('aria-expanded'), 'true');
    await wizard.getByTestId('provider-preset-picker-panel').waitFor({ state: 'visible' });
    await wizard.getByTestId('provider-preset-deepseek').click();
    await wizard.getByTestId('provider-preset-picker-panel').waitFor({ state: 'detached' });
    await wizard.locator('#byok-api-key').fill(DEEPSEEK_API_KEY);
    await wizard.getByTestId('wizard-verify-save-btn').click();
    await wizard.waitFor({ state: 'detached' });
    await page.getByTestId('provider-profile-item-deepseek-official').waitFor();
    await closeSettings(page);

    await page.getByTestId('desktop-library-new-creation').click();
    await page.getByTestId('welcome-view').waitFor();
    await page.fill('#turn-input', '开一个深海潜艇的文游。');
    await page.getByRole('button', { name: '发送行动', exact: true }).click();
    await page.getByTestId('story-timeline').getByText('DeepSeek 官方首幕：声呐屏幕亮起微光。', { exact: false }).waitFor();
    assert.ok(
      deepSeekRequests.some((r) => r.url.endsWith('/chat/completions') && r.auth === `Bearer ${DEEPSEEK_API_KEY}`),
      'New story under DeepSeek active profile should hit api.deepseek.com',
    );

    const modelTrigger = page.getByTestId('composer-provider-model-trigger');
    await modelTrigger.click();
    await page.getByTestId('composer-provider-model-menu').waitFor({ state: 'visible' });
    await page.getByTestId(`composer-provider-model-option-${customProfileId}-fetched-model-b`).click();

    const customCountBeforeOverride = customRequests.length;
    await page.fill('#turn-input', '检查声呐读数');
    await page.getByRole('button', { name: '发送行动', exact: true }).click();
    await page.getByTestId('turn-assistant').getByText('检查声呐读数', { exact: false }).waitFor();
    assert.equal(customRequests.length, customCountBeforeOverride + 1, 'Per-story override should route to custom provider');
    assert.equal(customRequests.at(-1).body.model, 'fetched-model-b');

    await page.reload({ waitUntil: 'networkidle' });
    await page.getByTestId('turn-assistant').getByText('检查声呐读数', { exact: false }).waitFor();
    const triggerTextAfterReload = await page.getByTestId('composer-provider-model-trigger').textContent();
    assert.ok(
      triggerTextAfterReload?.includes('我的中转站') && triggerTextAfterReload.includes('fetched-model-b'),
      `Per-story override did not persist across reload: ${triggerTextAfterReload}`,
    );

    await page.fill('#turn-input', '下潜至两百米');
    await page.getByRole('button', { name: '发送行动', exact: true }).click();
    await page.getByTestId('turn-assistant').getByText('下潜至两百米', { exact: false }).waitFor();
    assert.equal(customRequests.at(-1).body.model, 'fetched-model-b');

    await openSettings(page);
    assert.equal(await page.locator('[data-testid^="provider-profile-item-"]').count(), 2);
    console.log('CUSTOM_PROVIDER_SCENARIO_2_PASSED');

    // =========================================================================
    // Scenario 3: Optional Tavily search on third-party provider + zero
    //             third-party key leak to api.deepseek.com + synthesis uses custom model
    // =========================================================================
    await page.getByTestId(`provider-profile-switch-${customProfileId}`).click();
    await page.getByTestId(`provider-profile-edit-${customProfileId}`).click();
    await wizard.waitFor({ state: 'visible' });
    await wizard.getByTestId('provider-search-preset-tavily').click();
    await wizard.getByTestId('provider-search-key-input').fill(TAVILY_API_KEY);
    await wizard.getByTestId('wizard-verify-save-btn').click();
    await wizard.waitFor({ state: 'detached' });
    await closeSettings(page);

    const dsCountBeforeTavily = deepSeekRequests.length;
    const customStartScenario3 = customRequests.length;
    await page.getByTestId('desktop-library-new-creation').click();
    await page.getByTestId('welcome-view').waitFor();
    await page.fill('#turn-input', '开一个《钢之炼金术师》2003 动画版第 51 集后的文游。角色：爱德华·艾尔利克');
    await page.getByRole('button', { name: '发送行动', exact: true }).click();
    await page.getByTestId('story-timeline').getByText('自定义服务商首幕回执：钢炼自定义检索测试', { exact: false }).waitFor();

    assert.equal(deepSeekRequests.length, dsCountBeforeTavily, 'Tavily search under third-party provider must send ZERO requests to api.deepseek.com');
    assert.equal(tavilyRequests.length, 1, 'Expected one Tavily search request');
    assert.equal(tavilyRequests[0].auth, `Bearer ${TAVILY_API_KEY}`);
    assert.ok(String(tavilyRequests[0].body.query).includes('钢之炼金术师'));

    const scenario3Reqs = customRequests.slice(customStartScenario3);
    const synthesisReq = scenario3Reqs.find((r) => JSON.stringify(r.body.messages).includes('公开角色资料提炼器'));
    const mainFmaReq = scenario3Reqs.find((r) => JSON.stringify(r.body.messages).includes('公开资料参考'));
    assert.ok(synthesisReq, 'Expected synthesis request on third-party provider');
    assert.equal(synthesisReq.body.model, CUSTOM_MANUAL_MODEL, 'Synthesis should use third-party custom model');
    assert.ok(mainFmaReq, 'Expected main story request to receive Tavily-researched reference');
    console.log('CUSTOM_PROVIDER_SCENARIO_3_PASSED');

    // =========================================================================
    // Scenario 4: Token-only savings when custom pricing is blank -> fill CNY
    //             pricing -> verify ¥ cost & savings update in SessionUsageCard
    //             and WorkspaceUsageSummaryCard
    // =========================================================================
    for (let i = 1; i <= 4; i += 1) {
      const prompt = `长段推进第${i}轮：追查线索`;
      await page.fill('#turn-input', prompt);
      await page.getByRole('button', { name: '发送行动', exact: true }).click();
      await page.getByTestId('turn-assistant').getByText(prompt, { exact: false }).waitFor();
    }

    // Verify SessionUsageCard shows tokens-only savings without unavailable error
    await openStoryCompanionSettings(page);
    const sessionUsageCard = page.getByTestId('session-usage-card');
    const sessionTokensOnlyText = await sessionUsageCard.textContent();
    assert.equal(await sessionUsageCard.getByTestId('session-usage-unavailable').count(), 0, `Tokens-only session must not show unavailable error banner: ${sessionTokensOnlyText}`);
    assert.equal(sessionTokensOnlyText?.includes('非 DeepSeek 官方接口'), false);
    assert.equal(sessionTokensOnlyText?.includes('无法对比'), false);
    assert.ok(sessionTokensOnlyText?.includes('累计节省输入估算'), `Expected tokens-only heading in SessionUsageCard: ${sessionTokensOnlyText}`);
    const sessionTokenAmount = await sessionUsageCard.getByTestId('session-usage-savings-amount').textContent();
    assert.match(sessionTokenAmount || '', /[1-9][\d,]*\s*Token/);
    await closeStoryCompanion(page);

    // Verify WorkspaceUsageSummaryCard shows tokens-only savings without error banner
    await openSettings(page);
    const workspaceOverview = page.getByTestId('settings-usage-overview');
    const workspaceTokensOnlyText = await workspaceOverview.textContent();
    assert.equal(await workspaceOverview.getByTestId('workspace-usage-unavailable').count(), 0, 'Tokens-only workspace must not show unavailable error banner');
    assert.equal(workspaceTokensOnlyText?.includes('非 DeepSeek 官方接口'), false);
    assert.equal(workspaceTokensOnlyText?.includes('无法对比'), false);
    assert.ok(workspaceTokensOnlyText?.includes('累计节省输入估算'), `Expected tokens-only heading in WorkspaceUsageSummaryCard: ${workspaceTokensOnlyText}`);
    const workspaceTokenAmount = await workspaceOverview.getByTestId('workspace-usage-savings-amount').textContent();
    assert.match(workspaceTokenAmount || '', /[1-9][\d,]*\s*Token/);

    // Fill custom CNY pricing in wizard advanced settings
    await page.getByTestId(`provider-profile-edit-${customProfileId}`).click();
    await wizard.waitFor({ state: 'visible' });
    await wizard.getByTestId('provider-advanced-settings').locator('summary').click();
    await wizard.getByTestId('provider-pricing-currency').selectOption('CNY');
    await wizard.getByTestId('provider-pricing-input').fill('2');
    await wizard.getByTestId('provider-pricing-cache-input').fill('0.5');
    await wizard.getByTestId('provider-pricing-output').fill('8');
    await wizard.getByTestId('wizard-verify-save-btn').click();
    await wizard.waitFor({ state: 'detached' });
    await closeSettings(page);

    // Delete earlier unpriced stories so WorkspaceUsageSummaryCard evaluates pure CNY-priced turns,
    // and create a new compressed story with CNY pricing to verify both cards show ¥ cost & savings.
    await deleteAllVisibleStories(page);
    await page.getByTestId('welcome-view').waitFor();
    await page.fill('#turn-input', '开一个雾港灯塔调查的文游。');
    await page.getByRole('button', { name: '发送行动', exact: true }).click();
    await page.getByTestId('story-timeline').getByText('自定义服务商首幕回执：雾港计费测试', { exact: false }).waitFor();

    for (let i = 1; i <= 4; i += 1) {
      const prompt = `长段推进第${i}轮：雾港记录`;
      await page.fill('#turn-input', prompt);
      await page.getByRole('button', { name: '发送行动', exact: true }).click();
      await page.getByTestId('turn-assistant').getByText(prompt, { exact: false }).waitFor();
    }

    await openStoryCompanionSettings(page);
    const sessionCnyText = await page.getByTestId('session-usage-card').textContent();
    assert.ok(sessionCnyText?.includes('预计省费') && sessionCnyText.includes('¥'), `Expected ¥ cost & savings in SessionUsageCard: ${sessionCnyText}`);
    assert.ok(sessionCnyText.includes('按自定义模型单价与未压缩前文基线估算'));
    await closeStoryCompanion(page);

    await openSettings(page);
    const workspaceCnyText = await workspaceOverview.textContent();
    assert.ok(workspaceCnyText?.includes('累计预计省费') && workspaceCnyText.includes('¥'), `Expected ¥ cost & savings in WorkspaceUsageSummaryCard: ${workspaceCnyText}`);
    assert.ok(workspaceCnyText.includes('按自定义模型单价与未压缩前文基线估算'));
    console.log('CUSTOM_PROVIDER_SCENARIO_4_PASSED');

    // =========================================================================
    // Scenario 5: Prefill probe (unsupported & supported) + standard continuation
    //             fallback when unsupported
    // =========================================================================
    await page.getByTestId(`provider-profile-edit-${customProfileId}`).click();
    await wizard.waitFor({ state: 'visible' });
    await wizard.getByTestId('provider-advanced-settings').locator('summary').click();

    prefillProbeSupported = false;
    await wizard.getByTestId('provider-probe-prefill-btn').click();
    await wizard.getByTestId('provider-probe-prefill-result').getByText('暂不支持', { exact: false }).waitFor();
    assert.equal(await wizard.getByTestId('provider-prefill-toggle').isChecked(), false);
    await wizard.getByTestId('wizard-verify-save-btn').click();
    await wizard.waitFor({ state: 'detached' });
    await closeSettings(page);

    forceNextMainPartialRefusal = true;
    await page.fill('#turn-input', '询问柜台后的旧账本');
    await page.getByRole('button', { name: '发送行动', exact: true }).click();
    const partialTurn = page.getByTestId('turn-assistant').last();
    await partialTurn.getByTestId('turn-partial-refusal-banner').waitFor();

    const beforeContinueCount = customRequests.length;
    await partialTurn.getByTestId('turn-partial-refusal-continue').click();
    await partialTurn.getByText('楼梯口传来轻缓的脚步声', { exact: false }).waitFor();
    await partialTurn.getByTestId('turn-partial-refusal-banner').waitFor({ state: 'hidden' });

    const continueReq = customRequests[beforeContinueCount];
    assert.ok(continueReq, 'Expected standard continuation request');
    assert.equal(continueReq.url.includes('/beta/'), false, 'Unsupported prefill must NOT hit /beta/chat/completions');
    assert.equal(
      continueReq.body.messages.some((m) => Boolean(m.prefix)),
      false,
      'Standard continuation fallback must NOT send prefix: true',
    );
    assert.equal(continueReq.body.messages.at(-2)?.role, 'assistant');
    assert.equal(continueReq.body.messages.at(-1)?.role, 'user');
    assert.ok(continueReq.body.messages.at(-1)?.content.includes('请紧接上一句自然续写后续正文'));

    // Now probe against mocked supported response
    await openSettings(page);
    await page.getByTestId(`provider-profile-edit-${customProfileId}`).click();
    await wizard.waitFor({ state: 'visible' });
    await wizard.getByTestId('provider-advanced-settings').locator('summary').click();
    prefillProbeSupported = true;
    await wizard.getByTestId('provider-probe-prefill-btn').click();
    await wizard.getByTestId('provider-probe-prefill-result').getByText('支持', { exact: true }).waitFor();
    assert.equal(await wizard.getByTestId('provider-prefill-toggle').isChecked(), true);
    await wizard.getByTestId('wizard-verify-save-btn').click();
    await wizard.waitFor({ state: 'detached' });
    console.log('CUSTOM_PROVIDER_SCENARIO_5_PASSED');

    // =========================================================================
    // Scenario 6: Importing DeepSeek .zip while ONLY custom provider is configured
    //             and confirming AI filter + extraction/import use custom model
    // =========================================================================
    await page.getByTestId('provider-profile-delete-deepseek-official').click();
    await page.waitForFunction(
      () => document.querySelectorAll('[data-testid^="provider-profile-item-"]').length === 1,
    );
    await closeSettings(page);

    const dsCountBeforeImport = deepSeekRequests.length;
    await page.getByTestId('desktop-library-new-creation').click();
    await page.getByTestId('welcome-plus-menu-trigger').click();
    await page.getByTestId('welcome-deepseek-import').click();
    const importPanel = page.getByTestId('deepseek-import-panel');
    await importPanel.waitFor({ state: 'visible' });

    const zipPath = path.join(tmpDir, 'custom-provider-import.zip');
    fs.writeFileSync(zipPath, buildAmbiguousImportZip());
    await page.setInputFiles('#deepseek-zip-input', zipPath);
    await importPanel.getByTestId('ds-session-list').waitFor();

    // Exercise AI filter with ONLY custom provider configured
    await importPanel.getByTestId('ds-filter-tab-ai').click();
    await importPanel.getByTestId('ds-ai-filter-submit').click();
    await importPanel.getByTestId('ds-session-item').filter({ hasText: '自定义服务商导入档' }).waitFor();
    assert.equal(customRequests.at(-1).body.model, CUSTOM_MANUAL_MODEL);

    await importPanel.getByTestId('ds-filter-tab-all').click();
    const customBeforeBoundary = customRequests.length;
    await importPanel.getByTestId('ds-confirm-import-btn').click();
    await importPanel.waitFor({ state: 'detached' });
    await page.getByTestId('story-timeline').getByText('第一幕开始：码头雾浓。', { exact: false }).waitFor();

    await page.fill('#turn-input', '走向码头灯塔');
    await page.getByRole('button', { name: '发送行动', exact: true }).click();
    await page.getByTestId('turn-assistant').getByText('走向码头灯塔', { exact: false }).waitFor();

    const importFollowUpReqs = customRequests.slice(customBeforeBoundary);
    assert.ok(
      importFollowUpReqs.some((r) => JSON.stringify(r.body.messages).includes('剧本边界定位') && r.body.model === CUSTOM_MANUAL_MODEL),
      'Ambiguous DeepSeek .zip extraction should run via custom provider model',
    );
    assert.equal(deepSeekRequests.length, dsCountBeforeImport, 'Import & extraction must not call api.deepseek.com');
    console.log('CUSTOM_PROVIDER_SCENARIO_6_PASSED');

    // =========================================================================
    // Scenario 7: Exporting .folio.json backup with ZERO model/search API keys
    //             and keyless providerLibrary skeleton present
    // =========================================================================
    await openSettings(page);
    const [backupDownload] = await Promise.all([
      page.waitForEvent('download'),
      page.getByTestId('export-current-story').click(),
    ]);
    const backupName = backupDownload.suggestedFilename();
    assert.ok(backupName.endsWith('.folio.json'), `Expected .folio.json filename, got: ${backupName}`);
    const backupJsonText = fs.readFileSync(await backupDownload.path(), 'utf8');

    for (const secret of [CUSTOM_API_KEY, DEEPSEEK_API_KEY, TAVILY_API_KEY]) {
      assert.equal(backupJsonText.includes(secret), false, `Exported backup leaked secret: ${secret}`);
    }

    const parsedBackup = JSON.parse(backupJsonText);
    assert.equal(parsedBackup.schemaVersion, 3);
    assert.ok(parsedBackup.providerLibrary, 'Exported backup must include keyless providerLibrary skeleton');
    assert.equal(parsedBackup.providerLibrary.version, 2);
    assert.equal(parsedBackup.providerLibrary.profiles.length, 1);
    assert.equal(parsedBackup.providerLibrary.profiles[0].name, '我的中转站');
    assert.equal(parsedBackup.providerLibrary.profiles[0].apiKey, undefined);
    assert.equal(parsedBackup.providerLibrary.publicResearch?.provider, 'tavily');
    assert.equal(parsedBackup.providerLibrary.publicResearch?.apiKey, undefined);
    console.log('CUSTOM_PROVIDER_SCENARIO_7_PASSED');

    // =========================================================================
    // Scenario 8: Multi-protocol native flows (OpenAI Responses / Anthropic
    //             Messages / Gemini Native) with search picker, thinking
    //             toggle, multi-profile switching, and per-story override
    // =========================================================================
    // Add OpenAI (openai_responses)
    await page.getByTestId('add-provider-profile-btn').click();
    await wizard.waitFor({ state: 'visible' });
    assert.equal(await wizard.getByTestId('provider-preset-picker-trigger').getAttribute('aria-expanded'), 'true');
    await wizard.getByTestId('provider-preset-search-input').fill('responses');
    await wizard.getByTestId('provider-preset-openai').click();
    await wizard.getByTestId('provider-preset-picker-panel').waitFor({ state: 'detached' });
    await wizard.getByTestId('openai-subscription-notice').waitFor({ state: 'visible' });
    await wizard.locator('#byok-api-key').fill(OPENAI_API_KEY);
    await wizard.getByTestId('wizard-verify-save-btn').click();
    await wizard.waitFor({ state: 'detached' });
    const openaiItem = page.locator('[data-testid^="provider-profile-item-"]', { hasText: 'OpenAI' });
    await openaiItem.waitFor();
    const openaiProfileId = (await openaiItem.getAttribute('data-testid')).replace('provider-profile-item-', '');

    // Add Anthropic (anthropic_messages)
    await page.getByTestId('add-provider-profile-btn').click();
    await wizard.waitFor({ state: 'visible' });
    await wizard.getByTestId('provider-preset-search-input').fill('claude');
    await wizard.getByTestId('provider-preset-anthropic').click();
    await wizard.getByTestId('anthropic-subscription-notice').waitFor({ state: 'visible' });
    await wizard.locator('#byok-api-key').fill(ANTHROPIC_API_KEY);
    await wizard.getByTestId('wizard-verify-save-btn').click();
    await wizard.waitFor({ state: 'detached' });
    const anthropicItem = page.locator('[data-testid^="provider-profile-item-"]', { hasText: 'Anthropic (Claude)' });
    await anthropicItem.waitFor();
    const anthropicProfileId = (await anthropicItem.getAttribute('data-testid')).replace('provider-profile-item-', '');

    // Add Gemini (gemini_native)
    await page.getByTestId('add-provider-profile-btn').click();
    await wizard.waitFor({ state: 'visible' });
    await wizard.getByTestId('provider-preset-search-input').fill('googleapis.com');
    await wizard.getByTestId('provider-preset-gemini').click();
    await wizard.getByTestId('provider-gemini-billing-note').waitFor({ state: 'visible' });
    await wizard.locator('#byok-api-key').fill(GEMINI_API_KEY);
    await wizard.getByTestId('wizard-verify-save-btn').click();
    await wizard.waitFor({ state: 'detached' });
    const geminiItem = page.locator('[data-testid^="provider-profile-item-"]', { hasText: 'Google (Gemini)' });
    await geminiItem.waitFor();
    await closeSettings(page);

    // Active profile is Gemini -> test Gemini Native (thinking OFF -> ON)
    await page.getByTestId('desktop-library-new-creation').click();
    await page.getByTestId('welcome-view').waitFor();
    await page.fill('#turn-input', '开一个星际航站楼的文游。');
    await page.getByRole('button', { name: '发送行动', exact: true }).click();
    await page.getByTestId('story-timeline').getByText('Gemini原生首幕：星际航站楼全息告示牌闪烁蓝光。', { exact: false }).waitFor();
    assert.equal(geminiRequests.at(-1).body.generationConfig?.thinkingConfig?.thinkingBudget, 0);

    await composerThinkingToggle.click();
    assert.equal(await composerThinkingToggle.getAttribute('aria-pressed'), 'true');
    await page.fill('#turn-input', '扫描停机坪');
    await page.getByRole('button', { name: '发送行动', exact: true }).click();
    await page.getByTestId('turn-assistant').last().getByText('Gemini原生回复：扫描停机坪', { exact: false }).waitFor();
    assert.equal(geminiRequests.at(-1).body.generationConfig?.thinkingConfig?.includeThoughts, true);
    assert.ok(geminiRequests.at(-1).body.generationConfig?.thinkingConfig?.thinkingBudget > 0);
    await page.getByTestId('turn-assistant').last().getByTestId('reasoning-toggle').click();
    await page.getByTestId('turn-assistant').last().getByTestId('reasoning-content').getByText('Gemini思考链').waitFor();
    await composerThinkingToggle.click();
    assert.equal(await composerThinkingToggle.getAttribute('aria-pressed'), 'false');

    // Per-story override -> Anthropic Messages (thinking OFF -> ON)
    await page.getByTestId('composer-provider-model-trigger').click();
    await page.getByTestId('composer-provider-model-menu').waitFor({ state: 'visible' });
    await page.getByTestId(`composer-provider-model-option-${anthropicProfileId}-claude-sonnet-4-5`).click();

    await page.fill('#turn-input', '询问值班港务长');
    await page.getByRole('button', { name: '发送行动', exact: true }).click();
    await page.getByTestId('turn-assistant').last().getByText('Anthropic回复：询问值班港务长', { exact: false }).waitFor();
    assert.equal('thinking' in anthropicRequests.at(-1).body, false, 'Anthropic thinking OFF must omit `thinking`');

    await composerThinkingToggle.click();
    await page.fill('#turn-input', '核对航行日志');
    await page.getByRole('button', { name: '发送行动', exact: true }).click();
    await page.getByTestId('turn-assistant').last().getByText('Anthropic回复：核对航行日志', { exact: false }).waitFor();
    assert.equal(anthropicRequests.at(-1).body.thinking?.type, 'enabled');
    assert.ok(anthropicRequests.at(-1).body.max_tokens > anthropicRequests.at(-1).body.thinking.budget_tokens);
    await page.getByTestId('turn-assistant').last().getByTestId('reasoning-toggle').click();
    await page.getByTestId('turn-assistant').last().getByTestId('reasoning-content').getByText('Claude思考过程').waitFor();
    await composerThinkingToggle.click();

    // Switch active profile in Settings -> OpenAI Responses API (thinking OFF -> ON)
    await openSettings(page);
    await page.getByTestId(`provider-profile-switch-${openaiProfileId}`).click();
    await closeSettings(page);

    await page.getByTestId('desktop-library-new-creation').click();
    await page.getByTestId('welcome-view').waitFor();
    await page.fill('#turn-input', '开一个雪夜山庄的文游。');
    await page.getByRole('button', { name: '发送行动', exact: true }).click();
    await page.getByTestId('story-timeline').getByText('Responses首幕：雪夜山庄壁炉余烬未熄。', { exact: false }).waitFor();
    assert.equal(openaiRequests.at(-1).body.store, false);
    assert.equal('reasoning' in openaiRequests.at(-1).body, false, 'Responses thinking OFF must omit `reasoning`');

    await composerThinkingToggle.click();
    await page.fill('#turn-input', '推开壁炉旁暗门');
    await page.getByRole('button', { name: '发送行动', exact: true }).click();
    await page.getByTestId('turn-assistant').last().getByText('Responses回复：推开壁炉旁暗门', { exact: false }).waitFor();
    assert.equal(openaiRequests.at(-1).body.reasoning?.summary, 'auto');
    await page.getByTestId('turn-assistant').last().getByTestId('reasoning-toggle').click();
    await page.getByTestId('turn-assistant').last().getByTestId('reasoning-content').getByText('Responses推理摘要').waitFor();
    await composerThinkingToggle.click();

    console.log('CUSTOM_PROVIDER_SCENARIO_8_PASSED');
    console.log('ISSUE_CUSTOM_PROVIDER_E2E_PASSED');
  } finally {
    await context.close();
    await browser.close();
    server.kill('SIGTERM');
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
