import { describe, expect, it } from 'vitest';
import { detectNaturalModeSwitchIntent } from '../../src/harness/index.ts';

describe('explicit natural-language mode switches', () => {
  it.each([
    ['帮我切换到写故事吧', 'writing'],
    ['现在请把模式切换为写故事', 'writing'],
    ['麻烦帮我把当前 App 模式切换成角色互动。', 'character'],
    ['我想切换到写故事', 'writing'],
    ['我希望把模式切换成写故事', 'writing'],
    ['请把它切换到写故事', 'writing'],
    ['切换到小说', 'writing'],
    ['把模式改成小说', 'writing'],
    ['请切换到写故事，谢谢。', 'writing'],
  ] as const)('accepts the complete explicit request %s', (input, expected) => {
    expect(detectNaturalModeSwitchIntent(input)).toBe(expected);
  });

  it.each([
    '请帮我改成小说',
    '把故事改成小说',
    '把故事切换到小说',
    '改成小说',
    '把这一段改成小说里的书信体。',
    '下一幕转成角色互动式对话',
    '现在请把这一段改成小说里的书信体，并保持第一人称。',
    '请切换到写故事，谢谢，并保留当前第一人称。',
    '请切换到写故事，谢谢你的耐心。',
  ])('keeps contextual prose in the active mode: %s', (input) => {
    expect(detectNaturalModeSwitchIntent(input)).toBeNull();
  });
});
