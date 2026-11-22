import { describe, expect, it } from 'vitest';
import {
  buildRedactedWorkspaceSkeleton,
  createDiagnosticCollector,
  DIAGNOSTIC_BUNDLE_FILENAME_PREFIX,
  DIAGNOSTIC_STORAGE_KEY,
  DIAGNOSTIC_WINDOW_MS,
  formatDiagnosticBundleFileName,
  MAX_DIAGNOSTIC_EVENTS,
  newCharacter,
  newConversation,
  newDocument,
  newWork,
  type KeyValueStorage,
  type Story,
  type TurnNode,
} from '../../src/harness/index.ts';

function createMemoryKv(): KeyValueStorage {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => {
      map.set(k, v);
    },
    removeItem: (k) => {
      map.delete(k);
    },
  };
}

function makeTurnNode(
  id: string,
  parentId: string | null,
  role: TurnNode['role'],
  createdAt: number,
  content: string,
): TurnNode {
  return {
    id,
    parentId,
    role,
    content,
    reasoningContent: `思考链_${id}_CANARY`,
    createdAt,
    summarySnapshot: {
      content: `摘要_${id}_CANARY`,
      coveredUpToNodeId: parentId,
      summarizedTurnCount: 1,
    },
  };
}

function makeSyntheticStory(): Story {
  const n1 = makeTurnNode('story-n1-CANARY', null, 'user', 1, '绝密玩家首句_CANARY');
  const n2 = makeTurnNode('story-n2-CANARY', n1.id, 'assistant', 2, '绝密模型续写_CANARY');
  return {
    id: 'story-id-CANARY',
    title: '绝密文游标题_CANARY',
    sourceKind: 'manual_script',
    rawScript: '绝密原始剧本设定_CANARY',
    blueprint: {
      title: '绝密蓝图标题_CANARY',
      worldRules: ['绝密世界规则_CANARY'],
      protagonist: '绝密主角名_CANARY',
      npcs: [{ name: '绝密NPC名_CANARY', role: '反派', traits: '绝密性格_CANARY' }],
      taboos: ['绝密禁忌_CANARY'],
      openingHook: '绝密开局钩子_CANARY',
      extractionStatus: 'complete',
    },
    nodes: { [n1.id]: n1, [n2.id]: n2 },
    rootNodeIds: [n1.id],
    activeLeafNodeId: n2.id,
    setupNodeIds: [n1.id],
    branchNames: { [n2.id]: '绝密分支名称_CANARY' },
    branchSummaries: { [n2.id]: '绝密分支梗概_CANARY' },
    createdAt: 100,
    updatedAt: 200,
  };
}

describe('Folio V0.2 Ticket #92: Diagnostics v2 collector, sanitized error reasons & 3-mode skeleton', () => {
  it('enforces schemaVersion 2, 60-minute / 600-event window, folio-logs- prefix, and v1->v2 migration', () => {
    expect(DIAGNOSTIC_WINDOW_MS).toBe(60 * 60 * 1000);
    expect(MAX_DIAGNOSTIC_EVENTS).toBe(600);
    expect(DIAGNOSTIC_STORAGE_KEY).toBe('lfh.diagnostics.v2');
    expect(DIAGNOSTIC_BUNDLE_FILENAME_PREFIX).toBe('folio-logs-');
    expect(formatDiagnosticBundleFileName(new Date('2026-11-21T16:00:00.000Z'))).toBe(
      'folio-logs-2026-11-21T16-00-00-000Z.json',
    );

    const kv = createMemoryKv();
    let clock = 1_700_000_000_000;
    kv.setItem(
      'lfh.diagnostics.v1',
      JSON.stringify({
        events: [
          {
            ts: clock - 45 * 60 * 1000, // 45 mins old -> kept in 60-min window!
            level: 'info',
            category: 'llm',
            action: 'stream_done',
            durationMs: 120,
          },
          {
            ts: clock - 65 * 60 * 1000, // 65 mins old -> evicted!
            level: 'warn',
            category: 'ui',
            action: 'switch_branch',
          },
        ],
        radars: [],
      }),
    );

    const collector = createDiagnosticCollector({
      platform: 'android',
      storage: kv,
      now: () => clock,
    });

    expect(kv.getItem('lfh.diagnostics.v1')).toBeNull();
    expect(kv.getItem('lfh.diagnostics.v2')).not.toBeNull();

    const bundle = collector.buildBundle({
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-chat',
      memoryOnly: false,
    });

    expect(bundle.schemaVersion).toBe(2);
    expect(bundle.windowMinutes).toBe(60);
    expect(bundle.events).toHaveLength(1);
    expect(bundle.events[0]?.action).toBe('stream_done');
  });

  it('supports all V0.2 actions, strict SAFE_EVENT_METRICS allowlists, and V0.2 STACK_MODULES', () => {
    const collector = createDiagnosticCollector({ platform: 'web', now: () => 1_700_000_000_000 });
    const v2Actions: Array<[Parameters<typeof collector.recordEvent>[0]['category'], string]> = [
      ['llm', 'entry_route_classified'],
      ['llm', 'entry_route_ambiguous'],
      ['storage', 'entry_neutral_persisted'],
      ['ui', 'entry_misroute_corrected'],
      ['llm', 'proposal_parsed'],
      ['llm', 'proposal_needs_review'],
      ['ui', 'proposal_applied'],
      ['ui', 'proposal_dismissed'],
      ['ui', 'proposal_reverted'],
      ['ui', 'patch_reapplied'],
      ['ui', 'patch_conflict'],
      ['llm', 'summary_background_done'],
      ['llm', 'summary_background_skipped'],
      ['llm', 'summary_background_failed'],
      ['llm', 'summary_window_trimmed'],
      ['storage', 'manuscript_save_queued'],
      ['storage', 'manuscript_save_flushed'],
      ['storage', 'manuscript_save_error'],
      ['ui', 'manuscript_suggestion_adopted'],
      ['ui', 'manuscript_undo'],
      ['storage', 'backup_export_v3'],
      ['import', 'backup_import_v3'],
      ['import', 'backup_import_legacy'],
      ['storage', 'migration_v02_done'],
      ['storage', 'migration_v02_error'],
      ['ui', 'diagnostics_exported'],
      ['ui', 'diagnostics_shared'],
    ];

    for (const [category, action] of v2Actions) {
      collector.recordEvent({
        level: action.endsWith('_error') || action.endsWith('_failed') ? 'error' : 'info',
        category,
        action,
        meta: {
          target: 'container',
          op: 'patch',
          addedLines: 4,
          removedLines: 2,
          reasonCode: 'search_not_found',
          routeMode: 'writing',
          durationMs: 18,
          hydratedCount: 3,
          migratedCount: 5,
          // Unsafe / freeform fields must be dropped:
          freeform: '绝密自由文本_CANARY',
        },
      });
    }

    // Reject unsafe values for allowlisted metric keys
    collector.recordEvent({
      level: 'warn',
      category: 'llm',
      action: 'proposal_needs_review',
      meta: {
        target: 'secret_target_CANARY',
        op: 'evil_op_CANARY',
        routeMode: 'unknown_CANARY',
        reasonCode: '绝密原因 CANARY with spaces',
        addedLines: -5,
      },
    });

    // Verify V0.2 stack allowlist preserves V0.2 modules while ignoring unknown paths/modules
    collector.recordError({
      category: 'ui',
      action: 'patch_conflict',
      error: Object.assign(new Error('Patch anchor not found in setting'), { code: 'PATCH_CONFLICT' }),
      stack: [
        'Error: Patch anchor not found in setting',
        '    at applyProposal (/Users/alice_secret/repo/src/harness/markdownProposal.ts:42:11)',
        '    at diffLines (/Users/alice_secret/repo/src/harness/markdownDiff.ts:19:5)',
        '    at ProposalCard (/Users/alice_secret/repo/src/ui/ProposalCard.tsx:88:12)',
        '    at SecretFile (/Users/alice_secret/repo/src/ui/绝密模块_CANARY.tsx:10:1)',
        '    at useCreativeWorkspace (/Users/alice_secret/repo/src/ui/useCreativeWorkspace.ts:120:4)',
        '    at SettingsPage (/Users/alice_secret/repo/src/ui/SettingsPage.tsx:55:9)',
      ].join('\n'),
    });

    const bundle = collector.buildBundle({ baseUrl: '', model: 'deepseek-chat', memoryOnly: true });
    const json = JSON.stringify(bundle);

    expect(json).not.toContain('CANARY');
    expect(json).not.toContain('alice_secret');

    for (const [, action] of v2Actions) {
      expect(bundle.events.some((e) => e.action === action)).toBe(true);
    }

    const firstMeta = bundle.events[0]?.meta;
    expect(firstMeta).toEqual({
      target: 'container',
      op: 'patch',
      addedLines: 4,
      removedLines: 2,
      reasonCode: 'search_not_found',
      routeMode: 'writing',
      durationMs: 18,
      hydratedCount: 3,
      migratedCount: 5,
    });

    const rejectedMetaEvent = bundle.events[v2Actions.length];
    expect(rejectedMetaEvent?.meta).toBeUndefined();

    const stackEvent = bundle.events[bundle.events.length - 1];
    expect(stackEvent?.errorName).toBe('Error');
    expect(stackEvent?.errorCode).toBe('PATCH_CONFLICT');
    expect(stackEvent?.sanitizedReason).toBe('Patch anchor not found in setting');
    expect(stackEvent?.stackTop).toEqual([
      'markdownProposal.ts:42:11',
      'markdownDiff.ts:19:5',
      'ProposalCard.tsx:88:12',
      'useCreativeWorkspace.ts:120:4',
      'SettingsPage.tsx:55:9',
    ]);
  });

  it('validates V0.2 appEnv fields and sanitizes/caps userNote at 280 chars', () => {
    const collector = createDiagnosticCollector({ platform: 'android', now: () => 1_700_000_000_000 });
    const longNote =
      '点击保存时卡住 sk-live-canary-99887766 https://my-private-relay.example.com/v1/chat?token=canary-secret /Users/alice_secret/绝密故事.docx ' +
      'A'.repeat(300);

    const bundle = collector.buildBundle(
      { baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat', memoryOnly: false },
      {
        trigger: 'settings_manual',
        userNote: longNote,
        appEnv: {
          appVersion: '0.2.0',
          osVersion: 'Android 14',
          webviewVersion: 'Chrome/130.0.6723.58',
          theme: 'warm',
          viewport: '412x915',
          activeView: 'writing',
          storyCount: 2,
          workCount: 3,
          characterCount: 4,
        },
      },
    );

    expect(bundle.appEnv).toEqual({
      platform: 'android',
      appVersion: '0.2.0',
      osVersion: 'Android 14',
      webviewVersion: 'Chrome/130.0.6723.58',
      theme: 'warm',
      viewport: '412x915',
      activeView: 'writing',
      storyCount: 2,
      workCount: 3,
      characterCount: 4,
    });
    expect(bundle.userNote).toBeDefined();
    expect(bundle.userNote!.length).toBeLessThanOrEqual(280);
    expect(bundle.userNote).toContain('[REDACTED_KEY]');
    expect(bundle.userNote).toContain('[REDACTED_PATH]');
    expect(bundle.userNote).not.toContain('sk-live-canary-99887766');
    expect(bundle.userNote).not.toContain('my-private-relay.example.com');
    expect(bundle.userNote).not.toContain('canary-secret');
    expect(bundle.userNote).not.toContain('alice_secret');
    expect(bundle.userNote).not.toContain('绝密故事');

    // Rejects PII / paths / URLs injected into osVersion / webviewVersion
    const piiRejectedBundle = collector.buildBundle(
      { baseUrl: '', model: 'deepseek-chat', memoryOnly: false },
      {
        appEnv: {
          appVersion: '0.2.0',
          osVersion: 'Android (/data/user/0/secret_CANARY)',
          webviewVersion: 'https://relay.example.com/ua?sk=CANARY',
          theme: 'invalid-theme' as never,
          activeView: 'settings',
          storyCount: 1,
        },
      },
    );
    expect(piiRejectedBundle.appEnv.osVersion).toBeUndefined();
    expect(piiRejectedBundle.appEnv.webviewVersion).toBeUndefined();
    expect(piiRejectedBundle.appEnv.theme).toBeUndefined();
    expect(piiRejectedBundle.appEnv.activeView).toBe('settings');
  });

  it('produces zero-leakage v2 bundle & 3-mode workspaceSkeleton across stories, works, and characters', () => {
    const story = makeSyntheticStory();

    const work = {
      ...newWork('绝密写故事作品标题_CANARY', '绝密作品设定文档_CANARY'),
      id: 'work-id-CANARY',
      body: '绝密手写小说正文_CANARY'.repeat(40), // ~560 chars -> '501-2000'
      suggestions: [
        {
          id: 'sug-1-CANARY',
          instruction: '绝密润色指令_CANARY',
          text: '绝密润色建议_CANARY',
          revision: 0,
          start: 0,
          end: 5,
          documentReads: [],
        },
      ],
      discussion: [
        makeTurnNode('work-d1-CANARY', null, 'user', 10, '绝密灵感提问_CANARY'),
        makeTurnNode('work-d2-CANARY', 'work-d1-CANARY', 'assistant', 11, '绝密灵感回答_CANARY'),
      ],
      source: { storyId: story.id, nodeId: 'story-n2-CANARY' },
    };

    const char = newCharacter('绝密角色姓名_CANARY', '绝密角色人设正文_CANARY');
    char.id = 'char-id-CANARY';
    const conv1 = newConversation(char, 'personal', '绝密角色局部记忆1_CANARY');
    conv1.id = 'conv1-id-CANARY';
    conv1.nodes = {
      c1n1: makeTurnNode('c1n1', null, 'user', 20, '绝密角色对话A1_CANARY'),
      c1n2: makeTurnNode('c1n2', 'c1n1', 'assistant', 21, '绝密角色对话A2_CANARY'),
    };
    conv1.activeLeafNodeId = 'c1n2';
    const conv2 = newConversation(char, 'roleplay', '绝密角色局部记忆2_CANARY');
    conv2.id = 'conv2-id-CANARY';
    conv2.nodes = {
      c2n1: makeTurnNode('c2n1', null, 'user', 30, '绝密角色对话B1_CANARY'),
    };
    conv2.activeLeafNodeId = 'c2n1';
    char.conversations = [conv1, conv2];
    char.activeConversationId = conv1.id;

    const workspaceSkeleton = buildRedactedWorkspaceSkeleton({
      stories: [story],
      creativeWorkspace: {
        works: [work],
        characters: [char],
      },
    });

    expect(workspaceSkeleton).toEqual({
      storyCount: 1,
      workCount: 1,
      characterCount: 1,
      stories: [
        {
          storyAnonId: 's1',
          nodeCount: 2,
          forkCount: 0,
          sourceKind: 'manual_script',
        },
      ],
      works: [
        {
          workAnonId: 'w1',
          bodyCharBucket: '501-2000',
          suggestionCount: 1,
          discussionTurnCount: 2,
          hasSourceStory: true,
          documentVersionCount: 1,
        },
      ],
      characters: [
        {
          charAnonId: 'c1',
          conversationCount: 2,
          turnCounts: [2, 1],
          documentVersionCount: 1,
        },
      ],
    });

    const collector = createDiagnosticCollector({ platform: 'web', now: () => 1_700_000_000_000 });
    collector.recordError({
      category: 'storage',
      action: 'manuscript_save_error',
      error: Object.assign(
        new Error(
          'QuotaExceededError saving /data/user/0/io.localfiction.harness/files/绝密草稿.folio.json via https://my-relay.example.com/save?api_key=sk-secret-99887766',
        ),
        { name: 'QuotaExceededError', code: 'QUOTA_EXCEEDED' },
      ),
      stack: 'QuotaExceededError\n    at saveWork (/Users/alice_secret/src/ui/DraftPane.tsx:101:5)',
    });

    const bundle = collector.buildBundle(
      {
        baseUrl: 'https://my-relay.example.com/v1?token=secret-query-CANARY',
        model: 'deepseek-reasoner',
        apiKey: 'sk-live-canary-1234567890',
        memoryOnly: false,
      },
      {
        trigger: 'error_banner',
        activeStory: story,
        workspace: {
          stories: [story],
          creativeWorkspace: {
            works: [work],
            characters: [char],
          },
        },
        userNote: '保存时出错：绝密剧本.folio.json sk-live-canary-1234567890',
        appEnv: {
          appVersion: '0.2.0',
          osVersion: 'macOS 15.1',
          webviewVersion: 'Safari/605.1',
          theme: 'dark',
          viewport: '1280x800',
          activeView: 'writing',
          storyCount: 1,
          workCount: 1,
          characterCount: 1,
        },
      },
    );

    expect(bundle.workspaceSkeleton).toEqual(workspaceSkeleton);
    const serialized = JSON.stringify(bundle);

    const forbiddenStrings = [
      'CANARY',
      '绝密',
      'sk-live-canary',
      'sk-secret-99887766',
      'my-relay.example.com',
      'alice_secret',
      'io.localfiction.harness',
      'story-id-',
      'work-id-',
      'char-id-',
      'conv1-id-',
      'conv2-id-',
      'sug-1-',
    ];
    for (const secret of forbiddenStrings) {
      expect(serialized).not.toContain(secret);
    }

    // Readable sanitized error details remain debuggable
    expect(bundle.events[0]).toMatchObject({
      action: 'manuscript_save_error',
      errorName: 'QuotaExceededError',
      errorCode: 'QUOTA_EXCEEDED',
      stackTop: ['DraftPane.tsx:101:5'],
    });
    expect(bundle.events[0]?.sanitizedReason).toBe(
      'QuotaExceededError saving [REDACTED_PATH] via https://relay_ee3c9676',
    );
    expect(bundle.userNote).toBe('保存时出错：[file].json [REDACTED_KEY]');
  });

  it('caps sanitizedReason at 180 characters and scrubs non-HTTP error messages', () => {
    const collector = createDiagnosticCollector({ platform: 'web' });
    const longError = new TypeError(
      `Cannot read properties of undefined (reading 'proposals') near /var/mobile/Containers/Data/secret.txt ${'x'.repeat(240)}`,
    );
    collector.recordError({
      category: 'ui',
      action: 'proposal_applied',
      error: longError,
    });

    const bundle = collector.buildBundle({ baseUrl: '', model: 'deepseek-chat', memoryOnly: true });
    const ev = bundle.events[0];
    expect(ev?.errorName).toBe('TypeError');
    expect(ev?.sanitizedReason).toBeDefined();
    expect(ev!.sanitizedReason!.length).toBeLessThanOrEqual(180);
    expect(ev!.sanitizedReason).toContain("Cannot read properties of undefined (reading 'proposals')");
    expect(ev!.sanitizedReason).toContain('[REDACTED_PATH]');
    expect(ev!.sanitizedReason).not.toContain('secret.txt');
  });
});
