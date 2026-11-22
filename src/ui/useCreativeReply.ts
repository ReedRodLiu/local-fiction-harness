import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import {
  createDefaultId,
  EMPTY_SUMMARY_SNAPSHOT,
  streamCreativeReply,
  type CharacterConversation,
  type CreativeWorkspaceState,
  type DraftWork,
  type LlmMessage,
  type LocalCharacter,
  type MarkdownProposal,
  type ModelConfig,
  type PlatformRuntime,
  type TurnNode,
} from '../harness/index.ts';
import { toErrorMessage } from './textHelpers.ts';

export type RequestModel = (label: string, run: (config: ModelConfig) => void) => void;

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

export function sendOnEnter(event: KeyboardEvent<HTMLTextAreaElement>) {
  if (
    event.key !== 'Enter' ||
    event.shiftKey ||
    event.nativeEvent.isComposing ||
    event.nativeEvent.keyCode === 229
  ) {
    return;
  }
  event.preventDefault();
  event.currentTarget.form?.requestSubmit();
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
        options?: { onVisibleDelta?: (delta: string) => void; config?: ModelConfig },
      ) => ReturnType<typeof streamCreativeReply>,
      signal: AbortSignal,
      config: ModelConfig,
      setStreamText: (next: string) => void,
      appendReasoning: (delta: string) => void,
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
      void run(
        (messages, options) =>
          streamCreativeReply(runtime.transport, options?.config ?? config, messages, {
            signal: controller.signal,
            onReasoningDelta: (delta) => {
              if (!controller.signal.aborted) setReasoning((text) => text + delta);
            },
            onContentDelta: (delta) => {
              if (!controller.signal.aborted) {
                if (options?.onVisibleDelta) options.onVisibleDelta(delta);
                else setOutput((text) => text + delta);
              }
            },
          }),
        controller.signal,
        config,
        (next) => {
          if (!controller.signal.aborted) setOutput(next);
        },
        (delta) => {
          if (!controller.signal.aborted) setReasoning((text) => text + delta);
        },
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
          setBusy(false);
        });
    });
  }

  const fail = (err: unknown) => setError(toErrorMessage(err, '本地操作失败。'));
  return { start, busy, output, reasoning, error, fail, stop: () => active.current?.abort() };
}
