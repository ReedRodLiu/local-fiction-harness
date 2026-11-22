import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  WAITING_ROTATION_INTERVAL_MS,
  getWaitingPhrases,
} from '../../src/ui/waitingPhrases.ts';

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const readSource = (relPath: string) => readFileSync(join(repoRoot, relPath), 'utf8');

describe('Issue #102: Scenario-aware rotating waiting phrases', () => {
  it('keeps rotation interval within 2.8s–3.5s and provides approved phrase sets per scene', () => {
    expect(WAITING_ROTATION_INTERVAL_MS).toBeGreaterThanOrEqual(2800);
    expect(WAITING_ROTATION_INTERVAL_MS).toBeLessThanOrEqual(3500);

    expect(getWaitingPhrases('story')).toEqual([
      '下一幕在探头…',
      '顺着这一步往下走…',
      '翻翻前面的伏笔…',
    ]);
    expect(getWaitingPhrases('writing')).toEqual([
      '草稿纸上有点动静…',
      '给这段找个落笔处…',
      '把两段话搭个桥…',
    ]);
    expect(getWaitingPhrases('character', { characterName: '沈砚' })).toEqual([
      '沈砚想了想怎么开口…',
      '沈砚在斟酌怎么回你…',
      '沈砚听完，正准备接话…',
    ]);
    expect(getWaitingPhrases('character', { characterName: '   ' })).toEqual([
      'TA想了想怎么开口…',
      'TA在斟酌怎么回你…',
      'TA听完，正准备接话…',
    ]);
    expect(getWaitingPhrases('welcome').length).toBeGreaterThanOrEqual(2);
    expect(getWaitingPhrases('import_fetch').length).toBeGreaterThanOrEqual(2);
    expect(getWaitingPhrases('import_filter').length).toBeGreaterThanOrEqual(2);
    expect(getWaitingPhrases('import_organize').length).toBeGreaterThanOrEqual(2);
  });

  it('wires useRotatingWaitingPhrase across Story, Writing, Character, Welcome, and DeepSeek import views', () => {
    const appSource = readSource('src/ui/App.tsx');
    const draftSource = readSource('src/ui/DraftPane.tsx');
    const charSource = readSource('src/ui/CharacterPane.tsx');
    const welcomeSource = readSource('src/ui/WelcomeView.tsx');
    const importSource = readSource('src/ui/DeepSeekImportPanel.tsx');

    expect(appSource).toContain('useRotatingWaitingPhrase');
    expect(draftSource).toContain('useRotatingWaitingPhrase');
    expect(charSource).toContain('useRotatingWaitingPhrase');
    expect(welcomeSource).toContain('useRotatingWaitingPhrase');
    expect(importSource).toContain('useRotatingWaitingPhrase');

    expect(appSource).not.toContain('<span>思考中…</span>');
    expect(draftSource).not.toContain('<span>思考中…</span>');
    expect(charSource).not.toContain('<span>思考中…</span>');
    expect(welcomeSource).not.toContain('<span>思考中…</span>');
  });
});
