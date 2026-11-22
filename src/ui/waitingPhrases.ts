import { useEffect, useMemo, useState } from 'react';

export const WAITING_ROTATION_INTERVAL_MS = 3000;

export type WaitingScene =
  | 'story'
  | 'writing'
  | 'character'
  | 'welcome'
  | 'import_fetch'
  | 'import_filter'
  | 'import_organize';

const STORY_PHRASES = [
  '下一幕在探头…',
  '顺着这一步往下走…',
  '翻翻前面的伏笔…',
] as const;

const WRITING_PHRASES = [
  '草稿纸上有点动静…',
  '给这段找个落笔处…',
  '把两段话搭个桥…',
] as const;

const WELCOME_PHRASES = [
  '正在接住你的想法…',
  '顺着你说的理一理…',
  '看看从哪里落笔最顺手…',
] as const;

const IMPORT_FETCH_PHRASES = [
  '正在拉取导出压缩包…',
  '正在核对导出包结构…',
  '马上进入会话列表…',
] as const;

const IMPORT_FILTER_PHRASES = [
  '正在翻看这些旧对话…',
  '正在挑出文游与创作记录…',
  '快挑好啦，稍等片刻…',
] as const;

const IMPORT_ORGANIZE_PHRASES = [
  '正在为你理顺故事设定…',
  '正在归拢过往对话分支…',
  '马上就能开始继续故事…',
] as const;

export function getWaitingPhrases(
  scene: WaitingScene,
  options?: { characterName?: string },
): readonly string[] {
  switch (scene) {
    case 'story':
      return STORY_PHRASES;
    case 'writing':
      return WRITING_PHRASES;
    case 'character': {
      const name = options?.characterName?.trim() || 'TA';
      return [
        `${name}想了想怎么开口…`,
        `${name}在斟酌怎么回你…`,
        `${name}听完，正准备接话…`,
      ];
    }
    case 'welcome':
      return WELCOME_PHRASES;
    case 'import_fetch':
      return IMPORT_FETCH_PHRASES;
    case 'import_filter':
      return IMPORT_FILTER_PHRASES;
    case 'import_organize':
      return IMPORT_ORGANIZE_PHRASES;
  }
}

export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

export interface UseRotatingWaitingPhraseOptions {
  scene: WaitingScene;
  active: boolean;
  characterName?: string;
  intervalMs?: number;
}

export function useRotatingWaitingPhrase({
  scene,
  active,
  characterName,
  intervalMs = WAITING_ROTATION_INTERVAL_MS,
}: UseRotatingWaitingPhraseOptions): string {
  const phrases = useMemo(
    () => getWaitingPhrases(scene, { characterName }),
    [scene, characterName],
  );
  const [index, setIndex] = useState(0);

  useEffect(() => {
    setIndex(0);
    if (!active || phrases.length <= 1 || prefersReducedMotion()) {
      return;
    }
    const timer = window.setInterval(() => {
      setIndex((prev) => (prev + 1) % phrases.length);
    }, intervalMs);
    return () => {
      window.clearInterval(timer);
    };
  }, [active, phrases, intervalMs]);

  return phrases[index % phrases.length] ?? phrases[0] ?? '';
}
