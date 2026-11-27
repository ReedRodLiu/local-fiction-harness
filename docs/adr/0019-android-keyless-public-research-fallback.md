---
status: accepted
---

# Android 端免密钥公开网页联网检索兜底策略

> 增补 [ADR 0018](0018-multi-provider-openai-compatible-architecture.md) 第 5 节：在保持 Web 端纯客户端无代理边界的前提下，为 Android 端第三方服务商补充零配置免密钥公开网页检索与正文读取兜底，同时明确区分「默认自动」与「显式关闭」检索语义。

## Decision

1. **端范围与网络前提**：
   - 本能力**仅在 Android 端**（`PlatformRuntime.platform === 'android'`）启用，通过轻量原生 HTTPS 文本抓取桥接绕开浏览器 WebView CORS 限制，严格保持纯客户端无业务后端原则（[ADR 0001](0001-client-only-harness-without-dsh-or-backend.md)）。
   - Web 端因浏览器 CORS 策略限制，未配置外部搜索密钥时继续静默跳过，不在网页端引入公共代理或垂直站点特化逻辑。
   - 原生文本抓取桥接仅允许 `https://` 目标，强制限制响应体积上限（512 KB）与单次请求超时（10s 内），且**绝不携带**用户的模型或搜索 API Key。

2. **通用免密钥检索与读页链路**：
   - **搜索阶段（Search）**：优先请求中国大陆可直连的 `https://cn.bing.com/search?q=<query>` 解析公开结果（标题、URL、摘要）；当超时或无有效结果时，自动回退请求 `https://html.duckduckgo.com/html/?q=<query>`。
   - **读页阶段（Fetch）**：对筛选出的公开结果页优先通过 Jina Reader（`https://r.jina.ai/<url>`，免密钥 20 RPM）获取 Markdown 正文；当 `r.jina.ai` 限流或超时时，回退由 Android 原生直接请求目标公开 URL 并在本地剥离脚本/样式后提取纯文本，交由当前生效模型的 `createBackgroundModelConfig` 归纳。
   - **失败静默与合规边界**：遇到反爬拦截、验证码或网络异常时立即静默返回 `null`（不尝试任何验证码绕过，不阻断正常开书）；检索词严格限定为公开原作名、版本、时间线与角色名，绝不外发私有设定或对话正文。

3. **检索配置语义区分（`auto` vs `none`）**：
   - 区分 `auto`（默认自动）与 `none`（用户显式关闭）：
     - `auto`（新建与默认态）：DeepSeek 官方档案走自带 Search/Fetch；第三方档案在 Android 端自动走本免密钥公开网页兜底，在 Web 端静默跳过；
     - `tavily` / `bocha` / `deepseek_account`：双端均优先使用用户显式配置的搜索源；
     - `none`：用户明确关闭联网查证后，双端均不发起任何检索请求。

## Considered Options

- **接入垂直领域公开 API（如 Bangumi / Wikipedia）**：Bangumi 仅覆盖动漫游戏等垂直品类，Wikipedia 在中国大陆网络环境下直连不稳定，通用性与可用性不足。
- **使用 Jina Search（`s.jina.ai`）**：已取消免密钥访问（无 Key 返回 401），不符合零配置目标。
- **在 Web 端架设云端搜索中转**：违背 ADR-0001 纯客户端无后端架构。

## Consequences

- Android 原生层需新增受限 HTTPS 文本抓取插件与纯 JVM 单元测试；`src/harness/publicResearch.ts` 需新增通用搜索结果与正文提取器及 `auto` 路由分支。
- 向导与设置页需将“默认自动（安卓免费查证）”与“已关闭”区分呈现，并向 Web 端用户说明双端差异。
