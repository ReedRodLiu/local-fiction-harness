/**
 * 判拒正则最小可用集（乙套）—— 可直接抄进 `src/harness/`。
 *
 * 依据：`docs/research/2026-11-22-refusal-pattern-precision.md`
 * 实测：`docs/文游500篇/` 313 篇正文 + 4114 条正文否定句 + 2670 个段落块，
 *       误判 **0** 例；65 条拒答语料召回 **58** 条（89.2%）。
 *
 * 设计前提（每一条都对应一次实测误判，勿删注释）：
 *   1. 判定窗口取**前 320 字**，不看全文。空会话里拒答几乎都在开头；
 *      放宽到全文只会引入尾部台词误判（实测 甲套 320→全文 误判 52→55）。
 *   2. 先剥离 `结论：` / `1.` / `> ` / `- ` 前缀再匹配（模型爱加这些壳）。
 *   3. **每条规则都必须自带拒绝对象或助手口吻**。光有「不」字不判——
 *      中文小说里「我不会写」「这类内容他不做」「我没办法给你」全是合法台词。
 *   4. 命中提示词注入 / 越狱 / jailbreak 元词且全文 >280 字 → 豁免（那是讨论，不是拒答）。
 *   5. 分四层：L1 硬规则（长文也判）→ L2 具对象规则 → L3 通用软规则（仅短回复）
 *      → L4 微回复（可选，默认关闭，见文件末尾说明）。
 *
 * 与 purge 原版（MIT，Copyright (c) 2026 小杨）的关系：本集是**重写**而非移植。
 * purge 的 24 条里有 12 条在小说正文/台词上产生误判（见报告「甲套」一节），
 * 本集保留其「窗口 + 前缀清洗 + 元词豁免 + 必带对象」四个结构决策，正则全部重写。
 */

/** 判定窗口：默认只看前 320 字。 */
export const REFUSAL_WINDOW_CHARS = 320;

/**
 * 前缀清洗。按行剥引用符/列表符/标题符/序号，再剥首行「结论：」类标签。
 * 必须在匹配前调用——模型常用 `> `、`1. `、`结论：` 包住第一句拒答。
 */
export function refusalHead(text: string, windowChars = REFUSAL_WINDOW_CHARS): string {
  const cleaned = String(text)
    .replace(/\r\n?/g, "\n")
    .replace(/^[\s>*#\-—–]+/gm, "") // > 引用 / - 列表 / # 标题
    .replace(/^\d+[.、)）]\s*/gm, "") // 1. 2) 3、
    .replace(/^(?:结论|答复|回答|回复)[:：]\s*/, "")
    .trim();
  return windowChars === Infinity ? cleaned : cleaned.slice(0, windowChars);
}

/** 元词：出现这些词说明在讨论提示词本身。 */
export const REFUSAL_META_RE =
  /提示词注入|越狱|指令注入|prompt[ _-]?injection|jailbreak/i;

/**
 * 叙事签名：小说正文的四个正交特征。
 * 命中 >=2 项即认为这段是叙事，而不是助手在拒答——L3 层据此关门。
 * 依据：手写 79 条台词负例里 37 条带这些标记，而 65 条拒答语料 **0** 条带。
 */
const NARRATIVE_SIGNS: readonly RegExp[] = [
  /[「」『』“”"]/, // 引号对白
  /他|她/, // 第三人称
  /(?:说|道|问|答|喊|叫|笑|叹|低语|轻声|喃喃|开口)/, // 言说动词
  /(?:夜|晨|雨|风|灯|门|窗|剑|脸|血|雪|月|街|酒|茶)/, // 场景名词
];

function narrativeScore(text: string): number {
  let score = 0;
  for (const pattern of NARRATIVE_SIGNS) if (pattern.test(text)) score += 1;
  return score;
}

/**
 * 良性白名单：模态 / 认知 / 习语，永远不是拒答。
 * 每一条都对应报告里的一个具体误判样本，别顺手删。
 */
const BENIGN_PATTERNS: readonly RegExp[] = [
  /不得不/, // 「我不得不做这个决定」——情态，不是拒绝
  /(?:算|猜|想|记|看|分|说|数|料|预|认)不出/, // 「我算不出这个概率」——认知
  /(?:分|记|认)不清/,
  /(?:原谅|相信|放心|忍心|甘心|舍得|在意|介意|嫌弃|后悔|在乎|担心|害怕)/, // 「我没办法原谅你」
  /(?:添麻烦|麻烦你|怪你|怨你|恨你|骗你|瞒你|求你|劝你)/,
  /(?:让他|让她|他们|她们|大家|别人)会/,
  /(?:就写到这|先到这|改天再|下次再)/,
];

/** 内容类拒绝对象。L3 层要求窗口内至少出现一个。 */
export const REFUSAL_OBJECT_RE =
  /(?:请求|内容|话题|描写|场景|情节|段落|章节|要求|创作|部分|细节|环节|方向|改写|东西|文本|题材|剧情)/;

/** 一条规则 = [正则, 用途说明]。说明写清「挡掉什么」和「为什么这样写」。 */
export type RefusalRule = readonly [RegExp, string];

/**
 * L1 硬规则：自带助手口吻或内容类拒绝对象，**长文也判**。
 * 这一层单独上线时：正文误判 0，召回 52.3%。生产环境的最低安全底线。
 */
export const REFUSAL_RULES_HARD: readonly RefusalRule[] = [
  // ① 自称 AI + 同窗口内能力否定。小说角色不会自称 AI/语言模型，这是最硬的信号。
  //    要求「+ 能力否定」是为了放过「作为一个人工智能产品，它的卖点是可解释性」这类正常讨论。
  [
    /(?<![名为作])作为(?:一个|一名|一款)?\s*(?:AI|人工智能|语言模型|大模型|智能助手)[\s\S]{0,120}?(?:我不能|我无法|我不会|我不能够|无法为你|不能为你|不便)/,
    "自称 AI + 能力否定",
  ],
  // ② 道歉词 14 字内紧跟「我 + 能力否定」——拒答的开场签名。
  //    必须同时出现道歉与否定：放过「抱歉刚才那段写岔了」「对不起，我漏了一段」。
  [
    /(?:抱歉|对不起|很抱歉|十分抱歉|不好意思|恕我)[^。！？\n]{0,14}(?:我(?:不能|无法|不会|没办法|没法)|我确实不能|无法为你|不能为你)/,
    "道歉 + 能力否定",
  ],
  // ③ 客服腔「我这边/我这里」。角色对白说「我这儿」，不说「我这边无法」。
  [/我(?:这边|这里)(?:无法|不能|不便|没办法|没法)/, "客服腔自指"],
  // ④ 元拒绝：点名这段是注入/越狱本身。
  [/(?:这是|这段|上述|你给的|你发的)[^。！？\n]{0,8}(?:提示词注入|越狱|指令注入)/, "元拒绝：点名注入"],
  // ⑤ 框架反驳：「不会把 X 当作指令」。
  [/(?:不会|无法|不能)把[^。！？\n]{0,12}(?:当作|视为|当成)[^。！？\n]{0,12}(?:指令|命令)/, "拒绝执行框架"],
  // ⑥ 对象前置 + 否定 + 交付动词：「这类内容的我不写」「这个请求我不会给」。
  //    issue 正文点名的形态。对象必须是内容类名词，否定后必须落到交付动词，缺一不判。
  [
    /(?:这类|这种|这个|这条|这段|这部分|上述|该|此|那)[^。！？\n]{0,10}?(?:请求|内容|话题|描写|场景|情节|段落|章节|要求|创作|部分|东西)[^。！？\n]{0,14}?我(?:确实|真的|都|也|还是|就是)?(?:不|不?不会|不?不能|不?无法|不予|没办法|没法|拒绝)(?:写|做|出|提供|展开|参与|生成|回答|配合|完成|满足|处理|接)/,
    "对象前置 + 否定 + 交付动词",
  ],
  // ⑦ 平台准则口吻。小说正文不会提「使用规范/内容政策」。
  [/(?:使用|内容|社区)(?:规范|政策|准则|条款)[^。！？\n]{0,12}(?:不允许|禁止|不能|无法)/, "平台准则"],
  // ⑧ 「超出了我的能力/范围」。
  [/(?:超出|超乎)了?(?:我的|模型的)(?:能力|范围|职责)/, "超出能力范围"],
  // ⑨ 明确的拒绝动词。
  [/我(?:拒绝|不予)(?:回答|回应|参与|提供|执行|配合|生成|写)/, "拒绝动词"],
  // ⑩ 能力否定 + 抽象请求名词。
  [
    /(?:无法|不能|没办法|没法)(?:满足|完成|协助|处理|提供)(?:你的|您的|这个|该|此|上述)?(?:请求|要求|需求|任务)/,
    "无法满足请求",
  ],
  // ⑪ 未授权归因。
  [/这(?:属于|是)[^。！？\n]{0,8}(?:未授权|越权)/, "未授权归因"],
  // ⑫ 要求出示授权凭证。
  [/(?:需要|请|必须)(?:你)?(?:提供|出示|确认|把|先给)[^。！？\n]{0,14}(?:授权|许可|书面)/, "要求授权凭证"],
  // ⑬ 否定 + 交付动词 + 后置对象：「我不能写这类场景」「我无法协助完成这段创作」。
  [
    /我(?:不会|不|无法|不能|没办法|没法)[^。！？\n]{0,6}?(?:写|提供|生成|展开|输出|完成|满足|参与|协助|配合|处理)[^。！？\n]{0,12}?(?:这类|这种|这个|这段|这部分|上述|该|此|那)[^。！？\n]{0,6}?(?:内容|请求|话题|描写|场景|要求|部分|创作|东西)/,
    "否定 + 交付动词 + 后置对象",
  ],
];

/**
 * L2 具对象规则：句式本身已含内容类名词，可在**较长回复**（≤400 字）上启用。
 * 单独加在 L1 之上：正文误判 0，召回 52.3% → 78.5%。
 */
export const REFUSAL_RULES_OBJECT: readonly RefusalRule[] = [
  // 前句有内容名词，逗号后接「我不写」——后置否定的典型形态。
  [
    /(?:内容|描写|场景|情节|段落|细节|部分|环节|方向|话题|创作|改写)[^。！？\n]{0,14}?[，,、][^。！？\n]{0,10}?我(?:都|就|确实|真的)?不(?:写|做|出|提供|展开|参与|生成)/,
    "逗号后我不X（前有内容名词）",
  ],
  // 「…的我不写」后置否定。issue 点名的「这类内容的我不写」走 ⑥/本条两条路。
  [/[^。！？\n]{4,90}?的[^。！？\n]{0,6}?我(?:都|就)?不(?:写|做|出|提供|展开|参与|生成)/, "「…的我不写」"],
  // 「再往下/后面/其余 + 我不写」——先给一部分再推掉后半段，是最难判的软拒绝。
  [/(?:再往下|往下|后面|其余|剩下|至于)[^。！？\n]{0,10}?(?:我)?(?:都|就)?不(?:写|做|出|提供|展开|参与|生成)/, "「再往下我不写」"],
  // 「这我写不了」：指示代词跑到动词前面。
  [
    /(?:这|那|这个|这条|这段|这部分)[^。！？\n]{0,4}?我(?:都|也)?(?:写|做|出|提供|展开|参与|生成|处理|接|答)(?:不了|不出)/,
    "「这我写不了」",
  ],
  // 「这条我不做」「这个我不接」：对象前置的最短形态。
  // 注意：本条在裸台词上仍有误判（「这条我不接，你找别人吧」是剧中人说的话），
  // 是靠 L2 的 400 字上限 + 良性白名单把它压住的，别再放宽长度。
  [
    /^(?:这|那)(?:条|个|份|种|类|套|篇|段|一)[^。！？\n]{0,24}?我(?:都)?(?:不|不会)(?:做|出|写|提供|参与|帮|接|答|配合|回复|处理|展开|碰|办)/,
    "「这条我不X」",
  ],
  // 「这个我不能写」：对象前置 + 能力否定。
  [
    /^(?:这|那|这个|这条|这段|这部分|该|此)[^。！？\n]{0,12}?我(?:确实|真的|也)?(?:不能|无法|不会|没办法|没法)(?:写|做|出|提供|展开|参与|生成|回答|配合|完成|满足)/,
    "「这个我不能写」",
  ],
];

/**
 * L3 通用软规则：只在「短回复 + 无叙事签名 + 带内容对象」三条同时成立时启用。
 * 加在 L1+L2 之上：正文误判仍 0，召回 78.5% → 89.2%。
 * 这一层是**主要误判来源**，出问题先关它（`enableGeneric: false`）。
 */
export const REFUSAL_RULES_GENERIC: readonly RefusalRule[] = [
  [/我[^。！？\n]{0,4}(?:不会|不)(?:提供|写|生成|输出|完成|展开|参与|协助|配合|做|给|出|帮|接|回答|处理)/, "我+否定+交付动词"],
  [/我(?:帮|做|给|办|提供|答|写|出|接|处理|展开|生成)(?:不了|不出)/, "我X不了"],
  [
    /我(?:没有?办法|没有?能力|没法|做不到)(?:给|提供|协助|帮|做|配合|处理|完成|生成|写|回答|满足|继续|展开|按要求)/,
    "我没办法X",
  ],
  [/我不方便(?:做|提供|参与|展开|给|回答)/, "我不方便X"],
  [/不是我能(?:协助|帮|做|处理|决定|给)/, "不是我能X"],
  [/我(?:不会|不能|无法|不)(?:就|对|针对)[^。！？\n]{0,10}?(?:给|提供|出|做|写|回应|回答)/, "我不会就X给Y"],
  // 整段就是一句「我不X」。要求整条消息到此结束，放过「我不参与。她说完就走了」。
  [/^(?:抱歉|对不起|很抱歉|不好意思)?[，,]?我(?:不能|无法|不会|没办法|没法|不予|拒绝)[^。！？\n]{0,20}$/, "整段一句拒绝"],
];

/** 判定结果。`layer` 直接进诊断日志，方便事后统计误判来自哪一层。 */
export interface RefusalVerdict {
  readonly layer: "L1" | "L2" | "L3" | "L4";
  readonly rule: string;
  /** Stable zero-content identifier for diagnostics. */
  readonly ruleId: string;
}

export interface RefusalJudgeOptions {
  /** 判定窗口，默认 320。实测 320 / 400 / 全文在正文侧无差别，取短的省 CPU。 */
  readonly windowChars?: number;
  /** L2 层的最大文本长度，默认 400。 */
  readonly objectMaxLen?: number;
  /** L3 层的最大文本长度，默认 160。 */
  readonly genericMaxLen?: number;
  /** L3 层允许的最大句数，默认 3。 */
  readonly genericMaxSentences?: number;
  /** L3 层关门的叙事签名阈值，默认 2。 */
  readonly narrativeGuard?: number;
  /** 元词豁免的全文长度阈值，默认 280。 */
  readonly metaExemptOver?: number;
  /** 良性白名单开关，默认开。 */
  readonly benignGuard?: boolean;
  /** L2 开关。 */
  readonly enableObject?: boolean;
  /** L3 开关。线上出误判时第一个关它。 */
  readonly enableGeneric?: boolean;
  /**
   * L4 微回复开关，**默认关闭**。
   * 开启后召回 89.2% → 93.8%，但裸台词误判 6→22 条（27.9%）。
   * 只有在你确信「拒答一定是整条一句话」时才开。
   */
  readonly enableMicro?: boolean;
  /** L4 长度上限，默认 20。 */
  readonly microMaxLen?: number;
}

/**
 * L4 微回复：整条 ≤20 字、只有一句、且以「我/这…」起头就否定。
 * 实测 2670 个正文段落块 0 误判，但手写裸台词 79 条里会误判 20 条——
 * 那些句子在字面上确实和拒答一模一样，只能靠上下文区分。
 */
export const REFUSAL_RULE_MICRO =
  /^(?:我|不是我能|这个|这条|这类|这种|这)[^。！？\n]{0,16}?(?:不能|无法|不会|没办法|没法|做不到|不予|拒绝|不)(?:写|做|出|提供|展开|参与|生成|回答|配合|完成|满足|协助|帮|给|处理|继续|支持|了)/;

/**
 * 判拒。返回命中信息，或 `null` 表示「这是正文」。
 *
 * @example
 * judgeRefusal("抱歉，我不能帮你写这段内容。") // → { layer: "L1", rule: "道歉 + 能力否定" }
 * judgeRefusal("「我不会写。」他说得很轻。")   // → null
 */
export function judgeRefusal(text: string, options: RefusalJudgeOptions = {}): RefusalVerdict | null {
  const {
    windowChars = REFUSAL_WINDOW_CHARS,
    objectMaxLen = 400,
    genericMaxLen = 160,
    genericMaxSentences = 3,
    narrativeGuard = 2,
    metaExemptOver = 280,
    benignGuard = true,
    enableObject = true,
    enableGeneric = true,
    enableMicro = false,
    microMaxLen = 20,
  } = options;

  const raw = String(text ?? "").replace(/\r\n?/g, "\n");
  if (!raw.trim()) return null;
  const head = refusalHead(raw, windowChars);
  const fullLength = raw.trim().length;

  // L1：长文也判。
  for (const [index, [pattern, rule]] of REFUSAL_RULES_HARD.entries()) {
    if (pattern.test(head)) return { layer: "L1", rule, ruleId: `L1-${String(index + 1).padStart(2, "0")}` };
  }

  // L4 微回复：整条只有一句话时，不需要上下文对照。默认关闭。
  if (enableMicro && fullLength <= microMaxLen) {
    const trimmed = raw.trim();
    const sentences = trimmed.split(/[。！？\n]/).filter((s) => s.trim().length > 1);
    if (sentences.length <= 1 && REFUSAL_RULE_MICRO.test(trimmed)) {
      return { layer: "L4", rule: "微回复", ruleId: "L4-01" };
    }
  }

  // 元词豁免：长文里提「提示词注入/越狱」是在讨论，不是在拒答。
  if (REFUSAL_META_RE.test(head) && fullLength > metaExemptOver) return null;

  const benign = benignGuard && BENIGN_PATTERNS.some((pattern) => pattern.test(head));

  // L2：句式自带内容对象，容忍较长回复。
  if (enableObject && fullLength <= objectMaxLen && !benign) {
    for (const [index, [pattern, rule]] of REFUSAL_RULES_OBJECT.entries()) {
      if (pattern.test(head)) return { layer: "L2", rule, ruleId: `L2-${String(index + 1).padStart(2, "0")}` };
    }
  }

  if (!enableGeneric) return null;

  // L3：三重关门——长度、叙事签名、良性词。
  const sentences = raw.split(/[。！？\n]/).filter((s) => s.trim().length > 1);
  if (fullLength > genericMaxLen || sentences.length > genericMaxSentences) return null;
  if (narrativeScore(head) >= narrativeGuard) return null;
  if (benign) return null;
  if (!REFUSAL_OBJECT_RE.test(head)) return null;

  for (const [index, [pattern, rule]] of REFUSAL_RULES_GENERIC.entries()) {
    if (pattern.test(head)) return { layer: "L3", rule, ruleId: `L3-${String(index + 1).padStart(2, "0")}` };
  }
  return null;
}

/** Runs only the hard L1 rules used for the 120-character observation window. */
export function judgeHardRefusal(text: string, windowChars = REFUSAL_WINDOW_CHARS): RefusalVerdict | null {
  const raw = String(text ?? "").replace(/\r\n?/g, "\n");
  if (!raw.trim()) return null;
  const head = refusalHead(raw, windowChars);
  for (const [index, [pattern, rule]] of REFUSAL_RULES_HARD.entries()) {
    if (pattern.test(head)) {
      return { layer: "L1", rule, ruleId: `L1-${String(index + 1).padStart(2, "0")}` };
    }
  }
  return null;
}

/** 便捷布尔版。 */
export function looksLikeRefusal(text: string, options?: RefusalJudgeOptions): boolean {
  return judgeRefusal(text, options) !== null;
}

/** 上线条数：L1 13 条 + L2 6 条 + L3 7 条 = 26 条（L4 可选，默认关）。 */
export const REFUSAL_RULE_COUNT =
  REFUSAL_RULES_HARD.length + REFUSAL_RULES_OBJECT.length + REFUSAL_RULES_GENERIC.length;
