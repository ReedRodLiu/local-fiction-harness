---
status: accepted
---

# 放弃 DSH 与业务后端，转向纯客户端轻量文游 Harness

## Decision

彻底放弃 DeepSeek Harness（DSH / DSH Mobile）运行时、项目方业务后端与微信小程序路线，采用纯 TypeScript、零 DOM/Node 运行时依赖的自研文游 Harness（`src/harness/`）配合浏览器本地持久化（IndexedDB）与 BYOK 直连模型 API；仅在本地开发调试期启用 Vite 本地转发代理测试无浏览器 CORS 头的端点。

## Considered Options

- **复用 DSH / DSH Mobile 底座**：捆绑 Node.js/Cordis 容器与子进程工具权限，包体大、不适配纯网页运行且触及移动端沙盒限制。
- **自建云端中转与存档后端**：可绕开 CORS 与跨端同步，但违背无业务后端、不托管用户剧本与不代理计费的产品与合规边界。

## Consequences

- Harness 核心可无修改复用到后续轻量 Android 原生容器，且不向终端用户分发任何 Node/Shell 运行时。
- 客户端需自行承担浏览器的 CORS 约束（正式跨端直连留待原生网络层）以及浏览器端 `localStorage`/IndexedDB 易受清理的风险（必须提供 JSON 备份与仅内存会话模式）。
