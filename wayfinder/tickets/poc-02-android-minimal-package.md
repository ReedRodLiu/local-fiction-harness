---
kind: wayfinder-ticket
type: task
status: open
parent: map
blocked_by:
  - poc-01-local-web-fiction-harness
blocks: []
---

# POC-02：最小化 Android 封包能否实现无后端 BYOK 试用体验？

## Question

在 `POC-01` 本地网页核心跑通后，当需要打包给种子用户在手机上试用时，最简单的 Android 封包方案（如 Capacitor 等极薄原生容器）能否在不设服务器中转的前提下，绕开浏览器 CORS 限制直连模型 API、安全保管 Key 并稳定保存长篇存档？

## Work

- 选型最轻量的 Android Web 容器包装方案（如 Capacitor），禁止打包 Ubuntu/PRoot、Node.js 运行时或任意 Shell 执行能力。
- 将 `POC-01` 的网页端文游 Harness 封装为最小 Android 测试包，重点接入原生 HTTP 请求层（避免 WebView `fetch` 的 CORS 拦截），验证直连 DeepSeek 官方及用户自定义 OpenAI 兼容中转地址。
- 将网页端的 `localStorage` 密钥存放替换为 Android 原生安全存储接口，并验证故事与存档数据在本地文件/数据库中的持久化及导出导入备份。
- 在至少一台明确记录型号和 Android 版本的实体手机上测量 APK 体积、安装后占用、冷启动时间、切后台流式中断行为及强制关闭后的恢复能力。

## Acceptance

- 测试 APK 可在实体 Android 手机上独立安装并运行，无需连接电脑或项目方后端。
- 可成功填写任意 HTTPS 模型 API 地址与自带 Key 完成流式对话，并完成强制杀进程后的本地故事恢复；Key 不写入普通日志或明文共享配置文件。
- 附上真实 APK 体积、设备型号、Android 版本、实测性能数据及第三方依赖/许可证清单。
- 明确区分“种子用户侧载试用包”与“公开应用商店上架要求”（如 targetSdk、内容标识与合规审核），不将内测包视作已过审版本。

## Risks

- 不同品牌手机与低版本 Android System WebView 可能在 SSE 流式分块渲染、SSE 断线重连或局部滚动体验上存在兼容性问题。
- 若原生 HTTP 插件在流式 SSE 转发至 WebView 时存在缓冲延迟，可能影响打字机流式观感，需要实测确认。
- 手机切后台或锁屏时，系统对网络请求和进程的挂起可能导致长文本生成中断，需要设计重试与断点续写提示。
