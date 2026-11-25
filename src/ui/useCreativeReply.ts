import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import {
  createDefaultId,
  EMPTY_SUMMARY_SNAPSHOT,
  streamCreativeReply,
  type CharacterConversation,
  type CreativeWorkspaceState,
  type DraftWork,
  type LlmMessage,
  type LlmTransport,
  type LocalCharacter,
  type MarkdownProposal,
  type ModelConfig,
  type PlatformRuntime,
  type RefusalStreamIntegrationOptions,
  type TurnCallbacks,
  type TurnNode,
} from '../harness/index.ts';
import {
  getComposerEnterKeyHint,
  shouldSubmitComposerOnEnter,
  toErrorMessage,
} from './textHelpers.ts';

export type RequestModel = (label: string, run: (config: ModelConfig) => void) => void;

export type CreativeReplyRequestOptions = {
  onVisibleDelta?: (delta: string) => void;
  config?: ModelConfig;
  refusalOptions?: RefusalStreamIntegrationOptions;
};

/**
 * Wraps `streamCreativeReply` for UI callers so `refusalOptions` is forwarded as
 * the dedicated 5th argument rather than merged into stream callbacks.
 */
export function createCreativeReplyRequest(
  transport: LlmTransport,
  defaultConfig: ModelConfig,
  callbacks: TurnCallbacks,
) {
  return (messages: LlmMessage[], options?: CreativeReplyRequestOptions) =>
    streamCreativeReply(
      transport,
      options?.config ?? defaultConfig,
      messages,
      {
        ...callbacks,
        onContentDelta: (delta) => {
          if (callbacks.signal?.aborted) return;
          if (options?.onVisibleDelta) options.onVisibleDelta(delta);
          else callbacks.onContentDelta?.(delta);
        },
      },
      options?.refusalOptions,
    );
}

export function updateWork(
  state: CreativeWorkspaceState,
  id: string,
  update: (work: DraftWork) => DraftWork,
): CreativeWorkspaceState {
  if (!state.works.some((work) => work.id === id)) throw new Error('作品已不存在。');
  return { ...state, works: state.works.map((work) => (work.id === id ? update(work) : work)) };
}

export function updateCharacter(
  state: CreativeWorkspaceState,
  id: string,
  update: (character: LocalCharacter) => LocalCharacter,
): CreativeWorkspaceState {
  if (!state.characters.some((character) => character.id === id)) throw new Error('角色已不存在。');
  return {
    ...state,
    characters: state.characters.map((character) => (character.id === id ? update(character) : character)),
  };
}

export function updateConversation(
  character: LocalCharacter,
  id: string,
  update: (conversation: CharacterConversation) => CharacterConversation,
): LocalCharacter {
  if (!character.conversations.some((conversation) => conversation.id === id)) {
    throw new Error('对话已不存在。');
  }
  return {
    ...character,
    conversations: character.conversations.map((conversation) =>
      conversation.id === id ? update(conversation) : conversation,
    ),
  };
}

export function makeTurn(
  role: TurnNode['role'],
  content: string,
  parentId: string | null,
  turnSummary?: string,
): TurnNode {
  return {
    id: createDefaultId(),
    parentId,
    role,
    content,
    ...(turnSummary ? { turnSummary } : {}),
    summarySnapshot: EMPTY_SUMMARY_SNAPSHOT,
    createdAt: Date.now(),
  };
}

export function sendOnEnter(
  event: KeyboardEvent<HTMLTextAreaElement>,
  onSubmit?: () => void,
) {
  if (!shouldSubmitComposerOnEnter(event)) {
    return;
  }
  event.preventDefault();
  if (onSubmit) {
    onSubmit();
  } else {
    event.currentTarget.form?.requestSubmit();
  }
}

export function useComposerEnterKeyHint(): 'enter' | 'send' {
  const [enterKeyHint, setEnterKeyHint] = useState<'enter' | 'send'>(() => getComposerEnterKeyHint());

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const queries = [
      window.matchMedia('(pointer: coarse)'),
      window.matchMedia('(pointer: fine)'),
    ];
    const update = () => setEnterKeyHint(getComposerEnterKeyHint());
    update();
    for (const mq of queries) {
      if (typeof mq.addEventListener === 'function') {
        mq.addEventListener('change', update);
      } else if (typeof mq.addListener === 'function') {
        mq.addListener(update);
      }
    }
    return () => {
      for (const mq of queries) {
        if (typeof mq.removeEventListener === 'function') {
          mq.removeEventListener('change', update);
        } else if (typeof mq.removeListener === 'function') {
          mq.removeListener(update);
        }
      }
    };
  }, []);

  return enterKeyHint;
}

export function replyContent(content: string, proposal?: MarkdownProposal) {
  return content.trim() || (proposal ? '请核对拟保存的文档。' : '');
}

export function syncTextareaHeight(textarea: HTMLTextAreaElement) {
  if (!CSS.supports('field-sizing', 'content')) {
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, 180)}px`;
  }
}

export function useCreativeReply(runtime: PlatformRuntime, requestModel: RequestModel) {
  const active = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const [busy, setBusy] = useState(false);
  const [output, setOutput] = useState('');
  const [reasoning, setReasoning] = useState('');
  const [refusalRetrying, setRefusalRetrying] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      active.current?.abort();
    };
  }, []);

  function start(
    label: string,
    run: (
      request: (
        messages: LlmMessage[],
        options?: CreativeReplyRequestOptions,
      ) => ReturnType<typeof streamCreativeReply>,
      signal: AbortSignal,
      config: ModelConfig,
      setStreamText: (next: string) => void,
      appendReasoning: (delta: string) => void,
      onRefusalRetry: () => void,
    ) => Promise<void>,
  ) {
    requestModel(label, (config) => {
      if (!mounted.current || active.current) return;
      const controller = new AbortController();
      active.current = controller;
      setBusy(true);
      setError('');
      setOutput('');
      setReasoning('');
      setRefusalRetrying(false);
      const handleRefusalRetry = () => {
        if (!controller.signal.aborted) {
          setRefusalRetrying(true);
          setOutput('');
          setReasoning('');
        }
      };
      const request = createCreativeReplyRequest(runtime.transport, config, {
        signal: controller.signal,
        onReasoningDelta: (delta) => {
          if (!controller.signal.aborted) setReasoning((text) => text + delta);
        },
        onContentDelta: (delta) => {
          if (!controller.signal.aborted) setOutput((text) => text + delta);
        },
        onRefusalRetry: handleRefusalRetry,
      });
      void run(
        request,
        controller.signal,
        config,
        (next) => {
          if (!controller.signal.aborted) setOutput(next);
        },
        (delta) => {
          if (!controller.signal.aborted) setReasoning((text) => text + delta);
        },
        handleRefusalRetry,
      )
        .catch((err) => {
          if (!controller.signal.aborted) setError(toErrorMessage(err, '生成失败，请重试。'));
        })
        .finally(() => {
          if (active.current !== controller) return;
          active.current = null;
          if (!mounted.current) return;
          setOutput('');
          setReasoning('');
          setRefusalRetrying(false);
          setBusy(false);
        });
    });
  }

  const fail = (err: unknown) => setError(toErrorMessage(err, '本地操作失败。'));
  const clearError = () => setError('');
  return {
    start,
    busy,
    output,
    reasoning,
    refusalRetrying,
    error,
    fail,
    clearError,
    stop: () => active.current?.abort(),
  };
}
