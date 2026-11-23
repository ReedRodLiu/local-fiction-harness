export type PrefillMode = 'story' | 'writing' | 'character';
export type PrefillVariant = 'opening' | 'dialogue' | 'scene';

export interface BuildModePrefillOptions {
  variant?: PrefillVariant;
  characterName?: string;
  customPrefix?: string;
}

export const PREFILL_TEMPLATES: Readonly<
  Record<PrefillMode, Readonly<Record<PrefillVariant, string>>>
> = {
  story: {
    opening: '雨声在屋檐上碎成一片。他抬头，正好看见',
    dialogue: '"别回头，"他压低声音，"后面',
    scene: '灯忽然灭了。黑暗里，',
  },
  writing: {
    opening: '那年的雨也是这样，落在',
    dialogue: '"我记得那天，"她停顿了一下，"你',
    scene: '城门在身后合上时，他忽然意识到',
  },
  character: {
    opening: '（她把杯子往你面前推了推）你正要开口，',
    dialogue: '（她放下杯子，抬眼看向你）你',
    scene: '（沉默了很久）她终于开口：',
  },
};

export function buildModePrefill(
  mode: PrefillMode,
  options: BuildModePrefillOptions = {},
): string {
  if (options.customPrefix !== undefined) {
    return options.customPrefix;
  }

  const variant =
    options.variant ??
    (mode === 'character' && options.characterName?.trim() ? 'dialogue' : 'opening');
  if (mode === 'character' && variant === 'dialogue') {
    const characterName = options.characterName?.trim();
    if (characterName) {
      return `${characterName}：`;
    }
  }

  return PREFILL_TEMPLATES[mode][variant];
}
