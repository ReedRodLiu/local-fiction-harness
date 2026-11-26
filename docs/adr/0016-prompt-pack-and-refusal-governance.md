---
status: accepted
---

# 叙事提示词包模块与本地拒答治理机制边界

> 部分修订 [ADR 0009](0009-deepseek-official-guided-byok.md) 与 [ADR 0014](0014-deepseek-model-selection-and-reasoning-effort.md)：保留官方地址锁定与引导式 BYOK 原则，明确官方 `/beta` 地址族在请求拼装层的派生契约，并在不内置第三方规避正文的前提下提供用户自维护的叙事提示词包与本地拒答治理能力。
>
> 部分修订：`baseUrl` 锁定与 `/beta` 派生已由 [ADR 0018](0018-multi-provider-openai-compatible-architecture.md) 扩展为多服务商能力驱动续写与兼容探测，同时继续严守不内置第三方破甲提示词边界。

## Decision

1. **可判定的功能边界**：
   - **提供**：用户可自行导入、编辑与切换的「叙事提示词包（Prompt Pack）」本地三槽（`head` / `mid` / `tail`）编排模块（仅内置自写极简纯文学基础骨架）；基于 DeepSeek 官方 `/beta` 端点的前缀续写（Assistant Prefill）双端统一传输支持；基于实测 26 条拒答正则与薄交付否决器的流内判拒、120 字首包观察窗、单次自动重拟、历史拒答轮次隔离清洗、误判一键恢复首次原稿与半拒绝手动追要交互。
   - **不提供**：不提供任何宿主源码补丁、Service Worker 拦截或本地 sidecar；发行包不预置或分发任何第三方成品规避提示词（亦不设「一键开启破甲」按钮）；不自建云端中转代理或提示词包远程商店；不移植面向非虚构武器化拆解的 `DECOMPOSE` 切碎重试臂。
2. **官方地址族与请求层派生规则**：
   - `ModelConfig.baseUrl` 持久化配置仍锁定 `https://api.deepseek.com`，生产界面不暴露 URL 输入框。
   - `GenerationPreference` 新增 `promptPackMode` 与 `prefixCompletion`（`'off' | 'on_retry' | 'always'`），沿用「全局默认 + 按故事/作品/角色独立覆盖」作用域模型。
   - `/beta` 路径仅在 `src/harness/sse.ts` 的 `buildOpenAiChatRequest` 中因请求携带 `prefixCompletion` 时按需派生（`resolveBetaChatCompletionsUrl`），后台轻量任务（`createBackgroundModelConfig`）固定走稳定端点。
3. **`keyConfig.ts` API Key 保留正则同步加固**：
   - `normalizeOfficialModelConfig` 必须同步放宽端点校验正则至 `/^https:\/\/api\.deepseek\.com(?:\/v1|\/beta)?\/?$/i`，并由单元测试锁死 `/beta` 传入时不得静默清空 `apiKey`。
4. **本地数据隔离与零正文诊断**：
   - 提示词包内容独立存储并纳入 `.folio.json` v3 备份，严禁注册为 `lfh-proposal` 的可修改目标（防止模型通过提案篡改系统规则），且严禁进入 ADR-0008 脱敏诊断日志。

## Consequences

- `#1` Out of scope 中关于第三方审核规避机制的表述修订为指向本 ADR：Folio 仅提供中立的本地提示词槽位、官方 `/beta` 协议能力与拒答容错体验，外部导入文本及其接口调用合规性与重试额外 Token 消耗由用户自行承担。
- Web 与 Android `NativeSse` 共享同一套 `buildOpenAiChatRequest` 与回显游标逻辑，原生 Java 层保持零改动。
