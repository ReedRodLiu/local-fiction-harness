# 可回取上下文压缩：离线实验基础与官方回放缺口

## 结论

Folio 当前可以复跑 300 / 500 / 1,000 轮的固定原创夹具，并验证当前路线及共享祖先的回取、重启、续写和编辑旧轮后的分支隔离。它也已经具备 DeepSeek 缓存命中、未命中、输出、摘要、回取和重试的统一计量口径。

本次不能判断真实省费。执行环境没有已授权的官方 DeepSeek 测试凭据，也没有发送 funded request。离线报告中的 token 数是模拟值，费用字段保持未知，不能据此显示“预计省费”。

本提交没有修改生产 Settings。会话级省费展示需要真实请求 usage 的持久化来源；在官方证据和该数据路径就绪前，只保留实验内部的估值契约与结果结构。

## 已实现边界

- A 组固定历史回放会沿目标叶节点发送全部有效祖先；B 组调用 Folio v0.3.0 现有的三区上下文；C 组使用固定设定、当前路线最近轮次和按需回取。
- 回取只检索目标叶节点的活动路径。兄弟路线独有事实不会进入请求，重启后的 JSON 往返、在当前路线续写和从旧轮创建编辑兄弟分支均已离线验证。
- 逐请求记录区分 `generation`、`summary`、`retrieval`、`retry`，使用最终 SSE usage 中的缓存命中/未命中输入和 completion token。缺少 usage 的请求标为不完整，不用零替代。
- 省费比较只在双方均为完整 `deepseek-official` 数据、模型相同、峰谷费率相同时可用。高缓存命中导致候选组更贵时，结果保留负数表示费用上升。
- 受控短跑在传输前检查 120 请求、单操作 1 次重试、单请求 256K 输入、512 输出、US$0.25 总额和并发 1。未知凭据或任一预算越界时不得调用官方端点。
- 固定夹具的当前预检计划包含 102 次请求，最坏费用上限 US$0.128881。该上限采用字节级输入上界和全部缓存未命中价格，只用于中断控制，不是账单预测。

## 离线证据

复跑命令见 `experiments/context-compression/README.md`。固定 30 轮/组的三组短跑结果在 `experiments/context-compression/evidence/offline-smoke.json`：

- A、B、C 三组各覆盖 30 个生成回合。
- B 记录 40 条请求（含 9 个模拟摘要与 1 个模拟重试），C 记录 61 条请求（含 30 次本地回取记录）。
- 90 个生成请求均未包含兄弟路线独有事实，0 次串支。
- 重启重开、继续写入和编辑旧轮后兄弟分支隔离均通过。
- 两组费用比较均为 `unavailable / non-official-provider`。

这些数字只验证记录与隔离逻辑，不用于质量、延迟或费用结论。

## 官方资料

- [DeepSeek Context Caching](https://api-docs.deepseek.com/guides/kv_cache/) 说明缓存默认开启、按稳定前缀命中，并返回 `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`；缓存是 best-effort，不保证 100% 命中。
- [DeepSeek Pricing](https://api-docs.deepseek.com/quick_start/pricing/) 在 2026-11-23 标明 `deepseek-flash` 为 DeepSeek-V4.1-Flash-1017，上下文 1M、最大输出 384K；非高峰缓存命中输入、未命中输入和输出分别为每百万 token $0.003、$0.15、$0.60。

## 上游评估与许可证

`billion-context` `v0.1.216`（`6a641f3`）与独立 `acp-kernel` `v0.0.101`（`4d38906`）的根许可证都是 MIT 加终端用户可见产品的署名与仓库链接条款。固定版本、许可证摘要和包信息见 `experiments/context-compression/upstream-lock.json`。

本次没有复制或打包上游代码。`acp-kernel` 的核心设计可借鉴，但其包面向 Node.js 20+，tokenizer 和 wire 模块直接使用 Node 内置模块；`billion-context` 是 Node 代理和 agent 适配层，包含数据库等运行时依赖。二者不能作为当前 Web/Android 纯客户端依赖直接采用，本次因此实现纯 TypeScript 的实验等效原型。

## 未完成的正式验收

正式短跑、完整矩阵费用估算、真实质量盲评、重复运行波动和 Web/Android 兼容性验证仍待执行。完成这些项目之前，不应在产品中展示节省金额， ticket #121 也不满足正式验收。
