---
status: accepted
---

# 开放 DeepSeek 官方双模型选择与四档思考强度控制

> 部分修订 [ADR 0009](0009-deepseek-official-guided-byok.md)：开放官方模型选择与思考控制，同时保留 DeepSeek 官方地址锁定与零编程门槛引导式 BYOK 原则。
>
> 部分修订：叙事提示词包、官方 `/beta` 请求派生与拒答治理的边界见 [ADR 0016](0016-prompt-pack-and-refusal-governance.md)。

## Decision

- **官方双模型白名单与官方端点锁定**：面向所有用户开放 `deepseek-flash`（日常轻量）与 `deepseek-v4-pro`（旗舰深度）切换，界面采用通俗名称与模型标识副标题呈现；生产环境继续强制锁定 `https://api.deepseek.com`，不暴露 `Base URL` 或自定义模型名输入框（仅保留开发期 `.env.local` 代理覆盖通道）。全局默认模型保持 `deepseek-flash`，旧版缓存值（如 `deepseek-chat`）继续归一化为 `deepseek-flash`。
- **四档思考强度滑块与官方参数映射**：提供 `关闭 / 低 / 高 / 极限` 四档思考强度滑块，全局默认为 `高`（与 `v0.2` 此前未显式传参时的 DeepSeek 服务端默认行为一致）。请求时显式映射到 DeepSeek 官方 Chat Completions 参数：`关闭` 发送 `thinking: { type: "disabled" }` 与 `reasoning_effort: "none"`；`低 / 高 / 极限` 发送 `thinking: { type: "enabled" }` 与对应 `reasoning_effort`（`"low"` / `"high"` / `"max"`）。
- **全局默认 + 按条目可选独立覆盖**：设置页维护全局默认生成偏好；文游（`Story`）、写故事（`DraftWork`，讨论与写正文共用）与角色互动（`LocalCharacter`，角色级覆盖其下多条对话）分别保存可选独立覆盖值。未显式覆盖的条目始终动态跟随全局默认；欢迎页未落盘首轮调整的偏好在自动创建对应条目时一并携带写入，且不反向改写全局默认。
- **输入框内嵌工具行与非打断成本提示**：所有对话与写作主输入区（欢迎页、文游、写故事讨论与稿纸、角色互动）统一采用输入框卡片内双行结构，在文本输入区紧邻下方提供模型切换与四档思考强度滑块；切至 `deepseek-v4-pro` 时仅在控件旁展示一行轻提示说明耗时更长且额度消耗约为 Flash 的 3–4 倍，不弹窗打断。
- **前后台请求分层与节点元数据记录**：面向用户的可见生成流（包含欢迎页首轮同时完成意图分流与开局回复的 `entryRouter`）使用当前生效的生成偏好；纯后台或结构化任务（剧情摘要增量压缩 `compressSummaryWindow` 与 DeepSeek 导入设定提取 `deepseekImport`）固定使用 `deepseek-flash` 并关闭思考，以控制延迟与费用。每次助手回复节点（`TurnNode`）静默记录实际请求的模型与思考强度元数据并纳入脱敏诊断日志，不在回复卡片界面附加标签以保持阅读沉浸感。

## Considered Options

- **仅在「开发者模式」开放模型切换或允许手填任意模型名 / `Base URL`**：增加普通手机用户的认知负担与误配排障成本，违背官方直连与零门槛原则。
- **仅提供全局开关或按创作模式分设、或新建时静态快照默认配置**：前者无法兼顾“日常角色互动用 Flash 省钱快速、长篇精修用 Pro 深思”的同应用混用场景；后者会导致用户修改全局默认后对既有未特调作品不生效。
- **仅做二元思考开关或将控件收纳进设置页/二级弹窗**：失去 `low / high / max` 官方深度梯度的控制力，也让高频切换脱离对话上下文。
- **全部后台请求一律跟随主偏好，或将欢迎页首轮 `entryRouter` 降级为无思考 Flash**：前者会让增量摘要与导入提取慢且烧费；后者会让用户在欢迎页调好的 Pro / 高思考在第一幕被静默忽略。

## Consequences

- `ModelConfig`、`Story`、`DraftWork`、`LocalCharacter`、`TurnNode` 以及 `.folio.json` v3 备份校验需扩展可选的官方模型与思考强度字段，同时保持对已有 v0.2 本地数据与备份的零迁移向后兼容。
- `LlmStreamRequest` 与 `buildOpenAiChatRequest` 需传递 `thinking` 与 `reasoning_effort` 字段；Web 端与 Android 原生 `NativeSse` 均复用同一请求体构造，无需新增原生插件协议字段。
- `entryRouter`、`harness`、`creative`、`DraftPane`、`context`、`deepseekImport` 与诊断模块需明确区分“用户主生成偏好”和“后台固定轻量配置”。
