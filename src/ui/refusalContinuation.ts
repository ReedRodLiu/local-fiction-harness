import {
  assembleThreeZoneContext,
  buildPromptPackContextOptions,
  buildTurnProposalRecords,
  documentVersion,
  getActiveSummarySnapshot,
  invalidateStorySummarySnapshotsFromNode,
  invalidateSummarySnapshotsFromNode,
  judgeRefusal,
  normalizeReasoningEffort,
  parseProposalReply,
  resolveEffectivePrefixProtocol,
  restoreRefusalOriginalContent,
  routeRefusal,
  storyDocumentState,
  visibleReplyPrefix,
  type AbortSignalLike,
  type DeliveryMode,
  type LlmMessage,
  type LlmTransport,
  type MarkdownDocument,
  type ModelConfig,
  type PromptPackLibrary,
  type Story,
  type TurnNode,
} from '../harness/index.ts';

export interface PrefixContinuationOptions {
  transport: LlmTransport;
  config: ModelConfig;
  messages: LlmMessage[];
  prefixContent: string;
  signal?: AbortSignalLike;
  onReasoningDelta?: (delta: string) => void;
  onContentDelta?: (delta: string) => void;
}

export interface PrefixContinuationResult {
  content: string;
  reasoningContent: string;
  finishReason?: string | null;
}

export interface PrefixContinuationFinalizeOptions {
  mode: DeliveryMode;
  baseVersions?: { setting?: string; memory?: string; note?: string; manuscript?: string };
  now?: number;
}

function containsContinuationProtocol(raw: string, parsed: ReturnType<typeof parseProposalReply>): boolean {
  return (
    /(^|\n)[ \t]*`{3,}[ \t]*lfh-(?:summary|proposal|change)\b/m.test(raw) ||
    Boolean(parsed.turnSummary) ||
    parsed.proposals.length > 0 ||
    parsed.unparsedBlocks.length > 0
  );
}

/**
 * Parses the complete prefix response and its newly appended suffix, then
 * applies only the suffix's protocol records and refusal diagnostics to the
 * existing turn node.
 */
export function finalizePrefixContinuation(
  node: TurnNode,
  continued: PrefixContinuationResult,
  options: PrefixContinuationFinalizeOptions,
): TurnNode {
  const echoedPrefix = continued.content.startsWith(node.content);
  const rawContinuation = echoedPrefix
    ? continued.content.slice(node.content.length)
    : continued.content;
  const parsedContinuation = parseProposalReply(rawContinuation, {
    finishReason: continued.finishReason,
  });
  const newProposalRecords = buildTurnProposalRecords(
    parsedContinuation,
    options.baseVersions,
    options.now,
  );
  const continuationBody = parsedContinuation.content.trim();
  if (newProposalRecords.length === 0 && !continuationBody) {
    throw new Error('模型没有返回可追加的正文。');
  }
  const refusalVerdict = judgeRefusal(parsedContinuation.content);
  const refusalRoute = routeRefusal(
    parsedContinuation.content,
    refusalVerdict !== null,
    {
      mode: options.mode,
      hasProtocolArtifacts: containsContinuationProtocol(rawContinuation, parsedContinuation),
    },
  );
  if (refusalRoute === 'retry' || refusalRoute === 'retry-skeleton') {
    throw new Error('追要未获得新的有效正文，已保留原有内容，请稍后再试。');
  }
  const matchedRuleId = refusalRoute === 'partial_refused' ? refusalVerdict?.ruleId : undefined;
  const existingDiagnostics = { ...node.diagnostics };
  delete existingDiagnostics.sourceStatus;
  if (refusalRoute === 'pass') {
    delete existingDiagnostics.matchedRuleId;
  }
  const diagnostics = {
    ...existingDiagnostics,
    refusalRoute,
    ...(matchedRuleId ? { matchedRuleId } : {}),
  };
  const proposals = [...(node.proposals ?? []), ...newProposalRecords];

  let nextContent = node.content;
  if (echoedPrefix) {
    const parsed = parseProposalReply(continued.content, {
      finishReason: continued.finishReason,
    });
    if (parsed.content.trim()) {
      nextContent = parsed.content;
    }
  } else if (continuationBody) {
    const leadingWhitespace = rawContinuation.match(/^\s*/)?.[0] ?? '';
    const suffixText = parsedContinuation.content.startsWith(leadingWhitespace)
      ? parsedContinuation.content
      : `${leadingWhitespace}${parsedContinuation.content}`;
    nextContent = `${node.content}${suffixText}`;
  }

  return {
    ...node,
    content: nextContent,
    ...(parsedContinuation.turnSummary ? { turnSummary: parsedContinuation.turnSummary } : {}),
    ...(continued.reasoningContent ? { reasoningContent: continued.reasoningContent } : {}),
    diagnostics,
    ...(proposals.length > 0 ? { proposals } : {}),
  };
}

export interface StoryContinuationContextParams {
  story: Story;
  nodeId: string;
  config: ModelConfig;
  promptPackLibrary?: PromptPackLibrary;
  publicDocument?: MarkdownDocument;
  calculateBranchSummary?: (
    story: Story,
    config: ModelConfig,
    signal?: AbortSignalLike,
  ) => Promise<Story>;
  signal?: AbortSignalLike;
}

/**
 * Catches up branch summary up to the parent of a partial-refused turn and
 * assembles Three-Zone continuation messages with `requireHistory = false` so
 * long stories exceeding `recentMaxChars` never fail on continuation.
 */
export async function prepareStoryContinuationContext(
  params: StoryContinuationContextParams,
): Promise<{
  workingStory: Story;
  node: TurnNode;
  parent: TurnNode;
  messages: LlmMessage[];
  baseVersions: { setting?: string; memory?: string; note?: string };
}> {
  const {
    story,
    nodeId,
    config,
    promptPackLibrary,
    publicDocument,
    calculateBranchSummary,
    signal,
  } = params;
  const node = story.nodes[nodeId];
  if (!node || node.role !== 'assistant' || !node.parentId) {
    throw new Error('半拒绝节点不存在或缺少关联玩家输入。');
  }
  const parent = story.nodes[node.parentId];
  if (!parent || parent.role !== 'user') {
    throw new Error('半拒绝节点缺少关联玩家输入。');
  }
  let workingStory = story;
  if (calculateBranchSummary) {
    const summarized = await calculateBranchSummary(
      { ...story, activeLeafNodeId: node.parentId },
      config,
      signal,
    );
    workingStory = {
      ...summarized,
      activeLeafNodeId: story.activeLeafNodeId,
      updatedAt: story.updatedAt,
    };
  }
  const promptPackOptions = buildPromptPackContextOptions(
    promptPackLibrary,
    workingStory.generationPreference,
  );
  let requestDocuments:
    | {
        publicVersion?: ReturnType<typeof documentVersion>;
        container: ReturnType<typeof documentVersion>;
        local: ReturnType<typeof documentVersion>;
        snapshot: ReturnType<typeof getActiveSummarySnapshot>;
      }
    | undefined;
  if (workingStory.documents) {
    const state = storyDocumentState(
      { ...workingStory, documents: workingStory.documents },
      node.parentId,
      false,
    );
    requestDocuments = {
      ...(publicDocument ? { publicVersion: documentVersion(publicDocument) } : {}),
      container: documentVersion(workingStory.documents.container, state.container),
      local: documentVersion(workingStory.documents.local, state.local),
      snapshot: getActiveSummarySnapshot(workingStory, node.parentId),
    };
  }
  const { messages } = assembleThreeZoneContext(
    workingStory,
    node.parentId,
    undefined,
    undefined,
    false,
    requestDocuments,
    promptPackOptions,
  );
  return {
    workingStory,
    node,
    parent,
    messages,
    baseVersions: {
      setting: requestDocuments?.container.id,
      memory: requestDocuments?.publicVersion?.id,
      note: requestDocuments?.local.id,
    },
  };
}

/**
 * Restores a turn's original refusal text in a node map and invalidates
 * summary snapshots on the node and its descendants so stale summaries of
 * recovered text are never reused.
 */
export function restoreTurnNodeRefusalOriginal(
  nodes: Readonly<Record<string, TurnNode>>,
  nodeId: string,
): {
  nodes: Record<string, TurnNode>;
  restored: TurnNode;
  previousDiagnostics: TurnNode['diagnostics'];
} | null {
  const node = nodes[nodeId];
  if (!node || node.role !== 'assistant') return null;
  const restored = restoreRefusalOriginalContent(node);
  if (restored === node) return null;
  return {
    nodes: invalidateSummarySnapshotsFromNode({ ...nodes, [nodeId]: restored }, nodeId),
    restored,
    previousDiagnostics: node.diagnostics,
  };
}

/**
 * Restores an assistant turn's original refusal text in a Story and
 * invalidates story summary snapshots (including branch-note progress) on the
 * changed subtree.
 */
export function restoreStoryRefusalOriginal(
  story: Story,
  nodeId: string,
): {
  story: Story;
  restored: TurnNode;
  previousDiagnostics: TurnNode['diagnostics'];
} | null {
  const node = story.nodes[nodeId];
  if (!node || node.role !== 'assistant') return null;
  const restored = restoreRefusalOriginalContent(node);
  if (restored === node) return null;
  return {
    story: invalidateStorySummarySnapshotsFromNode(
      { ...story, nodes: { ...story.nodes, [nodeId]: restored } },
      nodeId,
    ),
    restored,
    previousDiagnostics: node.diagnostics,
  };
}

/**
 * Performs one explicit /beta prefix-continuation request and exposes only the
 * newly appended text while streaming. The returned content includes the prefix.
 */
export async function streamPrefixContinuation(
  options: PrefixContinuationOptions,
): Promise<PrefixContinuationResult> {
  const reasoningEffort = normalizeReasoningEffort(options.config.reasoningEffort);
  const prefixProtocol = resolveEffectivePrefixProtocol(options.config);
  const usePrefixCompletion = prefixProtocol !== 'none';
  const requestMessages: LlmMessage[] = usePrefixCompletion
    ? options.messages
    : [
        ...options.messages,
        { role: 'assistant', content: options.prefixContent },
        {
          role: 'user',
          content: '请紧接上一句自然续写后续正文，不要重复已写内容，也不要输出说明或免责声明。',
        },
      ];
  let content = '';
  let shownContinuation = '';
  let reasoningContent = '';
  let finishReason: string | null | undefined;

  for await (const delta of options.transport.streamChat({
    baseUrl: options.config.baseUrl,
    apiKey: options.config.apiKey,
    model: options.config.model,
    reasoningEffort,
    ...(options.config.capabilities ? { capabilities: options.config.capabilities } : {}),
    messages: requestMessages,
    ...(usePrefixCompletion ? { prefixCompletion: { content: options.prefixContent } } : {}),
    signal: options.signal,
  })) {
    if (options.signal?.aborted) {
      const error = new Error('操作已中止。');
      error.name = 'AbortError';
      throw error;
    }
    if (delta.finishReason != null) finishReason = delta.finishReason;
    if (delta.reasoningDelta && reasoningEffort !== 'none') {
      reasoningContent += delta.reasoningDelta;
      options.onReasoningDelta?.(delta.reasoningDelta);
    }
    if (!delta.contentDelta) continue;
    content += delta.contentDelta;
    if (options.prefixContent && options.prefixContent.startsWith(content)) {
      continue;
    }
    const continuation = content.startsWith(options.prefixContent)
      ? content.slice(options.prefixContent.length)
      : content;
    const visibleContinuation = visibleReplyPrefix(continuation);
    if (visibleContinuation.length > shownContinuation.length) {
      options.onContentDelta?.(visibleContinuation.slice(shownContinuation.length));
      shownContinuation = visibleContinuation;
    }
  }

  return {
    content,
    reasoningContent,
    ...(finishReason !== undefined ? { finishReason } : {}),
  };
}
