import { describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import {
  BUILTIN_NARRATIVE_PROMPT_PACK,
  createDiagnosticCollector,
  createDiagnosticStoryStorage,
  createDiagnosticTransport,
  createFictionHarness,
  createInMemoryStoryStorage,
  recordAutoScrollDiagnostic,
  recordRefusalOriginalRestoredDiagnostic,
  recordSwipeDiagnostic,
  sanitizeDiagnosticText,
  sanitizeEndpointProfile,
  scanDeepSeekExportZip,
  streamCreativeReply,
  type KeyValueStorage,
  type LlmTransport,
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

describe('Spec #26 / V0.2 Slice 1: Zero-content DiagnosticCollector, sanitization & 60-min ring buffer', () => {
  it('fails closed when the model field contains credentials, hosts, URLs, queries, or serialized text', () => {
    const rejectedModels = [
      {
        model: 'synthetic-api-key-without-prefix',
        apiKey: 'synthetic-api-key-without-prefix',
      },
      { model: 'my-private-relay.example.com' },
      { model: 'localhost' },
      { model: 'host.docker.internal' },
      { model: 'relay.private.invalid/model' },
      { model: 'http:private-endpoint' },
      { model: 'https://api.deepseek.com/v1?token=synthetic-query-value' },
      { model: 'x?token=synthetic-query-value' },
      { model: '{"token":"synthetic-query-value"}' },
      { model: 'Bearer synthetic-query-value' },
      { baseUrl: 'https://internal-gateway/v1', model: 'vendor/internal-gateway' },
      {
        baseUrl: 'https://internal-gateway/v1',
        model: 'vendor/internal-gateway-model',
      },
      {
        baseUrl: 'https://api.deepseek.com/v1?token=synthetic-query-value',
        model: 'synthetic-query-value',
      },
    ];

    for (const { baseUrl = '', model, apiKey } of rejectedModels) {
      expect(
        sanitizeEndpointProfile({ baseUrl, model, apiKey, memoryOnly: false }).model,
      ).toBe('unset');
    }

    for (const model of [
      'deepseek-chat',
      'claude-opus-4.6',
      'vendor/model',
      'gpt-oss:20b',
      'vendor/model:free',
    ]) {
      expect(sanitizeEndpointProfile({ baseUrl: '', model, memoryOnly: false }).model).toBe(model);
    }
  });

  it('builds endpoint profiles from raw config and ignores spoofed pre-sanitized fields', () => {
    const key = 'synthetic-api-key-without-prefix';
    const collector = createDiagnosticCollector({ platform: 'web' });
    const rawConfig = {
      baseUrl: 'https://my-private-relay.example.com/v1',
      model: key,
      apiKey: key,
      memoryOnly: false,
      hostKind: 'official' as const,
      host: 'api.deepseek.com',
      hasApiKey: true,
      isDevProxy: false,
    };

    const bundle = collector.buildBundle(rawConfig);
    const json = JSON.stringify(bundle);

    expect(bundle.endpointProfile.hostKind).toBe('relay');
    expect(bundle.endpointProfile.host).toMatch(/^relay_[0-9a-f]{8}$/);
    expect(bundle.endpointProfile.model).toBe('unset');
    expect(bundle.endpointProfile).not.toHaveProperty('baseUrl');
    expect(bundle.endpointProfile).not.toHaveProperty('apiKey');
    expect(json).not.toContain(key);
    expect(json).not.toContain('my-private-relay.example.com');
    expect(json).not.toContain('api.deepseek.com');
  });

  it('achieves zero leakage against privacy & secret canaries while keeping official host plaintext and hashing private relay', () => {
    const canaries = [
      'sk-live-canary-998877665544332211',
      'secret-bearer-canary-token-xyz',
      'my-private-relay.example.com',
      'canary-query-secret',
      'alice_secret_user',
      '绝密女主剧本_CANARY.docx',
      '深宫绝密标题_CANARY',
      '隐藏结局分支_CANARY',
      '主角沈知微的私密台词_CANARY',
      '内部推理链_CANARY',
    ];

    const kv = createMemoryKv();
    const collector = createDiagnosticCollector({
      platform: 'web',
      storage: kv,
      now: () => 1_700_000_000_000,
    });

    // Endpoint profile with private relay + query token + sk key
    const relayConfig = {
      baseUrl: 'https://my-private-relay.example.com/custom/v1?token=canary-query-secret',
      model: 'deepseek-chat',
      apiKey: 'sk-live-canary-998877665544332211',
      memoryOnly: true,
    };
    const relayProfile = sanitizeEndpointProfile(relayConfig);
    expect(relayProfile.hostKind).toBe('relay');
    expect(relayProfile.host).toMatch(/^relay_[0-9a-f]{8}$/);
    expect(relayProfile.hasApiKey).toBe(true);
    expect(relayProfile.model).toBe('deepseek-chat');

    // Deterministic hash for same private relay
    const relayProfile2 = sanitizeEndpointProfile({
      baseUrl: 'https://my-private-relay.example.com/other/path',
      model: 'deepseek-chat',
      apiKey: '',
      memoryOnly: false,
    });
    expect(relayProfile2.host).toBe(relayProfile.host);

    // Official domain preserved in plaintext (path/query stripped)
    const officialProfile = sanitizeEndpointProfile({
      baseUrl: 'https://api.deepseek.com/v1?api_key=sk-live-canary-998877665544332211',
      model: 'deepseek-reasoner',
      apiKey: 'sk-live-canary-998877665544332211',
      memoryOnly: false,
    });
    expect(officialProfile.hostKind).toBe('official');
    expect(officialProfile.host).toBe('api.deepseek.com');
    expect(officialProfile.model).toBe('deepseek-reasoner');

    const relativeEndpoint = sanitizeEndpointProfile({
      baseUrl: '/local-proxy',
      model: ' deepseek-chat ',
      memoryOnly: false,
    });
    expect(relativeEndpoint).toMatchObject({
      hostKind: 'unset',
      host: '',
      model: 'deepseek-chat',
      isDevProxy: false,
    });
    const explicitlyMarkedProxy = sanitizeEndpointProfile({
      baseUrl: '/local-proxy',
      model: ' deepseek-chat ',
      memoryOnly: false,
      isDevProxy: true,
    });
    expect(explicitlyMarkedProxy).toMatchObject({
      hostKind: 'local',
      host: 'dev_proxy',
      model: 'deepseek-chat',
      isDevProxy: true,
    });

    // Record events containing leaky error strings
    collector.recordError({
      category: 'llm',
      action: 'streamChat',
      statusCode: 401,
      error: new Error(
        'Auth failed for Bearer secret-bearer-canary-token-xyz with key sk-live-canary-998877665544332211 at https://my-private-relay.example.com/v1/chat?token=canary-query-secret',
      ),
      stack:
        'Error: fail\n    at /Users/alice_secret_user/dev/app.ts:12:3\n    at C:\\Users\\alice_secret_user\\file.ts:1:1',
    });

    collector.recordEvent({
      level: 'info',
      category: 'import',
      action: 'import_complete',
      meta: {
        // Even if caller accidentally passes a file path or URL in meta, sanitizer must scrub it
        hint: 'failed reading /Users/alice_secret_user/绝密女主剧本_CANARY.docx',
      },
    });

    const bundle = collector.buildBundle(relayConfig);
    const jsonText = JSON.stringify(bundle, null, 2);

    for (const canary of canaries) {
      expect(jsonText).not.toContain(canary);
    }
    expect(jsonText).toContain(relayProfile.host);
    expect(sanitizeDiagnosticText('https://api.deepseek.com/v1?k=123')).toBe(
      'https://api.deepseek.com',
    );
  });

  it('scrubs bare private hostnames, IP literals and attachment file names from free text', () => {
    const out = sanitizeDiagnosticText(
      'Invalid key for my-private-relay.example.com / 10.1.2.3 reading 绝密女主剧本_CANARY.docx near api.deepseek.com in tsconfig.json',
    );
    expect(out).not.toContain('my-private-relay');
    expect(out).not.toContain('10.1.2.3');
    expect(out).not.toContain('绝密女主剧本');
    expect(out).toContain('api.deepseek.com');
    expect(out).toContain('tsconfig.json');
    expect(out).toMatch(/relay_[0-9a-f]{8}/);
    expect(out).toContain('[file].docx');
  });

  it('keeps echoed story content out of meta/action while retaining sanitized error details and status/timing fields', () => {
    const kv = createMemoryKv();
    const options = {
      platform: 'web' as const,
      storage: kv,
      now: () => 1_700_000_000_000,
    };
    const collector = createDiagnosticCollector(options);
    collector.recordError({
      category: 'llm',
      action: 'stream_error',
      error: new TypeError(
        'HTTP 401 Unauthorized for Bearer secret-token-canary sk-live-canary-998877 at https://private-relay.example.com/v1?k=secret',
      ),
      statusCode: 401,
      durationMs: 27,
      meta: { response: '绝密玩家行动_CANARY' },
    });
    collector.recordEvent({
      level: 'warn',
      category: 'ui',
      action: '绝密玩家行动_CANARY',
    });

    const persisted = kv.getItem('lfh.diagnostics.v2') ?? '';
    const restored = createDiagnosticCollector(options).buildBundle({
      baseUrl: '',
      model: 'm',
      memoryOnly: false,
    });
    const json = JSON.stringify(restored);

    expect(persisted).not.toContain('绝密玩家行动_CANARY');
    expect(persisted).not.toContain('secret-token-canary');
    expect(persisted).not.toContain('sk-live-canary-998877');
    expect(persisted).not.toContain('private-relay.example.com');
    expect(json).not.toContain('绝密玩家行动_CANARY');
    expect(json).not.toContain('secret-token-canary');
    expect(json).not.toContain('sk-live-canary-998877');
    expect(json).not.toContain('private-relay.example.com');
    expect(restored.schemaVersion).toBe(2);
    expect(restored.windowMinutes).toBe(60);
    expect(restored.events[0]).toMatchObject({
      action: 'stream_error',
      statusCode: 401,
      durationMs: 27,
      errorName: 'TypeError',
      errorCode: 'HTTP_401',
    });
    expect(restored.events[0]?.sanitizedReason).toContain('HTTP 401 Unauthorized');
    expect(restored.events[0]?.sanitizedReason).toContain('[REDACTED_KEY]');
    expect(restored.events[0]).not.toHaveProperty('message');
    expect(restored.events[0]).not.toHaveProperty('stack');
    expect(restored.events[1]?.action).toBe('other');
  });

  it('returns detached bundle snapshots whose mutation cannot alter persisted diagnostics', () => {
    const kv = createMemoryKv();
    const collector = createDiagnosticCollector({
      platform: 'web',
      storage: kv,
      now: () => 1_700_000_000_000,
    });
    const endpoint = { baseUrl: '', model: 'm', memoryOnly: false };
    collector.recordEvent({
      level: 'info',
      category: 'llm',
      action: 'stream_done',
      durationMs: 23,
      meta: { chunks: 1 },
    });
    collector.recordImportRadar({
      exportFormatVersion: 3,
      sourceMode: 'zip_file',
      totalSessions: 1,
      selectedSessions: 1,
      danglingParentCount: 0,
      emptyTitleCount: 0,
      unknownFragmentTypes: ['NEW_FANCY_TYPE'],
      attachmentExtensions: { '.docx': 2 },
      scriptConfidenceCounts: { strong: 1, ambiguous: 0 },
      status: 'success',
      durationMs: 52,
    });

    const bundle = collector.buildBundle(endpoint);
    bundle.events[0]!.durationMs = 999;
    bundle.events[0]!.meta!.chunks = 999;
    bundle.importRadars[0]!.durationMs = 888;
    bundle.importRadars[0]!.unknownFragmentTypes.push('MUTATED_TYPE');
    bundle.importRadars[0]!.attachmentExtensions['.docx'] = 999;
    collector.recordEvent({ level: 'warn', category: 'ui', action: 'import_complete' });

    const persisted = JSON.parse(kv.getItem('lfh.diagnostics.v2') ?? '{}') as {
      events: Array<{ durationMs?: number; meta?: { chunks?: number } }>;
      radars: Array<{
        durationMs?: number;
        unknownFragmentTypes: string[];
        attachmentExtensions: Record<string, number>;
      }>;
    };
    expect(persisted.events[0]).toMatchObject({ durationMs: 23, meta: { chunks: 1 } });
    expect(persisted.radars[0]).toMatchObject({
      durationMs: 52,
      unknownFragmentTypes: ['NEW_FANCY_TYPE'],
      attachmentExtensions: { '.docx': 2 },
    });
  });

  it('rewrites recovered legacy payloads through the zero-content projection', () => {
    const kv = createMemoryKv();
    const now = 1_700_000_000_000;
    const canary = '绝密玩家行动_CANARY';
    kv.setItem(
      'lfh.diagnostics.v1',
      JSON.stringify({
        events: [
          {
            ts: now,
            level: 'error',
            category: 'llm',
            action: 'stream_error',
            durationMs: 9,
            statusCode: 401,
            message: `HTTP 401: ${canary}`,
            stack: `Error: ${canary}`,
            meta: { chunks: 2, response: canary },
          },
        ],
        radars: [
          {
            ts: now,
            durationMs: 31,
            exportFormatVersion: 3,
            sourceMode: 'zip_file',
            totalSessions: 1,
            selectedSessions: 1,
            danglingParentCount: 0,
            emptyTitleCount: 0,
            unknownFragmentTypes: [canary],
            attachmentExtensions: { '.pdf': 1, '.private-canary-name': 1 },
            scriptConfidenceCounts: { strong: 1, ambiguous: 0 },
            status: 'success',
          },
        ],
      }),
    );

    const collector = createDiagnosticCollector({
      platform: 'web',
      storage: kv,
      now: () => now,
    });
    const persisted = kv.getItem('lfh.diagnostics.v2') ?? '';
    const bundle = collector.buildBundle({ baseUrl: '', model: 'm', memoryOnly: false });

    expect(kv.getItem('lfh.diagnostics.v1')).toBeNull();
    expect(persisted).not.toContain(canary);
    expect(JSON.stringify(bundle)).not.toContain(canary);
    expect(bundle.events[0]).toMatchObject({ statusCode: 401, durationMs: 9, meta: { chunks: 2 } });
    expect(bundle.events[0]).not.toHaveProperty('message');
    expect(bundle.events[0]).not.toHaveProperty('stack');
    expect(bundle.importRadars[0]).toMatchObject({ durationMs: 31, unknownFragmentTypes: ['INVALID_TYPE_NAME'] });
    expect(bundle.importRadars[0]?.attachmentExtensions).toEqual({ '.other': 1, '.pdf': 1 });
  });

  it('evicts events older than 60 minutes, caps at 600 events, and recovers pre-crash events on new instance', () => {
    let clock = 1_700_000_000_000;
    const kv = createMemoryKv();
    const collectorA = createDiagnosticCollector({
      platform: 'android',
      storage: kv,
      now: () => clock,
    });

    // Old event at t=0
    collectorA.recordEvent({ level: 'info', category: 'ui', action: 'old_event' });

    // Advance 61 minutes -> old_event is expired (59-min event would still be kept)
    clock += 61 * 60 * 1000;
    for (let i = 0; i < 605; i++) {
      collectorA.recordEvent({
        level: 'info',
        category: 'branch',
        action: i === 0 ? 'switch_branch_failed' : 'switch_branch',
      });
    }
    collectorA.recordError({
      category: 'crash',
      action: 'unhandled_render_crash',
      error: new Error('Boom before reload'),
    });

    // Simulate reload / crash recovery with a brand-new collector instance on the same KeyValueStorage
    const collectorB = createDiagnosticCollector({
      platform: 'android',
      storage: kv,
      now: () => clock,
    });
    const bundle = collectorB.buildBundle({
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-chat',
      apiKey: '',
      memoryOnly: true,
    });

    expect(bundle.schemaVersion).toBe(2);
    expect(bundle.windowMinutes).toBe(60);
    expect(bundle.events.length).toBe(600);
    expect(bundle.events.some((e) => e.action === 'other')).toBe(false);
    expect(bundle.events.some((e) => e.action === 'switch_branch_failed')).toBe(false);
    expect(bundle.events[bundle.events.length - 1]?.action).toBe('unhandled_render_crash');
  });
});

describe('Spec #26 Slice 2: DeepSeek structure radar & breadcrumb wrappers', () => {
  it('collects a zero-content structure radar with unknown fragment types and extension-only attachment counts', () => {
    const session = {
      id: 'sess-radar',
      title: null,
      current_message_id: 2,
      inserted_at: '2026-11-12T10:00:00Z',
      updated_at: '2026-11-12T10:10:00Z',
      messages: [
        {
          id: 1,
          parent_id: 99,
          role: 'USER',
          status: 'FINISHED',
          fragments: [
            { type: 'REQUEST', content: '主角沈知微的私密台词_CANARY' },
            { type: 'NEW_FANCY_TYPE', content: 'x' },
            { type: 'secret title canary!', content: 'x' },
            {
              type: 'FILE',
              files: [
                { file_name: '绝密女主剧本_CANARY.docx', export_path: 'files/a.docx' },
                { file_name: 'b.TXT', export_path: 'files/b.txt' },
                { file_name: '绝密_CANARY.weirdlongext123', export_path: 'files/c' },
              ],
            },
          ],
        },
        {
          id: 2,
          parent_id: 1,
          role: 'ASSISTANT',
          status: 'FINISHED',
          fragments: [{ type: 'TOOL_SEARCH' }, { type: 'RESPONSE', content: '回复正文_CANARY' }],
        },
      ],
    };
    const zip = zipSync({
      'manifest.json': strToU8(JSON.stringify({ export_format_version: 3 })),
      'chat_sessions/sess-radar.json': strToU8(JSON.stringify(session)),
    });

    const { structure } = scanDeepSeekExportZip(zip);
    expect(structure.exportFormatVersion).toBe(3);
    expect(structure.totalSessions).toBe(1);
    expect(structure.danglingParentCount).toBe(1);
    expect(structure.emptyTitleCount).toBe(1);
    expect(structure.unknownFragmentTypes).toEqual(['INVALID_TYPE_NAME', 'NEW_FANCY_TYPE']);
    expect(structure.attachmentExtensions).toEqual({ '.docx': 1, '.txt': 1, '.other': 1 });

    const kv = createMemoryKv();
    const collector = createDiagnosticCollector({ platform: 'web', storage: kv });
    collector.recordImportRadar({
      ...structure,
      sourceMode: 'zip_file',
      selectedSessions: 1,
      scriptConfidenceCounts: { strong: 1, ambiguous: 0 },
      status: 'success',
      durationMs: 52,
    });
    const json = JSON.stringify(
      collector.buildBundle({ baseUrl: '', model: 'm', memoryOnly: false }),
    );
    for (const canary of ['CANARY', 'sess-radar', '绝密', '沈知微', 'secret title']) {
      expect(json).not.toContain(canary);
    }
    expect(json).toContain('NEW_FANCY_TYPE');
    expect(JSON.stringify(collector.buildBundle({
      baseUrl: '',
      model: 'm',
      memoryOnly: false,
    }).importRadars[0])).toContain('"durationMs":52');
    const restored = createDiagnosticCollector({ platform: 'web', storage: kv }).buildBundle({
      baseUrl: '',
      model: 'm',
      memoryOnly: false,
    });
    expect(restored.importRadars[0]?.durationMs).toBe(52);
  });

  it('records stream and storage breadcrumbs without leaking content or secrets', async () => {
    const collector = createDiagnosticCollector({ platform: 'web' });
    const okTransport: LlmTransport = {
      async *streamChat() {
        yield { contentDelta: '正文_CANARY' };
      },
    };
    const failTransport: LlmTransport = {
      // eslint-disable-next-line require-yield
      async *streamChat() {
        throw new Error('HTTP 401 Bearer sk-live-canary-123456789 at https://relay-canary.example.com/v1?k=1');
      },
    };
    for await (const _ of createDiagnosticTransport(okTransport, collector).streamChat({
      baseUrl: 'x',
      apiKey: 'sk-live-canary-123456789',
      model: 'm',
      messages: [{ role: 'user', content: '玩家输入_CANARY' }],
    })) {
      void _;
    }
    await expect(async () => {
      for await (const _ of createDiagnosticTransport(failTransport, collector).streamChat({
        baseUrl: 'x',
        apiKey: 'k',
        model: 'm',
        messages: [],
      })) {
        void _;
      }
    }).rejects.toThrow();

    const storage = createDiagnosticStoryStorage(createInMemoryStoryStorage(), collector);
    await storage.listStories();
    await storage.getActiveStorySelection();
    await storage.setActiveStoryId('story-id-private-canary');

    const bundle = collector.buildBundle({ baseUrl: '', model: 'm', memoryOnly: false });
    const json = JSON.stringify(bundle);
    expect(json).not.toContain('CANARY');
    expect(json).not.toContain('sk-live');
    expect(json).not.toContain('relay-canary');
    expect(bundle.events.map((e) => e.action)).toEqual(
      expect.arrayContaining([
        'stream_done',
        'stream_error',
        'list_stories',
        'get_active_story_selection',
        'set_active_story_id',
      ]),
    );
    expect(json).not.toContain('story-id-private-canary');
    expect(bundle.events.find((e) => e.action === 'stream_error')?.statusCode).toBe(401);
  });

  it('records only proposal outcomes for creative and story replies', async () => {
    const storage = createMemoryKv();
    const collector = createDiagnosticCollector({ platform: 'web', storage });
    const config = { baseUrl: '', model: 'fixture', apiKey: 'SECRET_CANARY', memoryOnly: true };
    const fence = '```';
    const valid = `${fence}lfh-change\n${JSON.stringify({ target: 'container', markdown: 'PROPOSAL_CANARY' }, null, 2)}\n${fence}`;
    const invalid = `${fence}lfh-change\n{BROKEN_CANARY}\n${fence}`;
    const replies = [
      { contentDelta: 'REPLY_CANARY', finishReason: 'stop' },
      { contentDelta: `REPLY_CANARY\n${invalid}`, finishReason: 'stop' },
      { contentDelta: `REPLY_CANARY\n${valid}`, finishReason: 'length' },
      { contentDelta: `REPLY_CANARY\n${valid}`, finishReason: 'stop' },
      { contentDelta: `REPLY_CANARY\n${valid}`, finishReason: 'length' },
    ];
    const transport = createDiagnosticTransport({
      async *streamChat() {
        const reply = replies.shift();
        if (!reply) throw new Error('Unexpected model request');
        yield reply;
      },
    }, collector);
    const messages = [{ role: 'user' as const, content: 'USER_CANARY' }];
    await streamCreativeReply(transport, config, messages);
    await streamCreativeReply(transport, config, messages);
    await expect(streamCreativeReply(transport, config, messages)).rejects.toThrow();
    const harness = createFictionHarness({ transport });
    const turn = await harness.runTurn(harness.createStory({ title: 'TITLE_CANARY' }), 'USER_CANARY', config);
    expect(turn.proposal?.target).toBe('container');
    const retry = await harness.regenerateNode(turn.story, turn.assistantNode.id, config);
    expect(retry.proposal).toBeUndefined();

    const restored = createDiagnosticCollector({ platform: 'web', storage });
    const bundle = restored.buildBundle(config);
    const outcomes = bundle.events.filter((event) => event.action.startsWith('markdown_proposal_'));
    expect(outcomes.map(({ action, level }) => [action, level])).toEqual([
      ['markdown_proposal_none', 'info'],
      ['markdown_proposal_invalid', 'warn'],
      ['markdown_proposal_incomplete', 'warn'],
      ['markdown_proposal_recognized', 'info'],
      ['markdown_proposal_incomplete', 'warn'],
    ]);
    expect(outcomes.every((event) => event.meta === undefined && event.sanitizedMessage === undefined)).toBe(true);
    expect(JSON.stringify(bundle)).not.toContain('CANARY');
  });

  it('preserves compare_and_set_active_story_id and its error action without rewriting to other', async () => {
    const collector = createDiagnosticCollector({ platform: 'web' });
    const inner = createInMemoryStoryStorage();
    const failingInner = {
      ...inner,
      async compareAndSetActiveStoryId(expected: string | null, next: string | null) {
        if (next === 'fail-target') throw new Error('cas failed');
        return inner.compareAndSetActiveStoryId(expected, next);
      },
    };
    const tracked = createDiagnosticStoryStorage(failingInner, collector);
    await tracked.compareAndSetActiveStoryId(null, 'story-a');
    await expect(tracked.compareAndSetActiveStoryId('story-a', 'fail-target')).rejects.toThrow('cas failed');

    const bundle = collector.buildBundle({ baseUrl: '', model: 'deepseek-chat', memoryOnly: true });
    expect(bundle.events.map((event) => event.action)).toEqual([
      'compare_and_set_active_story_id',
      'compare_and_set_active_story_id_error',
    ]);
  });

  it('records only zero-content refusal metrics and rejects pack names, slot text, and refusal text', async () => {
    const collector = createDiagnosticCollector({ platform: 'web' });
    collector.recordEvent({
      level: 'error',
      category: 'llm',
      action: 'refusal_detected',
      meta: {
        packName: 'PACK_NAME_CANARY',
        slotText: 'SLOT_TEXT_CANARY',
        model: 'MODEL_CANARY',
        sanitizedReason: 'ERROR_BODY_CANARY',
        packEnabled: true,
        slotChars: { head: 3, mid: 4, tail: 5 },
        prefixMode: 'on_retry',
        refusalRoute: 'retry',
        matchedRuleId: 'L1-02',
        retryCount: 0,
        refusalText: 'REFUSAL_TEXT_CANARY',
      } as never,
    });

    const library = {
      packs: [{
        ...BUILTIN_NARRATIVE_PROMPT_PACK,
        id: 'diag-pack',
        title: 'PACK_NAME_CANARY',
        readOnly: false,
        slots: {
          head: 'SLOT_TEXT_CANARY',
          mid: 'MID_CANARY',
          tail: 'TAIL_CANARY',
        },
      }],
      activePackId: 'diag-pack',
    };
    let requestCount = 0;
    const transport: LlmTransport = {
      async *streamChat() {
        requestCount += 1;
        if (requestCount === 1) {
          yield { contentDelta: '抱歉，我不能帮你写这段内容。', finishReason: 'stop' };
        } else {
          yield { contentDelta: '雨声落在窗沿上，他推门走进屋里，看见桌上还留着半盏温茶。', finishReason: 'stop' };
        }
      },
    };
    const harness = createFictionHarness({
      transport,
      promptPackLibrary: library,
      diagnostics: collector,
    });
    await harness.runTurn(harness.createStory({ title: '诊断测试' }), '继续', {
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-flash',
      apiKey: 'sk-test-123456',
      memoryOnly: true,
    });

    const bundle = collector.buildBundle({
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-flash',
      apiKey: '',
      memoryOnly: true,
    });
    const refusalEvents = bundle.events.filter((event) => event.action.startsWith('refusal_'));
    expect(refusalEvents.map((event) => event.action)).toEqual([
      'refusal_detected',
      'refusal_detected',
      'refusal_retry_recovered',
    ]);
    expect(refusalEvents[1].meta).toEqual({
      packEnabled: true,
      slotChars: { head: 16, mid: 10, tail: 11 },
      prefixMode: 'on_retry',
      refusalRoute: 'retry',
      matchedRuleId: 'L1-02',
      retryCount: 0,
    });
    const json = JSON.stringify(bundle);
    for (const canary of [
      'PACK_NAME_CANARY',
      'SLOT_TEXT_CANARY',
      'MID_CANARY',
      'TAIL_CANARY',
      'REFUSAL_TEXT_CANARY',
      'MODEL_CANARY',
      'ERROR_BODY_CANARY',
      '抱歉，我不能帮你写这段内容。',
    ]) {
      expect(json).not.toContain(canary);
    }
  });

  it('records original-refusal restoration using only safe node diagnostic metrics', () => {
    const collector = createDiagnosticCollector({ platform: 'web' });
    const nodeDiagnostics = {
      sourceStatus: 'REFUSAL' as const,
      refusalRoute: 'refused_exhausted' as const,
      matchedRuleId: 'L1-02',
      retriedWithPrefix: true,
      recoveredFromText: 'RESTORED_BODY_CANARY',
    };

    recordRefusalOriginalRestoredDiagnostic(collector, nodeDiagnostics);

    const bundle = collector.buildBundle({ baseUrl: '', model: '', memoryOnly: true });
    const event = bundle.events.find((item) => item.action === 'refusal_original_restored');
    expect(event?.meta).toEqual({
      refusalRoute: 'refused_exhausted',
      matchedRuleId: 'L1-02',
      retryCount: 1,
    });
    expect(JSON.stringify(bundle)).not.toContain('RESTORED_BODY_CANARY');
  });

  it('records zero-content auto-scroll diagnostic breadcrumbs and drops unallowlisted fields', () => {
    const collector = createDiagnosticCollector({ platform: 'web' });

    recordAutoScrollDiagnostic(collector, {
      level: 'warn',
      action: 'autoscroll_target_non_scrollable',
      metrics: {
        scrollMode: 'writing',
        scrollState: 'following',
        scrollOverflowY: 'visible',
        scrollTop: 0,
        scrollHeight: 2400.4,
        clientHeight: 780,
        scrollGapPx: 1620,
        reasonCode: 'resolved_scrollable_ancestor',
        // @ts-expect-error verify runtime fail-closed sanitization of unexpected text keys
        storyText: 'SECRET_STORY_CANARY',
      },
    });
    recordAutoScrollDiagnostic(collector, {
      level: 'warn',
      action: 'autoscroll_target_missing',
      metrics: {
        scrollMode: 'character',
        scrollState: 'following',
        reasonCode: 'missing_stage_ref',
      },
    });
    recordAutoScrollDiagnostic(collector, {
      level: 'info',
      action: 'autoscroll_follow_transition',
      metrics: {
        scrollMode: 'story',
        scrollState: 'user_paused',
        scrollGapPx: 320,
        reasonCode: 'paused_by_user',
      },
    });
    recordAutoScrollDiagnostic(collector, {
      level: 'warn',
      action: 'autoscroll_follow_anomaly',
      metrics: {
        scrollMode: 'welcome',
        scrollState: 'following',
        scrollGapPx: 410,
        reasonCode: 'scroll_missed_bottom',
      },
    });

    const bundle = collector.buildBundle({ baseUrl: '', model: '', memoryOnly: true });
    const scrollEvents = bundle.events.filter((event) => event.action.startsWith('autoscroll_'));
    expect(scrollEvents.map((event) => event.action)).toEqual([
      'autoscroll_target_non_scrollable',
      'autoscroll_target_missing',
      'autoscroll_follow_transition',
      'autoscroll_follow_anomaly',
    ]);
    expect(scrollEvents[0].meta).toEqual({
      scrollMode: 'writing',
      scrollState: 'following',
      scrollOverflowY: 'visible',
      scrollTop: 0,
      scrollHeight: 2400,
      clientHeight: 780,
      scrollGapPx: 1620,
      reasonCode: 'resolved_scrollable_ancestor',
    });
    expect(JSON.stringify(bundle)).not.toContain('SECRET_STORY_CANARY');
  });

  it('records zero-content swipe gesture diagnostics with allowlisted surface and reasonCode only', () => {
    const collector = createDiagnosticCollector({ platform: 'android' });
    recordSwipeDiagnostic(collector, {
      action: 'swipe_gesture_canceled',
      surface: 'drawer_close',
      reasonCode: 'pointer_cancel_horizontal',
    });
    recordSwipeDiagnostic(collector, {
      action: 'swipe_gesture_rejected',
      surface: 'overlay_back',
      reasonCode: 'below_threshold',
    });

    const bundle = collector.buildBundle({ baseUrl: '', model: '', memoryOnly: true });
    expect(bundle.events.map((e) => ({ level: e.level, category: e.category, action: e.action, meta: e.meta }))).toEqual([
      {
        level: 'warn',
        category: 'ui',
        action: 'swipe_gesture_canceled',
        meta: { swipeSurface: 'drawer_close', reasonCode: 'pointer_cancel_horizontal' },
      },
      {
        level: 'info',
        category: 'ui',
        action: 'swipe_gesture_rejected',
        meta: { swipeSurface: 'overlay_back', reasonCode: 'below_threshold' },
      },
    ]);
  });

  it('redacts custom provider domains to relay_<hash> and scrubs tvly/sk/Bearer tokens from publicResearch and provider errors', () => {
    const profile = sanitizeEndpointProfile({
      baseUrl: 'https://custom-gateway.example.org:8443/v1?api_key=tvly-dev-CANARY123456',
      model: 'tvly-dev-CANARY123456',
      apiKey: 'sk-custom-CANARY987654',
      memoryOnly: false,
    });
    expect(profile.hostKind).toBe('relay');
    expect(profile.host).toMatch(/^relay_[0-9a-f]{8}$/);
    expect(profile.model).toBe('unset');

    const siliconProfile = sanitizeEndpointProfile({
      baseUrl: 'https://api.siliconflow.cn/v1',
      model: 'deepseek-ai/DeepSeek-V3',
      apiKey: 'sk-sf-CANARY',
      memoryOnly: false,
    });
    expect(siliconProfile.hostKind).toBe('relay');
    expect(siliconProfile.host).toMatch(/^relay_[0-9a-f]{8}$/);
    expect(siliconProfile.model).toBe('deepseek-ai/DeepSeek-V3');

    const collector = createDiagnosticCollector({ platform: 'web' });
    collector.recordError({
      category: 'llm',
      action: 'stream_error',
      statusCode: 401,
      error: new Error(
        'Tavily search failed at https://api.tavily.com/search?api_key=tvly-dev-CANARY123456 with key tvly-CANARY654321 and Bearer bocha-secret-CANARY-token and sk-CANARY999888 against custom-gateway.example.org',
      ),
    });

    const bundle = collector.buildBundle({
      baseUrl: 'https://custom-gateway.example.org:8443/v1',
      model: 'deepseek-ai/DeepSeek-V3',
      apiKey: 'sk-custom-CANARY987654',
      memoryOnly: false,
    });
    const json = JSON.stringify(bundle);
    expect(json).not.toContain('custom-gateway.example.org');
    expect(json).not.toContain('api.tavily.com');
    expect(json).not.toContain('tvly-dev-CANARY123456');
    expect(json).not.toContain('tvly-CANARY654321');
    expect(json).not.toContain('bocha-secret-CANARY-token');
    expect(json).not.toContain('sk-CANARY999888');
    expect(json).not.toContain('sk-custom-CANARY987654');
    expect(bundle.events[0]?.sanitizedReason).toContain('[REDACTED_KEY]');
    expect(bundle.events[0]?.sanitizedReason).toContain('Bearer [REDACTED]');
  });

});
