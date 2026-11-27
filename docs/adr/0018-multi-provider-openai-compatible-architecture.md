---
status: accepted
---

# 以通用 OpenAI 兼容多服务商档案为默认架构并保留 DeepSeek 一等预设

> 部分修订 [ADR 0009](0009-deepseek-official-guided-byok.md)、[ADR 0014](0014-deepseek-model-selection-and-reasoning-effort.md) 与 [ADR 0016](0016-prompt-pack-and-refusal-governance.md)：解除对 `https://api.deepseek.com` 与官方双模型白名单的强制锁定，将自定义 OpenAI 兼容多服务商档案确立为默认架构，同时保留 DeepSeek 官方作为拥有全套原生增强的一等内置预设。
>
> 增补：Android 端第三方服务商免密钥公开网页联网检索兜底策略见 [ADR 0019](0019-android-keyless-public-research-fallback.md)。

## Decision

1. **标准协议与多服务商档案库（Provider Profile）**：
   - 首阶段以 **OpenAI Chat Completions 兼容协议**（`POST /chat/completions` 与 `GET /models`）为唯一核心传输协议，在协议适配边界为后续接入其他原生协议预留扩展接缝。
   - 用户可在本地保存多组服务商档案（包含名称、Base URL、可选 API Key、常用模型清单、可选后台轻量模型、可选自定义单价与能力声明），并指定全局默认档案。
   - 单个故事（`Story`）、作品（`DraftWork`）与角色（`LocalCharacter`）的 `GenerationPreference` 支持独立覆盖 `providerId`、`model` 与思考档位，未覆盖时继承全局默认。
   - 摘要压缩、导入设定提取、分支概括与检索合成等后台轻量任务优先使用所属档案配置的后台轻量模型（DeepSeek 预设默认 `deepseek-flash`）；未单独配置时自动复用当前主模型，且不传或关闭思考参数。

2. **零编程门槛的统一引导与 DeepSeek 一等预设**：
   - 替换原有的仅 DeepSeek 连接向导，提供统一的「连接模型服务」配置引导：顶部并列常见服务商快捷预设（DeepSeek 官方、OpenAI、OpenRouter、硅基流动、本地服务、自定义端点），表单支持 `GET /models` 拉取与手填模型 ID 双轨，校验受阻时允许「跳过校验直接保存」。
   - **保留 DeepSeek 官方一等预设**：选择 DeepSeek 预设仅需一条 API Key 即可开箱启用全套原生能力（主对话生成、官方 Search/Fetch 公网检索、余额查询与充值跳转、内置峰谷费率省费估算、`/beta` 前缀续写）。
   - 主界面仅展示必填字段与 3 行通俗能力状态说明（聊天与叙事预设 / 自动查原作 / 余额与省费统计）；将后台轻量模型、自定义单价与增强续写兼容探测收入默认折叠的「更多可选设置」，避免向零编程经验用户暴露底层参数术语。

3. **全局默认关闭的统一思考开关**：
   - 主生成流思考开关在全局及各服务商上**默认关闭**。
   - **DeepSeek 预设**：关闭态显式发送 `thinking: { type: "disabled" }` 与 `reasoning_effort: "none"`（防止服务端默认高强度思考）；开启后沿用确定性的 `低 / 高 / 极限` 官方档位。
   - **第三方 OpenAI 兼容服务商**：关闭态请求体**完全省略** `thinking` 与 `reasoning_effort` 字段（防止非推理模型或严格网关返回 `400`）；开启后仅发送标准 `reasoning_effort`（`low / medium / high`）。

4. **叙事连贯保护与能力驱动的续写机制**：
   - 严守 [ADR 0016](0016-prompt-pack-and-refusal-governance.md) 功能边界：**应用内绝不提供、内置或分发任何破甲/规避提示词**，仅提供中立工具入口与容错机制。
   - 三段槽位叙事预设、流内拒答检测、120 字首包观察窗、尾段重拟、历史拒答隔离与误判一键恢复均基于标准 OpenAI 消息结构通用生效。
   - 前缀续写（Prefix Completion）按服务商能力驱动：DeepSeek 预设默认启用 `/beta/chat/completions` 与 `prefix: true`；第三方服务商默认关闭前缀续写，半拒绝追要自动降级为标准 `assistant + user` 续写指令，并在折叠进阶区提供「测一下支不支持」兼容探测按钮以按需启用不改写 URL 的标准末尾 `assistant` 预填。

5. **联网检索源（Public Research Source）分层**：
   - 使用 DeepSeek 官方预设时，继续直连官方 `/v1/tools/search` 与 `/v1/tools/fetch`；**严禁将第三方服务商的 API Key 发往 `api.deepseek.com`**。
   - 选中第三方服务商时，界面自动呈现可选的联网检索配置区：内置免费额度充足的搜索服务预设（如 Tavily、博查等）并附简短用途与免费额度说明，同时允许直接借用档案库中已连接的 DeepSeek 账号；未配置检索源时静默跳过公网查证，正常以纯上下文开书。

6. **通用 Token 省量统计与可选自定义计费**：
   - 流式 `usage` 解析同时兼容 DeepSeek 风格的 `prompt_cache_hit_tokens` 与 OpenAI 标准的 `prompt_tokens_details.cached_tokens`。
   - DeepSeek 预设保留内置峰谷费率对比与 `/user/balance` 查询；第三方服务商支持在折叠设置中按模型（或档案默认）选填每百万 Token 单价与币种（`CNY` / `USD`）：填写后按自定义单价计算实测费用与预计省费，未填写时仅展示通用 Token 用量、缓存命中率、压缩轮次与估算节省输入 Token 数，不渲染不可比报错。

7. **跨端网络、历史迁移、导入兼容与安全边界**：
   - 严格保持纯客户端架构（[ADR 0001](0001-client-only-harness-without-dsh-or-backend.md)），不架设云端中转代理；Web 端直连第三方端点若被浏览器 CORS 拦截，给予通俗指引（建议改用 Android App 或支持网页直连的服务商）。
   - 老版本本地单槽 `ModelConfig` 自动迁移为首个默认服务商档案，同时解除对非官方 `baseUrl` 与模型名的强归一化覆盖。
   - 完整保留 DeepSeek 导出包（`.zip`）导入能力，确保仅配置第三方模型服务商的用户同样可导入历史导出包并用当前档案完成结构化提取。
   - `.folio.json` 完整备份允许导出不含密钥的服务商骨架配置，**严禁导出任何模型或搜索 API Key**；Android 端多档案与搜索密钥统一由 Keystore 加密存储；脱敏诊断包（[ADR 0008](0008-zero-content-diagnostics-and-turn-context-integrity.md)）继续对第三方域名做哈希脱敏（`relay_<hash>`）。

## Considered Options

- **彻底移除所有 DeepSeek 专属能力使全服务商无差别**：会导致余额查询、开箱官方检索、`/beta` 续写与默认费率对比等已验证体验退化，增加老用户与零基础新用户的配置摩擦。
- **把底层协议方言与参数开关直接暴露在首屏**：`thinking`、`/beta`、`prefix`、`reasoning_effort` 等技术概念会让无编程经验用户无从下手，极易误配触发 `400` / `404`。
- **纯客户端直接爬取免 Key 公共搜索引擎替代 Web Search**：Web 端受 CORS 拦截、移动端易受反爬与验证码阻断，稳定性远低于自带免费额度的开放搜索 API。
- **首阶段同步原生适配 OpenAI / Anthropic / Gemini 三套流协议**：成倍增加双端 SSE 解析与排障成本，延后通用自定义提供商主流程上线。

## Consequences

- `keyConfig`、`sse`、`publicResearch`、`usageSavings`、`refusalWrapper` / `refusalContinuation`、`backup`、`diagnostics` 与前端连接引导/设置页需按多服务商档案与能力模型重构。
- Android 原生 `NativeVault` / `SecretVault` 需支持多档案与独立检索源的密钥加密存储；`NativeSse` 保持协议无关的 POST + SSE 字节流透传不变。
- 本仓库既有测试、E2E 桩与 `.folio.json` 备份校验需保持对老版单槽本地配置及 v3 备份的向后兼容。
