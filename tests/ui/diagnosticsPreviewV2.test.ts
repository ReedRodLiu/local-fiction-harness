import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  createDiagnosticCollector,
  emptyWorkspace,
  formatDiagnosticBundleFileName,
  type DiagnosticBundle,
  type Story,
} from '../../src/harness/index.ts';
import { DiagnosticsPreview, buildDiagnosticsExportPayload } from '../../src/ui/DiagnosticsPreview.tsx';
import { SettingsPage } from '../../src/ui/SettingsPage.tsx';
import { BannerAlert } from '../../src/ui/primitives/BannerAlert.tsx';

vi.mock('../../src/ui/useWebHistoryLayer.ts', () => ({ useWebHistoryLayer: () => undefined }));

const repoRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

function makeSampleBundle(userNote?: string): DiagnosticBundle {
  const collector = createDiagnosticCollector({ platform: 'web', now: () => 1700000000000 });
  const story: Story = {
    id: 's1',
    title: '绝密剧本标题',
    rawScript: '绝密剧本正文',
    blueprint: {
      title: '绝密剧本标题',
      worldRules: ['规则一'],
      protagonist: '主角',
      npcs: [],
      taboos: [],
      openingHook: '开场',
      extractionStatus: 'complete',
    },
    nodes: {},
    rootNodeIds: [],
    activeLeafNodeId: null,
    createdAt: 1,
    updatedAt: 1,
  };
  return collector.buildBundle(
    { baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', apiKey: 'sk-secret-123456', memoryOnly: false },
    {
      trigger: 'settings_manual',
      userNote,
      activeStory: story,
      workspace: {
        stories: [story],
        creativeWorkspace: emptyWorkspace(),
      },
      appEnv: {
        platform: 'web',
        appVersion: '0.2.0',
        viewport: '1280x800',
        activeView: 'settings',
        storyCount: 1,
        workCount: 0,
        characterCount: 0,
      },
    },
  );
}

describe('DiagnosticsPreview V2, BannerAlert, SettingsPage & Android Share contracts', () => {
  it('renders human-first checklist, collapsed raw JSON details, userNote input, and workspace toggle', () => {
    const markup = renderToStaticMarkup(
      createElement(DiagnosticsPreview, {
        open: true,
        buildBundle: ({ userNote } = {}) => makeSampleBundle(userNote),
        onExport: vi.fn(async () => undefined),
        onClose: vi.fn(),
        onExitComplete: vi.fn(),
      }),
    );

    expect(markup).toContain('导出排障日志');
    expect(markup).toContain('将包含：最近 60 分钟运行记录、设备与版本信息、当前结构统计');
    expect(markup).toContain('绝不包含：你的剧本、设定正文、聊天记录与 DeepSeek 密钥');
    expect(markup).toContain('遇到什么问题？（选填）');
    expect(markup).toContain('附带工作区匿名结构计数');
    expect(markup).toContain('data-testid="diagnostics-active-story"');
    expect(markup).toContain('checked=""');
    expect(markup).toContain('查看原始 JSON');
    expect(markup).not.toMatch(/<details[^>]* open=/);
    expect(markup).toContain('分享 / 导出日志包');
    expect(markup).toContain('复制到剪贴板');
    expect(markup).not.toContain('绝密剧本正文');
    expect(markup).not.toContain('sk-secret-123456');
  });

  it('includes sanitized userNote and toggles both activeStorySkeleton and workspaceSkeleton', () => {
    const withSkeleton = buildDiagnosticsExportPayload(makeSampleBundle('切换分支后卡顿 Bearer sk-secret-9999'), {
      includeWorkspaceSkeleton: true,
      userNote: '切换分支后卡顿 Bearer sk-secret-9999',
    });
    expect(withSkeleton.bundle.activeStorySkeleton).toBeDefined();
    expect(withSkeleton.bundle.workspaceSkeleton).toBeDefined();
    expect(withSkeleton.bundle.userNote).toContain('切换分支后卡顿');
    expect(withSkeleton.jsonText).not.toContain('sk-secret-9999');

    const withoutSkeleton = buildDiagnosticsExportPayload(makeSampleBundle(), {
      includeWorkspaceSkeleton: false,
      userNote: '',
    });
    expect(withoutSkeleton.bundle.activeStorySkeleton).toBeUndefined();
    expect(withoutSkeleton.bundle.workspaceSkeleton).toBeUndefined();
    expect(formatDiagnosticBundleFileName(new Date('2026-11-21T12:00:00.000Z'))).toBe(
      'folio-logs-2026-11-21T12-00-00-000Z.json',
    );
  });

  it('renders BannerAlert with optional trailing action link and dismiss button', () => {
    const markup = renderToStaticMarkup(
      createElement(BannerAlert, {
        tone: 'danger',
        testId: 'async-error-banner',
        action: { label: '导出日志', onClick: vi.fn() },
        onDismiss: vi.fn(),
        children: '后台操作失败',
      }),
    );
    expect(markup).toContain('后台操作失败');
    expect(markup).toContain('导出日志');
    expect(markup).toContain('data-testid="async-error-banner-action"');
    expect(markup).toContain('data-testid="async-error-banner-dismiss"');
  });

  it('updates SettingsPage labels, .folio.json backup UI, and collapsible 高级排障', () => {
    const disconnectedMarkup = renderToStaticMarkup(
      createElement(SettingsPage, {
        appVersion: '0.2.0',
        hasCredentials: false,
        config: { baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', apiKey: '', memoryOnly: false },
        useDevEnvKey: false,
        showDevTestProxy: false,
        themePreference: 'light',
        fontSize: 16,
        canExportCurrentStory: true,
        currentStoryTitle: '雨夜车站',
        onBack: vi.fn(),
        onOpenSetupWizard: vi.fn(),
        onClearSavedKey: vi.fn(),
        onApplyDevTestConfig: vi.fn(),
        onOpenDiagnostics: vi.fn(),
        onOpenPublicMemory: vi.fn(),
        onExportCurrentStory: vi.fn(),
        onImportBackupFile: vi.fn(),
        onThemePreferenceChange: vi.fn(),
        onFontSizeChange: vi.fn(),
      }),
    );
    expect(disconnectedMarkup).toContain('连接 DeepSeek');
    expect(disconnectedMarkup).not.toContain('连接 DeepSeek 钥匙');
    expect(disconnectedMarkup).toContain('我的记忆');
    expect(disconnectedMarkup).toContain('管理我的记忆');
    expect(disconnectedMarkup).not.toContain('公共记忆');
    expect(disconnectedMarkup).toContain('全量数据备份与恢复');
    expect(disconnectedMarkup).toContain('导出全量备份 (.folio.json)');
    expect(disconnectedMarkup).toContain('accept=".folio.json,.lfh.json,.json,application/json"');
    expect(disconnectedMarkup).toContain('从备份恢复');
    expect(disconnectedMarkup).toContain('问题反馈与日志');
    expect(disconnectedMarkup).toContain('导出排障日志');
    expect(disconnectedMarkup).toContain('高级排障');
    expect(disconnectedMarkup).not.toMatch(/<details[^>]* open=/);
    expect(disconnectedMarkup).toContain('Folio v0.2.0');
    expect(disconnectedMarkup).not.toContain('APP_VERSION');

    const connectedMarkup = renderToStaticMarkup(
      createElement(SettingsPage, {
        appVersion: '0.2.0',
        hasCredentials: true,
        config: { baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', apiKey: 'sk-1234567890abcd', memoryOnly: false },
        useDevEnvKey: false,
        showDevTestProxy: false,
        themePreference: 'light',
        fontSize: 16,
        canExportCurrentStory: false,
        currentStoryTitle: '',
        onBack: vi.fn(),
        onOpenSetupWizard: vi.fn(),
        onClearSavedKey: vi.fn(),
        onApplyDevTestConfig: vi.fn(),
        onOpenDiagnostics: vi.fn(),
        onOpenPublicMemory: vi.fn(),
        onExportCurrentStory: vi.fn(),
        onImportBackupFile: vi.fn(),
        onThemePreferenceChange: vi.fn(),
        onFontSizeChange: vi.fn(),
      }),
    );
    expect(connectedMarkup).toContain('data-testid="connected-key-mask"');
  });

  it('uses NativeVaultPlugin share chooser title 分享排障日志 for folio-logs- without extra permissions', () => {
    const javaSource = readFileSync(
      join(repoRoot, 'android', 'app', 'src', 'main', 'java', 'io', 'localfiction', 'harness', 'NativeVaultPlugin.java'),
      'utf8',
    );
    const manifestSource = readFileSync(
      join(repoRoot, 'android', 'app', 'src', 'main', 'AndroidManifest.xml'),
      'utf8',
    );

    expect(javaSource).toContain('folio-logs-');
    expect(javaSource).toContain('分享排障日志');
    expect(javaSource).toContain('FileProvider.getUriForFile');
    expect(javaSource).toContain('Intent.createChooser');
    expect(manifestSource).not.toContain('WRITE_EXTERNAL_STORAGE');
    expect(manifestSource).not.toContain('READ_EXTERNAL_STORAGE');
  });
});
