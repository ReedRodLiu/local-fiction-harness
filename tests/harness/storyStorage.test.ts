import { describe, expect, it } from 'vitest';
import { validateGenerationPreference } from '../../src/harness/index.ts';

describe('storyStorage validateGenerationPreference', () => {
  it('accepts providerId, arbitrary non-empty model names, and widened reasoningEffort values', () => {
    expect(
      validateGenerationPreference(
        {
          providerId: '  openai-1  ',
          model: '  gpt-4o-mini  ',
          reasoningEffort: 'medium',
          promptPackMode: '  custom-pack  ',
          prefixCompletion: 'on_retry',
        },
        '测试故事',
      ),
    ).toEqual({
      providerId: 'openai-1',
      model: 'gpt-4o-mini',
      reasoningEffort: 'medium',
      promptPackMode: 'custom-pack',
      prefixCompletion: 'on_retry',
    });

    expect(validateGenerationPreference(undefined, '测试故事')).toBeUndefined();
    expect(validateGenerationPreference({}, '测试故事')).toBeUndefined();
  });

  it('rejects invalid providerId, empty or over-200-char model, invalid reasoningEffort, and non-objects', () => {
    expect(() => validateGenerationPreference('bad', '测试故事')).toThrow(/generationPreference 必须为对象/);
    expect(() => validateGenerationPreference({ providerId: '   ' }, '测试故事')).toThrow(/providerId 无效/);
    expect(() => validateGenerationPreference({ model: '   ' }, '测试故事')).toThrow(/model 无效/);
    expect(() => validateGenerationPreference({ model: 'a'.repeat(201) }, '测试故事')).toThrow(/model 无效/);
    expect(() => validateGenerationPreference({ reasoningEffort: 'ultra' }, '测试故事')).toThrow(
      /reasoningEffort 无效/,
    );
  });
});
