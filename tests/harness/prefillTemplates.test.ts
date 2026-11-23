import { describe, expect, it } from 'vitest';
import { buildModePrefill, PREFILL_TEMPLATES } from '../../src/harness/index.ts';

describe('DeepSeek prefix completion narrative prefill templates', () => {
  it('provides unfinished Chinese openings for all three modes', () => {
    expect(buildModePrefill('story')).toBe('雨声在屋檐上碎成一片。他抬头，正好看见');
    expect(buildModePrefill('writing')).toBe('那年的雨也是这样，落在');
    expect(buildModePrefill('character')).toBe('（她把杯子往你面前推了推）你正要开口，');

    for (const templates of Object.values(PREFILL_TEMPLATES)) {
      for (const template of Object.values(templates)) {
        expect(template).toMatch(/[\u3400-\u9fff]/);
        expect(template).not.toMatch(/sure,?\s+here is/i);
        expect(template).not.toMatch(/[。！？.!?…）】」』”’]\s*$/);
      }
    }
  });

  it('selects a mode variant and uses a character name for dialogue prefixes', () => {
    expect(buildModePrefill('story', { variant: 'dialogue' })).toBe(
      '"别回头，"他压低声音，"后面',
    );
    expect(buildModePrefill('writing', { variant: 'scene' })).toBe(
      '城门在身后合上时，他忽然意识到',
    );
    expect(buildModePrefill('character', { characterName: '沈砚' })).toBe('沈砚：');
    expect(buildModePrefill('character', { variant: 'dialogue', characterName: '沈砚' })).toBe(
      '沈砚：',
    );
    expect(buildModePrefill('character', { variant: 'dialogue' })).toBe('你听见她轻声说：');
    expect(JSON.stringify(PREFILL_TEMPLATES)).not.toContain('阿箬');
  });

  it('lets an explicit custom prefix take precedence without rewriting it', () => {
    expect(
      buildModePrefill('story', {
        variant: 'scene',
        customPrefix: '自定义起手……',
      }),
    ).toBe('自定义起手……');
  });
});
