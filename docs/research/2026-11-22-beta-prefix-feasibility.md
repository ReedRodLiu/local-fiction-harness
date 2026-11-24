# beta 前缀续写双端可行性：思考模式预填位置、首块回显与预填句式

核查日期：2026-11-22。本调研对应 Wayfinder 地图 [#113](https://github.com/ReedRodLiu/local-fiction-harness/issues/113) 下的研究票据 [#117](https://github.com/ReedRodLiu/local-fiction-harness/issues/117)，用于判断 DeepSeek 官方 Chat Prefix Completion（Beta）能否在「Capacitor + React + TS ↔ Android NativeSse」这条双端链路上落地，并把请求体契约写成实现票可直接照做的形态。

**证据分级**：本文每条结论都标注了来源类型。`【官方】`＝ DeepSeek 官方文档原文；`【第三方实现】`＝ 独立复刻 DeepSeek beta 契约的服务端实现（非官方，但把没写进文档的分支语义写清楚了）；`【待实测】`＝ 官方与第三方都没给出确定答案，必须由文末探针脚本用真实 Key 验证。**不要把【第三方实现】和【待实测】当成官方承诺。**

---

## 一、结论总览

| 子问题 | 结论 | 置信度与来源 |
| --- | --- | --- |
| **1. 思考模式下的预填位置** | `content` 预填落在**正文通道**（官方原话「force the model to start its answer by the content of the supplied prefix」）；`reasoning_content` 预填落在**思维链通道**（官方原话「as the input for the CoT in the last assistant message」）。两者是**两个独立通道**，不是同一份文本的两个写法。| 【官方】API Reference 的 assistant message 字段说明 |
| **思考模式下 prefix 是否被接受** | 接受。能力矩阵里 `Chat Prefix Completion（Beta）` 对 `deepseek-flash` 与 `deepseek-v4-pro` 都是 ✓，而这两个模型都是「默认开启思考」的模型；对照组 `FIM Completion（Beta）` 被显式标注 `Non-thinking mode only`，前缀续写**没有**这条限制。| 【官方】Models & Pricing 能力矩阵 |
| **2. 首块是否回显预填** | **不回显。响应只包含模型新增的部分。** 官方文档没写这一条；第三方实现明确写了「The response carries only what the model adds.」，且 FIM 端点专有的 `echo` 参数在 chat prefix completion 上不存在。| 【第三方实现】+ 推论；**需实测确认**（见 §3 契约双分支设计） |
| **3. 预填句式** | 不要用 `Sure, here is`。预填必须**用目标语种 + 该模型自己会写的口吻**，并且**停在句子中间**（未完成态），让「继续写」成为唯一高概率动作。三模式**共用一套机制、三套词表**。| §4 给出模板 |
| **4. 与现有参数并存** | `thinking:{type:'enabled'}` + `reasoning_effort:'high'` + `prefix:true` **可并存**（能力矩阵 + reasoning_content 是专为思考模式前缀续写设计的 Beta 字段）。不发 `stop` 时**会有啰嗦收尾风险**——官方示例之所以要 `stop=["\`\`\`"]`，原话就是「to prevent additional explanations from the model」。| 【官方】两处文档交叉 |
| **5. 能否落地** | **可以落地**，但必须放开三类约束，并且把「首块是否回显」写成**双向兼容**（检测到才剥离，绝不盲切）。落地改动集中在 `sse.ts` 一处，Android Java 层零改动。| §5、§6 |

---

## 二、本仓工程基线核查（改动落点）

| 维度 | 现状 | 来源文件 |
| --- | --- | --- |
| URL 解析 | `resolveChatCompletionsUrl` 只在 baseUrl 已以 `/chat/completions` 结尾时直接返回，否则拼 `/chat/completions`；**不认识 `/beta` 语义** | [src/harness/sse.ts](../../src/harness/sse.ts#L185-L194) |
| 请求体拼装 | `buildOpenAiChatRequest` 固定输出 `{ model, messages, stream:true, thinking, reasoning_effort }`，**不发送** `stop` / `temperature` / `top_p` / `seed` / `safety_check` / `tools` | [src/harness/sse.ts](../../src/harness/sse.ts#L207-L238) |
| 消息类型 | `LlmMessage` 只有 `role: 'system' \| 'user' \| 'assistant'` + `content`，**没有** `prefix` / `reasoning_content` 字段 | [src/harness/types.ts](../../src/harness/types.ts#L128-L131) |
| 流式增量 | `LlmStreamDelta = { contentDelta?, reasoningDelta?, finishReason? }`，解析层已同时识别 `reasoning_content` 与 `reasoning` 两种拼法 | [src/harness/types.ts](../../src/harness/types.ts#L133-L137)、[src/harness/sse.ts](../../src/harness/sse.ts#L89-L113) |
| baseUrl 强锁定 | `normalizeOfficialModelConfig` 把 baseUrl 强制写回 `https://api.deepseek.com`；**且 `apiKey` 那条正则只认 `https://api.deepseek.com[/v1]`**，一旦 baseUrl 变成 `.../beta`，`apiKey` 会被清成空串 | [src/harness/keyConfig.ts](../../src/harness/keyConfig.ts#L106-L115) |
| Android 透传 | Java 层完全不解析 body，`body.getBytes(UTF_8)` 原样写出；只有 URL scheme 必须是 http/https | [src/platform/capacitorSseTransport.ts](../../src/platform/capacitorSseTransport.ts#L53-L118)、[SseStreamClient.java](../../android/app/src/main/java/io/localfiction/harness/SseStreamClient.java#L100-L137) |
| 调用方累加 | `streamText` 自己累加 `content` / `reasoningContent`，再交给 `visibleReplyPrefix` 剥离协议块；`creative.ts` 同构 | [src/harness/harness.ts](../../src/harness/harness.ts#L252-L289)、[src/harness/creative.ts](../../src/harness/creative.ts#L516-L543) |

**关键结论**：`normalizeOfficialModelConfig` 的 baseUrl 强锁定与 `apiKey` 正则是一对**隐性耦合**。若为了走 beta 而把 baseUrl 改成 `https://api.deepseek.com/beta`，`apiKey` 会被静默清空，表现为「莫名 401」。所以 beta 地址**必须在 `buildOpenAiChatRequest` 内部派生，不能写进 baseUrl**（详见 §6）。

---

## 三、子问题 1 & 2：预填位置与首块回显

### 3.1 官方到底写了什么

官方「对话前缀续写（Beta）」指南全篇只有两条注意事项（[中文版](https://api-docs.deepseek.com/zh-cn/guides/chat_prefix_completion/)、[English](https://api-docs.deepseek.com/guides/chat_prefix_completion)）：

1. 最后一条消息 `role` 必须是 `assistant`，并给它设 `prefix: True`；
2. `base_url` 必须设为 `https://api.deepseek.com/beta`。

示例代码里 `assistant` 的 `content` 写成 `"```python\n"`，并配 `stop=["```"]`，官方对 `stop` 的解释原文是「to prevent additional explanations from the model」。**整篇指南没有出现 `thinking`、`reasoning_effort`、`reasoning_content` 任何一个词。**

真正写明思考模式的字段说明在 API Reference 的 assistant message schema 里（官方文档站 + 官方文档镜像 [llms-full.txt](https://cdn.jsdelivr.net/gh/thevibeworks/deepseek-docs@main/llms-full.txt) 均可核对）：

> **`prefix`** bool — (Beta) Set this to `true` to force the model to start its answer by the content of the supplied prefix in this `assistant` message. You must set `base_url="https://api.deepseek.com/beta"` to use this feature.
>
> **`reasoning_content`** string nullable — (Beta) Used for the thinking mode in the Chat Prefix Completion feature as the input for the CoT in the last assistant message. When using this feature, the `prefix` parameter must be set to `true`.

这三句话给出了本票最核心的答案：**`content` 是「answer 的开头」，`reasoning_content` 是「CoT 的输入」，两者写在同一条 assistant 消息上、由服务端分别喂进两个通道。** 官方没有给合并示例，但字段语义已经确定了两者不是互斥关系。

### 3.2 四种组合的行为矩阵

`A/B/C/D` 四组即 issue 要求跑的组合，`E` 是思考关闭的附加对照（用来确认「只有正文预填」在非思考模式下的行为，防止把思考模式的结论错误外推到 `reasoning_effort:'none'` 的后台任务上）。

| # | `content` | `reasoning_content` | `thinking` | 预期行为（服务端视角） | 正文流 | 思维链流 | 400 风险 | 证据 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **A** | 有 | 无 | enabled | 官方「force the model to start its answer by the content」→ 正文以预填开头续写。第三方实现进一步说明：思考模式下**正文预填会先把推理通道以空内容关闭**，续写被当作 answer 读取，而不是「在正文之前的推理」。 | 从预填末尾继续；**推理通道被空关闭，预期 `reasoning_content` 为空或不存在** | 空（或极短） | 低 | 【官方】字段语义 +【第三方实现】`continue_prompt` 的 `answer_started` 逻辑；**`reasoning_content` 是否真的为空 = 待实测** |
| **B** | 空 | 有 | enabled | 官方「as the input for the CoT」→ 预填续的是思维链。第三方实现：`reasoning_content` 预填**保持推理通道打开**，模型在这个前缀后继续想，想完再开正文通道。 | 正常产出正文，**与预填无文本关系** | 以预填开头继续 | 低（但**思考关闭时必须 400**，见下） | 【官方】字段语义 +【第三方实现】 |
| **C** | 有 | 有 | enabled | 两个通道各续各的：先在思维链上从 `reasoning_content` 续，再关推理通道、开正文通道，正文从 `content` 续。第三方实现的拼接顺序是 `reasoning + 结束标记 + 正文开标记 + content`。 | 从预填末尾继续 | 从预填末尾继续 | 低 | 【第三方实现】；**合并顺序 = 待实测** |
| **D** | 空 | 空 | enabled | `prefix:true` 但没有任何预填文本＝**等价于普通请求**（第三方实现原话「nothing has begun: an ordinary reply」）。 | 从零开始 | 正常思考 | 低 | 【第三方实现】；对照组，用来验证「prefix 标记本身不改变行为」 |
| **E** | 有 | 无 | **disabled** | 非思考模式下的正文预填，行为同 A 的正文流。 | 从预填末尾继续 | 无 | 低 | 【第三方实现】；**用于保护 `createBackgroundModelConfig`（`reasoning_effort:'none'`）的后台任务路径** |

**四种组合里必定 400 的只有一类**：`reasoning_content` 预填 + 思考关闭（组合 B 的错配形态）。第三方实现对这条的判定是硬报错：`"reasoning_content in an assistant prefix requires thinking mode, in which the reply begins in the reasoning channel"`。理由很直白——不思考就没有 CoT 通道可续。

> ⚠️ **2026-02 归档文档的坑（重要）**：旧版 `deepseek-reasoner` 页面曾明写「if the `reasoning_content` field is included in the sequence of input messages, the API will return a `400` error」（[归档快照](https://web.archive.org/web/20260226212031/https://api-docs.deepseek.com/guides/reasoning_model)）。这条**已被现行文档取代**：现行[思考模式](https://api-docs.deepseek.com/zh-cn/guides/thinking_mode)写的是「若请求**未携带** `tools` 参数：`reasoning_content` 无需回传；即使传入 API，也会被忽略，不会拼接进上下文」。我们从不发 `tools`，所以 B / C 不会被这条老规则打死。但正因存在过这条规则，「`reasoning_content` 能不能放进 input」在社区里长期是混乱信息源——**必须以实测为准，不能照抄旧文章**。

### 3.3 「思考流与正文流会不会错位」

官方流式样例的写法本身就假定了顺序（[思考模式 · 流式样例](https://api-docs.deepseek.com/zh-cn/guides/thinking_mode)）：

```python
for chunk in response:
    if chunk.choices[0].delta.reasoning_content:
        reasoning_content += chunk.choices[0].delta.reasoning_content
    else:
        content += chunk.choices[0].delta.content
```

即**先思维链、后正文，两个通道不交错**。按组合分：

- **A（正文预填）**：推理通道被空关闭 → 预期首个 `delta` 就直接是 `content`。**这是唯一「必须先关推理才能续正文」的组合，也是错位风险最高的一组**：若服务端仍先推了一段 `reasoning_content`，客户端现有的 `onReasoningDelta` 会弹出「思考中」，而正文预填在用户眼里是「凭空出现」的。
- **B / C（含 `reasoning_content` 预填）**：思维链先流满、再切正文，与现有 `streamText` / `creative.ts` 的累加逻辑完全同构，**无错位风险**。
- **D**：等同普通请求，无风险。

**结论**：错位不是「两个流会串」，而是「组合 A 下推理通道可能意外非空，导致 UI 的思考态与正文态衔接突兀」。实现上不需要改解析器，只需要在 UI 侧允许「有预填正文时，思考态可以瞬间结束」。

---

## 四、首块回显：契约按组合分开写

### 4.1 结论

**高置信：不回显。** 三个独立证据：

1. 第三方实现在模块 docstring 里把它当契约写死：「The last message is an assistant message carrying `prefix: true`; the model's reply begins with its `content` ... **The response carries only what the model adds.**」（[ROCm/ATOM #3036](https://github.com/ROCm/ATOM/commit/e48ad896f07e8a6de4018f66a94ae23c1b26dc54)）
2. **`echo` 是 FIM 专属参数**，不在 chat prefix completion 的参数表里。同一个 commit 里 `/beta/completions` 明确支持「DeepSeek's `echo` (leading the first streamed chunk)」，而 `/beta/chat/completions` 没有对等描述——若 chat 端点也回显，就不需要给 FIM 单独发明一个 `echo` 开关了。
3. 官方 FIM 文档给 `echo` 的定义是「是否回显 prompt」，属于**需要显式开启**的能力（[FIM 补全](https://api-docs.deepseek.com/zh-cn/guides/fim_completion)）；chat 端没有这个开关，默认即不回显。

### 4.2 但契约必须写成双分支

这是本票最重要的工程决定。**社区里已经有真实用户踩过这个坑**：rikkahub #1918 的期望行为第 3 条就是「生成结束后，界面上显示的内容应包含这段预填文本加模型续写的部分，而不是只显示续写」（[rikkahub#1918](https://github.com/rikkahub/rikkahub/issues/1918)）——说明「服务端只回新增」是常态，而客户端不合并就会少字。

因此契约按组合写死如下：

| 组合 | 首块回显 `content` | 首块回显 `reasoning_content` | 客户端必须做的事 |
| --- | --- | --- | --- |
| A / E | **否**【待实测】 | 不适用（该通道被关闭） | 把预填文本**合成第 0 个 `contentDelta`** |
| B | 不适用（无正文预填） | **否**【待实测】 | 预填只影响思维链，**不进入 `TurnNode.content`**；若要展示思考过程，需自行前置 |
| C | **否**【待实测】 | **否**【待实测】 | 正文侧同 A，思维链侧同 B |
| D | 无预填，无此问题 | 无预填 | 无 |

**实现铁律：检测到才剥离，绝不盲切。** 预填 `"雨还没停。他抬起头，看见"` 若被盲切 13 个字符，而服务端本来就没回显，就会把模型真正写出的开头吃掉——这是**静默数据损坏**，比少字严重得多。正确做法是维护一个「待匹配预填」游标：

- 收到的累计正文**仍是预填的前缀**（`prefill.startsWith(acc)`）→ 一个字都不吐给 UI，继续等；
- 累计正文**已越过预填且完全一致**（`acc.startsWith(prefill)`）→ 吐出 `acc.slice(prefill.length)`，此后回显路径关闭，后续全量透传；
- 累计正文**在中途与预填分叉**（既非前缀也非常量前缀）→ 判定「未回显」，把之前扣下的字符**全量补吐**，此后全量透传。

这个游标在「回显」和「不回显」两种世界里都收敛到正确结果，所以**即使 §4.1 的判断错了也不会损坏数据**。这也是为什么它必须写在传输层、而不是写进 `parseOpenAiSseStream`——后者是纯粹的 OpenAI SSE 语法解析器，目前对请求体零知识，不应被污染。

---

## 五、子问题 3：预填句式

### 5.1 为什么不能用 `Sure, here is`

`Sure, here is...` 是**英文 helpful-assistant 语域里概率最高的通用开场**——2026 年的 prefill 实践文章把它当成反面教材，因为它正是「空 assistant turn 的最高概率开头」（[Assistant Prefill：预填模型回复开头](https://feinterview.poetries.top/ai-monitor/news/assistant-prefill-write-the-start-of-the-model-s-reply-and-the-format-stops-being-a-re)）。它的两个副作用正好都指向我们的场景：

1. **语域锁死**：写成英文助手腔，中文小说的叙事声线被强行拉到「客服播报」，后续正文会持续漂移；
2. **它触发的是「说明」而不是「叙述」**：`Sure, here is` 后面接的必须是「这篇小说是这样的：」——模型于是开始写导读，而不是写正文。

顺带一个反直觉的旁证：[SORRY-Bench 的参数消融](https://credibleai.github.io/modelpedia/findings/IC-310/index.html)（IC-310）测出「用 `sure, here is` 预填会把安全履约率抬高 19–58%」——也就是说这个前缀**极强地把模型推入「合规助手」人格**。对文游/小说续写来说，这恰恰是最不想要的人格。

### 5.2 构造原则

```
<目标语种> + <该模式的文体特征> + <该模型自己会写的口吻锚点> + 停在句子中间
```

四条都要满足，缺一条就退化：

- **目标语种**：中文小说就写中文。用英文预填等于要求模型先翻译再创作，中间那一步就是声线断裂点。
- **文体特征**：文游要有动作/环境推进，写故事要有稿纸质感，角色互动要有说话人标记。
- **口吻锚点**：最好直接复用我们 system prompt 里已经建立的角色名/视角词，让预填与上下文同源。
- **停在句子中间**：这是抑制「啰嗦收尾」的主要手段（见 §5.4）。句子写完整了，模型就会认为这段结束了，转而写总结。

### 5.3 中文小说场景模板（三组 + 三模式对照）

**① 正文首句起手**（用于「新的一段/新的一轮」开头，最常用）

| 模式 | 预填模板 | 说明 |
| --- | --- | --- |
| 文游叙事 | `「雨声在屋檐上碎成一片。他抬头，正好看见」` | 环境细节 + 主角动作 + 未完成的「看见」，把镜头推进交给模型 |
| 写故事 | `「那年的雨也是这样，落在」` | 回忆式起手，适合稿纸上的散文腔；停在介词上，强制模型填宾语 |
| 角色互动 | `「（她把杯子往你面前推了推）」` | 圆括号动作描写 + 「你」，锚定第二人称与角色名 |

**② 半句对话**（用于「接一句台词」，最容易体现口吻一致性）

| 模式 | 预填模板 | 说明 |
| --- | --- | --- |
| 文游叙事 | `「"别回头，"他压低声音，"后面」` | 引号内半句 + 未完成的方位词，模型必须补完这句台词再决定剧情 |
| 写故事 | `「"我记得那天，"她停顿了一下，"你」` | 对话中留一个直接指向「你」的空位，天然拉住第二人称 |
| 角色互动 | `「阿箬："你终于来了。」` | `角色名：` 前缀是最强的角色锚点，与 [PromptAttic Recipe 4](https://www.promptattic.com/library/assistant-prefill-recipes-that-ship) 的 name-tag 手法同源 |

**③ 场景起手**（用于「换场/开新幕」）

| 模式 | 预填模板 | 说明 |
| --- | --- | --- |
| 文游叙事 | `「灯忽然灭了。黑暗里，」` | 事件 + 逗号悬停，模型必须给环境反应 |
| 写故事 | `「城门在身后合上时，他忽然意识到」` | 「忽然意识到」后面必然是内心戏，适合需要心理描写的段落 |
| 角色互动 | `「（沉默了很久）她终于开口：」` | 动作 + 冒号，把发言权平滑交出去 |

### 5.4 三模式共用一套吗：**机制共用，词表分开**

必须共用同一套**机制**（同一组四组合分支、同一个回显游标、同一个 URL 派生），否则 `sse.ts` 会被三套逻辑撕碎。但**词表不能共用**，原因：

1. 文游的输出契约里带着 ` ```lfh-choices ` 快捷选项与 `lfh-proposal` 尾块（见 [006 §6](../../docs/research/2026-11-22-v02-proposal-protocol-and-markdown-diff.md)），预填必须与这些协议的**起始位置**兼容；
2. 写故事面对的是 `DraftPane` 的稿纸，说话人标记会被当成正文污染；
3. 角色互动的 `角色名：` 前缀在文游里会变成不该出现的旁白。

所以落点应该是：一个 `prefillTemplates` 表，按 `'story' | 'draft' | 'character'` 三个 key 分组，每组三个场景（首句/半句对话/场景起手），构造器共用。

### 5.5 不发 `stop` 时的收尾行为

**官方已经承认这个问题**：前缀续写示例里配 `stop=["```"]`，官方给出的理由就是「to prevent additional explanations from the model」。也就是说，**不设 `stop` 时模型确实倾向于在续写完成后补一段解释/总结**。

对我们的约束是硬性的：**不能照抄官方的 `stop=["```"]`**。因为我们的 Markdown 通道依赖 ` ```lfh-proposal ` / ` ```lfh-choices ` 围栏做提案与快捷选项（[src/harness/markdownProposal.ts](../../src/harness/markdownProposal.ts#L780-L835)），一旦把 ` ``` ` 设为停止符，提案块会被从围栏处直接截断，`splitMarkdownReply` 只会看到未闭合围栏。

可行的三条抑制手段，按推荐顺序：

1. **预填停在句子中间**（首选，零成本）：句子没说完，模型的第一动作只能是补完，而不是总结；
2. **system prompt 里显式禁止**：与现有「只输出正文，不要解释」类指令合并，不加新字段；
3. **UI 侧兜底**：现有 `finish_reason === 'stop'` 判定保持不变；若出现尾随客套话，交给后续 Markdown 渲染层处理，不在传输层做文本裁剪（裁剪会误伤正文里的「总之」这类词）。

---

## 六、子问题 4：与现有参数的关系

### 6.1 `thinking` + `reasoning_effort` + `prefix` 并存

**被接受。** 三条证据叠加：

1. 能力矩阵里 `deepseek-flash` 与 `deepseek-v4-pro` 对 Chat Prefix Completion（Beta）都是 ✓，而这两个模型的能力矩阵同一行写着「THINKING MODE: Supports both non-thinking and thinking (**default**) modes」——即默认就带思考（[Models & Pricing](https://api-docs.deepseek.com/zh-cn/quick_start/pricing)）。
2. 同矩阵里 `FIM Completion（Beta）` 被显式标注 `Non-thinking mode only`，而 chat prefix completion 没有——**官方只在 FIM 上做了非思考限定，没有在 chat 前缀续写上做**。
3. `reasoning_content` 这个输入字段本身就是「为思考模式下的前缀续写」而设的（官方字段说明原文），**如果思考模式不支持 prefix，这个字段就没有存在意义**。

一条额外旁证：官方 [联网工具 · 继续生成](https://api-docs.deepseek.com/zh-cn/guides/web_tools#continue-generation) 的 Chat Completions 示例里，`safety_check: {"level":"high"}` 与 `prefix: true` 是**写在同一个请求体里**的，说明 `prefix` 与这些顶层扩展字段不互斥。我们不发 `safety_check`，但这条证明 `prefix` 不是「只能单独使用」的开关。

### 6.2 采样参数的互斥规格

我们本来就不发 `stop` / `temperature` / `top_p` / `seed`。规格里要写死的是「将来若发，与之互斥」的清单：

| 参数 | 与 `prefix:true` 的关系 | 来源 |
| --- | --- | --- |
| `stop` | **禁止同发**（本仓特有约束）。官方示例用它防啰嗦，但会截断 `lfh-*` 围栏 | 官方示例 + 本仓协议 |
| `temperature` / `presence_penalty` / `frequency_penalty` | 思考模式下**不生效**（设置不报错但被忽略）；非思考模式生效，但与预填的「锁开头」目标冲突，不建议发 | 【官方】思考模式文档 |
| `top_p` | `deepseek-flash`：仅思考模式生效，<0.95 按 0.95 处理；`deepseek-v4-pro`：思考模式忽略传入值 | 【官方】思考模式文档 + API Reference |
| `seed` | 官方 Chat Completions 参数表中**不存在**该参数，本来就不发 | 【官方】API Reference |
| `safety_check: high` / 声明联网工具 / `title` | **会让上述采样参数被忽略**；更关键的是**用过联网工具的回复不能续写，会 400** | 【官方】联网工具文档 |

***

**联网工具那条 400 的原文错误串**（实现时直接用于判错）：
`messages: the last \`assistant\` message used \`deepseek_web_search\` or \`deepseek_read_url\` and cannot be continued; resend the previous request`

我们不发 `tools`，本条目前不会触发；但它确立了「**prefix 的合法性取决于上一条 assistant 消息的历史**」，将来若接入联网工具，续写分支必须直接禁用。

---

## 七、允许 / 禁止的请求体契约

### 7.1 允许

```jsonc
POST https://api.deepseek.com/beta/chat/completions
{
  "model": "deepseek-flash",
  "messages": [
    { "role": "user", "content": "..." },              // 前一条必须是 user / system / tool
    {
      "role": "assistant",
      "content": "雨还没停。他抬起头，看见",             // 必填：正文预填（可为空串，等价于普通请求）
      "reasoning_content": "...",                       // 可选：思维链预填，仅思考模式
      "prefix": true                                     // 必填：布尔 true
    }
  ],
  "stream": true,
  "thinking": { "type": "enabled" },
  "reasoning_effort": "high"
}
```

### 7.2 禁止（会 400 或行为未定义）

| # | 禁止项 | 依据 |
| --- | --- | --- |
| 1 | `prefix` 出现在**非末条**消息上 | 【第三方实现】`'prefix' may be set only on the last message`；官方「最后一条消息的 role 为 assistant」 |
| 2 | 末条 `prefix:true` 但 `role != assistant` | 【官方】指南注意事项 1 |
| 3 | 末条 assistant 的**前一条也是 assistant** | 【第三方实现】`an assistant prefix must follow a user, system or tool message` |
| 4 | 前缀消息携带 `tool_calls` | 【第三方实现】`an assistant prefix cannot carry tool_calls` |
| 5 | 前缀消息 `content` 里塞图片/文件内容块（只能纯文本） | 【第三方实现】`an assistant prefix may contain only text` |
| 6 | `reasoning_content` 不是字符串 | 【第三方实现】`must be a string` |
| 7 | **思考关闭 + 给 `reasoning_content` 预填** | 【第三方实现】硬报错；语义上无 CoT 通道可续 |
| 8 | 在**非 beta** 端点带 `prefix:true` | 【官方】必须 `/beta`。第三方实现说明其自有 `/v1` 会**静默忽略** `prefix`——静默忽略比报错更危险，会导致「预填看起来生效了其实没生效」 |
| 9 | 续写一条**用过联网工具**的 assistant 消息 | 【官方】400，错误串见 §6.2 |
| 10 | 与 `response_format: {type:'json_object'}` 同用 | 【第三方实现】`cannot be combined with structured output`；官方未定义 |
| 11 | 与图片输入同用 | 【第三方实现】`cannot be combined with image input`；官方未定义 |

> **第 8 条是本仓最需要防的一条**：`normalizeOfficialModelConfig` 会把 baseUrl 归一化成没有 `/beta` 的地址（[keyConfig.ts#L110](../../src/harness/keyConfig.ts#L110)）。如果实现时忘了在拼装层派生 beta 路径，请求会带着 `prefix:true` 打到稳定端点上去——**按第三方实现的行为推断是静默忽略，用户只会觉得「预填没效果」，没有任何报错**。所以实现必须自测「URL 里真的出现了 `/beta/`」。

---

## 八、若要在 `sse.ts` 落地：改哪几行、怎么改（只写设计）

### 8.1 `src/harness/types.ts`

- `LlmStreamRequest`（[L143-L152](../../src/harness/types.ts#L143-L152)）新增可选字段：
  `prefixCompletion?: { content: string; reasoningContent?: string }`。
  **不给 `LlmMessage` 加 `prefix` 字段**——理由：`LlmMessage` 是五个调用方（`harness.ts`、`creative.ts`、`context.ts`、`entryRouter.ts`、`deepseekImport.ts`）共用的历史消息类型，一旦允许在手写历史里设 `prefix`，就很容易造出「非末条带 prefix」或「两条连续 assistant」的非法体（§7.2 第 1/3 条）。让 `buildOpenAiChatRequest` 自己追加末条 assistant，是唯一能保证契约成立的位置。
- `LlmStreamDelta`（[L133-L137](../../src/harness/types.ts#L133-L137)）**不改**。预填合成走 `contentDelta`，不新增通道。

### 8.2 `src/harness/sse.ts` · URL 派生

- `resolveChatCompletionsUrl`（[L185-L194](../../src/harness/sse.ts#L185-L194)）**保持不动**（它服务稳定端点）。
- 新增 `resolveBetaChatCompletionsUrl(baseUrl)`：把 `https://api.deepseek.com` → `https://api.deepseek.com/beta/chat/completions`；若 baseUrl 已以 `/beta` 结尾则**不重复追加**（幂等）；若已是 `/beta/chat/completions` 直接返回。
- **不要在 `keyConfig.ts` 里动 baseUrl**：`normalizeOfficialModelConfig`（[L106-L115](../../src/harness/keyConfig.ts#L106-L115)）第 109 行的 `apiKey` 正则 `/^https:\/\/api\.deepseek\.com(?:\/v1)?\/?$/i` 不认 `/beta`，把 baseUrl 改成 beta 会**静默清空 apiKey**。beta 地址只在拼装层存在，不进入持久化配置。

### 8.3 `src/harness/sse.ts` · `buildOpenAiChatRequest`

在 [L227-L237](../../src/harness/sse.ts#L227-L237) 的 return 前插入三件事：

1. **选 URL**：`const url = req.prefixCompletion ? resolveBetaChatCompletionsUrl(rawBase) : resolveChatCompletionsUrl(rawBase);`
2. **追加末条 assistant**：`messages = [...req.messages, { role:'assistant', content: prefixCompletion.content, prefix:true, ...(reasoningContent ? {reasoning_content} : {}) }]`。注意 `prefix:true` 必须**恒为布尔 true**（第三方实现明确 `prefix: null` 视为未设置，所以不要用 `null` 表达「不加」）。
3. **思考态校验（守住 §7.2 第 7 条）**：若 `prefixCompletion.reasoningContent` 存在但 `thinking.type === 'disabled'` **或** `reasoning_effort === 'none'`，**直接丢弃 `reasoning_content` 降级为纯正文预填**，而不是把请求发出去换一个 400。这里与 `createBackgroundModelConfig`（[keyConfig.ts#L143-L149](../../src/harness/keyConfig.ts#L143-L149)）相关：后台任务固定 `reasoning_effort:'none'`，必须落到组合 E 而不是组合 B 的错配形态。

`thinking` / `reasoning_effort` 的现有映射（[L220-L226](../../src/harness/sse.ts#L220-L226)）**不动**——它们已经与 `prefix` 共存合法（§6.1）。

### 8.4 `src/harness/sse.ts` · 回显游标（不改 `parseOpenAiSseStream`）

`parseOpenAiSseStream`（[L121-L183](../../src/harness/sse.ts#L121-L183)）与 `parseSseEventData`（[L54-L114](../../src/harness/sse.ts#L54-L114)）**一行都不改**。它们是纯语法解析器，不该知道请求长什么样。

回显游标放在**传输层**，即 `createOpenAiTransport().streamChat`（[L253-L281](../../src/harness/sse.ts#L253-L281)）与 `createCapacitorSseTransport().streamChat`（[capacitorSseTransport.ts#L142](../../src/platform/capacitorSseTransport.ts#L142)）各自 `yield* parseOpenAiSseStream(...)` 的外面，抽成一个共用的 async generator 包装器 `applyPrefixEchoCursor(deltas, prefillContent)`：

- 状态机见 §4.2（等前缀 / 已越过 / 分叉补吐 / 关闭游标）；
- **首个 `contentDelta` 之前先合成发射 `prefillContent`**，让下游五个调用方（`harness.ts` [L280-L283](../../src/harness/harness.ts#L280-L283)、`creative.ts` [L531-L536](../../src/harness/creative.ts#L531-L536) 等）拿到**完整正文**，`TurnNode.content` 天然包含预填，**无需改任何调用方**；
- `reasoningDelta` 不做游标（B/C 组合的预填只影响 CoT，不进正文，也不需要在 UI 补显）。

选这个位置的关键理由：**回显与不回显两种世界都收敛到同一条输出**，所以 §4.1 那个「不回显」的判断即使被实测推翻，也只需要改一个布尔常量，不动任何调用方。

### 8.5 连带需要记的两处

- `TurnNode`（[types.ts#L88-L104](../../src/harness/types.ts#L88-L104)）建议新增 `prefillContent?: string` 元数据。原因：分支重生成时若把上一轮**已烘焙进 `content` 的预填**再当预填发一次，会出现预填叠加。这条与 ADR-0014「每次助手回复节点静默记录实际请求参数」是同一套做法。
- Android 侧**零改动**已确认：[SseStreamClient.java#L100-L137](../../android/app/src/main/java/io/localfiction/harness/SseStreamClient.java#L100-L137) 只校验 http/https scheme 后原样写出 body 字节；`capacitorSseTransport.ts` [L53](../../src/platform/capacitorSseTransport.ts#L53) 复用同一个 `buildOpenAiChatRequest`，所以 URL 与 body 的改动自动双端一致。唯一需要复核的是 `diagnostics.ts` 的主机白名单（[L41-L48](../../src/harness/diagnostics.ts#L41-L48)）已经含 `api.deepseek.com`，`/beta` 同主机，无需新增。

---

## 九、待实测清单（必须有真 Key 才能关掉）

本机 `~/.env.local` 里的 `VITE_TEST_API_KEY` 是**百度千帆**的密钥（`bce-v3/...` 形态），不是 DeepSeek 的 `sk-` Key，**跑不了本票的真实请求**。下列结论目前只有文档与第三方实现支撑，必须由操作者用自己的 Key 跑探针确认：

| # | 待实测项 | 为什么必须实测 | 探针怎么回答 |
| --- | --- | --- | --- |
| 1 | **首块是否回显预填正文** | 官方零说明；§4.2 的双分支设计虽然安全，但决定「游标走哪条路」 | 看用例 A 的「正文是否以预填 content 开头」 |
| 2 | **组合 A 下 `reasoning_content` 是否为空** | 决定 UI 思考态会不会「一闪而过」 | 看用例 A 的「思维链累计长度」 |
| 3 | **组合 C 的合并顺序** | 官方无示例；第三方实现是 `reasoning → 结束标记 → 正文` | 看用例 C 前 3 个 chunk 里 `reasoning_content` 与 `content` 的先后 |
| 4 | **`reasoning_content` 预填在稳定端点/非 beta 端点是否被静默忽略** | 决定 §7.2 第 8 条的防呆要不要做成硬断言 | 对比 `DEEPSEEK_BETA_BASE=https://api.deepseek.com` 与 `.../beta` |
| 5 | **`prefix:true` + 空 content（组合 D）是否等同普通请求** | 验证「prefix 标记本身不改变行为」这个假设 | 看用例 D 正文是否从零开始 |
| 6 | **不发 `stop` 时的尾随啰嗦程度** | §5.5 的三条抑制手段需要实证校准 | 观察各用例 `finish_reason: stop` 之后正文尾部 |
| 7 | **组合 E（思考关闭 + 正文预填）** | 保护 `createBackgroundModelConfig` 的后台路径 | 看用例 E 是否 200 且正文正常 |

---

## 十、探针脚本

`docs/research/2026-11-22-beta-prefix-probe.mjs`：Node 原生 `fetch`，零依赖，遍历 A/B/C/D/E 五组各发一次流式请求，打印 HTTP 状态、首 3 个 SSE chunk 原始 JSON、`finish_reason`、正文/思维链长度、以及正文是否以预填内容开头。

```bash
DEEPSEEK_API_KEY=sk-xxxx DEEPSEEK_MODEL=deepseek-flash \
  node docs/research/2026-11-22-beta-prefix-probe.mjs
```

- 缺 `DEEPSEEK_API_KEY` 时打印一行说明并 `exit 0`（不当作错误，便于 CI/本地随手跑）；
- `DEEPSEEK_MODEL` 默认 `deepseek-flash`；`DEEPSEEK_BETA_BASE` 可用于对比 beta / 稳定端点（默认 `https://api.deepseek.com/beta`）；
- 请求体刻意与 `buildOpenAiChatRequest` 对齐（不发 `stop` / `temperature` / `top_p` / `seed` / `safety_check` / `tools`），避免引入额外互斥变量；
- 已在本地假服务端上验证过三种形态：回显、不回显、400 分支，以及缺 Key 分支，输出格式可用。

---

## 十一、主要参考一手信源

- **官方 DeepSeek 文档**
  - [对话前缀续写（Beta）· 中文](https://api-docs.deepseek.com/zh-cn/guides/chat_prefix_completion/) ／ [English](https://api-docs.deepseek.com/guides/chat_prefix_completion)（末条 `role=assistant` + `prefix:True`、`base_url=/beta`、官方示例用 `stop` 防啰嗦）
  - [Chat Completions API Reference](https://api-docs.deepseek.com/zh-cn/api/create-chat-completion)（assistant message 的 `prefix` / `reasoning_content` 字段原文；`stop` / `stream_options` / `safety_check` / `title` 参数定义）
  - [思考模式](https://api-docs.deepseek.com/zh-cn/guides/thinking_mode)（`thinking` / `reasoning_effort` 映射、`reasoning_content` 回传规则、流式样例的通道顺序、`temperature` / `top_p` 行为）
  - [联网工具 · 继续生成](https://api-docs.deepseek.com/zh-cn/guides/web_tools#continue-generation)（用过联网工具的回复不能续写、精确 400 错误串、Chat Completions 示例中 `safety_check` 与 `prefix:true` 并存）
  - [模型 & 价格](https://api-docs.deepseek.com/zh-cn/quick_start/pricing)（能力矩阵：Chat Prefix Completion 对双模型均 ✓；FIM 标注 Non-thinking mode only）
  - [模型内容安全](https://api-docs.deepseek.com/zh-cn/guides/safety)（`safety_check` 取值与拒答行为）
  - [更新日志](https://api-docs.deepseek.com/zh-cn/updates)（2024-07-25 引入 Beta 前缀续写；2026 年 V4.1 / V4 Pro 版本线）
  - 官方文档镜像全文 [llms-full.txt](https://cdn.jsdelivr.net/gh/thevibeworks/deepseek-docs@main/llms-full.txt)（用于核对 schema 原文与 Markdown 源）
  - **历史归档**：[Reasoning Model (deepseek-reasoner) · 2026-02 快照](https://web.archive.org/web/20260226212031/https://api-docs.deepseek.com/guides/reasoning_model)（旧版「input 里带 `reasoning_content` 即 400」的规定，现已废止——理解社区混乱信息的来源）
- **第三方独立实现（把官方没写的分支语义写清楚了）**
  - [ROCm/ATOM PR #3036 · commit e48ad89](https://github.com/ROCm/ATOM/commit/e48ad896f07e8a6de4018f66a94ae23c1b26dc54)：`prefix_completion.py` 完整实现（`AssistantPrefix`、`take_assistant_prefix`、`continue_prompt`），含「response carries only what the model adds」「content prefix 先空关推理通道」「`/v1` 静默忽略 prefix」以及全部 400 校验条件
- **社区实践**
  - [rikkahub#1918](https://github.com/rikkahub/rikkahub/issues/1918)：真实用户报告「预填不生效」的两个根因（末条不是 assistant、缺 `prefix:true`），并明确提出「界面应显示预填 + 续写」
  - [dsh-preset-enhance · WORKBENCH 指南](https://github.com/bychv/dsh-preset-enhance/blob/main/docs/guides/WORKBENCH.md)：「预填充到思考」开关默认开启（前缀写入 `reasoning_content`），关闭时写入 `content`；思考关闭时按正文发送；匹配的预填请求自动切到 `https://api.deepseek.com/beta`
  - [ai-chat v1.0.11 变更](https://git.yixinzone.com/library/ai-chat/-/blob/main/versions/v1.0.11.md)：生产环境的续写实现，明确「baseUrl 含 `/beta` + 末尾 assistant `prefix=true` + 存在思考内容时传递 `reasoning_content`」
  - [new-api · DeepSeek 渠道文档](https://github.com/futureppo/new-api/blob/394ef98ef406bc3fa25a71031f8a6357eb1b3101/docs/channel/deepseek.md)：网关侧判定「Chat 中包含 `prefix:true` 时自动走 `/beta/chat/completions`」，佐证 beta 路径是硬要求
- **预填句式与原理**
  - [Assistant Prefill on Claude: 4 Recipes That Ship (2026)](https://www.promptattic.com/library/assistant-prefill-recipes-that-ship)：persona name-tag 手法、「预填格式而非结论」、`Sure, here is` 作为反面教材。**注意该文的「prefill 不能与 extended thinking 同用」是 Anthropic 的限制，DeepSeek 恰好相反（`reasoning_content` 就是为思考模式预填设计的），不可照搬**
  - [Assistant Prefill：预填模型回复开头](https://feinterview.poetries.top/ai-monitor/news/assistant-prefill-write-the-start-of-the-model-s-reply-and-the-format-stops-being-a-re)：解释为什么空 assistant turn 的最高概率开头是 `Sure! Here's...`
  - [IC-310 · SORRY-Bench 参数消融](https://credibleai.github.io/modelpedia/findings/IC-310/index.html)：`sure, here is` 预填会显著抬高「合规助手」履约率——旁证该前缀的人格锁定效应
- **本仓基线**
  - [src/harness/sse.ts](../../src/harness/sse.ts)、[src/harness/types.ts](../../src/harness/types.ts)、[src/harness/keyConfig.ts](../../src/harness/keyConfig.ts)、[src/harness/keyValidation.ts](../../src/harness/keyValidation.ts)、[src/platform/capacitorSseTransport.ts](../../src/platform/capacitorSseTransport.ts)、[SseStreamClient.java](../../android/app/src/main/java/io/localfiction/harness/SseStreamClient.java)、[src/harness/harness.ts](../../src/harness/harness.ts)、[src/harness/creative.ts](../../src/harness/creative.ts)、[src/harness/markdownProposal.ts](../../src/harness/markdownProposal.ts)、[src/harness/diagnostics.ts](../../src/harness/diagnostics.ts)
  - [ADR-0009](../../docs/adr/0009-deepseek-official-guided-byok.md)（官方地址锁定与引导式 BYOK）、[ADR-0014](../../docs/adr/0014-deepseek-model-selection-and-reasoning-effort.md)（双模型 + 四档思考强度映射）
  - [2026-11-22 提案协议调研](2026-11-22-v02-proposal-protocol-and-markdown-diff.md)（`lfh-proposal` 围栏协议，与 `stop` 互斥的由来）
