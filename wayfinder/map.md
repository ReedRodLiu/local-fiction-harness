---
kind: wayfinder-map
label: wayfinder:map
status: active
---

# 本地优先 AI 文游开发地图

## Destination

跑通“自研轻量文游 Harness + 本地存储”的最小实现：先在本地网页端完成源码级文游闭环（剧本导入、流式对话、上下文组装与摘要记忆、本地持久化与回溯分支），并在需要向用户交付手机试用时验证最小化 Android 封包可行性，以此产出下一阶段 MVP 规格与决策依据。

## Notes

- 已调整的产品路线和边界见[项目方案](../docs/project-plan.md)；关键技术与合规前期依据见[最小客户端技术讨论依据](../docs/research/2026-11-17-client-runtime-options.md)和[微信小程序合规调研](../docs/research/2026-11-17-miniapp-compliance.md)。
- 彻底放弃 DSH（DeepSeek Harness）运行底座及微信小程序载体；核心文游 Harness 保持纯客户端逻辑与本地存储，不依赖桌面客户端、项目方业务服务器或云端模型代理。
- 坚持“本地网页最小实现先行，需要给用户试用时再做最小 Android 封包”的节奏；未实测的体积、性能、内存与浏览器跨域表现不写作既定指标。
- 保持最小权限与简洁架构：开发机构建可使用前端工具链，但不得将 Node.js、Ubuntu/PRoot 或任意 Shell 能力打包分发给终端用户。
- 本地 Markdown tracker 的文件关系约定见[Wayfinder 记录方式](README.md)。

## Decisions so far

- 已决定彻底放弃 DSH 底座（原 `poc-a`、`poc-b`、`poc-c` DSH 验证票据已作废移除），转向自研轻量文游 Harness 与本地存储（见[项目方案](../docs/project-plan.md)）。
- 已决定先跑通本地网页端最小实现（Vite + React + TypeScript，支持 `.docx`/`.md`/`.txt`/粘贴自由导入 + LLM 蓝图拆解 + 原文兜底锚定），需要打包给用户手机试用时再做最小化 Android 封包，不考虑微信小程序路线（见[项目方案](../docs/project-plan.md)）。
- 已决定 `POC-01` 优先使用测试端点 `https://qianfan.baidubce.com/v2/tokenplan/personal`（模型 `deepseek-v4.1-flash`）完成通用 Harness 联调（已实测该端点支持 SSE 流式且返回 `reasoning_content`，但不允许浏览器直接跨域，开发期需配 Vite 本地代理），DeepSeek 官方 API 联调单独拆出票据跟进。

## Not yet specified

- DeepSeek 官方 API（`api.deepseek.com`）与千帆等兼容端点在剧本拆解、文风遵循与浏览器直连 CORS 上的具体差异（见后续联调票据）。
- 自研文游 Harness 的上下文预算分配、基础剧情摘要触发时机与回溯分支时摘要同步回滚的体验质量标准。
- Android 最小封包在真实设备上的安装包体积、低版本 WebView 兼容性、API Key 系统安全存储方式与后台中断恢复表现。
- 目标玩家的 Android/iOS 设备占比、BYOK 上手流失率、工具付费意愿，以及后续是否及何时补做 iOS 端。
- 若从熟人内测走向面向公众公开发行，网页/Android 客户端各自对应的 AI 内容标识、拟人化互动边界与用户自导剧本权属提示落地标准。

## Out of scope

- 放弃基于 DSH（DeepSeek Harness、`@deepseek-ai/dsh-sdk-minimal`、DSH Go、DSH Mobile）的移植、裁剪与运行底座。
- 不做微信小程序版本。
- 本轮不做业务后端、用户数据托管、云端模型代理转发、账号体系或需要连接电脑客户端的方案。
- 本轮不启动 iOS 原生适配、完整数值游戏引擎、创作者工作台或剧本交易市场。
