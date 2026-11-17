---
kind: wayfinder-map
label: wayfinder:map
status: active
---

# 本地优先 AI 文游开发地图

## Destination

跑通“自研轻量文游 Harness + 本地存储”的最小实现：先在本地网页端完成源码级文游闭环（`.docx`/`.md`/`.txt`/粘贴导入、LLM 蓝图拆解 + 原文兜底锚定、流式对话、三区上下文组装与摘要记忆、IndexedDB 本地持久化与回溯分支），并在需要向用户交付手机试用时验证最小化 Android 封包可行性，以此产出下一阶段 MVP 规格与决策依据。

## Notes

- 已调整的产品路线和边界见[项目方案](../docs/project-plan.md)；核心领域词汇见[术语表](../GLOSSARY.md)；关键技术与合规前期依据见[最小客户端技术讨论依据](../docs/research/2026-11-17-client-runtime-options.md)和[微信小程序合规调研](../docs/research/2026-11-17-miniapp-compliance.md)。
- 彻底放弃 DSH（DeepSeek Harness）运行底座及微信小程序载体；核心文游 Harness 保持纯客户端逻辑与本地存储，不依赖桌面客户端、项目方业务服务器或云端模型代理。
- 坚持“本地网页最小实现先行，需要给用户试用时再做最小 Android 封包”的节奏；未实测的体积、性能、内存与浏览器跨域表现不写作既定指标。
- 保持最小权限与简洁架构：开发机构建可使用前端工具链，但不得将 Node.js、Ubuntu/PRoot 或任意 Shell 能力打包分发给终端用户。
- 本地 Markdown tracker 的文件关系约定见[Wayfinder 记录方式](README.md)。

## Decisions so far

- 已决定彻底放弃 DSH 底座（原 `poc-a`、`poc-b`、`poc-c` DSH 验证票据已作废移除），转向自研轻量文游 Harness 与本地存储（见[项目方案](../docs/project-plan.md)）。
- 已决定先跑通 `Vite + React + TypeScript` 本地网页端最小实现（`src/harness/` 纯 TS 核心与 `src/ui/` 解耦，支持 `.docx`/`.md`/`.txt`/粘贴导入、LLM 拆解故事蓝图 + 原文全量锚定兜底），需要打包给用户手机试用时再做最小化 Android 封包，不考虑微信小程序路线。
- 已决定 `POC-01` 优先使用本地 `.env.local` 提供的测试 OpenAI 兼容端点完成通用 Harness 联调（已实测该端点支持 SSE 流式且返回 `reasoning_content`，但不允许浏览器直接跨域，开发期需配 Vite 本地转发代理，且该代理**仅限本地开发调试用于绕过无 CORS 头测试端点，绝不作为线上中转架构**）；DeepSeek 官方 API 联调单独拆出票据跟进。
- **语料样本特征与解析边界（POC-01 前置抽样收口）**：抽样本地剧本语料覆盖短篇（~1.2K–2K 字符）至长篇严苛规则剧本（~9K–14K+ 字符），涵盖乙女攻略、模拟人生、古代宫廷、修仙及校园/娱乐圈等题材；`.docx` 剧本普遍包含 Word 多维表格（`w:tbl`，用于属性矩阵、日程或角色关系表）与分级标题，`.txt` 剧本常见 `【...】` 分区标签、分隔线、围栏伪代码块状态面板、`A/B/C/D` 选项与严格禁忌指令。因此前端解析需完整保留 `.docx` 表格与段落结构（如转为 Markdown 表格），不预设单一内部模板格式。
- **核心领域模型与回溯语义（POC-01 边界收口）**：统一以 `Story` / `Raw Script` / `Story Blueprint` / `Turn Node` / `Branch` / `Plot Summary` / `Three-Zone Context` 建模；每个 `Turn Node` 绑定当时冻结的 `Plot Summary` 快照，在回溯或切换平行 `Branch` 时同步回滚当前摘要至目标父节点的快照，彻底隔离不同分支的剧情记忆；`Three-Zone Context` 按固定锚定区（原始剧本全文 + 轻量格式/不越界约束）+ 滚动剧情摘要区 + 近期对话窗口（按预算裁剪并触发增量摘要压缩）组装。

## Not yet specified

- DeepSeek 官方 API（`api.deepseek.com`）与兼容端点在剧本拆解、文风遵循与浏览器直连 CORS 上的具体差异（见 `POC-03`）。
- 长期运行下不同长度与密度剧本的最佳上下文 Token 预算配比及摘要压缩提示词的体验调优基线（将在 `POC-01` 真实联调后基于实测数据补充）。
- Android 最小封包在真实设备上的安装包体积、低版本 WebView 兼容性、API Key 系统安全存储方式与后台中断恢复表现（见 `POC-02`）。
- 目标玩家的 Android/iOS 设备占比、BYOK 上手流失率、工具付费意愿，以及后续是否及何时补做 iOS 端（见 `RESEARCH-01`）。
- 若从熟人内测走向面向公众公开发行，网页/Android 客户端各自对应的 AI 内容标识、拟人化互动边界与用户自导剧本权属提示落地标准（见 `RESEARCH-01`）。

## Out of scope

- 放弃基于 DSH（DeepSeek Harness、`@deepseek-ai/dsh-sdk-minimal`、DSH Go、DSH Mobile）的移植、裁剪与运行底座。
- 不做微信小程序版本。
- 本轮不做业务后端、用户数据托管、云端模型代理转发、账号体系或需要连接电脑客户端的方案。
- 本轮不启动 iOS 原生适配、完整数值游戏引擎、创作者工作台或剧本交易市场。
