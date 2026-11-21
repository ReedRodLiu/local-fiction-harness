---
status: accepted
---

# 对话内非阻塞增量提案协议、轻量 Markdown 渲染与全模式可靠性底盘

> 演进 [ADR 0011](0011-three-mode-markdown-harness.md)，并与 [ADR 0012](0012-natural-language-single-entry-and-single-markdown-setting.md) 配套。依据 [V0.2-RESEARCH-01](https://github.com/ReedRodLiu/local-fiction-harness/issues/81) 与 [V0.2-DECISION-03](https://github.com/ReedRodLiu/local-fiction-harness/issues/84)。

## Decision

- **头体分离增量提案协议（`lfh-proposal`）与对话内非阻塞确认卡片**：废除容易因换行/引号转义或尾随文字静默失败的单行 JSON `lfh-change` 协议，改用「`key: value` 元数据头 + `---` + 原生未转义 Markdown 正文」的 `lfh-proposal` 围栏（解析层向下兼容 `lfh-change`）。支持 `summary` 人话变更摘要、`patch`（`SEARCH/REPLACE`）/ `append` / `section` 增量编辑优先（`full` 兜底）、单轮多提案，以及格式微瑕或流式截断时降级为可手动核对卡片（绝不静默丢弃）。提案状态持久化于 `TurnNode.proposals`（`pending | applied | dismissed | reverted | needs_review`），不阻塞对话阅读，冲突时优先自动重算或并排恢复且绝不覆盖用户手写草稿，确认保存后保留完整版本链并支持一键撤销。
- **轻量客户端 Markdown 渲染与中文可读 Diff**：采用 `marked@18.2.1`（仅使用 `marked.lexer`）配合纯 React Token 组件树与严格 URL 协议白名单（`https:` / `http:` / `mailto:`）实现全模式 Markdown 渲染，禁止使用 `dangerouslySetInnerHTML`，避免引入 `DOMPurify`；约定仅显式 ` ```lfh-hud ` 围栏（及文游模式旧无标签键值块向后兼容）渲染为状态面板，彻底解除写故事与角色互动普通代码块的劫持。变更对比采用零依赖纯 TypeScript 两级 Myers Hunk Diff（变更前后各保留 2 行上下文，句内优先使用 `Intl.Segmenter('zh', { granularity: 'word' })` 并对旧 Android WebView 降级为码点级）。
- **全模式统一分支树、后台无感压缩与编辑保护**：`写故事` 聊天记录、`角色互动` 与 `文游` 统一共享 `TurnNode` 分支树与同一套后台滚动剧情摘要压缩策略；全面移除顶栏「补算摘要中…」状态、手动补算摘要与红点提示，压缩失败或中断静默沿用上次成功覆盖并温和截断近期窗口保底。`写故事` 正文采用 400ms 防抖保存 + 失焦/隐藏刷盘 + 串行写入队列 + 可撤销栈（正文采纳建议与设定保存均可一键撤销）。`AppErrorBoundary` 仅对不可恢复的渲染崩溃接管全屏，全局异步异常降级为可关闭轻提示且不再自动弹出 JSON 诊断包；三区指标、Token 估算、版本 ID 与版本号统一下沉至「设置 → 高级排障」。
- **统一全量备份（`.folio.json` v3）与 V0.1 → V0.2 静默迁移**：引入覆盖文游、写故事、角色互动、「我的记忆」与显示偏好（严禁包含 API Key）的单文件 `.folio.json` v3 备份格式，同时向下兼容导入旧版 `.lfh.json` 并默认以非破坏副本策略合入。应用启动与备份导入时执行幂等静默迁移：将旧 `StoryBlueprint`/`rawScript` 并入单一 Markdown「故事设定」，将写故事线性 `discussion` 升级为 `TurnNode` 树，并保留旧角色对话内容而忽略已退场的二元 `kind` 开关。

## Considered Options

- **启用 DeepSeek Tool Calling（`tools`）或 JSON Mode 替代文本流协议**：Thinking Mode 下 `tools` 要求客户端逐轮原样回传历史 `reasoning_content` 否则返回 400，且与单轮流式正文/分支回溯叠加复杂度高；JSON Mode 会强制整条回复为单一 JSON 且解析失败时可能返回空格填充文本。
- **引入 `markdown-it` / `react-markdown` + `DOMPurify` + `diff`（jsdiff）**：运行时包体显著增大，仍需额外编写中文分词兼容、Hunk 折叠与 `HudPanel` 隔离逻辑，不如 `marked.lexer` + 自研 ~120 行两级 Diff 轻盈可控。
- **保留阻塞式 `DocumentDialog` 或按模式各自维护独立备份/摘要逻辑**：打断创作心流、容易在取消时丢失提案，且导致写故事和角色互动在长对话后突破上下文预算、数据无法整机迁移。

## Consequences

- `src/harness/` 需新增 `markdownDiff.ts` 与升级版提案解析/合并模块，并统一三模式上下文压缩与 `.folio.json` v3 备份校验。
- `GLOSSARY.md` 与 `ADR-0012` 定义的「当前设定 / 我的记忆 / 分支笔记 / 提案确认卡片」获得完整底层状态机、迁移路径与可撤销安全网支撑。
- 旧版 V0.1 本地存储与 `.lfh.json` 导出文件可无损平滑升级到 Folio V0.2，无需用户手工重新整理或重建作品。
