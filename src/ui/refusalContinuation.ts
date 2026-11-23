import {
  normalizeReasoningEffort,
  type AbortSignalLike,
  type LlmMessage,
  type LlmTransport,
  type ModelConfig,
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
