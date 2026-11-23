# 可回取上下文压缩：离线实验基础与官方回放缺口

## 结论

Folio 当前可以复跑 300 / 500 / 1,000 轮的固定原创夹具，并验证当前路线及共享祖先的回取、`A → B → A` / `A → B → C` 路线切换、重启、续写和真实 Harness 旧轮编辑入口的分支隔离。它也已经具备 DeepSeek 缓存命中、未命中、输出、摘要、回取和重试的统一计量口径。

本次不能判断真实省费。执行环境没有已授权的官方 DeepSeek 测试凭据，也没有发送 funded request。离线报告中的 token 数是模拟值，费用字段保持未知，不能据此显示“预计省费”。

本提交没有修改生产 Settings。会话级省费展示需要真实请求 usage 的持久化来源；在官方证据和该数据路径就绪前，只保留实验内部的估值契约、`unavailable` / `available` 展示设计和结果结构。

## 已实现边界

- A 组固定历史回放逐轮以目标行动的前一回复作为父节点，生成的上下文随回合增长；不会把原始路线最终叶节点重复作为每轮历史，也不会把行动本身再追加一次。B 组调用 Folio v0.3.0 的三区上下文，并用生产代码的 `getUncoveredNodes`、`selectNodesToSummarize` 和滚动批次推进摘要覆盖指针；每次只覆盖已经过确定性离线折叠的连续节点。C 组使用固定设定、当前路线最近轮次和按需回取。
- 回取凭据仍来自 13 组共享探针。夹具为同名角色沈砚生成 50 组互斥的衣物、伤痕和随身物状态；提示只使用 `沈砚 衣物` 等短线索，不含答案。测试检查本路线应出现的事实和兄弟路线禁止出现的事实。纯 Harness 的 `switchBranch` 已执行 `A → B → A` 与 `A → B → C`，并记录路径节点数、上下文字符数、模拟 token 数和跨路线事实数。重启后的 JSON 往返、在当前路线续写，以及 `FictionHarness.editAndBranch` 从旧轮流创建兄弟分支也已离线验证；旧轮回复来自进程内假 transport，`providerCalls` 为 0。
- 全历史、滚动摘要和按需回取的 retry 分别重新调用本组上下文策略。报告保存策略名称、消息数、输入字符数、可见正文 UTF-16 字符数和只读内容指纹，不保存请求正文，测试据此确认三组 retry 载荷不同，且各自与该组同一逻辑回合的生成上下文一致。
- 逐请求记录区分 `generation`、`summary`、`retrieval`、`retry`，并显式标记 `outbound-http` 或 `local`。生成、摘要和重试的出站请求使用最终 SSE usage 中的缓存命中/未命中输入和 completion token；本地回取没有上游 usage，记录明确使用 `null`，既不要求 provider usage，也不产生费用。缺少 usage 的仅限出站请求标为不完整，不用零替代。
- 官方 SSE 返回可选的 `completion_tokens_details.reasoning_tokens` 时，`LlmUsage` 和实验 usage 契约保留该元数据。`completion_tokens` 本身已经包含思考 token，费用和总 completion token 不再额外相加 reasoning token。
- 省费比较只在双方均为完整 `deepseek-official` 数据、模型相同、峰谷费率相同且完成的逻辑回合 ID 完全一致时可用。任一侧为空、声明回合少于完成 ID、双方回合范围错位或仅部分重叠时均不可用。当前不自动重算共同前缀。成功的生成重试按同一逻辑回合只计一次，但每次请求的 usage 仍全部计费。高缓存命中导致候选组更贵时，结果保留负数表示费用上升。
- 受控短跑在传输前检查 128 次出站 HTTP 请求、单操作 1 次重试、单请求 256K 输入、512 输出、US$0.25 总额和精确并发 1。请求/token 数量必须是非负安全整数，retry attempt 必须落在允许范围，费用和费率必须是有限非负数；`NaN`、负数、小数计数、无效 attempt、零并发或更大并发都会阻止运行。本地回取记录不计入出站请求上限。未知凭据或任一预算越界时不得调用官方端点。
- 固定夹具的当前预检计划包含 90 次生成、30 次确定性模拟摘要和 3 次重试，共 123 次出站 HTTP 请求，另有 30 条本地回取记录，最坏出站费用上限 US$0.17205945。该上限采用字节级输入上界和全部缓存未命中价格，只用于中断控制，不是账单预测。

## 离线证据

复跑命令见 `experiments/context-compression/README.md`。固定 30 轮/组的三组短跑结果在 `experiments/context-compression/evidence/offline-smoke.json`：

- A、B、C 三组各覆盖相同的 30 个逻辑生成回合，并分别保存唯一完成回合 ID。
- 三组共有 123 条出站 HTTP 记录。B 的记录包含 30 个明确标记 `deterministic-offline` 的模拟摘要与 1 个成功重试，重试不增加完成回合数，摘要覆盖违规为 0；C 另有 30 条 `local` 回取记录，`usage` 均为 `null`，不计入 128 次出站上限。
- 90 个生成、30 个背景摘要和 3 个 retry 输入都带只读内容指纹并检查兄弟路线独有事实，0 次串支。
- `A → B → A` 返回的 A 路径与原路径完全一致，`A → B → C` 正确落到 C；两条路径的每步跨路线事实数均为 0。
- 重启重开、继续写入和真实 `FictionHarness.editAndBranch` 旧轮编辑后的兄弟分支隔离均通过。
- 两组费用比较均为 `unavailable / non-official-provider`。

这些数字只验证记录与隔离逻辑，不用于质量或费用结论。离线延迟是固定算法生成的模拟值，不来自 provider。延迟 p50/p95 使用 nearest-rank，只取 `logicalTurnId` 已完成的生成/retry 样本；同一回合以最后成功尝试的首段可见正文等待为准，失败尝试、摘要和本地回取不进入分位数。

## 会话级省费展示设计

这一设计只定义实验与后续产品的结果含义，未修改实时 Settings，也没有添加占位金额。

- `unavailable`：显示“本会话暂无可比省费”和具体原因，例如非官方数据、usage 不完整、模型或费率不同、回合范围不一致、样本不足；可显示比较覆盖的逻辑回合数，禁止显示 `0`、单边金额、估算代替值或“预计省费”。
- `available`：显示对照策略、本会话策略、逻辑回合数、官方模型、峰谷费率、双方实测费用与节省额；候选更贵时写“费用增加”并显示正数增幅。只展示两组完成回合 ID 完全一致、usage 完整且费用来源可追溯的单会话结果。

正式实现等待真实官方 usage 持久化。在此之前不在产品 Settings 中放置无数据来源的占位卡片或推测数值。

## 官方资料

- [DeepSeek Context Caching](https://api-docs.deepseek.com/guides/kv_cache/) 说明缓存默认开启、按稳定前缀命中，并返回 `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`；缓存是 best-effort，不保证 100% 命中。
- [DeepSeek Pricing](https://api-docs.deepseek.com/quick_start/pricing/) 在 2026-11-23 标明 `deepseek-flash` 为 DeepSeek-V4.1-Flash-1017，上下文 1M、最大输出 384K；非高峰缓存命中输入、未命中输入和输出分别为每百万 token $0.003、$0.15、$0.60。

## 上游评估与许可证

`billion-context` `v0.1.216`（`6a641f3`）与独立 `acp-kernel` `v0.0.101`（`4d38906`）的根许可证都是 MIT 加终端用户可见产品的署名与仓库链接条款。固定版本、许可证摘要和包信息见 `experiments/context-compression/upstream-lock.json`。

本次没有复制或打包上游代码。`acp-kernel` 的核心设计可借鉴，但其包面向 Node.js 20+，tokenizer 和 wire 模块直接使用 Node 内置模块；`billion-context` 是 Node 代理和 agent 适配层，包含数据库等运行时依赖。二者不能作为当前 Web/Android 纯客户端依赖直接采用，本次因此实现纯 TypeScript 的实验等效原型。

## 未完成的正式验收

正式短跑、完整矩阵费用估算、真实质量盲评、重复运行波动和 Web/Android 兼容性验证仍待执行。完成这些项目之前，不应在产品中展示节省金额， ticket #121 也不满足正式验收。
