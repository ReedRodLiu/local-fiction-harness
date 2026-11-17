---
kind: wayfinder-ticket
type: task
status: open
parent: map
blocked_by:
  - poc-01-local-web-fiction-harness
blocks: []
---

# POC-03：DeepSeek 官方 API 专项联调与模型差异评估

## Question

在 `POC-01` 基于测试中转/替代模型（千帆 `deepseek-v4.1-flash`）跑通文游 Harness 闭环后，切换至 DeepSeek 官方 API（`api.deepseek.com`，如 `deepseek-chat` / `deepseek-reasoner`）时，剧本拆解稳定性、长上下文演绎一致性、流式行为及浏览器直连 CORS 表现是否存在差异？

## Work

- 使用用户补充的 DeepSeek 官方 API Key，验证 `https://api.deepseek.com` 的 `/chat/completions` 在当前 Harness 下的兼容情况（含 `OPTIONS` 预检、CORS 响应头实测、流式 `content` 与 `reasoning_content` 输出特征）。
- 选取 `docs/文游500篇/` 中不同体裁（乙女攻略、模拟人生、规则严苛的校园/娱乐圈长剧本）的典型样本，对比测试剧本蓝图拆解准确率、伪代码块面板遵守度、长程记忆摘要效果及单局 Token 成本。
- 若发现官方接口与千帆等兼容接口在参数（如 `max_tokens`、`response_format`、系统提示词遵循度）上存在差异，沉淀为统一的适配器规则，不写死单一模型假设。

## Acceptance

- 使用真实 DeepSeek 官方 Key 在本地网页端跑通至少 3 类典型剧本的完整导入与多轮游玩验证。
- 产出 DeepSeek 官方端点 CORS 实测记录、模型差异对比及必要的 Harness 适配调整说明。

## Risks

- 不同模型及不同接入平台对超长 System Prompt、JSON 结构化拆解与 `reasoning_content` 的支持存在差异，可能需要针对模型特性微调拆解提示词与重试策略。
- `api.deepseek.com` 同样可能不支持浏览器直接跨域请求，最终移动端试用仍需依托 `POC-02` 原生网络层。
