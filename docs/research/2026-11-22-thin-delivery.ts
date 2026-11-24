/**
 * 「薄交付」判定 —— 可直接抄进 `src/harness/`。
 *
 * 依据：`docs/research/2026-11-22-thin-delivery-calibration.md`
 * 前置：`docs/research/2026-11-22-refusal-pattern-precision.ts`（26 条判拒正则，下称 D1）
 *
 * 回答的问题不是「这条回复像不像拒绝」，而是「这条回复交付了任何东西」。
 * 文游 / 写故事 / 角色互动的「交付」不等于代码行数——一个 2 字的「嗯。」
 * 在角色互动里是完全合法的交付，而 5 字的「我不参与。」不是。两者字数一样。
 *
 * ## 三条设计底线（每条都对应一次实测，勿删注释）
 *
 * 1. **不可单独作为重试触发器。** 裸跑薄交付在阈值 20 上会误判 56/79 条手写台词、
 *    16/30 条技术讨论——因为「我不会给你第二次机会。」和「我不参与。」字面同构。
 *    它只做两件事：给 D1 **做否决**（命中但已交付 → 不重试），
 *    以及判 `partial_refused`（半拒绝）。
 *
 * 2. **极短合法回复靠三道闸门保，不靠字数。** 依次是：协议围栏 → 叹词白名单
 *    → 场景锚点。三者在 497 条短回复正例上把误判压到 0（手写 38 条全过）。
 *
 * 3. **设定/面板行是文游的真实误判面，不是叙事。** 阈值放到 20 时，2670 个段落块
 *    里 20 例误判全部是「谢云\n40\n邯河县主」这类人物面板。它们是交付，
 *    所以 `structuredLineGuard` 会把 ≥3 行的结构化块直接放过。
 *
 * 与 purge 原版（MIT，`Copyright (c) 2026 小杨`）的关系：保留「一个可计算阈值 +
 * 半拒绝复用它」的结构，度量整体重写。purge 的 `代码行 < 10 且步骤 < 5` 是编程场景度量，
 * 在小说正文上恒为真（正文里几乎不会有代码块与有序列表），照抄会把 313 篇正文全判成薄。
 */

/** 交付判定的三种场景，对应三套 system prompt：文游 `context.ts:117-123`、写故事与角色互动 `creative.ts:259-272`。 */
export type DeliveryMode = "story" | "writing" | "character";

export interface DeliveryOptions {
  /**
   * 正文字数阈值：**达到或超过**此值即认为已交付。
   *
   * 默认 **20**。标定依据：65 条拒答中位 10 字、最长 42 字；
   * 阈值 20 是「召回 95.4% / 台词误判 56」与「召回 80% / 台词误判 52」之间
   * 唯一同时保住段落块 0 误判与 ≥93% 召回的点（见标定表）。
   * 调到 13 会让召回掉到 55.4%，调到 30 会让段落块误判从 0 涨到 59。
   */
  readonly thinMaxChars?: number;
  /** 场景锚点阈值，默认 1（一票通过）。设 2 会把「「嗯。」她说。」这类短句误判成薄。 */
  readonly sceneAnchorMin?: number;
  /** 叹词/应答词白名单的最大字数，默认 4。`嗯。`=2、`好啊`=2、`行吧`=2。 */
  readonly interjectionMaxChars?: number;
  /** 是否把协议围栏视为交付，默认 true。关掉会把「一句正文 + lfh-summary」判成薄。 */
  readonly fenceCountsAsDelivery?: boolean;
  /**
   * 结构化行数闸门：非空行 ≥ 此值即视为已交付，默认 3。
   * 挡住「谢云\n40\n邯河县主\n谢悦」这类人物面板——它们是交付，只是没有叙事。
   * 拒答语料 65 条全部是单行（实测 line count 集合 = [1]），这条闸门对召回零代价。
   */
  readonly structuredLineGuard?: number;
  /** 写故事模式下，列表项数 ≥ 此值即认为已交付，默认 2。 */
  readonly listRescueMin?: number;
  /** 写故事模式下，代码行数 ≥ 此值即认为已交付，默认 3。 */
  readonly codeRescueMin?: number;
  /** 场景。默认 `story`（最严：只认叙事）。 */
  readonly mode?: DeliveryMode;
  /**
   * 调用方已确认有协议产物（`lfh-summary` 已解析出来 / 有 proposal / 有 choices）。
   *
   * **必须传**：真实管线里 `parseProposalReply()`（`src/harness/markdownProposal.ts:655`
   * 起）会把 `lfh-*` 围栏从正文剥离，`streamCreativeReply()`（`creative.ts:558`）
   * 返回的 `content` 里已经没有围栏了。只喂 `content` 而不传这个参数，
   * 围栏证据会全丢，`deliveryIsThin` 会把每一条正常回复都判薄。见报告「坑」第 1 条。
   */
  readonly hasProtocolArtifacts?: boolean;
}

export interface DeliveryInspection {
  /** 剥掉围栏、Markdown 记号、空白之后的字符数。 */
  readonly bodyChars: number;
  /** 非空行数。 */
  readonly bodyLines: number;
  /** 判定结果。 */
  readonly thin: boolean;
  /** 命中的场景锚点名，进诊断日志用。 */
  readonly anchors: readonly string[];
  /** 是否命中叹词白名单。 */
  readonly interjection: boolean;
  /** 是否检测到协议围栏（或调用方声明有协议产物）。 */
  readonly protocol: boolean;
  /** 写故事模式下的兜底计数。 */
  readonly listItems: number;
  readonly codeLines: number;
}

export const DEFAULT_DELIVERY_OPTIONS = {
  thinMaxChars: 20,
  sceneAnchorMin: 1,
  interjectionMaxChars: 4,
  fenceCountsAsDelivery: true,
  structuredLineGuard: 3,
  listRescueMin: 2,
  codeRescueMin: 3,
  mode: "story",
} as const satisfies Required<Omit<DeliveryOptions, "hasProtocolArtifacts">>;

/** 协议围栏。`lfh-summary` 是每轮强制契约，另三个是可选契约。 */
const PROTOCOL_FENCE_RE =
  /^[ \t]{0,3}(`{3,})[ \t]*(lfh-summary|lfh-proposal|lfh-change|lfh-choices|lfh-hud)[ \t]*$/m;

/**
 * 叹词 / 应答词白名单。**闭集**，只收不带动词的短应答。
 *
 * 这些是「极短但合法」的正文主力：`嗯。` `好。` `是。` `……`。
 * 误判成拒答就是灾难——角色只哼一声，harness 却重试了一次。
 * 覆盖 497 条短回复正例里的 42 条，拒答语料 0 条命中（拒答至少要有一个交付动词）。
 */
const INTERJECTION_RE =
  /^(?:嗯|哦|喔|噢|唔|呃|额|啊|呀|哈|呵|嘿|诶|欸|喂|嘘|唉|哎|是|对|好|行|成|中|可|不|别|走|来|去|滚|停|嗯嗯|哦哦|哈哈|嘻嘻|嘿嘿|好啊|行吧|好吧|是的|对的|好嘞|嗯呢)[啊呀呢吧了嘛哦哪啦]*$/;

/**
 * 场景锚点。任一项命中即视为「这段在演故事，不是在答复用户」。
 * 每一条都对应报告里的一个具体短回复正例；65 条拒答语料 **0** 条命中任何一项。
 */
const SCENE_ANCHORS: readonly (readonly [RegExp, string])[] = [
  [/[「」『』“”"]/, "引号对白"], // 「嗯。」/「疼吗？」
  [/[（(][^（()）]{1,40}[）)]/, "圆括号动作"], // （她没说话，只是把杯子推过来。）
  [/[他她]/, "第三人称"], // 她没说话。/ 他没有回头。
  // 言说/体态动词必须处在**动词位**：后跟「道/了/着/过」或句读。
  // 裸写 `说|道|问|答` 会被 `问题`/`答案`/`说明` 这些名词词组命中——
  // 实测 `我不会就这个问题给出方案。` 就是被 `问题` 里的「问」放了行。
  [/(?:说|问|答|喊|叫|笑|叹|低语|喃喃|开口|点头|摇头|沉默|顿了顿)(?:道|了|着|过|[，。！？：,」”])/, "言说/体态动词"],
  // 感官与场景名词。比 #116 的 NARRATIVE_SIGNS 宽：判的是「有没有画面」而不是「像不像台词」。
  [/(?:夜|晨|雨|风|灯|门|窗|剑|刀|血|雪|月|街|酒|茶|杯|碗|手|脸|眼|声|香|痛|冷|热|光|影|雾|烟)/, "感官/场景"],
  // 第二人称 + 体验动词：文游正文的「你听见门关上的声音」。
  // 必须配动词——`我帮不了你。` 里也有「你」，单看人称会把它放行。
  [/你[^。！？\n]{0,8}?(?:听|看|觉|感|闻|发现|注意|想|记|抬|回|伸|转|走|站|坐|握|接|推|拉)/, "第二人称 + 体验动词"],
];

/** 列表项 / 代码围栏：只在写故事模式当交付证据。 */
const LIST_ITEM_RE = /^[ \t]*(?:\d+[.、)）]|[-*+])[ \t]+\S/gm;
const CODE_FENCE_RE = /^[ \t]{0,3}`{3,}[a-zA-Z0-9+#._-]*[ \t]*$/gm;

/**
 * 会把字数算多的 Markdown 噪音：围栏记号、标题符、引用符、强调符、行内代码反引号。
 * 不清掉它们，一条 `**嗯。**` 会被算成 6 字，挤出 `thinMaxChars` 的判区。
 */
function stripMarkdownNoise(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(PROTOCOL_FENCE_RE, "")
    .replace(/^[ \t]{0,3}`{3,}.*$/gm, "") // 普通代码围栏行
    .replace(/^[ \t]{0,3}#{1,6}[ \t]*/gm, "") // 标题符
    .replace(/^[ \t]{0,3}>[ \t]?/gm, "") // 引用符
    .replace(/^[ \t]{0,3}(?:\d+[.、)）]|[-*+])[ \t]+/gm, "") // 列表符
    .replace(/[*_~`]+/g, "") // 强调 / 行内代码
    .replace(/[ \t\u3000]+/g, ""); // 空白与全角空格不计入正文字数
}

/** 判定「这条回复有没有交付任何东西」。 */
export function deliveryIsThin(text: string, options: DeliveryOptions = {}): boolean {
  return inspectDelivery(text, options).thin;
}

/** 完整信号版，供诊断日志与自测断言。 */
export function inspectDelivery(text: string, options: DeliveryOptions = {}): DeliveryInspection {
  const {
    thinMaxChars = DEFAULT_DELIVERY_OPTIONS.thinMaxChars,
    sceneAnchorMin = DEFAULT_DELIVERY_OPTIONS.sceneAnchorMin,
    interjectionMaxChars = DEFAULT_DELIVERY_OPTIONS.interjectionMaxChars,
    fenceCountsAsDelivery = DEFAULT_DELIVERY_OPTIONS.fenceCountsAsDelivery,
    structuredLineGuard = DEFAULT_DELIVERY_OPTIONS.structuredLineGuard,
    listRescueMin = DEFAULT_DELIVERY_OPTIONS.listRescueMin,
    codeRescueMin = DEFAULT_DELIVERY_OPTIONS.codeRescueMin,
    mode = DEFAULT_DELIVERY_OPTIONS.mode,
    hasProtocolArtifacts = false,
  } = options;

  const raw = String(text ?? "").replace(/\r\n?/g, "\n");
  const trimmed = raw.trim();
  const stripped = stripMarkdownNoise(trimmed);
  // 剥掉句末标点再判：`嗯。` 与 `嗯` 是同一件事，句号不该把它挤出白名单。
  const bare = stripped.replace(/[。！？…~～.．!?,，、;；:：\-—–\s]+/g, "");

  const bodyChars = stripped.replace(/\n+/g, "").length;
  const bodyLines = trimmed.split("\n").filter((line) => line.trim() !== "").length;
  const listItems = (trimmed.match(LIST_ITEM_RE) ?? []).length;
  const codeFences = (trimmed.match(CODE_FENCE_RE) ?? []).length;
  const codeLines = codeFences >= 2 ? Math.max(0, codeFences - 2) : 0;
  const protocol = hasProtocolArtifacts || (fenceCountsAsDelivery && PROTOCOL_FENCE_RE.test(trimmed));

  const anchors: string[] = [];
  for (const [pattern, label] of SCENE_ANCHORS) {
    if (pattern.test(trimmed)) anchors.push(label);
  }
  const interjection = bare.length > 0 && bare.length <= interjectionMaxChars && INTERJECTION_RE.test(bare);

  const base = { bodyChars, bodyLines, anchors, interjection, protocol, listItems, codeLines };

  // ① 空白回复：没交付。
  if (!trimmed) return { ...base, thin: true };
  // ①b 纯标点（`……` / `——`）：文游里的「无声」，是正文不是拒答。
  //     拒答至少要有一个交付动词，所以纯标点不可能由拒答产生。
  if (bodyChars > 0 && bare.length === 0) return { ...base, thin: false };
  // ② 协议围栏 = 履行了输出契约，哪怕正文只有一句。
  if (protocol) return { ...base, thin: false };
  // ③ 结构化多行块（人物面板 / 数值表）：是交付，只是没有叙事。拒答 65/65 全是单行。
  if (bodyLines >= structuredLineGuard) return { ...base, thin: false };
  // ④ 字数够了。
  if (bodyChars >= thinMaxChars) return { ...base, thin: false };
  // ⑤ 叹词白名单：极短合法回复的第一道兜底。
  if (interjection) return { ...base, thin: false };
  // ⑥ 场景锚点一票通过。
  if (anchors.length >= sceneAnchorMin) return { ...base, thin: false };
  // ⑦ 写故事模式：大纲 / 要点列表算交付。文游与角色互动不算——那里的列表是跳出戏外。
  if (mode === "writing" && (listItems >= listRescueMin || codeLines >= codeRescueMin)) {
    return { ...base, thin: false };
  }
  return { ...base, thin: true };
}

/**
 * 拒答**嫌疑**：`THIN_REFUSAL_SUSPECT_RE` 只问「第一人称 + 否定 + 交付动词」这个骨架。
 *
 * 单独用它判拒答会大面积误伤台词（`我不会给你第二次机会。` 同构），
 * 实测：薄@20 ∧ 嫌疑 只有 58.5% 召回、18/79 台词误判——比 26 条正则的基线更差。
 * 因此**不推荐**把它接在薄交付后面（这是 issue 里的设计 (b)，已被否）。
 * 保留导出只为一件事：`partial_refused` 的诊断归因。
 */
export const THIN_REFUSAL_SUSPECT_RE =
  /^(?:抱歉|对不起|很抱歉|十分抱歉|不好意思|恕我)?[，,]?(?:我|这|那|不是)[^。！？\n]{0,24}?(?:不能|无法|不会|没办法|没法|做不到|不予|拒绝|不方便|不)(?:写|做|出|给|提供|展开|参与|生成|回答|配合|完成|满足|协助|帮|处理|继续|接|这个|这些|这段|下去|往下)/;

/** 交付动词。`骨架救援` 与 `半拒绝` 共用的词表。 */
export const DELIVERY_VERB_RE =
  /(?:写|做|出|给|提供|展开|参与|生成|回答|配合|完成|满足|协助|帮|处理|继续|接|办|输出|创作|描述|说明|列出|讲解|解释)/;

/**
 * 自身状态动词：说话人说自己生活里的能与不能，与「交付」无关。
 * `我不后悔。` `我不敢。` `我不识字。` 全部落在这里，是台词不是拒答。
 */
export const SELF_STATE_RE =
  /(?:后悔|在乎|介意|怪|困|饿|累|疼|痛|怕|敢|配|识字|认路|游泳|吃|喝|说谎|相信|原谅|记得|明白|懂|愿意|需要|想|欠|呼吸|活|留|走|来|去|回|睡|醒|死|记账|写字)/;

/**
 * 内容类 / 抽象请求名词。与 #116 的 `REFUSAL_OBJECT_RE` 同源，
 * 额外收了 `方案|信息|这个|这些|这段|往下|继续|范围|问题`——
 * 这七个词正是 7 条漏检拒答里剩下的对象形态。
 */
export const THIN_OBJECT_RE =
  /(?:请求|内容|话题|描写|场景|情节|段落|章节|要求|创作|部分|细节|环节|方向|改写|东西|文本|题材|剧情|方案|信息|这个|这些|这段|往下|继续|范围|问题)/;

/**
 * **薄骨架救援**：issue 里设计 (a) 的「薄交付只在短回复上兜底」的正确实现。
 *
 * 五个条件同时成立才判「这是拒答」：
 *   1. `deliveryIsThin(text, { thinMaxChars: 13 })` —— 真的什么都没写；
 *   2. 无场景锚点 —— 不是叙事；
 *   3. 含交付动词 —— `我不后悔。` 没有交付动词，落不进来；
 *   4. 不含自身状态动词 —— `我不敢。` `我做不到。`（台词）被挡住；
 *   5. 含内容对象 + 含「我」自指 —— `不要出现任何代码！`（设定文档）被挡住。
 *
 * 实测：救回 7 条漏检里的 4 条（`我没办法给你这个。`/`我不方便提供这些信息。`/
 * `不是我能协助的范围。`/`我做不到继续往下写。`），代价是台词误判 5→6，
 * 技术讨论误判 7→2（因为否决闸门先砍掉了 5 条），纯叙事短回复误判 0/397 不变。
 * 剩下 3 条（`我不参与。`/`我帮不了你。`/`我不会就这个问题给出方案。`）无内容对象，
 * 松到能抓它们会让句级正文误判从 0 涨到 34——这是本方案的边界，见报告 §5.6。
 */
export function deliverySkeletonLooksLikeRefusal(text: string, options: DeliveryOptions = {}): boolean {
  const body = String(text ?? "").trim();
  if (!body) return false;
  const inspection = inspectDelivery(body, { ...options, thinMaxChars: 13 });
  if (!inspection.thin) return false;
  if (inspection.anchors.length > 0) return false;
  if (!DELIVERY_VERB_RE.test(body)) return false;
  if (SELF_STATE_RE.test(body)) return false;
  if (!THIN_OBJECT_RE.test(body)) return false;
  if (!/我/.test(body)) return false;
  return true;
}

export type RefusalRoute =
  /** 26 条正则命中且交付薄 → 重试一次。 */
  | "retry"
  /** 正则命中但已交付 → 半拒绝，告知用户而不是重试。 */
  | "partial_refused"
  /** 正则未命中但薄骨架成立 → 重试一次。 */
  | "retry-skeleton"
  /** 两条都不命中 → 静默通过。 */
  | "pass";

/**
 * 串联决策：**薄交付给正则做否决，薄骨架给正则补召回**。
 *
 * 对应 issue 里的问题 3，结论是 (a) 的改良版：
 *   ① 26 条正则先判（`judgeRefusal`）；
 *   ② 命中 → 再看交付：薄则 `retry`，不薄则 `partial_refused`（不重试）；
 *   ③ 未命中 → 薄骨架成立则 `retry-skeleton`，否则 `pass`。
 *
 * 实测（65 条拒答 / 313 篇正文 / 5459 否定句 / 2670 段落块 / 79 台词 / 30 技术 / 497 短回复）：
 *   召回 87.7% → 90.8%（可重试）＋ 3.1%（转告知）＝ 93.8% 被处理；
 *   技术讨论误判 7 → 2；台词误判 5 → 6；全文 / 段落块 / 短回复正例误判均为 **0**。
 */
export function routeRefusal(
  text: string,
  regexHit: boolean,
  options: DeliveryOptions = {},
): RefusalRoute {
  if (regexHit) {
    return deliveryIsThin(text, options) ? "retry" : "partial_refused";
  }
  return deliverySkeletonLooksLikeRefusal(text, options) ? "retry-skeleton" : "pass";
}

/** 半拒绝判定：正则命中 + 交付不薄。保留 purge 的名字与语义，实现换成上表。 */
export function looksLikePartialRefusal(text: string, regexHit: boolean, options: DeliveryOptions = {}): boolean {
  return routeRefusal(text, regexHit, options) === "partial_refused";
}

export const DELIVERY_SIGNAL_NAMES = [
  "empty",
  "punctuation-only",
  "protocol-fence",
  "structured-lines",
  "char-budget",
  "interjection",
  "scene-anchor",
  "writing-structure",
] as const;

/* ────────────────────────────────────────────────────────────────────────────
 * 最小自测。不引任何测试框架，抄进 `src/harness/` 后可直接跑：
 *   node --experimental-strip-types docs/research/2026-11-22-thin-delivery.ts
 * 或者把下面的 CASES 原样搬进 vitest 的 it()。
 * 每条期望值都来自 `2026-11-22-thin-delivery-calibration.md` 的实测表。
 * ──────────────────────────────────────────────────────────────────────────── */

interface DeliveryCase {
  readonly name: string;
  readonly text: string;
  readonly thin: boolean;
  readonly options?: DeliveryOptions;
}

export const DELIVERY_CASES: readonly DeliveryCase[] = [
  // ── 极短合法回复：绝不能被判薄 ────────────────────────────────────────────
  { name: "叹词·嗯", text: "嗯。", thin: false },
  { name: "叹词·是", text: "是。", thin: false },
  { name: "叹词·好", text: "好。", thin: false },
  { name: "叹词·好吧", text: "好吧。", thin: false },
  { name: "纯标点·省略号", text: "……", thin: false },
  { name: "纯标点·破折号", text: "——", thin: false },
  { name: "引号对白", text: "「嗯。」", thin: false },
  { name: "引号对白·带言说", text: "「嗯。」她说。", thin: false },
  { name: "圆括号动作", text: "（她没说话，只是把杯子推过来。）", thin: false },
  { name: "第三人称动作", text: "她没有回头。", thin: false },
  { name: "第二人称体验", text: "你听见门关上的声音。", thin: false },
  { name: "感官场景", text: "血从指缝里渗出来。", thin: false },
  { name: "纯标点·沉默", text: "（沉默。）", thin: false },

  // ── 协议围栏：履行输出契约即交付 ─────────────────────────────────────────
  { name: "围栏·summary", text: "嗯。\n```lfh-summary\n她把茶推过来，等他先开口。\n```", thin: false },
  { name: "围栏·proposal", text: "改好了。\n```lfh-proposal\ntarget: manuscript\nop: append\n---\n雨还在下。\n```", thin: false },
  { name: "围栏·choices", text: "门开了。\n```lfh-choices\nA. 走进去\nB. 转身\n```", thin: false },
  { name: "调用方声明有协议产物", text: "……", thin: false, options: { hasProtocolArtifacts: true } },

  // ── 结构化多行块：人物面板是交付 ────────────────────────────────────────
  { name: "人物面板", text: "谢云\n40\n邯河县主\n谢悦\n苍小落", thin: false },
  { name: "两行不足闸门", text: "学识80\n医术70", thin: true },

  // ── 7 条漏检里薄交付能兜住的 4 条 + 3 条兜不住的 ────────────────────────
  { name: "漏检·我帮不了你", text: "我帮不了你。", thin: true },
  { name: "漏检·我没办法给你这个", text: "我没办法给你这个。", thin: true },
  { name: "漏检·我不方便提供这些信息", text: "我不方便提供这些信息。", thin: true },
  { name: "漏检·我做不到继续往下写", text: "我做不到继续往下写。", thin: true },
  { name: "漏检·我不参与", text: "我不参与。", thin: true },

  // ── 台词：字面同构但不是拒答，薄交付判薄（所以它必须做否决器而非发现器）──
  { name: "台词·我不会给你第二次机会", text: "我不会给你第二次机会。", thin: true },
  { name: "台词·我不能给你承诺", text: "我不能给你承诺，战场上没有承诺。", thin: true },
  { name: "台词·我不参与朝堂", text: "我不参与朝堂上的事，这是祖训。", thin: true },

  // ── writing 模式的列表兜底 ──────────────────────────────────────────────
  { name: "writing·三条大纲", text: "1. 铺垫\n2. 越界\n3. 余波", thin: false, options: { mode: "writing" } },
  { name: "story·三条大纲不算交付", text: "1. 铺垫\n2. 越界\n3. 余波", thin: true, options: { mode: "story", structuredLineGuard: 4 } },

  // ── 空白 ────────────────────────────────────────────────────────────────
  { name: "空串", text: "", thin: true },
  { name: "纯空白", text: "  \n\t \n", thin: true },
];

export const SKELETON_CASES: readonly { readonly text: string; readonly hit: boolean }[] = [
  { text: "我没办法给你这个。", hit: true },
  { text: "我不方便提供这些信息。", hit: true },
  { text: "我做不到继续往下写。", hit: true },
  { text: "这个面子我不给。", hit: true }, // 已知代价：台词里唯一被捞回来的一条
  { text: "我不参与。", hit: false }, // 无内容对象
  { text: "我帮不了你。", hit: false }, // 无内容对象（"你"不算内容类对象）
  { text: "我不后悔。", hit: false }, // 自身状态动词
  { text: "我不敢。", hit: false }, // 自身状态动词
  { text: "不要出现任何代码！！！", hit: false }, // 无第一人称自指
  { text: "「嗯。」", hit: false }, // 场景锚点
  { text: "（她没说话，只是把杯子推过来。）", hit: false }, // 场景锚点
  { text: "我不会给你第二次机会。", hit: false }, // 无内容对象
];

/** 跑一遍自测，返回失败项。空数组 = 全过。 */
export function runDeliverySelfTest(): string[] {
  const failures: string[] = [];
  for (const testCase of DELIVERY_CASES) {
    const actual = deliveryIsThin(testCase.text, testCase.options);
    if (actual !== testCase.thin) {
      failures.push(`deliveryIsThin(${JSON.stringify(testCase.text)}) = ${actual}，期望 ${testCase.thin}（${testCase.name}）`);
    }
  }
  for (const skeletonCase of SKELETON_CASES) {
    const actual = deliverySkeletonLooksLikeRefusal(skeletonCase.text);
    if (actual !== skeletonCase.hit) {
      failures.push(`deliverySkeletonLooksLikeRefusal(${JSON.stringify(skeletonCase.text)}) = ${actual}，期望 ${skeletonCase.hit}`);
    }
  }
  return failures;
}
