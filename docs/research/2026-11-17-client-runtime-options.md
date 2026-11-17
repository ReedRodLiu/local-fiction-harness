# 最小文游客户端：技术讨论依据

核查日期：2026-11-17。本记录支持路线讨论，不修改项目方案或 Wayfinder 票据，也不表示已经完成真机验证。

## 已核对的一手资料

- DeepSeek 的 `/chat/completions` 是无状态 API，由调用端组织并回传多轮上下文。因此，客户端可以自行管理剧本、摘要和最近剧情，无需依赖 DSH 才能调用模型。[官方多轮对话文档](https://api-docs.deepseek.com/zh-cn/guides/multi_round_chat/)
- 官方 `chat-demo` 是浏览器直连 API 的静态聊天应用，无需应用后端；提供流式输出、消息分支、历史导入导出和移动布局。其 README 声明 MIT，并提醒第三方依赖有各自许可证。适合先评估可复用范围，不代表应直接照搬所有功能。[仓库及 README](https://github.com/deepseek-ai/chat-demo)
- `chat-demo` 将 Key 放在 localStorage，聊天放在 IndexedDB；这不是系统安全密钥存储。直接打开本地 HTML 还依赖浏览器的文件来源存储能力和服务商的跨域许可。不能把开发代理成功当作发布版浏览器直连成功。[数据存储和运行说明](https://github.com/deepseek-ai/chat-demo#data-and-storage)
- 微信小程序需要预配置通信域名，HTTPS 域名须满足 ICP 备案等要求。进入后台后，未在 5 秒内完成的网络请求会被中断。用户任意填写 API 地址不能直接等同于域名已获允许。[微信网络文档](https://developers.weixin.qq.com/miniprogram/dev/framework/ability/network.html)
- 微信 `wx.request` 支持 `enableChunked`，`RequestTask` 有 `onChunkReceived`。这提供流式接收的基础，但 DeepSeek 的响应、中文分块解析、取消和失败恢复仍需真机验证。[请求接口](https://developers.weixin.qq.com/miniprogram/dev/api/network/request/wx.request.html)
- 小程序普通 storage 上限为同一用户、同一小程序 10 MB；本地缓存文件与本地用户文件合计最多 200 MB。临时文件不保证跨生命周期可用。长期剧情应使用用户文件，并实现用户可操作的备份导出。[存储](https://developers.weixin.qq.com/miniprogram/dev/framework/ability/storage.html)、[文件系统](https://developers.weixin.qq.com/miniprogram/dev/framework/ability/file-system.html)
- Capacitor 提供把 Web 应用放入 Android/iOS 原生容器并访问原生接口的路线。它不是微信小程序的打包器；实际包体、存储、密钥和网络行为须另测。[官方介绍](https://capacitorjs.com/docs)

微信开发者文档在本轮网页抓取工具中打开失败，随后通过直接 HTTP 获取官方页面并解析正文核对以上条款。

## 建议与待验证项

建议先实现客户端文游闭环，暂不将 DSH 嵌入和裁剪作为开工前提。首版限定一个模型服务商、自然语言文本导入、独立故事、流式生成、本地保存恢复、重写及基础剧情摘要。摘要不能保证无损记忆；应保留原始记录，回溯时同步恢复摘要范围。

Web 适合先验证产品交互；轻量 Android 容器适合在浏览器条件不满足或需要设备能力时验证手机体验。开发机使用 Node/npm 构建，不意味着把这些工具分发给手机用户。

微信小程序在技术上可作为独立前端候选。正式路线仍需确认：实际账号可配置 DeepSeek 域名、正式域名校验下直连和流式成功、后台中断处理、导入导出体验，以及主体/类目/审核要求。尚未核对实际小程序后台，也未运行 API 请求或构建安装包。
