import { describe, expect, it } from 'vitest';
import { detectNaturalModeSwitchIntent } from '../../src/harness/index.ts';

describe('explicit natural-language mode switches', () => {
  it.each([
    ['帮我切换到写故事吧', 'writing'],
    ['现在请把模式切换为写故事', 'writing'],
    ['麻烦帮我把当前 App 模式切换成角色互动。', 'character'],
  ] as const)('accepts the complete explicit request %s', (input, expected) => {
    expect(detectNaturalModeSwitchIntent(input)).toBe(expected);
  });

  it.each([
    '把这一段改成小说里的书信体。',
    '下一幕转成角色互动式对话',
    '现在请把这一段改成小说里的书信体，并保持第一人称。',
  ])('keeps contextual prose in the active mode: %s', (input) => {
    expect(detectNaturalModeSwitchIntent(input)).toBeNull();
  });
});
