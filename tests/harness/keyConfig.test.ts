import { describe, expect, it } from 'vitest';
import {
  isOfficialDeepSeekUrl,
  normalizeGenerationPreference,
  normalizeOfficialModelConfig,
  resolveEffectiveModelConfig,
  type ModelConfig,
} from '../../src/harness/index.ts';

const baseConfig: ModelConfig = {
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-flash',
  apiKey: 'sk-test-key',
  memoryOnly: false,
};

describe('Prompt Pack generation preference, official URL detection, and arbitrary model resolution', () => {
  it('keeps the API key when a beta base URL is normalized back to the official stable URL', () => {
    const normalized = normalizeOfficialModelConfig({
      ...baseConfig,
      baseUrl: 'https://api.deepseek.com/beta',
    });

    expect(normalized.baseUrl).toBe('https://api.deepseek.com');
    expect(normalized.apiKey).toBe('sk-test-key');
  });

  it('detects official DeepSeek base URLs across v1/beta/trailing-slash variants', () => {
    expect(isOfficialDeepSeekUrl('https://api.deepseek.com')).toBe(true);
    expect(isOfficialDeepSeekUrl('  HTTPS://api.deepseek.com/v1/  ')).toBe(true);
    expect(isOfficialDeepSeekUrl('https://api.deepseek.com/beta')).toBe(true);
    expect(isOfficialDeepSeekUrl('https://api.openai.com/v1')).toBe(false);
    expect(isOfficialDeepSeekUrl('https://relay.example.com/deepseek')).toBe(false);
    expect(isOfficialDeepSeekUrl('')).toBe(false);
  });

  it('keeps valid prompt-pack, prefix-completion, providerId, and arbitrary non-DeepSeek models in GenerationPreference', () => {
    expect(
      normalizeGenerationPreference({
        providerId: '  openai-main  ',
        model: '  gpt-4o-mini  ',
        reasoningEffort: 'medium',
        promptPackMode: 'pack-custom',
        prefixCompletion: 'always',
      }),
    ).toEqual({
      providerId: 'openai-main',
      model: 'gpt-4o-mini',
      reasoningEffort: 'medium',
      promptPackMode: 'pack-custom',
      prefixCompletion: 'always',
    });

    expect(
      normalizeGenerationPreference({
        providerId: '   ',
        model: 'x'.repeat(201),
        promptPackMode: '',
        prefixCompletion: 'invalid' as never,
      }),
    ).toBeUndefined();
  });

  it('preserves arbitrary non-empty override.model in resolveEffectiveModelConfig', () => {
    const thirdPartyGlobal: ModelConfig = {
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o',
      reasoningEffort: 'none',
      apiKey: 'sk-openai',
      memoryOnly: false,
    };

    expect(
      resolveEffectiveModelConfig(thirdPartyGlobal, {
        model: '  claude-3-7-sonnet  ',
        reasoningEffort: 'medium',
      }),
    ).toMatchObject({
      baseUrl: 'https://api.openai.com/v1',
      model: 'claude-3-7-sonnet',
      reasoningEffort: 'medium',
    });
  });
});
