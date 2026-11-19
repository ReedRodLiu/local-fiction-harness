# 开新书前搜索原作设定与指定剧情起点

核查日期为 2026-11-20，代码基线为 `509dd06`。票据 #55 只研究「开新书」时从选定作品和剧情点往后写之前的一次公开资料搜索。从当前文游分支继续写作是另一条产品路径。

## 首版建议

优先验证 **DeepSeek Chat Completions 的服务端联网工具**。文档明确支持项目已选的 `deepseek-flash` 和用户已有的 DeepSeek API Key。先用一次独立请求验证能否带回足够的同版本证据，在用户确认版本、剧情起点和依据后再开写。若首版要求每次点击都确实发出搜索、按官网域名筛选或控制抓取次数，应选 **DeepSeek 独立 Search / Fetch**。两者均可直连同一官方 API，无需项目方业务后端。 [联网工具](https://api-docs.deepseek.com/zh-cn/guides/web_tools/) · [网页搜索与抓取](https://api-docs.deepseek.com/zh-cn/guides/search/) · [ADR-0001 纯客户端](../adr/0001-client-only-harness-without-dsh-or-backend.md) · [ADR-0009 官方 BYOK](../adr/0009-deepseek-official-guided-byok.md)

## 两条检索路径

| 路径 | 官方能力 | 首版取舍 |
| --- | --- | --- |
| Chat Completions 的联网工具 | DeepSeek 在 2026-11-13 把网页/App 搜索开放到 API。用现有 `POST /chat/completions` 和 `deepseek-flash`，在 `tools` 声明 `deepseek_web_search`，需要读用户提供的公开链接时可声明 `deepseek_read_url`。关闭思考时做普通联网搜索，开启时可多次搜索并读页。模型决定是否调用工具，指定工具名称来强制调用会报错。服务端联网工具当前只计模型 Token。 | 少一套检索调用，适合先用样例验证。一次产品操作可能触发零次或多次搜索；必须依据工具结果确认是否实际联网，且核对引用是否支撑对应结论。该模式仅接受文本 `response_format`。来源元数据可单独解析，正文里的 URL 不能代替它。 [发布公告](https://api-docs.deepseek.com/zh-cn/news/news261113/) · [Chat Completions 联网契约](https://api-docs.deepseek.com/zh-cn/guides/web_tools/#chat-completions-api) · [计费](https://api-docs.deepseek.com/zh-cn/guides/search/#billing) |
| 独立 Search / Fetch | 用同一 Bearer Key 调用 `POST /v1/tools/search`，返回标题、URL、摘要等。可通过 `site:`、精确短语等收窄检索，`need_content` 可请求正文，但正文仍可能为空。对选中的公开 URL 可调用 `POST /v1/tools/fetch`，返回标题和 Markdown 正文。中文指南当前分别按每千次有结果的成功请求 5 元计费。 | 客户端可限制查询和读取数量，便于审核搜索范围。首版可先搜一次，只在证据需要且结果已选定时读少量原页。需要新增短 JSON 请求及证据归纳。模型归纳若启用，再按普通模型调用计费。搜索摘要和排序只用于选页，正文缺失或站点拒绝访问时保留待核状态。 [Search 接口](https://api-docs.deepseek.com/zh-cn/api/search/) · [Fetch 接口](https://api-docs.deepseek.com/zh-cn/api/fetch/) · [计费与错误](https://api-docs.deepseek.com/zh-cn/guides/search/) |

官方网页/App 的联网按钮属于第一方产品。API 能力以公开 API 契约为准。DeepSeek 官方静态前端 Demo 也使用用户自填 Key，但它走 Anthropic 兼容的 Messages 协议，能作为浏览器侧实现参考。本项目可在现用的 Chat Completions 协议上接入相应扩展字段。Responses API 另有面向 `deepseek-v4-pro` 的 `web_search`，本票讨论的是 Flash 的 `deepseek_web_search`。 [官方 Demo 源码](https://github.com/deepseek-ai/chat-demo/blob/main/src/services/api/client.ts) · [Responses API 工具说明](https://api-docs.deepseek.com/guides/responses_api/)

如需独立于 DeepSeek 的全网搜索供应商，Brave Search API 有公开接口，但需要用户另备 `X-Subscription-Token`，其文档也提醒避免把密钥暴露在客户端代码中。本次只核查鉴权文档，首版没有引入它的必要。找不到证据时，可让用户在外部浏览器核对公开页面，并在本地补充其确认的前提。 [Brave 官方鉴权文档](https://api-dashboard.search.brave.com/documentation/guides/authentication)

## 现有代码与双端直连

- **仓库现状。** 生产配置固定为 `https://api.deepseek.com` 与 `deepseek-flash`。写作请求发送 `model`、`messages` 和 `stream: true`。现有传输只整理正文增量、思考增量及结束原因，平台接口没有检索或通用 JSON 请求方法。向导通过 `GET /models` 验 Key，这一步只证明模型列表接口可访问。 [模型配置](../../src/harness/keyConfig.ts) · [密钥校验](../../src/harness/keyValidation.ts) · [请求及 SSE 解析](../../src/harness/sse.ts) · [平台接口](../../src/harness/types.ts)
- **服务端联网的接入点。** 非流式结果的 `message.annotations` 包含正文范围和引用 URL，`message.server_tool_calls` 包含工具记录以及来源或页面信息。流式时，中间事件在 `choice.server_tool_event`，完整引用与工具记录在终止块的 `delta`。可沿用现有原生传送字节的方式，在开书请求中单独解析这些扩展字段。若选非流式 JSON，可直接解析完整对象，但双端要有返回 JSON 的入口。两种方式都需处理无引用、末块缺失和响应体报错。官方指南说明，HTTP 200 也可能含生成失败。 [联网契约与流式字段](https://api-docs.deepseek.com/zh-cn/guides/web_tools/#chat-completions-api) · [原生 SSE 适配器](../../src/platform/capacitorSseTransport.ts)
- **Web。** 正式版使用浏览器 `fetch`。跨域 Bearer + JSON POST 要通过 CORS 预检，实际响应也要允许该来源。Vite 代理仅用于开发。也可以在外部浏览器打开公开链接让用户核对，但这一步不会把目标网页正文交给本应用，任意官网的脚本跨域读取仍取决于各站的响应。 [Web Runtime](../../src/platform/webRuntime.ts) · [Vite 配置](../../vite.config.ts) · [Fetch 标准的 CORS 协议](https://fetch.spec.whatwg.org/#http-cors-protocol)
- **Android。** 当前模型请求经原生 `HttpURLConnection`，其请求不受 WebView CORS 约束。WebView 里的 `fetch` 仍受约束，当前密钥向导也直接调用全局 `fetch`。独立 Search / Fetch 或非流式开书请求如需走原生，可评估显式调用 `CapacitorHttp.post` 或增加限定目标和响应大小的原生 JSON 请求。仓库关闭了 `CapacitorHttp` 的全局补丁，现有 SSE 适配器和 ZIP 下载入口各有自己的契约。 [ADR-0004 平台接缝](../adr/0004-capacitor-monorepo-and-platform-runtime-seam.md) · [ADR-0005 原生 SSE](../adr/0005-native-chunked-sse-bridge-over-capacitor-http.md) · [原生网络实现](../../android/app/src/main/java/io/localfiction/harness/SseStreamClient.java) · [Capacitor 配置](../../capacitor.config.ts) · [Capacitor v8 HTTP 文档](https://capacitorjs.com/docs/apis/http) · [校验向导](../../src/ui/DeepSeekSetupWizard.tsx)

本次对 `api.deepseek.com` 的 `/chat/completions`、`/v1/tools/search`、`/v1/tools/fetch` 做了无密钥、无请求体的 `OPTIONS` 预检。三个路径均返回 HTTP/2 200，允许示例来源 `https://example.org`、方法 `POST` 及显式请求头 `authorization,content-type`。可用同一请求模板复核，替换末尾路径即可。

```sh
curl -sS -D - -o /dev/null -X OPTIONS https://api.deepseek.com/chat/completions \
  -H 'Origin: https://example.org' \
  -H 'Access-Control-Request-Method: POST' \
  -H 'Access-Control-Request-Headers: authorization,content-type'
```

## 凭据与外发数据

- 两条 DeepSeek 路径都沿用用户自带的开放平台 Key。当前正式配置会持久化 Key，Web 用 `localStorage`，Android 用 Keystore 加密后存储。两端底层存储支持仅内存模式，但首版正式配置归一化将该选项设为关闭。DeepSeek 开放平台协议第 2.4 节提醒避免把 Key 暴露在客户端代码中，官方 Demo 则展示了运行时用户自填。客户端方案应避免把项目方 Key 打包分发，用户的 Key 仅发送到官方 API 的鉴权头，不能出现在查询、引用 URL、日志或导出中。 [Key 存储](../../src/harness/keyConfig.ts) · [Android Vault](../../android/app/src/main/java/io/localfiction/harness/NativeVaultPlugin.java) · [诊断边界](../adr/0008-zero-content-diagnostics-and-turn-context-integrity.md) · [开放平台协议](https://cdn.deepseek.com/policies/zh-CN/deepseek-open-platform-terms-of-service.html) · [官方 Demo 数据说明](https://github.com/deepseek-ai/chat-demo#data-and-storage)
- 建议在点击搜索前让用户看到待发送的作品名、版本、公开剧情节点或公开 URL。联网工具路线会把这条检索消息送给 DeepSeek，并由服务商据此生成搜索词。独立接口只发短查询与选定 URL，省略可选的 `ori_question`（原始问题）和 `localization`（定位用 IP 字段）。私有剧本、对话历史、个人信息和作者拟新增的情节在检索期间留在本地。若后面调用模型归纳，只送必要的来源证据。开放平台隐私政策说明会处理 API 输入输出，并涉及搜索关键词共享以及输入输出可能用于训练或改进的条件。 [Search 请求字段](https://api-docs.deepseek.com/zh-cn/api/search/) · [开放平台隐私政策第五至七节](https://cdn.deepseek.com/policies/zh-CN/deepseek-open-platform-privacy-policy.html)

## 公开资料样例：《钢之炼金术师》终集之后

样例输入为「从《钢之炼金术师》第 51 集结局后继续，想写兄弟提前找到重逢的方法」。用剧名、集数和官网域名查找，并打开对应的作品介绍、分集页及后续作品介绍。以下为人工查证，未以 DeepSeek API 跑该样例。

| 核对项 | 可给作者的结果 |
| --- | --- |
| 版本与起点 | **2003 版**全 51 集，第 51 集《ミュンヘン1921》是终集。**2009 版**第 51 集标题是《不死の軍団》，终集是第 64 集。只写「第 51 集结局」会命中两个不同剧情点。建议请作者确认版本和集末，不能仅凭命中率选版本。 [2003 版官方收录目录](https://online.aniplex.co.jp/itemTqLEXigu.html) · [2009 版第 51 集](https://www.hagaren.jp/about/story05.html) · [2009 版终集公告](https://www.aniplex.co.jp/lineup/hagarenfa/news/detail/?id=10328) |
| 2003 版可核对的事实 | 第 51 集官网梗概记载，恩维为了见霍恩海姆进入门中，爱德为召回重要之物再次合掌。2005 年剧场版官方介绍另可证实其开场背景为兄弟分隔两界、爱德在 1923 年的慕尼黑。后续电影背景要标明时间及出处，请作者选择沿用电影背景还是从电视终集分歧。 [第 51 集梗概](https://www.hagaren.jp/story/51.html) · [剧场版官方介绍](https://www.aniplex.co.jp/lineup/hagaren-movie-shamballa/) |
| 缺失或冲突 | 第 51 集公开梗概止于爱德的动作，未交代两人紧接着的确切位置和状态。标题的「1921」和剧场版介绍的「1923」对应不同剧情时间，可分别引用。2009 版终集公开摘要只说明旅程结束，单凭该页也不能确认结尾各人去向。若同版本的来源对关键情节有互相矛盾的说法，展示各自出处和差异，等用户指定依据。 [2003 版终集梗概](https://www.hagaren.jp/story/51.html) · [剧场版官方介绍](https://www.aniplex.co.jp/lineup/hagaren-movie-shamballa/) · [2009 版终集梗概](https://www.hagaren.jp/about/story06.html) |
| 作者新增 | 「兄弟提前找到重逢的方法」是续写设定。可以接在作者确认的状态之后，保留作者选择，搜索和来源均无需为它背书。 |

首版结果可以只给出版本与剧情起点、少量逐条可核对的背景、待确认项和作者新增设定。每条可核对事实带页面标题、可打开的 URL、集数或段落定位及一句支持该事实的转述。优先查看原文、制作方或出版方页面，来源是否支持该版本及时间点由用户复核。纯搜索摘要、模型引用和通用 Wiki 可帮助找线索，关键事实仍需可检查的证据。无结果、证据冲突或用户跳过搜索时，由用户手动确认可用于开写的前提。

## 进入设计确认前还需实测

1. 用公开作品输入分别测生产 Web 来源和 Android 真机。Web 验证带 Key 的实际 POST、浏览器可读取的成功及错误响应。Android 验证选定的原生路径、取消和超时，覆盖已有 Key 与引导绑定。比较返回字段、延迟、用量和账号余额要求。
2. 用上述同名版本、一个冷门作品及一个抓取失败的公开页面，检查能否逐条回到正确来源，能否辨认工具未执行、引用不足、资料冲突或串版。若服务端联网在这些条件下无法稳定提供可核对证据，再评估有查询和抓取次数上限的独立接口。
3. 检查实际发出的请求及本地诊断、导出内容，确认作者新增设定、剧本和历史未进入检索请求，Key 只在 DeepSeek 鉴权头和预定的本地存储中。

本次核实了仓库实现、公开接口契约、无密钥预检和样例页面。未登录、开通或购买服务，未发出带 Key 的请求或提交用户数据。真实账户调用、搜索覆盖率、引文质量、费用和双端端到端行为均待实测。
