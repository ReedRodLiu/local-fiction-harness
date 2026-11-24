import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { toErrorMessage } from '../../src/ui/textHelpers.ts';

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

describe('Issue #101: readable network error mapping & non-overlapping composer flow notices', () => {
  it('translates raw Socket/fetch exceptions into Chinese user-facing messages', () => {
    expect(toErrorMessage(new Error('Software caused connection abort'), 'fallback')).toContain(
      '系统或网络切换中断',
    );
    expect(toErrorMessage(new Error('Connection reset by peer'), 'fallback')).toContain(
      '连接意外断开',
    );
    expect(toErrorMessage(new Error('Read timed out'), 'fallback')).toContain('超时');
    expect(toErrorMessage(new Error('Failed to fetch'), 'fallback')).toContain('无法连接模型服务器');
    expect(toErrorMessage(new Error('SSLException: handshake aborted'), 'fallback')).toContain(
      'HTTPS 安全连接',
    );
    expect(toErrorMessage(new Error('余额不足'), 'fallback')).toBe('余额不足');
    expect(toErrorMessage(null, '兜底错误')).toBe('兜底错误');
  });

  it('places error banners inside flow-layout .composer-flow-notices across all 3 modes', () => {
    for (const relPath of ['src/ui/App.tsx', 'src/ui/CharacterPane.tsx', 'src/ui/DraftPane.tsx']) {
      const source = readFileSync(join(repoRoot, relPath), 'utf8');
      expect(source).toContain('className="composer-flow-notices"');
      expect(source).toContain('onDismiss=');
    }
  });
});
