import { describe, expect, it } from 'vitest';
import {
  normalizeGenerationPreference,
  normalizeOfficialModelConfig,
  type ModelConfig,
} from '../../src/harness/index.ts';

const baseConfig: ModelConfig = {
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-flash',
  apiKey: 'sk-test-key',
  memoryOnly: false,
};

describe('Prompt Pack generation preference and official beta endpoint normalization', () => {
  it('keeps the API key when a beta base URL is normalized back to the official stable URL', () => {
    const normalized = normalizeOfficialModelConfig({
      ...baseConfig,
      baseUrl: 'https://api.deepseek.com/beta',
    });

    expect(normalized.baseUrl).toBe('https://api.deepseek.com');
    expect(normalized.apiKey).toBe('sk-test-key');
  });

  it('keeps valid prompt-pack and prefix-completion overrides and drops invalid values', () => {
    expect(
      normalizeGenerationPreference({
        promptPackMode: 'pack-custom',
        prefixCompletion: 'always',
      }),
    ).toEqual({
      promptPackMode: 'pack-custom',
      prefixCompletion: 'always',
    });

    expect(
      normalizeGenerationPreference({
        promptPackMode: '',
        prefixCompletion: 'invalid' as never,
      }),
    ).toBeUndefined();
  });
});
