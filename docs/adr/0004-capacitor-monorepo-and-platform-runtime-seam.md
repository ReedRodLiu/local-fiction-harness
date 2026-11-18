---
status: accepted
---

# 单仓 Capacitor 容器与 PlatformRuntime 异步接缝

## Decision

在同一仓库内采用 Capacitor 将共享的 `src/harness/` 与 `src/ui/` 封装为 Android 最小封包，并将全部宿主能力差异收拢到单一顶层异步接缝 `PlatformRuntime`（包含 `transport`、`storyStorage`、`secretStore`、`backupExporter`、`supportsMemoryOnlySession`）。Web 端保留 `fetch`（含仅开发期代理）、`localStorage`、IndexedDB 与 Blob 下载；Android 端改用原生加密 `SecretStore`、App 私有目录原子持久化 `StoryStorage` 及原生文件/分享面板 `BackupExporter`。

## Considered Options

- **独立维护 Kotlin/Jetpack Compose 或 React Native 安卓客户端**：虽能调用原生能力，但会导致文游交互界面与状态逻辑双端分裂，违背“功能只写一遍、同步交付双端”的演进要求。
- **在 Android WebView 内直接沿用 `localStorage` 与 IndexedDB**：WebView 缓存清理会导致玩家数月故事进度与故事蓝图丢失，密钥隔离弱于原生加密存储，且 `<a download>` 在 WebView 内不可靠。

## Consequences

- `src/harness/` 继续维持纯 ES2022（`tsconfig.harness.json` 中 `types: []`，零 DOM/Node/Capacitor 直接导入），所有业务迭代在单仓一次修改即可同步交付 Web 与 Android APK。
- 模型配置读写由同步变为异步预水合模型，应用启动时从 `SecretStore` 水合配置，切换「仅当前会话内存保存」时立即清除原生加密存储中的 API Key；Vite 开发代理严格限制在 `apply: 'serve'`，绝不打入 `dist/` 或 APK 资产。
