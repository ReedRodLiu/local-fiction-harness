---
status: accepted
---

# 双计费通道预设拆分、显式协议边界与 Gemini 官方接口修正

> 补充并局部修订 [ADR 0020](0020-multi-protocol-and-expanded-provider-presets.md)：针对国内厂商「按量 API 通道」与「Token 订阅通道」密钥及端点互相隔离的现状，在保留既有四组分类与纯客户端 BYOK 原则的前提下，拆分 9 家双通道预设并收敛协议识别与 Gemini 官方模型拉取行为。

## Decision

1. **9 家双通道厂商拆分为并排独立预设（不新增分组）**：
   - 将同时提供开放平台按量 API 与独立 Token 订阅 / Coding Plan（且支持静态 API Key）的 9 家国内厂商拆分为并排的两个预设项，优先使用厂商官方订阅命名（无独立品牌名时以「按量 API / Token 订阅」区分）：
     - `moonshot`（月之暗面 Kimi（按量 API））/ `moonshot_coding`（Kimi Code）
     - `zhipu`（智谱 GLM（按量 API））/ `zhipu_coding`（GLM Coding Plan）
     - `dashscope`（阿里云百炼（按量 API））/ `dashscope_coding`（阿里云百炼 Coding Plan）
     - `volcengine`（火山方舟 豆包（按量 API））/ `volcengine_coding`（火山方舟 Coding Plan）
     - `minimax`（MiniMax（按量 API））/ `minimax_token_plan`（MiniMax Token Plan）
     - `qianfan`（百度千帆（按量 API））/ `qianfan_token_plan`（百度千帆 Token Plan）
     - `hunyuan`（腾讯混元（按量 API））/ `hunyuan_coding`（腾讯云 Coding Plan）
     - `sensenova`（商汤日日新（按量 API），修正为 `https://api.sensenova.cn/v1`）/ `sensenova_token_plan`（商汤日日新 Token Plan，`https://token.sensenova.cn/v1`）
     - `stepfun`（阶跃星辰（按量 API））/ `stepfun_plan`（阶跃星辰 Step Plan）
   - 保持 `spark`（讯飞星火）为单预设以控制小白用户选择列表长度；不新增第 5 个分类分组；不增加额外表单开关，仅通过 `setupHint` 提示密钥隔离与部分 Coding Plan 的工具场景限制。
   - 消费级网页 OAuth 订阅（ChatGPT Plus/Pro、Claude Pro/Max、Gemini AI Pro）仍不纳入预设目录，只保留不可用说明横幅。

2. **严格显式协议（不做隐式 URL 协议识别）**：
   - 移除 `resolveVerificationProtocol` 中基于 `generativelanguage.googleapis.com` 正则的隐式协议推断，完全遵循用户当前选定预设或主动切换的 `apiProtocol`（缺省回退 `openai_chat`）。
   - 拉取模型列表不前置拦截空 Key 请求，统一按真实返回状态码与错误体给出准确提示。

3. **Google Gemini 官方特例修正**：
   - 在 `gemini_native` 协议下为裸域名（`https://generativelanguage.googleapis.com`）自动补全 `/v1beta`；
   - `GET /v1beta/models` 携带 `?pageSize=1000` 并支持 `nextPageToken` 翻页，避免 50 条默认分页截断；
   - 过滤实测中混入的生图、音频、转录、机器人与深度研究等非对话模型（`-image`、`nano-banana`、`lyria`、`transcribe`、`robotics`、`computer-use`、`deep-research`）；
   - 将 Gemini 无 Key 时返回的 `403 ACCESS_DENIED` 准确提示为需要填写有效 API Key，并将输入框占位符更新为兼容 `AIza...` 与新格式 `AQ....`。

## Considered Options

- **新增第 5 个「Token 订阅」分类或单预设内双 Tab 切换**：会打破同厂商对比的直观性或引入额外交互层级，不利于非技术用户理解；同组内并排放置且采用官方订阅名称更符合直觉。
- **根据 Base URL 自动切换 `apiProtocol`**：容易在用户配置自定义中转站时产生意外覆盖，改为严格以用户主动选择的协议为准。

## Consequences

- `ProviderPresetId` 由 21 项扩展至 30 项；`OFFICIAL_MODEL_HOSTS` 补充新增官方端点域名。
- `keyValidation.ts`、`sse.ts` 与 `ProviderSetupWizard.tsx` 的调整均保持在既有表单结构内，不新增任何配置字段。
