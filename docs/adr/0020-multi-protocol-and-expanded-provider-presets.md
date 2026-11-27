---
status: accepted
---

# 多协议原生适配与常见模型服务商全量预置

> 部分修订 [ADR 0018](0018-multi-provider-openai-compatible-architecture.md) 第 1–4 节与第 6–7 节：在保持纯客户端 BYOK 与 DeepSeek 一等预设不变的前提下，将传输层从单一 OpenAI Chat Completions 扩展为四协议原生适配，并将内置服务商预设扩充至覆盖国内外主流厂商的 21 个条目。

## Decision

1. **四协议适配边界与显式协议字段**：
   - 在 `ProviderCapabilities` 中引入显式协议声明 `apiProtocol`：
     - `openai_chat`：OpenAI Chat Completions（`/chat/completions`），兼容 DeepSeek 及国内绝大部分开放平台与本地服务；
     - `openai_responses`：OpenAI Responses API（`/responses`、`store: false`、`instructions` + `input`）；OpenAI 官方预设默认启用，支持在折叠设置中切回 `openai_chat`；
     - `anthropic_messages`：Anthropic Messages API（`/v1/messages`、`x-api-key`、`anthropic-version`、Web 端携带 `anthropic-dangerous-direct-browser-access: true`）；
     - `gemini_native`：Google Gemini 原生 REST SSE（`/v1beta/models/{model}:streamGenerateContent?alt=sse`、`x-goog-api-key`、`systemInstruction` + `contents`）。
   - 各预设自带推荐默认协议；「自定义服务商」与折叠的「更多可选设置」支持手动切换协议，便于接入双协议服务商或第三方中转站。
   - 所有协议继续复用 Android 端协议无关的 `NativeSsePlugin` 字节流透传与 Web `fetch` 流式读取，仅在 TypeScript 传输与校验层做请求构造与 SSE/用量解析。

2. **全量 BYOK API Key 原则（暂不接入消费级订阅 OAuth）**：
   - 本阶段统一保持纯本地 BYOK API Key：Google Gemini AI Pro 与 Anthropic Claude Pro/Max 官方均禁止第三方应用复用消费级订阅额度；OpenAI `Sign in with ChatGPT` 虽有协议通路，但需引入 Android Deep Link / Custom Tabs 与 OAuth Token 刷新托管，待后续独立评估立项。
   - 在 Gemini、Anthropic、OpenAI 表单中提供简明提示，说明消费级会员不含 API 调用额度、需在开发者平台创建 API Key（并提示 Google AI Studio 提供免费层级）。

3. **21 项内置服务商预设与轻量模型策略**：
   - 保留 `deepseek`（官方推荐一等预设）与 `local`（Ollama / LM Studio）、`custom`，并将常见提供商扩展至 21 项：
     - 海外直连：`openai`、`anthropic`、`gemini`、`xai`、`groq`
     - 国内直连：`moonshot`（Kimi）、`zhipu`（智谱 GLM）、`dashscope`（阿里云百炼）、`volcengine`（火山方舟）、`minimax`、`qianfan`（百度千帆）、`hunyuan`（腾讯混元）、`spark`（讯飞星火）、`sensenova`（商汤日日新）、`stepfun`（阶跃星辰）、`lingyi`（零一万物）
     - 聚合路由：`openrouter`、`siliconflow`
   - 每个预设仅内置 2–4 个代表性主力/轻量模型（含推荐 `defaultModel` 与 `backgroundModel`），主要依赖模型列表拉取与手填兜底（Gemini 拉取 `/v1beta/models` 时自动过滤 `supportedGenerationMethods` 含 `generateContent` 的对话模型；火山方舟支持提示填写推理接入点 `ep-...`；不支持 `/models` 的端点允许直接保存）。

4. **跨协议思考映射、续写降级与用量归一化**：
   - **思考开关**：维持全局默认关闭。`openai_responses` 开启传 `reasoning: { effort, summary: 'auto' }`；`anthropic_messages` 开启传 `thinking: { type: 'enabled', budget_tokens }`；`gemini_native` 关闭时对支持模型发 `thinkingBudget: 0`（对 Pro 等不允许设为 `0` 的模型按合法下限处理）、开启发 `thinkingBudget` + `includeThoughts: true`；国内 `openai_chat` 兼容服务商关闭态严禁传思考字段，开启态按已核实的官方方言（如百炼 `enable_thinking` 等）做轻量映射。
   - **前缀续写**：`anthropic_messages` 在未开启思考时允许使用末尾 `assistant` 预填，一旦开启思考自动禁用 prefill 以防 `400`；`openai_responses` 与 `gemini_native` 默认降级为标准消息续写（`none`）。
   - **用量与诊断/备份**：将四协议的输入/输出/缓存命中/思考 Token 统一归一化至 `LlmUsage`；把新增官方预设域名列入脱敏诊断包白名单 `OFFICIAL_MODEL_HOSTS`（严禁记录内容与密钥）；`.folio.json` 导入时遇到未知 `presetId` 平滑降级为 `custom`。

5. **向导 UI 收纳结构**：
   - 「连接模型服务」弹窗顶部采用单条醒目切换栏（展示当前服务商与「切换服务商（21 项）▾」），不再平铺预设卡片网格；展开后提供关键词过滤与四组分类（`推荐与内置` / `国内大模型` / `海外大模型` / `聚合・本地・自定义`），点选后自动收起。
   - 仅初次新手引导与编辑已有档案时默认收起（延续 DeepSeek 一等直连引导）；从设置页点击「添加服务商」新建时默认展开分类面板。

## Considered Options

- **仅扩充 OpenAI Chat Completions 兼容列表而不接原生协议**：虽开发成本最低，但 Anthropic / Gemini 官方兼容层在思考控制、缓存统计与部分地区直连行为上不如原生端点完整，且 OpenAI 新模型正逐步向 Responses API 演进。
- **同步在 Android 端接入 OpenAI `Sign in with ChatGPT` OAuth**：需要改造 `AndroidManifest.xml` Deep Link、引入系统浏览器回调与 Token 刷新存储，而 Web 纯前端依然受 CORS 限制，且 Gemini/Claude 会员均不可用，纳入本票会显著拉长交付周期。
- **在弹窗顶部保留 6 张推荐卡片再加展开抽屉**：会造成「6 个外露 + 15 个折叠」的重复层级与手机端首屏拥挤，统一收纳进单条可展开分类选择器更简洁一致。

## Consequences

- `src/harness/types.ts`、`src/harness/keyConfig.ts`、`src/harness/sse.ts`、`src/harness/keyValidation.ts`、`src/harness/diagnostics.ts`、`src/harness/backup.ts` 与 `src/platform/capacitorSseTransport.ts` 需按四协议适配器与 21 预设目录重构；Android Java `NativeSsePlugin` 保持不变。
- `ProviderSetupWizard.tsx` 及 `tests/ui/providerSetupWizard.test.ts`、`tests/e2e/issue-custom-provider.mjs` 需按可展开分类选择器更新交互，同时保留 `provider-preset-<id>` 测试锚点。
