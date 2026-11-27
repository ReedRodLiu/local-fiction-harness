---
status: accepted
---

# 首版锁定 DeepSeek 官方渠道与引导式 BYOK 接入

> 部分修订：本决议中“隐藏模型名称并锁定单模型”的约束已由 [ADR 0014](0014-deepseek-model-selection-and-reasoning-effort.md) 调整为开放官方双模型选择与四档思考强度控制；官方地址锁定与引导式 BYOK 原则继续生效。
>
> 部分修订：叙事提示词包、官方 `/beta` 请求派生与拒答治理的边界见 [ADR 0016](0016-prompt-pack-and-refusal-governance.md)。
>
> 部分修订：官方地址强锁定与仅 DeepSeek 引导已由 [ADR 0018](0018-multi-provider-openai-compatible-architecture.md) 修订为以多服务商 OpenAI 兼容档案为默认架构、保留 DeepSeek 为一等内置预设。

## Decision

面向零编程经验的普通手机用户，首版生产环境彻底隐藏 `Base URL` 与模型名称配置界面，默认且强制归一化为 DeepSeek 官方地址（`https://api.deepseek.com`）与主力模型 `deepseek-flash`（仅内部开发代理 `.env.local` 与 E2E 测试通道保留注入覆盖能力）。延续**延迟 BYOK（自带 API Key）**原则，允许未配 Key 用户先导入剧本与浏览剧情树，仅在首次触发模型请求或主动点击绑定入口时弹出统一的三步引导向导（外链系统浏览器前往 DeepSeek 开放平台创建 Key -> 一键粘贴/手动输入并清洗空白 -> 调用零 Token 消耗的 `GET /models` 在线验真后持久化保存），并在已绑定态提供脱敏尾号展示、更换 Key 与「清除已保存的key」操作。

## Considered Options

- **保留 Base URL 与模型名称输入框，仅加文字说明或折叠进「高级选项」**：普通手机用户面对 `Base URL`、`端点`、`deepseek-chat` 等术语仍会产生认知障碍，且误改配置会导致难以排查的网络错误。
- **使用 DeepSeek 扫码/OAuth 授权登录或内置 WebView 登录**：经前期调研（见 `docs/research/2026-11-18-deepseek-official-oauth-qr.md`），DeepSeek 官方未对第三方开放 OAuth/扫码授权接口，且内嵌 WebView 易触发微信/手机登录态拦截。
- **开屏强制配 Key 才允许进入主界面**：违背本地优先体验，容易在用户未看到产品价值前直接劝退。

## Consequences

- 读取既有本地配置时（非开发代理模式下）会强制将 `baseUrl` 与 `model` 归一化为 `https://api.deepseek.com` 与 `deepseek-flash`，历史测试设备缓存的旧模型标识（如 `deepseek-chat`）会被自动迁移覆盖。
- 未来若需支持 `deepseek-v4-pro` 或自定义中转渠道，需在明确区分“普通模式 / 开发者模式”的前提下再逐步恢复模型切换能力。
