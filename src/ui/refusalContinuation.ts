import {
  buildTurnProposalRecords,
  judgeRefusal,
  normalizeReasoningEffort,
  parseProposalReply,
  routeRefusal,
  type AbortSignalLike,
  type DeliveryMode,
  type LlmMessage,
  type LlmTransport,
  type ModelConfig,
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
  const parsed = parseProposalReply(continued.content, {
    finishReason: continued.finishReason,
  });
  const rawContinuation = continued.content.startsWith(node.content)
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
  const visibleContent = parsed.content.trim();
  if (newProposalRecords.length === 0 && (!visibleContent || visibleContent === node.content.trim())) {
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
  const matchedRuleId = refusalVerdict?.ruleId ??
    (refusalRoute === 'retry-skeleton' ? 'skeleton-01' : undefined);
  const clearsLegacyRefusalSource = refusalRoute === 'pass' || refusalRoute === 'partial_refused';
  const marksRefusalSource = !clearsLegacyRefusalSource;
  const existingDiagnostics = { ...node.diagnostics };
  if (clearsLegacyRefusalSource && existingDiagnostics.sourceStatus === 'REFUSAL') {
    delete existingDiagnostics.sourceStatus;
  }
  const diagnostics = {
    ...existingDiagnostics,
    refusalRoute,
    ...(marksRefusalSource ? { sourceStatus: 'REFUSAL' as const } : {}),
    ...(matchedRuleId ? { matchedRuleId } : {}),
  };
  const proposals = [...(node.proposals ?? []), ...newProposalRecords];

  return {
    ...node,
    content: visibleContent ? parsed.content : node.content,
    ...(parsedContinuation.turnSummary ? { turnSummary: parsedContinuation.turnSummary } : {}),
    ...(continued.reasoningContent ? { reasoningContent: continued.reasoningContent } : {}),
    diagnostics,
    ...(proposals.length > 0 ? { proposals } : {}),
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
  let content = '';
  let shownContinuation = '';
  let reasoningContent = '';
  let finishReason: string | null | undefined;

  for await (const delta of options.transport.streamChat({
    baseUrl: options.config.baseUrl,
    apiKey: options.config.apiKey,
    model: options.config.model,
    reasoningEffort,
    messages: options.messages,
    prefixCompletion: { content: options.prefixContent },
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
    const continuation = content.startsWith(options.prefixContent)
      ? content.slice(options.prefixContent.length)
      : content;
    if (continuation.length > shownContinuation.length) {
      options.onContentDelta?.(continuation.slice(shownContinuation.length));
      shownContinuation = continuation;
    }
  }

  return {
    content,
    reasoningContent,
    ...(finishReason !== undefined ? { finishReason } : {}),
  };
}
