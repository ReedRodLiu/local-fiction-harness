---
status: accepted
---

# 放弃 CapacitorHttp 整包缓冲，采用轻量原生分块 SSE 流式桥接

## Decision

Android 端明确不采用 Capacitor 内置 `CapacitorHttp` 承载模型推理请求，而是在 Android 容器内实现一个极薄的原生分块 SSE 流式桥接插件：按请求 ID 发起直连 HTTPS POST 请求，实时按块读取响应字节流并通过事件向 JS 层递增派发原始块、完成与错误信号（支持 `abort` 立即中断底层连接），在平台适配器层将其封装为标准 `LlmTransport`（`AsyncIterable<LlmStreamDelta>`），复用 `src/harness/sse.ts` 的跨块 UTF-8 解码与 `reasoning_content` / `content` 分离解析。

## Considered Options

- **启用 Capacitor 内置 `CapacitorHttp` 补丁**：原生层会整包缓冲 HTTP 响应体直至连接关闭才返回，长篇叙事响应期间界面完全卡死，无法实现逐字流式吐字与实时思考过程展示。
- **继续在 Android WebView 内直接调用浏览器 `fetch`**：受制于 WebView CORS 策略，玩家无法直连无 `Access-Control-Allow-Origin` 响应头的官方/兼容/自定义中转模型端点。

## Consequences

- Android 端彻底绕开 WebView CORS 限制并保留完整逐块 SSE 流式体验与即时中断能力，且无需引入 Node.js、云端中转或 DSH 运行时。
- 仓库需维护少量仅用于流式 HTTP 转发与中断的 Android 原生插件代码及对应 JVM 单元测试，跨端流式行为由统一的 JS 契约测试保障。
