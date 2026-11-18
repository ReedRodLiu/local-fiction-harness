# DeepSeek 官方扫码授权登录可行性核查（个人开发者 / 双端纯客户端）

核查日期：2026-11-18。本记录在分支 `explore/deepseek-qr-auth` 完成，用于回答「个人开发者能否在放弃 DSH 底座的前提下，通过 DeepSeek 官方公开渠道实现 Web + Android 双端扫码授权登录获取用户 LLM 调用权限」。

## 结论：当前不可行，终止此需求探索

截至 2026-11-18，**DeepSeek 官方未向第三方/个人开发者开放任何可用于获取用户 LLM 调用额度的 OAuth 2.0 或扫码授权登录接口**；同时受限于本项目「Web + Android 双端可用」与「不接入/仿冒 DSH 第一方私有协议」的约束，**终止该需求探索**，维持现有手动 BYOK（自带 API Key）路线。

## 已核对的一手资料与实测结果

1. **DeepSeek 官方 API 文档全站无第三方 OAuth / 扫码登录文档**
   - 检查 `https://api-docs.deepseek.com/zh-cn/sitemap.xml` 与 `https://api-docs.deepseek.com/sitemap.xml` 全站页面目录，没有任何 OAuth、授权码、设备码（Device Flow）或第三方扫码授权登录接入文档。
   - [首次调用 API](https://api-docs.deepseek.com/zh-cn/) 仅提供在控制台申请 API Key 后通过 `Authorization: Bearer <API Key>`（或 Anthropic 兼容格式的 `x-api-key`）进行鉴权。

2. **DeepSeek 最新官方无后端前端参考实现（2026-11-13）同样采用手动填 Key**
   - 在 [更新日志](https://api-docs.deepseek.com/zh-cn/updates) 与 [DeepSeek 全家桶应用 API 发布（2026-11-13）](https://api-docs.deepseek.com/zh-cn/news/news261113) 中，DeepSeek 官方发布了静态对话演示客户端 [`deepseek-ai/chat-demo`](https://github.com/deepseek-ai/chat-demo)（同样定位为无应用后端、纯浏览器连接 API、支持导入 DeepSeek 导出历史对话）。
   - [构建 Chatbot 指南](https://api-docs.deepseek.com/zh-cn/guides/build_a_chatbot) 与 `chat-demo` 的 `README.md`、`src/services/api/client.ts` 均明确：用户需先在设置页手动填入自己的 API Key（存入 `localStorage`），前端通过 `Authorization: Bearer ${apiKey}` 调用 `GET /models` 校验，并通过 `x-api-key` 调用 `/anthropic/v1/...`，**官方自己的参考 Web 客户端也未使用扫码授权或 OAuth**。

3. **DeepSeek Harness（DSH）的扫码登录属于第一方专用协议，不可作为个人开发者公开接入方案**
   - 核查 [`deepseek-ai/deepseek-harness`](https://github.com/deepseek-ai/deepseek-harness) 源码（`packages/account/deepseek-account/src/index.ts`、`src/protocol.ts`、`README.zh.md` 及 `.agents/notes/implemented/architecture/2026-09-14-deepseek-account-login.zh.md`）：
     - DSH 使用的是 `platform.deepseek.com` 上的专属第一方接口 `/auth-api/v0/dsh/auth_init`、`/dsh/authorize` 与 `/auth-api/v0/dsh/auth_exchange`，没有第三方应用 `client_id` 注册流程，签发的也不是标准 API Key，而是 `x-dsh-auth-token`（扣费走用户的开放平台充值钱包 `normal_wallets` 与赠金 `bonus_wallets`）。
     - 协议硬性校验回调地址仅允许本机回环 HTTP（`http://localhost:<port>/oauth/callback`、`127.0.0.1` 或 `[::1]` 显式端口），不支持非本机域名，无法在纯 Web 端部署场景下运行。
   - 本项目已在 [ADR-0001](../adr/0001-client-only-harness-without-dsh-or-backend.md) 放弃 DSH 底座，且不仿冒未对第三方公开的第一方私有协议。

4. **标准 API Key 直连能力确认（作为现有 BYOK 路线基线）**
   - 实测 `OPTIONS https://api.deepseek.com/models`（携带 `Origin: http://localhost:5173`、`Access-Control-Request-Method: GET`）返回 `HTTP/2 200`，包含 `access-control-allow-origin: http://localhost:5173` 与 `access-control-allow-credentials: true`，说明 DeepSeek 官方 API 的标准 Bearer Key 调用已支持浏览器 CORS 直连，可继续支撑 Web + Android 双端 BYOK。

## 后续处置

- 暂停「DeepSeek 扫码授权登录」方向，不在当前阶段开展原型或实现。
- 若后续需要降低玩家上手成本，仅可在不改变官方协议的前提下优化现有 BYOK 填写引导（或由 [wayfinder/map.md](../../wayfinder/map.md) 既有 `#5` 调研继续验证玩家对手动配置 API Key 的接受度）。
