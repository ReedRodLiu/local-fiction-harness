---
status: accepted
---

# 放弃 CapacitorHttp 整包缓冲，采用轻量原生分块 SSE 流式桥接

## Decision

Android 端明确不采用 Capacitor 内置 `CapacitorHttp` 承载模型推理请求，而是在 Android 容器内实现一个极薄的原生分块 SSE 流式桥接插件：按请求 ID 发起直连 HTTPS POST 请求，实时按块读取响应字节流并通过事件向 JS 层递增派发原始块、完成与错误信号（支持 `abort` 立即中断底层连接），在平台适配器层将其封装为标准 `LlmTransport`（`AsyncIterable<LlmStreamDelta>`），复用 `src/harness/sse.ts` 的跨块 UTF-8 解码与 `reasoning_content` / `content` 分离解析。

为避免长推理期间玩家短暂切屏、切后台或锁屏被系统挂起套接字与 WebView JS 桥接，原生插件同步遵循以下后台流保活与缓冲契约：

- **按需 `dataSync` 前台服务与有限期 `PARTIAL_WAKE_LOCK`**：在首个活跃 SSE 流启动时启动轻量级 `SseForegroundService`（`foregroundServiceType="dataSync"`，`START_NOT_STICKY`），展示低打扰进行中通知（“Folio 正在生成回复…”），并持有带显式安全超时上限（10 分钟 > 120 秒读超时）的非引用计数 `PARTIAL_WAKE_LOCK`；通过 `SseKeepaliveCoordinator` 按 `requestId` 集合管理引用计数，一旦全部活跃流结束（`sseComplete` / `sseError` / `abortStream` / `handleOnDestroy`）立即停止服务并释放唤醒锁，绝不在空闲期驻留后台。
- **Android 13+ 通知权限安全降级**：声明 `FOREGROUND_SERVICE`、`FOREGROUND_SERVICE_DATA_SYNC`、`WAKE_LOCK` 与 `POST_NOTIFICATIONS`（同步纳入 `scripts/audit-artifacts.mjs` 白名单），并在启动前台服务/申请唤醒锁处捕获系统受限异常；即使 `POST_NOTIFICATIONS` 未授予导致通知被系统折叠，仍保持唤醒锁与原生流连接可用而不崩溃。
- **Pause/Resume 有序事件缓冲**：`NativeSsePlugin` 通过 `handleOnPause()` / `handleOnResume()` 与纯 JVM `SseEventBuffer` 协同。WebView 处于暂停或恢复重放过渡期间，按 `requestId` 隔离的 FIFO 队列暂存 `sseChunk`、`sseComplete`、`sseError` 事件；恢复前台后按原顺序一次性冲刷至 `notifyListeners` 并立即清理已结束请求状态；`abortStream` 同步清空对应请求缓冲；若切后台期间发生真实底层断网，先重放已收到分片再向上抛出含已收字节数（零正文/零密钥）的 `CONNECTION_ABORTED` 错误。

## Considered Options

- **启用 Capacitor 内置 `CapacitorHttp` 补丁**：原生层会整包缓冲 HTTP 响应体直至连接关闭才返回，长篇叙事响应期间界面完全卡死，无法实现逐字流式吐字与实时思考过程展示。
- **继续在 Android WebView 内直接调用浏览器 `fetch`**：受制于 WebView CORS 策略，玩家无法直连无 `Access-Control-Allow-Origin` 响应头的官方/兼容/自定义中转模型端点。
- **仅依赖 `FLAG_KEEP_SCREEN_ON` 而不使用 `dataSync` 前台服务与后台事件缓冲**：用户切出应用或按电源键锁屏后，`Activity` 立即进入 `onPause`/`onStop`，系统迅速回收网络套接字或冻结 WebView 派发，导致深度思考长响应在数十秒后触发 `CONNECTION_ABORTED`。
- **引入 FCM/JPush 或云端中继缓存生成结果**：违背本地优先与 BYOK 架构原则，且引入不必要的云端依赖与隐私暴露面。

## Consequences

- Android 端彻底绕开 WebView CORS 限制并保留完整逐块 SSE 流式体验与即时中断能力，且无需引入 Node.js、云端中转或 DSH 运行时；玩家在长推理期间短暂切屏或锁屏不再因页面暂停即断流。
- `AndroidManifest.xml` 仅新增流式保活必需的系统权限与非导出 `SseForegroundService`，`scripts/audit-artifacts.mjs` 白名单同步校验并禁止无关权限与空闲驻留。
- 仓库需维护少量仅用于流式 HTTP 转发、前台保活与暂停缓冲的 Android 原生插件代码及对应 JVM 单元测试，跨端流式行为由统一的 JS 契约测试保障。
