# Folio V0.2 聊天提案协议升级与轻量 Markdown 渲染 / Diff 方案调研

核查日期：2026-11-22。本调研在分支 `research/v02-proposal-protocol-and-markdown-diff` 完成，对应 Wayfinder 地图 [#80](https://github.com/ReedRodLiu/local-fiction-harness/issues/80) 下的研究票据 [#81](https://github.com/ReedRodLiu/local-fiction-harness/issues/81)，用于为 Folio V0.2「自然语言优先 · Markdown 单一真相 · 非阻塞对话内确认卡片 · 真 Markdown 渲染」提供一手资料支撑的技术选型建议。

---

## 一、明确结论总览（Executive Summary）

| 调研子题 | 推荐方案 | 核心收益与包体影响 | 与 V0.2 / ADR 基线对齐点 |
| --- | --- | --- | --- |
| **1. 聊天提案协议升级** | **Tagged Block 元数据头 + 原生未转义 Markdown 正文（`lfh-proposal`）**，支持 **`patch`（Search/Replace 或按节替换）优先、`full` 兜底**、单轮多提案与**降级可恢复解析** | 彻底消除长文档在 JSON 字符串内的 `\n`/`\"` 转义错误与重写截断；原生携带 `summary` 人话摘要；**零静默丢弃**（格式微瑕或截断时保留原文走降级卡片） | 保持 [src/harness/sse.ts](../../src/harness/sse.ts) 单轮文本流直连，兼容 `deepseek-chat` / `deepseek-reasoner` / `deepseek-flash` / `deepseek-v4-pro`，无需强绑 Tool Calling 历史 `reasoning_content` 回传限制 |
| **2. 客户端轻量 Markdown 渲染** | **`marked@18.2.1`（仅使用 `marked.lexer` 产出 Token AST）+ 极薄 React Token 渲染器（~150 行）+ 协议白名单校验** | **零 `dangerouslySetInnerHTML`，零 `DOMPurify` 运行时依赖**；包体增量约 **~15.0 KB gzip**；天然组件级插入 `<HudPanel>` 与表格/列表/引用排版；严格按显式标签/模式隔离，不再劫持「写故事」「角色互动」普通代码块 | 严格符合 [ADR-0010](../../docs/adr/0010-native-css-tokens-and-top-layer-ui-architecture.md) 极简低包体与原生 CSS Tokens 规范，完全兼容 Android WebView 60+ 与现有 `data-testid` E2E 契约 |
| **3. 人类可读 Markdown Diff** | **自研零依赖纯 TS 两级 Myers Diff（~120 行）+ Hunk 上下文折叠**：行级 Myers + 句内高亮（WebView 87+ 用 `Intl.Segmenter('zh', { granularity: 'word' })`，旧 WebView 降级为 `Array.from` 码点级） | **零第三方依赖**，仅增加 **~1.5 KB gzip**（比引入 `diff@9.0.0` 再包一层更轻）；天然解决 `jsdiff` 默认正则不切中文词的痛点；390px 窄屏默认折叠未改行，一眼看清改了哪几行 | 与 `tokens.css` 现有三套主题无缝配合（仅需对称补齐 `--status-ok-soft` 即可通过 `npm run audit:ui`） |

---

## 二、本仓工程基线核查

| 维度 | 本仓实测基线 | 来源文件 |
| --- | --- | --- |
| 运行时与编译目标 | `react@^19.0.0`、`react-dom@^19.0.0`、`vite@^6.0.11`、`typescript@^5.7.3`；`tsconfig.app.json` 与 `tsconfig.harness.json` 均设 `"target": "ES2022"` | [package.json](../../package.json)、[tsconfig.app.json](../../tsconfig.app.json)、[tsconfig.harness.json](../../tsconfig.harness.json) |
| Android & WebView 基线 | `@capacitor/android@^8.6.2`、`minSdkVersion = 24`、`targetSdkVersion = 36`；`audit-artifacts.mjs` 限制 Debug APK ≤ **20 MB**（地图 `#36` 调研期基线 **4.15 MB**） | [android/variables.gradle](../../android/variables.gradle)、[scripts/audit-artifacts.mjs](../../scripts/audit-artifacts.mjs)、[2026-11-19 调研](2026-11-19-ui-styling-and-sheet-stack.md) |
| DeepSeek 官方 BYOK 基线 | 强制收敛到 `https://api.deepseek.com` 与默认模型 `deepseek-flash`（自动迁移旧缓存 `deepseek-chat`）；`buildOpenAiChatRequest` 仅发送 `{ model, messages, stream: true }`，`parseOpenAiSseStream` 分离 `reasoningDelta` 与 `contentDelta` | [src/harness/keyConfig.ts](../../src/harness/keyConfig.ts#L11-L30)、[src/harness/sse.ts](../../src/harness/sse.ts#L88-L214)、[ADR-0009](../../docs/adr/0009-deepseek-official-guided-byok.md) |
| 现有提案协议 | `CHANGE_FENCE = '```lfh-change'`，指令要求末尾附**单行 JSON**（含 `target`、`markdown` 全文及可选 `name`）；`splitMarkdownReply` 要求全文仅一个闭合块且无尾随文本，否则标为 `invalid` | [src/harness/markdownDocuments.ts](../../src/harness/markdownDocuments.ts#L44-L85)、[tests/harness/markdownProposalParsing.test.ts](../../tests/harness/markdownProposalParsing.test.ts) |
| 现有提案静默丢弃与弹窗阻塞 | `harness.ts` / `creative.ts` 仅在 `finishReason === 'stop'` 且 `proposalStatus === 'recognized'` 时返回 `proposal`；`invalid` / `incomplete` 仅写入零内容诊断日志，UI 端无任何用户提示；收到提案后直接弹出模态 `DocumentDialog` | [src/harness/harness.ts](../../src/harness/harness.ts#L561-L583)、[src/harness/creative.ts](../../src/harness/creative.ts#L185-L192)、[src/ui/App.tsx](../../src/ui/App.tsx#L1567-L1593)、[src/ui/DocumentDialog.tsx](../../src/ui/DocumentDialog.tsx) |
| 现有消息渲染与状态面板 | `parseAssistantMessage` 仅识别末尾 ` ```lfh-choices` 并把**所有** ` ```...``` ` 代码围栏一律切为 `{ type: 'codeblock' }`；`MessageContent.tsx` 将所有 `codeblock` 渲染为 `<HudPanel>`（"状态面板"），正文仅用 `.split(/\n\n+/)` 渲染 `<p>` | [src/harness/messageFormat.ts](../../src/harness/messageFormat.ts#L16-L56)、[src/ui/MessageContent.tsx](../../src/ui/MessageContent.tsx#L151-L180) |
| UI Token 与测试契约 | `audit-ui-tokens.mjs` 强制所有色值集中在 `src/ui/styles/tokens.css`（`light`/`dark`/`warm` 键名一致，仅 Hex/`rgba()`）；E2E 依赖 `[data-testid=hud-panel]`、`[data-testid=turn-body]`、`[data-testid=choice-option]` | [scripts/audit-ui-tokens.mjs](../../scripts/audit-ui-tokens.mjs)、[src/ui/styles/tokens.css](../../src/ui/styles/tokens.css)、[tests/e2e/run-e2e.mjs](../../tests/e2e/run-e2e.mjs#L3557-L3801) |

---

## 三、子问题 1：聊天提案协议升级

### 1.1 现有 `lfh-change` 协议的五大结构性局限

通过逐行检查 [src/harness/markdownDocuments.ts](../../src/harness/markdownDocuments.ts#L30-L85)、[src/harness/harness.ts](../../src/harness/harness.ts#L561-L583) 与 [src/harness/creative.ts](../../src/harness/creative.ts#L185-L192)，现行协议存在以下硬伤：

1. **Markdown 塞进单行 JSON 字符串极易格式出错**：`CHANGE_PROMPT` 要求在 ` ```lfh-change` 内输出包含完整 `markdown` 文档的单行 JSON。中文设定文档天然包含大量换行、双引号 `"`、Markdown 代码围栏与反斜杠；模型一旦漏转义一个换行（真实换行而非 `\n`）或双引号，就会直接触发 `JSON.parse` 失败（[tests/harness/markdownProposalParsing.test.ts#L33-L36](../../tests/harness/markdownProposalParsing.test.ts#L33-L36) 即专门验证了真换行会被判定为 `invalid`）。
2. **每轮全文重写成本高、极易触发长度截断**：当故事/角色设定达到 2,000–6,000 字时，哪怕用户只说「把主角的武器改成银匕首」或「记住我喜欢慢热互动」，模型也必须把整篇 Markdown 全部重新输出一遍，成倍消耗输出 Token（且降低流式末尾响应速度），一旦超出输出预算或网络中断即因缺失闭合 ` ``` ` 被判定为 `incomplete`/`invalid`。
3. **格式微瑕直接导致「静默丢弃」**：`splitMarkdownReply`（[src/harness/markdownDocuments.ts#L51-L75](../../src/harness/markdownDocuments.ts#L51-L75)）使用严苛正则 `/^\x60{3}lfh-change\r?\n([\s\S]*?)\r?\n\x60{3}\s*$/`：
   - 只要模型在闭合围栏后多说一句礼貌结语（如「已为您整理好，请确认。」），整个提案直接 `invalid`；
   - 只要模型在同一轮想同时更新「当前设定」和「通用偏好」，出现第二个 `lfh-change` 块即整个 `invalid`；
   - `App.tsx`、`CharacterPane.tsx`、`DraftPane.tsx` 均只检查 `if (result.proposal)`，对 `proposalStatus === 'invalid'` **没有任何界面提示或降级挽救**，只在后台记一条零内容 `warn` 日志，用户在对话中看到“我已经帮你改好了”的回复，实际上资料毫无变化。
4. **缺少结构化「人话变更摘要」字段**：现有 `MarkdownProposal` 只有 `{ target, markdown, name? }`，没有独立的 `summary` 字段；V0.2 的非阻塞对话内确认卡片需要在折叠状态下先用一句话说清「改了什么」（如“将主角武器改为银匕首，并补充一条冷兵器偏好”），不能靠截取大段正文的头部。
5. **意图枚举与 V0.2 心智模型错位**：现有 `target` 为内部工程术语 `public | container | local | character`，且缺少「从文游衍生到写故事（`draft`）」及后台局部笔记静默维护的显式语义区分。

### 1.2 DeepSeek 官方 API 一手能力与协议约束

对照 DeepSeek 官方文档（[Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode)、[JSON Output](https://api-docs.deepseek.com/guides/json_mode)、[Function Calling](https://api-docs.deepseek.com/guides/function_calling)、[Chat Prefix Completion](https://api-docs.deepseek.com/guides/chat_prefix_completion)、[Models & Pricing](https://api-docs.deepseek.com/quick_start/pricing)）：

1. **为什么不用 `response_format: { type: "json_object" }`（JSON Mode）**：
   - 启用 JSON Mode 会强制整条回复都是单一 JSON，无法先流式输出自然语言剧情/对话再附带变更提案；
   - 官方 [JSON Output 文档](https://api-docs.deepseek.com/guides/json_mode) 明确警告：当模型输出无法解析为合法 JSON 时，API 可能将非 JSON 部分替换为空格（`U+0020`），导致即便 `finish_reason === "stop"` 也可能收到近乎空白的响应；
   - 历史型号 `deepseek-reasoner` 原生不支持 `response_format={"type": "json_object"}`。
2. **为什么 V0.2 文本流主通道不建议强依赖 `tools`（Function Calling）**：
   - 虽然新版 DeepSeek 推理/对话模型已支持在 Thinking Mode 下调用工具（[Thinking Mode 文档](https://api-docs.deepseek.com/guides/thinking_mode)），但官方明确规定：**在包含 `tools` 的多轮推理请求中，客户端必须把上一轮助手消息里的完整 `reasoning_content` 原样回传进 `messages`**，否则接口直接返回 **`400 Bad Request`（`Missing reasoning_content field in the assistant message`）**；在 `deepseek-v4-pro` 等模型启用思考+工具调用时还会强制锁定 `top_p = 0.95`；
   - 更关键的是，Tool Calling 会把提案塞进 `delta.tool_calls` 并返回 `finish_reason: "tool_calls"`，如果客户端还需要展示一句承接自然语言或触发二段请求才能收口回复，会显著增加 `sse.ts`、分支重生成（`TurnNode` 回溯/分支切换/摘要压缩）与延迟成本；早期 `deepseek-reasoner` 更是完全不支持 Function Calling。
   - **结论**：保留单一 OpenAI 兼容文本流（`delta.content`）承载「自然语言正文 + 尾部结构化文本协议块」，同时在所有 DeepSeek 型号（`deepseek-chat` / `deepseek-reasoner` / `deepseek-flash` / `deepseek-v4-pro`）上具备最高一致性。
3. **关于 `max_tokens` 与长度预算**：
   - 官方文档显示，非思考模式默认 `max_tokens` 为 **8K**，思考模式默认 **64K**（`reasoning_effort=max` 可扩展到 **128K**），而早期 `deepseek-reasoner` 最终回答默认 **4K**、上限 **8K**（思考部分独立计上限）。在客户端未显式传大额 `max_tokens` 或面对长文设定时，**避免让模型在回复末尾全量复述数千字设定**是降低截断失效率的根本手段。

### 1.3 候选提案格式对比与推荐方案

| 对比维度 | 方案 A：继续单行 JSON (`lfh-change`) | 方案 B：Tool Calling (`tools`) | 方案 C（推荐）：Tagged Block 元数据头 + 原生 Markdown 增量块 (`lfh-proposal`) |
| --- | --- | --- | --- |
| **JSON 转义脆性** | 极高（正文中任意未转义引号/换行即失败） | 中（模型仍需在 `arguments` JSON 字符串内转义整段 Markdown） | **零转义脆性**（元数据用极简 `key: value` 行，正文直接写原生 Markdown） |
| **大文档 Token 与截断风险** | 高（每次必须重写全文） | 高/中（取决于参数 schema） | **低**（默认走 `patch` 搜索替换或 `section` 整节替换，仅短文/新建走 `full`） |
| **多意图 / 单轮多提案** | 不支持（多块即 `invalid`） | 原生支持多个 `tool_calls` | **原生支持多个有序提案块** |
| **流式正文兼容与分支树复杂度** | 高 | 低（需处理 `tool_calls` + 历史 `reasoning_content` 回传） | **高**（沿用现有 `sse.ts` 单次流式请求即可，且可在流式期间隐藏协议前缀） |
| **旧型号兼容性** | 依赖严格 JSON 指令遵循 | 早期 `deepseek-reasoner` 不支持 | **全兼容**（纯文本格式遵循门槛最低） |

#### 推荐协议细则（`lfh-proposal`）

1. **格式定义（头体分离，零字符串转义）**：
   采用自定义围栏 ` ```lfh-proposal `（或 XML 标签 `<lfh-proposal>...</lfh-proposal>`；**更推荐围栏+分隔线**，因为若正文内嵌示例说明时，可用四反引号 ```` ````lfh-proposal ```` 或匹配最近完整块，且沿用现有一致的 `lfh-*` 围栏家族 `lfh-choices`）。
   ```markdown
   ```lfh-proposal
   target: setting
   op: patch
   summary: 将主角武器从铁剑改为银匕首，并记录冷兵器偏好
   ---
   <<<<<<< SEARCH
   - 武器：制式铁剑
   =======
   - 武器：雕花银匕首
   >>>>>>> REPLACE
   ```
   ```
   - **支持字段**：
     - `target`：推荐 V0.2 语义值 `setting`（当前作品/故事/角色设定）、`memory`（通用偏好/我的记忆）、`note`（当前分支局部笔记）、`character`（从文游衍生新建角色，需 `name`）、`draft`（从文游衍生新开写故事稿，可选 `name`），**parser 层同时向后兼容** `container` / `public` / `local`。
     - `op`：
       - `patch`（默认首选）：正文内包含 1 个或多个 `<<<<<<< SEARCH` / `=======` / `>>>>>>> REPLACE` 块，只需包含唯一可定位的 1–5 行上下文即可完成局部修改；
       - `append`：向文档末尾或指定 `section`（如 `## 重要物品`）追加条目，无需搜索锚点，适合“帮我记一下”；
       - `section`：带 `heading: ## 某章节` 时整节替换，避免大篇幅字符匹配误差；
       - `full`：仅在目标文档为空、小于约 800 字、或 `character` / `draft` 跨范围新建时使用，直接给出完整 Markdown 正文。
     - `summary`：单行自然语言人话摘要，直接渲染在确认卡片主标题下方；若模型漏写，客户端自动按“目标类型 + 变更行统计”生成兜底摘要（如“更新当前设定（修改 2 行）”）。
     - `name`：仅 `character` / `draft` 衍生时提供。

2. **三层容错解析与「绝不静默丢弃」机制**：
   - **L1 宽松提取（不因尾随客套话或空格挂掉）**：不再要求提案块必须位于整条回复的最末尾且不能有任何尾随字符；允许捕获多个有序 `lfh-proposal` 块，允许闭合围栏前后有空行或 LLM 收尾客套话，并兼容旧式 ` ```lfh-change` JSON 块。
   - **L2 Patch 容错匹配（解决空白符与轻微行数漂移）**：应用 `SEARCH` 块时按三级匹配顺序查找：精确行匹配 → 忽略行尾空白（`trimEnd`）匹配 → 归一化连续空白/Markdown 列表前缀匹配；若全部未命中（如旧底稿已被用户手动改过），**不要丢弃提案**！
   - **L3 降级恢复状态（`recognized` / `needs_review` / `incomplete`）**：
     - 只要正文中出现了 `lfh-proposal`（或 `lfh-change`）起始标记，哪怕因为 `finish_reason === 'length'` 断流、闭合围栏缺失、头字段缺漏或 `SEARCH` 锚点未命中：
       - 解析器返回结构化对象 `{ proposals: [...], unparsedBlocks: [{ raw, reason, partialTarget?, partialSummary? }] }`，而非把 `proposal` 设为 `undefined` 悄悄吞掉；
       - 对话内确认卡片针对 `unparsedBlocks` 渲染**非阻塞“建议未完整生成 / 需手动核对”降级卡片**，允许用户一键展开原始内容复制、手动打开对应文档编辑应用，或点击“让 AI 重新整理这次改动”。
   - **流式阶段隐藏处理**：升级 `visibleReplyPrefix` 逻辑，同时检测 ```` ```lfh-proposal ```` 与 ```` ```lfh-change ```` 的任意长度尾部前缀；一旦识别进入提案块，正文流暂停向 `TurnCard` 吐出原始协议文本（避免闪现 `<<<<<<< SEARCH`），改为在流式末尾展示“正在整理资料变更建议…”轻量提示，流结束瞬间无缝切换为可展开确认卡片。

---

## 四、子问题 2：客户端轻量 Markdown 渲染（Web + Android WebView）

### 2.1 现有实现瓶颈与「状态面板劫持」问题

核查 [src/harness/messageFormat.ts](../../src/harness/messageFormat.ts#L16-L39) 与 [src/ui/MessageContent.tsx](../../src/ui/MessageContent.tsx#L151-L180)：
- **排版能力缺失**：`MessageContent` 仅将文本按 `\n\n+` 拆分成 `<p>`，导致所有 `# 标题`、`**加粗**`、`*斜体*`、`> 引用`、`- / 1. 列表`、GFM `| 表格 |`、`---` 分隔线和行内代码 `` `code` `` 全部以原始符号裸露给普通用户。
- **代码块劫持问题**：`splitCodeSegments` 把**任意** ` ```[lang]\n...\n``` ` 代码围栏一律拆为 `{ type: 'codeblock' }`，再由 `MessageContent` 一律映射为 `<HudPanel>`（「状态面板」）。而在「写故事」模式（作者与 AI 探讨段落格式、信件框、大纲表格）和「角色互动」模式（角色发送手写便签、代码片段、歌词等普通代码块）下，普通代码块被强行套上终端图标和“状态面板 / 网格视图”外壳，严重破坏阅读沉浸感。

### 2.2 候选轻量 Markdown 渲染库一手实测对比

以下版本、依赖树与包体积数据均直接核查自 npm registry 元数据与 Bundlephobia：

| 候选库（实测版本） | 依赖数 | Minified / Gzipped | 内置 GFM（含表格） | XSS 防护与默认安全策略 | Android WebView 兼容与 React 集成 |
| --- | --- | --- | --- | --- | --- |
| **`marked@18.2.1`** | **0**（MIT） | **~49.7 kB min / ~15.0 kB gz**（npm unpacked 592 KB） | **原生内置**（标题、加粗、列表、引用、删除线、任务列表、表格） | Core **故意不做 HTML 清理**（旧 `sanitize` 选项已彻底删除）；官方要求用外部 sanitizer（如 `DOMPurify`）或走 `marked.lexer()` 自控渲染 | `tsconfig` 编译目标为 `ES2020`，完全覆盖 Capacitor 8 底线（WebView 60+）及非 GMS ROM；原生自带 TS 类型与 ESM 导出 |
| **`markdown-it@15.0.3`** | **6**（`mdurl`、`argparse`、`entities`、`uc.micro`、`linkify-it`、`punycode.js`，MIT） | **~95.9 kB min / ~39.8 kB gz**（npm unpacked 2.06 MB） | **内置**（CommonMark + GFM 表格与删除线） | **默认 `html: false`**（转义原始 HTML 标签）+ `validateLink` 拦截 `javascript:` / `vbscript:` / 危险 `data:` URI | v15（2026-07）全面迁至 TS 并提供 `markdown-it/browser` ESM，但不支持按规则 tree-shake，单库 gzip 已达 `marked` 的 **2.65 倍** |
| **`micromark@4.0.3`** + `micromark-extension-gfm@3.0.0` | **17 + 8**（大量微型 AST/工具子包，MIT） | 核心 ~52.1 kB min / ~14.8 kB gz；加 `gfm` 表格等子扩展后增至 **~22–25+ KB gz** | 需额外挂载 `micromark-extension-gfm`（仅 `gfm-table` 即 +7.5 kB min / +2.4 kB gz） | 默认 `allowDangerousHtml: false`（转义原始 HTML），但直接输出 HTML 字符串仍需关注 URI 协议校验 | 纯输出 HTML 字符串或事件流；若走社区 React AST 封装 `react-markdown@10.1.0` + `remark-gfm@4.0.1`，总包体飙升至 **~152.6 kB min / ~46.4 kB gz** |
| **`DOMPurify@3.4.18`**（仅作安全基线参考） | 1（`@types/trusted-types`） | **~28.0 kB min / ~11.2 kB gz** | — | 行业标准 DOM/HTML XSS 清洗器 | 3.x 支持现代 Chrome/WebView/Safari；若与 `marked.parse` 组合总增量达 **~26.2 KB gz** |

### 2.3 推荐架构：`marked.lexer()` + 极薄 React Token 渲染器 + 显式 `HudPanel` 契约

相比 `marked.parse + DOMPurify + dangerouslySetInnerHTML`（~26.2 KB gz 且必须用 DOM 字符串注入）或 `react-markdown + remark-gfm`（~46.4 KB gz），**推荐在 Folio 中采用 `marked@18.2.1` 的词法器模式（`marked.lexer`）直接映射到轻量 React 组件树（~150 行 TS）**：

1. **为什么 `marked.lexer()` -> React JSX 是包体、安全与隔离的最优解**：
   - **省去 `DOMPurify` 与 `dangerouslySetInnerHTML`**：`marked.lexer(src, { gfm: true, breaks: true })` 只把 Markdown 文本切分为纯 JS Token 对象数组，不拼接 HTML 字符串。React 渲染时仅对白名单 Token 类型（`heading`、`paragraph`、`blockquote`、`list`、`list_item`、`table`、`code`、`codespan`、`strong`、`em`、`del`、`link`、`hr`、`br`、`text`、`escape`）生成对应的 React JSX 元素（`<h1>`..`<h6>`、`<table>` 等）。
   - **天然 XSS 免疫**：
     - 遇到 `token.type === 'html'`（不论块级还是行内原始 HTML 标签如 `<script>`、`<img onerror=...>`），**一律当作普通 React 文本节点渲染**（等效于 `html: false` 自动转义展示，绝不注入 DOM）；
     - 遇到 `link`（或禁止渲染外链的 `image` 可降级为 `[图片: alt]` 文本或占位），通过 `isSafeHref(href)` 严格放行 `https:`、`http:`、`mailto:`（可选 `#` 页内锚点），彻底阻断 `javascript:`、`vbscript:`、`data:` 协议 XSS；并给外链统一加 `rel="noopener noreferrer" target="_blank"`（或由客户端确认打开）。
   - **包体严格收敛**：仅引入单个零依赖包 `marked@18.2.1`（~15.0 KB gzip），远小于 `markdown-it`（~39.8 KB gz）和 `react-markdown + remark-gfm`（~46.4 KB gz），对 4.15 MB Debug APK 增量不到 **0.4%**。

2. **彻底修复 `HudPanel` 劫持普通代码块**：
   - 在 `MarkdownView` 接收 `mode?: 'story' | 'writing' | 'character'`（或 `allowHudDetection?: boolean`）属性与 `code` Token 处理分支中建立明确契约：
     - **显式游戏面板协议（跨模式通用推荐）**：提示词约定当且仅当模型要输出游戏状态面板时，使用显式语言标签 ` ```lfh-hud `（兼容 ` ```hud ` / ` ```status `）。
     - **老存档 / 已有 Prompt 向后兼容（仅文游模式）**：当 `mode === 'story'` 且代码围栏无语言标签（`!token.lang`）或标签属于泛化标识时，才回退调用现有 `parseHudFields(token.text)`，若成功解析为 ≥2 个键值字段则渲染 `<HudPanel>`；否则一律渲染为标准语义 `<pre className="md-code-block"><code>...</code></pre>`。
     - **写故事 & 角色互动模式严格隔离**：在「写故事」和「角色互动」中，除非显式声明 `lfh-hud`，否则**所有普通代码块（无语言、`markdown`、`text`、`python` 等）均渲染为普通 `<pre><code>` 排版代码块**，彻底不再劫持为状态面板。
   - **E2E 契约保护**：保留外层 `<div className="turn-body" data-testid="turn-body">` 包裹渲染输出，保留 `<HudPanel>` 的 `data-testid="hud-panel"` 与 `.hud-panel` 语义类，确保 [tests/e2e/run-e2e.mjs](../../tests/e2e/run-e2e.mjs#L3557-L3801) 与 [tests/ui/e2eSemanticSelectors.test.ts](../../tests/ui/e2eSemanticSelectors.test.ts) 无损通过。

3. **流式性能优化与样式合规**：
   - **流式分块增量缓存（防 $O(n^2)$ 重解析）**：在 SSE 流式输出期间，可将文本按已闭合的块边界（双换行 `\n\n` 且不在未闭合 ` ``` ` 围栏内）切分为「已冻结前导块数组 + 尾部活跃块」，配合 `React.memo` 仅重解析并重渲染尾部正在增长的最后 1 块，避免千字长回复每收 1 个 token 都重算整篇表格/列表。
   - **表格与移动端防溢出**：Markdown `<table>` 在 390px 窄屏必须外包 `.md-table-wrap { overflow-x: auto; max-width: 100%; }`，防止撑破气泡宽度；所有颜色与边框全部引用 [src/ui/styles/tokens.css](../../src/ui/styles/tokens.css) 既有变量（如 `--bg-surface`、`--border-hairline`、`--text-secondary`），不使用 Tailwind Typography 或手写 SVG，保证 `npm run audit:ui` 零报错。
   - **一处复用于三端场景**：同一 `<MarkdownView>` 组件可直接复用于聊天回复流、`DocumentDialog` / 对话内确认卡片的「渲染预览」模式、以及后续设定查看面板，消灭当前 `DocumentDialog.tsx` L80 仅用 `<pre>` 展示提案全文的粗糙感。

---

## 五、子问题 3：人类可读 Markdown Diff 方案

### 3.1 移动端对话内确认卡片的 Diff 诉求特征

V0.2 将把「资料修改确认」从阻塞全屏模态框下沉为「非阻塞对话内确认卡片」：
- 默认展示**人话变更摘要**（如“更新当前设定 · 修改 2 处，新增 1 行”）；
- 用户点击「查看改了哪几行」时，在卡片内或轻量展开区展示人类可读 Diff：
  1. **必须是上下文折叠的 Hunk 视图（Unified Collapsed Hunks）**：移动端 390×844 屏宽有限，文档动辄 50–300 行，若把未改动的 95% 原文全铺开，用户需要长距离滚动才能找到红色/绿色行；应默认只展示变更行及其上下各 **2 行上下文**，中间连续未改动部分折叠为可点击展开的“…… 省略 18 行未改动内容 ……”。
  2. **必须支持中文无空格文本的句内词/字级高亮**：Markdown 修改常常是“把某段 80 字设定里的主角名字、年龄或一个形容词改掉”。如果只做整行红/绿对比，用户要在两段几乎一样的 80 字中文里肉眼找差异；因此需要**两级 Diff（行级定位 + 替换行句内高亮）**。

### 3.2 `diff`（jsdiff）vs 自研纯 TS Myers/LCS 实测对比

| 评估维度 | 方案 A：引入 `diff@9.0.0`（`kpdecker/jsdiff`） | 方案 B（推荐）：纯 TS 两级 Myers Diff（~120 行） |
| --- | --- | --- |
| **包体与依赖** | 0 依赖，BSD-3-Clause；Bundlephobia **~22.5 kB min / ~7.8 kB gz**（npm unpacked 615 KB），v8/v9 原生带 TS 类型与 `./lib/*` ESM 子路径导出 | **0 第三方依赖**；核心算法 + Hunk 折叠 + 句内配对约 **110–140 行 TS（~1.5 KB gz）** |
| **中文（CJK）句内 Diff 质量** | 原生 `diffWords` 默认按英文空白与单词边界正则切分，**对无空格连续中文容易整句吞并成一个 token**；v8+ 起新增 `intlSegmenter` 参数，传入 `new Intl.Segmenter('zh', { granularity: 'word' })` 才可准确按中文分词对比 | 直接按统一策略编写：`Intl.Segmenter('zh', { granularity: 'word' })` 可用时按中文词粒度对比，不可用时自动按 `Array.from(line)`（Unicode 码点）对比，**绝不把中文整段混为一个 token，也不截断 Emoji 代理对** |
| **Android WebView 兼容风险** | `diff@9.0.0` 已明确将目标基线切换为 **Node LTS + Baseline core browsers**；且即便引入 `diff`，`Intl.Segmenter` 在 Android WebView 的最低支持版本仍为 **WebView 87+**（[MDN](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Intl/Segmenter)），低于 87 的老旧 ROM 仍需业务层做特性检测与降级 | 全部代码受控于本仓 `tsconfig.app.json` 与 Vite 打包链路，天然兼容 WebView 60+；`typeof Intl?.Segmenter === 'function'` 特性检测内建于 5 行分词 helper 中 |
| **Hunk 折叠与行配对胶水代码** | `diffLines` 只返回扁平 `Change[]`，`structuredPatch` 面向 git patch 文本而非前端结构化行号/句内配对；**仍需自己写约 60–80 行折叠与配对逻辑** | 算法输出即直接结构化为 `{ hunks, stats: { added, removed } }`，无冗余转换层 |

### 3.3 推荐实现设计与工程护栏

1. **两级 Myers O(ND) 算法设计（`src/harness/markdownDiff.ts`，纯函数可单测）**：
   - **归一化换行**：先统一 `\r\n` -> `\n`，按行切分为 `oldLines` / `newLines`。
   - **L1 行级 Myers Diff**：计算最短编辑脚本（`equal` / `delete` / `insert`），为每行附带 `oldLineNumber` 与 `newLineNumber`。
   - **Hunk 聚合与上下文折叠**：以 `contextLines = 2` 合并相邻变更，生成 `DiffHunk[]`（每个 hunk 含连续变更与前后各 2 行上下文），间隔处生成 `{ type: 'collapsed', hiddenCount, lines }`，用户点击可原地展开。
   - **L2 替换行对的句内高亮（Inline Diff）**：当同一变更区间内同时出现 `delete` 块与 `insert` 块且两者行数较小（例如 `Math.max(delCount, insCount) <= 4`）时，逐对（或按拼接后文本）运行轻量 Myers Diff：
     - 分词器 `tokenizeForInlineDiff(text)`：若运行时存在 `Intl.Segmenter`（WebView 87+ / 现代桌面浏览器），使用缓存单例 `new Intl.Segmenter('zh', { granularity: 'word' })` 切出中文词、英文单词与标点；否则退化为 `Array.from(text)`（按完整 Unicode 码点切分，安全兼容 Android WebView 60–86）。
     - 对真正改动的部分标记 `highlight: true`，渲染为 `<del className="diff-inline-del">` 与 `<ins className="diff-inline-ins">`。
2. **性能与病态输入护栏**：
   - Myers 算法在常规文本（修改少量局部）下复杂度接近 $O((N+M) \cdot D)$，百行级设定改动耗时 < 1 ms；
   - 若遇到整篇重写（如 `N + M > 800` 或编辑步数 `D > 400`），主动触发 `maxEditDistance` 熔断，降级展示「全文变更概览（原 N 行 → 新 M 行）+ 折叠前/后全文对比」，避免低端手机 WebView 主线程卡顿。
3. **语义色 Token 对齐（`audit:ui` 合规）**：
   - 现有 [src/ui/styles/tokens.css](../../src/ui/styles/tokens.css) 已定义 `--status-danger` / `--status-danger-soft`（可用于删除行与行内删除高亮）及 `--status-ok`（可用于新增文本色），**建议在 `light` / `dark` / `warm` 三个主题下对称新增 `--status-ok-soft`**（如浅色 `#ECFDF3`、深色 `rgba(74, 222, 128, 0.14)`、暖纸 `#E6F2EB`），即可零例外通过 `npm run audit:ui`。

---

## 六、对地图 #80 后续 `grilling` 与实施 Tickets 的工程约束建议

1. **协议层（与 `#80` 无感 Harness 结合）**：
   - V0.2 `lfh-proposal` 协议同时作为「对话内非阻塞确认卡片」与「分支局部笔记后台维护」的统一底层载体；客户端负责将 `patch` / `append` / `section` 合并为完整的候选 `markdown` 字符串并计算 `markdownDiff`，再经现有的版本乐观锁 `writeDocument(doc, expectedHead, nextMarkdown)` 落盘，**不改变 `MarkdownDocument` 的完整版本链存储模型**（仍保留完整历史版本与一键撤销能力）。
   - 解析器单元测试须覆盖：真换行 Markdown 正文、正文含嵌套代码块、闭合围栏后带尾随解释、单轮多提案、`patch` 上下文行偏移、流式 `length` 截断降级为 `needs_review` 卡片。
2. **渲染层（与 ADR-0010 结合）**：
   - 将 `marked@18.2.1` 封装在独立模块（如 `src/ui/MarkdownView.tsx`），禁止在仓库任何位置直接调用 `dangerouslySetInnerHTML`；
   - 保留 `MessageContent.tsx` 中 `lfh-choices` 尾部快捷选项的剥离与渲染优先级（先剥离 `lfh-proposal` 与 `lfh-choices`，再将剩余叙事文本交由 `MarkdownView` 渲染）。
3. **Diff 层（与移动端卡片交互结合）**：
   - Diff 视图在对话内确认卡片中默认折叠，卡片只展示：`target` 中文标签 + `summary` 一句话人话摘要 + 变更统计（如 `+3 -1 行`）+ 「查看改了哪几行」折叠切换 + 「应用改动 / 暂不应用」非阻塞按钮。

---

## 七、主要参考一手信源

- 仓库现状：[package.json](../../package.json)、[tsconfig.app.json](../../tsconfig.app.json)、[tsconfig.harness.json](../../tsconfig.harness.json)、[android/variables.gradle](../../android/variables.gradle)、[scripts/audit-artifacts.mjs](../../scripts/audit-artifacts.mjs)、[scripts/audit-ui-tokens.mjs](../../scripts/audit-ui-tokens.mjs)、[src/harness/markdownDocuments.ts](../../src/harness/markdownDocuments.ts)、[src/harness/creative.ts](../../src/harness/creative.ts)、[src/harness/harness.ts](../../src/harness/harness.ts)、[src/harness/messageFormat.ts](../../src/harness/messageFormat.ts)、[src/harness/sse.ts](../../src/harness/sse.ts)、[src/harness/keyConfig.ts](../../src/harness/keyConfig.ts)、[src/ui/MessageContent.tsx](../../src/ui/MessageContent.tsx)、[src/ui/DocumentDialog.tsx](../../src/ui/DocumentDialog.tsx)、[src/ui/App.tsx](../../src/ui/App.tsx)、[src/ui/styles/tokens.css](../../src/ui/styles/tokens.css)、[tests/harness/markdownProposalParsing.test.ts](../../tests/harness/markdownProposalParsing.test.ts)、[tests/e2e/run-e2e.mjs](../../tests/e2e/run-e2e.mjs)、[ADR-0009](../../docs/adr/0009-deepseek-official-guided-byok.md)、[ADR-0010](../../docs/adr/0010-native-css-tokens-and-top-layer-ui-architecture.md)、[ADR-0011](../../docs/adr/0011-three-mode-markdown-harness.md)
- DeepSeek 官方 API 文档：[Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode)、[JSON Output](https://api-docs.deepseek.com/guides/json_mode)、[Function Calling](https://api-docs.deepseek.com/guides/function_calling)、[Chat Prefix Completion](https://api-docs.deepseek.com/guides/chat_prefix_completion)、[Models & Pricing](https://api-docs.deepseek.com/quick_start/pricing)
- Markdown 解析与 XSS 清理一手资料：[markedjs/marked](https://github.com/markedjs/marked)（`marked@18.2.1` npm metadata & [Using Marked / Security](https://marked.js.org/using_pro)）、[markdown-it/markdown-it](https://github.com/markdown-it/markdown-it)（`markdown-it@15.0.3` npm metadata）、[micromark/micromark](https://github.com/micromark/micromark)（`micromark@4.0.3` & `micromark-extension-gfm@3.0.0`）、[cure53/DOMPurify](https://github.com/cure53/DOMPurify)（`dompurify@3.4.18`）、Bundlephobia 包体实测（`marked@18.2.1`、`markdown-it@15.0.3`、`micromark@4.0.3`、`micromark-extension-gfm-table@2.1.2`、`react-markdown@10.1.0`、`remark-gfm@4.0.1`、`dompurify@3.4.18`）
- Diff 与 CJK 分词一手资料：[kpdecker/jsdiff](https://github.com/kpdecker/jsdiff)（`diff@9.0.0` npm metadata、Bundlephobia、`release-notes.md` 与 `intlSegmenter` 选项）、[MDN `Intl.Segmenter` 兼容性数据](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Intl/Segmenter)（Chrome / Android WebView 87+）
