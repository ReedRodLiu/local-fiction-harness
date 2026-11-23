# 可回取上下文压缩实验

本目录只包含 V0.3 上下文压缩对照实验的离线夹具、计量实现和受控运行入口。它不改写 Folio 的正式上下文策略，也不把模拟结果当成真实省费结论。

## 当前状态

- 已运行：30 轮三组离线短跑（每组 10 个连续、10 个多分支、10 个嵌套分支行动）。
- 未运行：DeepSeek 官方 V4.1 Flash 回放、完整 300 / 500 / 1,000 轮矩阵、真实质量盲评。
- 原因：当前执行环境没有 `DEEPSEEK_API_KEY`。没有读取应用密钥、用户密钥或其他凭据存储，也没有改用 Go 或其他实验端点。
- 因此两组省费比较均返回 `unavailable / non-official-provider`，界面不得显示金额结论。
- 本提交没有向生产 Settings 接入占位金额或推测性配置。会话级省费展示要等真实 usage 数据路径和官方证据同时就绪后再设计。

## 复跑离线证据

```sh
node --experimental-strip-types experiments/context-compression/run.mjs \
  --now 2026-11-23T00:00:00+08:00 \
  --output experiments/context-compression/evidence/offline-smoke.json
```

输出包含：

- 每组匿名逐请求 token 用量、首段正文等待、分支切换首轮等待、完成率和请求阶段。
- 生成、剧情摘要、回取、重试的独立记录；缺失 usage 的单列为未知，不计作零。
- 固定历史的分支身份、共享祖先回取、重启重开、续写和编辑旧轮后兄弟分支隔离结果。
- 明确标记 `mode: offline-simulated`、`providerRuns: 0` 和 `credentialStatus: not-read`。本次会话另由主代理确认父进程没有 `DEEPSEEK_API_KEY`。

离线记录中的 token 数是按固定文本计算的模拟值，`costUsd` 固定为 `null`，不能用于判断真实缓存命中、延迟或费用。

## 夹具

| 场景 | 原始规模 | 路线数 | 分支深度 |
| --- | ---: | ---: | ---: |
| `continuous` | 300 轮 | 1 | 1 |
| `branching` | 500 轮 | 20 | 2 |
| `nested` | 1,000 轮 | 50 | 3 |

夹具包含原创中文剧本、共享伏笔 `北星七号`、各路线互斥的银印状态，以及同名角色沈砚在不同路线的不同状态。所有用户行动为 1–15 个汉字。生成器固定随机种子后产生稳定拓扑。

## 受控官方运行边界

正式短跑的硬上限定义在 `OFFICIAL_SHORT_RUN_BUDGET`：

| 项目 | 上限 |
| --- | ---: |
| 请求数（含摘要、回取和重试） | 120 |
| 单操作重试 | 1 次 |
| 单请求输入 | 256,000 token |
| 单请求输出 | 512 token |
| 总费用 | US$0.25 |
| 并发 | 1 |

预检按每次请求的固定输入和最大输出，使用缓存全部未命中的最坏价格计算；任何一项越界都会在传输层发出请求前阻止运行。官方短跑还必须使用 `https://api.deepseek.com`、`deepseek-flash`、主生成思考强度 `high`，并显式选择与账单一致的峰谷费率。当前 `--real` 会直接拒绝，因为尚无已授权的官方测试凭据和实际预检记录。

当前固定夹具的离线预检计划为 102 次请求，最坏费用上限 US$0.128881，仍在 US$0.25 总上限内。这个数字按字节数上界和全部缓存未命中计算，是中断用的保守上限，不是预计账单。

## 官方资料核对

核对日期：2026-11-23。资料为当日公开页面：

- [DeepSeek Context Caching](https://api-docs.deepseek.com/guides/kv_cache/)：缓存默认启用，按稳定前缀命中；usage 提供 `prompt_cache_hit_tokens` 与 `prompt_cache_miss_tokens`，缓存不保证 100% 命中。
- [DeepSeek Pricing](https://api-docs.deepseek.com/quick_start/pricing/)：`deepseek-flash` 对应 DeepSeek-V4.1-Flash-1017，1M 上下文、384K 最大输出；非高峰每百万 token 为缓存命中 $0.003、未命中 $0.15、输出 $0.60。

## 上游许可证核对

本次仅参考增量压缩、稳定前缀和按需回取思路，没有复制或打包上游代码。固定版本和文件摘要记录在 `upstream-lock.json`。

- `billion-context` `v0.1.216` 根许可证为 MIT 加“终端用户可见产品必须署名并链接仓库”的附加条款。
- 独立 `acp-kernel` `v0.0.101` 根许可证为 MIT 加同类署名条款。
- `acp-kernel` 声明 Node.js 20+；源码在 tokenizer 与 wire 模块使用 `node:module` / `node:crypto`，不能原样作为 Web/Android 纯客户端包。Billion Context 是 Node.js 代理和 agent 适配层，根包还包含 `mysql2`、`zod` 等运行时依赖。

因此本次候选组采用纯 TypeScript 客户端等效原型。若之后纳入上游代码，必须重新锁定分发包、核对包内 LICENSE 与依赖，并在产品文档或“关于 / 致谢”中列出实际采用的组件和仓库链接。

## 尚未关闭的验收项

1. 使用已授权的官方测试凭据完成 30 轮预检与真实回放，保存逐请求 usage、实际输出、峰谷费率和重试记录。
2. 用真实短跑结果估算完整矩阵费用并设置阶段中断上限。
3. 对共享伏笔、分支互斥事实、短指令执行、角色一致性和剧情连贯性进行盲评。
4. 重复运行关键分支并统计波动；Web/Android 直连兼容性需由正式产品采用路径验证。
