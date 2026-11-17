---
kind: wayfinder-ticket
type: prototype
status: open
parent: map
blocked_by: []
blocks:
  - poc-02-android-minimal-package
  - poc-03-deepseek-official-integration
---

# POC-01：自研轻量文游 Harness 能否在本地网页端跑通最小闭环？

## Question

在不引入 DSH 运行时和项目方业务后端的前提下，能否用 Vite + React + TypeScript 实现纯客户端文游 Harness（`src/harness/` 与 `src/ui/` 解耦）在本地网页端跑通最小闭环，覆盖 `.docx`/`.md`/`.txt` 自由剧本导入、LLM 蓝图拆解、原文兜底锚定、流式演绎、本地持久化与分支回溯？

## Work

- 搭建 `Vite + React + TypeScript` 纯前端工程，保持 `src/harness/` 为无 DOM、无 Node 运行时依赖的纯 TS 核心模块，便于后续复用到 Android 容器。
- 实现自由剧本导入：支持粘贴文本及纯前端解析 `.docx`、`.md`、`.txt`（不限制内部文游排版格式）；调用 LLM 自动拆解为结构化“故事蓝图”（标题、背景规则、主角与 NPC 档案、禁忌与开场提示）供用户查看确认，同时在对话 System Prompt 中**完整保留原始剧本全文作为兜底锚定**。
- 实现三区上下文治理与分支状态树：固定锚定区（原文 + 轻量规则）+ 滚动剧情摘要区 + 近期对话窗口；在 IndexedDB 中持久化故事工程、消息树与节点摘要快照，支持撤回重写与平行分支，回溯时同步回滚对应范围的剧情摘要。
- 实现可配置 OpenAI-compatible SSE 流式客户端：兼容 `delta.content` 与 `delta.reasoning_content` 分离渲染/解析，提供 API Key 的 `localStorage` 持久化与“仅当前会话内存保存”开关及网页原型风险提示。
- 验证联网与 CORS：由于已实测测试端点 `https://qianfan.baidubce.com/v2/tokenplan/personal/chat/completions` 在 `OPTIONS` 预检返回 404 且无 `Access-Control-Allow-Origin` 响应头，在 Vite 开发服务器配置本地测试转发代理（仅用于开发调试，不作为线上中转架构），并用 `.env.local` 中的测试模型 `deepseek-v4.1-flash` 跑通真实端到端联调。
- 测试验收：用 Vitest 覆盖 Harness 核心逻辑与 Mock SSE，用已安装的 `Microsoft Edge` 或本机缓存的 Playwright Chromium（不下载新浏览器二进制）执行关键交互与刷新恢复的 E2E 验证。

## Acceptance

- 本地网页原型可独立完成“上传 `.docx`/`.md`/`.txt` 剧本 → LLM 拆解故事蓝图 → 多轮流式生成（正确处理 `reasoning_content` 与伪代码块/选项排版）→ 刷新浏览器后 IndexedDB 恢复 → 撤回重写/切分支并同步回滚摘要”。
- 核心 Harness 代码完全位于 `src/harness/` 且通过 Vitest 自动化测试；关键浏览器交互通过本地 E2E 测试。
- 实测记录已导入剧本样本（如 `docs/文游500篇/` 抽样格式）在结构化拆解与多轮演绎中的表现、Token 消耗规律与限制。
- 源码与 Git 提交中不包含任何 DSH 运行时、真实 API Key 或外部语料文件。

## Risks

- 实际模型端点大多不开放浏览器跨域（已实测千帆测试端点无 CORS 头），开发期本地代理有效不等于公网静态页能直接跨域请求，跨端试用仍需依赖后续 `POC-02` Android 原生网络层。
- 浏览器 `localStorage` / IndexedDB 并非系统级安全密钥存储，且清理浏览器站点数据会导致存档丢失，需提供本地导出/导入 JSON 备份。
- 类似 `deepseek-v4.1-flash` 的推理模型在 SSE 中会先输出 `reasoning_content`，若 `max_tokens` 预算或 JSON 抽取容错不足，可能影响蓝图拆解或流式正文展示。
