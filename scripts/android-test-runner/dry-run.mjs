import fs from 'node:fs';
import path from 'node:path';

export const DRY_RUN_DUMPSYS_WINDOW = `
WINDOW MANAGER DISPLAY CONTENTS (dumpsys window displays)
  Display: mDisplayId=0 stacks=1
    init=1080x2400 420dpi mMinSize=1080x2400 cur=1080x2400 app=1080x2268 rng=1080x1008-2268x2196
    mCurrentDisplayInfo=DisplayInfo{"Built-in Screen", displayId 0, real 1080 x 2400, app 1080 x 2268, density 420, rotation 0 (ROTATION_0)}
    mDisplayFrames=DisplayFrames w=1080 h=2400 r=0
    mDisplayCutout=DisplayCutout{insets=Rect(0, 118 - 0, 0) boundingRect={Bounds=[Rect(486, 0 - 594, 118)]}}
    InsetsState
      InsetsSource id=e650000 type=statusBars frame=[0,0][1080,118] visible=true flags=[]
      InsetsSource id=c8e0001 type=navigationBars frame=[0,2337][1080,2400] visible=true flags=[]
      InsetsSource id=c8e0005 type=systemGestures frame=[0,0][84,2400] visible=true flags=[]
      InsetsSource id=c8e0006 type=systemGestures frame=[996,0][1080,2400] visible=true flags=[]
`;

function parseOpTag(expr) {
  const match = String(expr).match(/^\/\*\s*@lfh-op\s+([A-Za-z0-9_]+)\s+(\{[\s\S]*?\})\s*\*\//);
  if (!match) return null;
  try {
    return { op: match[1], args: JSON.parse(match[2]) };
  } catch {
    return null;
  }
}

async function consumeSseFromMock(url, payload) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    const errText = await response.text().catch(() => '');
    return {
      ok: false,
      aborted: false,
      errorCode: `HTTP_${response.status}`,
      content: errText,
      reasoningContent: '',
    };
  }

  let content = '';
  let reasoningContent = '';
  let aborted = false;
  let sawDone = false;

  const reader = response.body?.getReader();
  if (!reader) {
    return { ok: true, aborted: false, errorCode: null, content: '', reasoningContent: '' };
  }
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split('\n\n');
      buffer = blocks.pop() ?? '';
      for (const block of blocks) {
        const line = block
          .split('\n')
          .find((l) => l.startsWith('data:'));
        if (!line) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') {
          sawDone = true;
          continue;
        }
        try {
          const parsed = JSON.parse(data);
          const delta = parsed?.choices?.[0]?.delta ?? {};
          if (typeof delta.reasoning_content === 'string') {
            reasoningContent += delta.reasoning_content;
          }
          if (typeof delta.content === 'string') {
            content += delta.content;
          }
        } catch {
          // Ignore malformed chunk in simulation
        }
      }
    }
  } catch {
    aborted = true;
  }

  if (!sawDone && !aborted) {
    aborted = true;
  }

  return {
    ok: !aborted,
    aborted,
    errorCode: aborted ? 'CONNECTION_ABORTED' : null,
    content,
    reasoningContent,
  };
}

export function createDryRunHarness(options = {}) {
  const suite = options.suite === 'smoke' ? 'smoke' : 'e2e';
  const packageId =
    options.packageId ??
    (suite === 'smoke' ? 'io.localfiction.harness.smoke' : 'io.localfiction.harness.e2e');

  const adbCalls = [];
  const evaluatedExpressions = [];
  const pmClearCalls = [];
  const screenrecordStarts = [];
  const deletedEntities = { storyIds: [], workIds: [], characterIds: [] };

  const state = {
    packageId,
    timeOrigin: 1_764_224_400_000,
    overlayDepth: 0,
    historySession: 'session-token-1',
    sessionToken: 'session-token-1',
    drawerOpen: false,
    settingsOpen: false,
    wizardOpen: false,
    storyMenuOpen: false,
    storyMenuItemIndex: 0,
    importPanelOpen: false,
    importPreviewOpen: false,
    diagnosticsOpen: false,
    modeSwitchDialogOpen: false,
    inLauncher: false,
    powerAsleep: false,
    screenOffObserved: false,
    wakeLockObserved: false,
    sseForegroundActive: false,
    imeVisible: false,
    autoScrollPaused: false,
    stageScrollGapPx: 0,
    drawerScrollTop: 0,
    currentMode: 'story',
    lockedMode: 'story',
    originalModeDataUntouched: true,
    tutorialStage: 'main',
    tutorialStepIndex: 0,
    tutorialMainDone: false,
    tutorialSettingsDone: false,
    profiles: [
      {
        id: 'deepseek-official',
        name: 'DeepSeek 官方',
        presetId: 'deepseek',
        baseUrl: 'https://api.deepseek.com',
        defaultModel: 'deepseek-chat',
      },
      ...(options.hasCustomProfile
        ? [
            {
              id: 'custom-profile-1',
              name: '自定义测试端点',
              presetId: 'custom',
              baseUrl: 'https://custom-provider.example.invalid/v1',
              defaultModel: 'custom-model-v1',
            },
          ]
        : []),
    ],
    activeProfileId: 'deepseek-official',
    activeModel: 'deepseek-chat',
    draftBaseUrl: '',
    draftModel: '',
    draftName: '',
    stories: [
      { id: 'preexisting-story-1', title: '既有本地故事', mode: 'story', updatedAt: 1000 },
    ],
    works: [{ id: 'preexisting-work-1', title: '既有作品', updatedAt: 1000 }],
    characters: [{ id: 'preexisting-char-1', title: '既有角色', updatedAt: 1000 }],
    turns: [],
    lastErrorBanner: null,
    lastRefusalRoute: null,
    balanceText: '¥ 88.80',
    screenshotCounter: 0,
    activePromptPackId: 'default-pack',
    reasoningEffort: 'off',
  };

  function currentSnapshot() {
    return {
      url: 'http://localhost/',
      readyState: 'complete',
      timeOrigin: state.timeOrigin,
      sessionToken: state.sessionToken,
      historySession: state.historySession,
      overlayDepth: state.overlayDepth,
      visualViewport: {
        width: 412,
        height: state.imeVisible ? 520 : 915,
        offsetLeft: 0,
        offsetTop: 0,
        scale: 1,
      },
      innerHeight: 915,
      dpr: 2.625,
      stageScrollGapPx: state.stageScrollGapPx,
      drawerOpen: state.drawerOpen,
      settingsOpen: state.settingsOpen,
      wizardOpen: state.wizardOpen,
      diagnosticsOpen: state.diagnosticsOpen,
      modeSwitchDialogOpen: state.modeSwitchDialogOpen,
      testIds: [
        'app-workspace',
        'main-stage',
        ...(state.drawerOpen ? ['mobile-library-dialog', 'mobile-library-sheet', 'library-list-scroll'] : []),
        ...(state.settingsOpen ? ['settings-page', 'provider-profile-list', 'active-provider-base-url', 'refresh-balance-btn', 'deepseek-balance-value', 'replay-tutorial-btn'] : []),
        ...(state.tutorialStage ? ['spotlight-tutorial', 'spotlight-cutout', 'spotlight-next-btn', 'spotlight-skip-btn'] : []),
        ...(state.modeSwitchDialogOpen ? ['mode-switch-confirm-dialog', 'mode-switch-source', 'mode-switch-target', 'mode-switch-confirm-btn'] : []),
        ...(state.autoScrollPaused ? ['scroll-to-bottom'] : []),
      ],
    };
  }

  const adbRunner = (cmd, args = []) => {
    adbCalls.push({ cmd, args: [...args] });
    const joined = args.join(' ');

    if (joined.includes('pm clear')) {
      pmClearCalls.push(joined);
      if (suite === 'smoke' || joined.includes('io.localfiction.harness.smoke')) {
        throw new Error('SECURITY VIOLATION: pm clear is forbidden on .smoke');
      }
      state.tutorialStage = 'main';
      state.tutorialStepIndex = 0;
      state.tutorialMainDone = false;
      state.tutorialSettingsDone = false;
      state.profiles = state.profiles.slice(0, 1);
      state.activeProfileId = 'deepseek-official';
      state.stories = [];
      state.works = [];
      state.characters = [];
      state.turns = [];
      return 'Success\n';
    }
    if (joined.includes('adb') && args[0] === 'devices') {
      return `${options.serial ?? 'emulator-5554'}\tdevice\n`;
    }
    if (joined.includes('devices')) {
      return `List of devices attached\n${options.serial ?? 'emulator-5554'}\tdevice\n`;
    }
    if (joined.includes('date +%s%3N')) {
      return `${Date.now() - 150}\n`;
    }
    if (joined.includes('dumpsys window displays')) {
      return DRY_RUN_DUMPSYS_WINDOW;
    }
    if (joined.includes('wm size')) {
      return 'Physical size: 1080x2400\n';
    }
    if (joined.includes('wm density')) {
      return 'Physical density: 420\n';
    }
    if (joined.includes('locksettings get-disabled')) {
      return options.lockscreenProtected ? 'false\n' : 'true\n';
    }
    if (joined.includes('dumpsys trust')) {
      return options.lockscreenProtected
        ? 'deviceLocked=true isKeyguardSecure=true\n'
        : 'deviceLocked=false isKeyguardSecure=false\n';
    }
    if (joined.includes('dumpsys power')) {
      return [
        `mWakefulness=${state.powerAsleep ? 'Asleep' : 'Awake'}`,
        ...(state.screenOffObserved || state.wakeLockObserved
          ? [`PARTIAL_WAKE_LOCK              'Folio:NativeSseKeepalive' ACQ=-10s`]
          : []),
      ].join('\n');
    }
    if (joined.includes('dumpsys input_method')) {
      return state.imeVisible ? 'mInputShown=true\n' : 'mInputShown=false\n';
    }
    if (joined.includes('dumpsys activity activities')) {
      const top = state.inLauncher
        ? 'topResumedActivity=ActivityRecord{com.google.android.apps.nexuslauncher/.NexusLauncherActivity}\ntopDisplayFocusedRootTask=Task{1 type=home}'
        : `topResumedActivity=ActivityRecord{${packageId}/.MainActivity}\ntopDisplayFocusedRootTask=Task{2 type=standard}`;
      const svc = state.sseForegroundActive
        ? `\n  * ServiceRecord{abc u0 ${packageId}/io.localfiction.harness.SseForegroundService}`
        : '';
      return `${top}${svc}\n`;
    }
    if (joined.includes('dumpsys activity services')) {
      return state.sseForegroundActive
        ? `  * ServiceRecord{abc u0 ${packageId}/io.localfiction.harness.SseForegroundService}\n`
        : '';
    }
    if (joined.includes('dumpsys window')) {
      return state.inLauncher
        ? 'mCurrentFocus=Window{1 u0 com.google.android.apps.nexuslauncher/.NexusLauncherActivity}\nmFocusedApp=ActivityRecord{com.google.android.apps.nexuslauncher/.NexusLauncherActivity}\n'
        : `mCurrentFocus=Window{2 u0 ${packageId}/.MainActivity}\n`;
    }
    if (joined.includes('uiautomator dump')) {
      return 'UI hierchary dumped\n';
    }
    if (joined.includes('exec-out cat /sdcard/')) {
      return state.inLauncher
        ? '<hierarchy><node package="com.google.android.apps.nexuslauncher" text="Home" /></hierarchy>'
        : `<hierarchy><node package="${packageId}" text="Folio" /></hierarchy>`;
    }
    if (args.includes('screencap')) {
      state.screenshotCounter += 1;
      return Buffer.from(`dryrun-png-${state.inLauncher ? 'launcher' : 'app'}-${state.screenshotCounter}`);
    }
    if (args.includes('pull')) {
      const dest = args[args.length - 1];
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, Buffer.from('dryrun-mp4'));
      return '1 file pulled.';
    }
    if (args.includes('screenrecord')) {
      screenrecordStarts.push(joined);
      return '';
    }
    if (joined.includes('input keyevent KEYCODE_HOME')) {
      state.inLauncher = true;
      return '';
    }
    if (joined.includes('input keyevent KEYCODE_POWER')) {
      state.powerAsleep = true;
      state.screenOffObserved = true;
      state.wakeLockObserved = true;
      return '';
    }
    if (joined.includes('input keyevent KEYCODE_WAKEUP')) {
      state.powerAsleep = false;
      return '';
    }
    if (joined.includes('input keyevent KEYCODE_DPAD_DOWN')) {
      if (state.storyMenuOpen) state.storyMenuItemIndex = 1;
      return '';
    }
    if (joined.includes('input keyevent KEYCODE_BACK')) {
      if (state.importPreviewOpen) {
        state.importPreviewOpen = false;
        state.overlayDepth = 1;
      } else if (state.storyMenuOpen) {
        state.storyMenuOpen = false;
        state.overlayDepth = 1;
      } else if (state.wizardOpen) {
        state.wizardOpen = false;
        state.overlayDepth = 1;
      } else if (state.settingsOpen) {
        state.settingsOpen = false;
        state.overlayDepth = 0;
      } else if (state.drawerOpen) {
        state.drawerOpen = false;
        state.overlayDepth = 0;
      } else if (state.diagnosticsOpen || state.historySession !== state.sessionToken) {
        state.diagnosticsOpen = false;
        state.overlayDepth = 0;
        state.inLauncher = true;
      } else {
        state.inLauncher = true;
      }
      return '';
    }
    if (joined.includes('am start')) {
      state.inLauncher = false;
      state.powerAsleep = false;
      return 'Status: ok\n';
    }
    if (joined.includes('am force-stop')) {
      state.drawerOpen = false;
      state.settingsOpen = false;
      state.wizardOpen = false;
      state.overlayDepth = 0;
      return '';
    }
    if (joined.includes('input swipe')) {
      const [x1, y1, x2, y2] = args.slice(-5, -1).map(Number);
      if (x1 <= 84 && x2 > x1 && Math.abs(y2 - y1) < 100) {
        if (state.settingsOpen) {
          state.settingsOpen = false;
          state.overlayDepth = 0;
        } else {
          state.inLauncher = true;
        }
      } else if (x2 > x1 + 100 && Math.abs(y2 - y1) < 120) {
        if (state.settingsOpen) {
          state.settingsOpen = false;
          state.overlayDepth = 0;
        } else if (!state.drawerOpen) {
          state.drawerOpen = true;
          state.overlayDepth = 1;
        }
      } else if (x1 > x2 + 100 && Math.abs(y2 - y1) < 120 && state.drawerOpen) {
        state.drawerOpen = false;
        state.overlayDepth = 0;
      } else if (y1 > y2 + 100 && state.drawerOpen) {
        state.drawerScrollTop += 240;
      } else if (y2 > y1 + 100 && !state.drawerOpen) {
        state.autoScrollPaused = true;
      }
      return '';
    }
    if (joined.includes('input tap')) {
      const [x, y] = args.slice(-2).map(Number);
      if (state.modeSwitchDialogOpen) {
        state.modeSwitchDialogOpen = false;
        state.currentMode = 'work';
        state.overlayDepth = 0;
      } else if (y > 1600 && !state.drawerOpen && !state.settingsOpen) {
        state.imeVisible = true;
      }
      void x;
      return '';
    }
    if (joined.includes('logcat -d')) {
      return [
        '11-27 06:20:01.000  4215  4215 I SseStreamClient: stream opened',
        '11-27 06:20:05.000  4215  4215 I SseForegroundService: keepalive active',
        '11-27 06:20:08.000  4215  4215 W SseStreamClient: classified error CONNECTION_ABORTED',
      ].join('\n');
    }
    return '';
  };

  async function handleOp(op, args) {
    switch (op) {
      case 'readSnapshot':
        return currentSnapshot();
      case 'checkKeyUiVisible':
        return Boolean(state.wizardOpen);
      case 'clickSelector': {
        const sel = String(args.selector ?? '');
        if (sel.includes('library-drawer-trigger')) {
          state.drawerOpen = true;
          state.overlayDepth = 1;
        } else if (sel.includes('mobile-settings-open')) {
          state.drawerOpen = false;
          state.settingsOpen = true;
          state.overlayDepth = 1;
        } else if (sel.includes('open-setup-wizard-btn') || sel.includes('add-provider-profile-btn')) {
          state.wizardOpen = true;
          state.overlayDepth = 2;
        } else if (sel.includes('provider-preset-custom') || sel.includes('provider-preset-local')) {
          return true;
        } else if (sel.includes('wizard-verify-save-btn')) {
          const newId = `custom-${state.profiles.length + 1}`;
          state.profiles.push({
            id: newId,
            name: state.draftName || `测试档案 ${state.profiles.length}`,
            presetId: 'custom',
            baseUrl: state.draftBaseUrl || 'http://127.0.0.1:18080',
            defaultModel: state.draftModel || 'deepseek-chat',
          });
          state.activeProfileId = newId;
          state.activeModel = state.draftModel || 'deepseek-chat';
          state.wizardOpen = false;
          state.overlayDepth = 1;
        } else if (sel.includes('provider-profile-switch-')) {
          const targetId = sel.split('provider-profile-switch-')[1]?.replace(/["\]]/g, '') ?? '';
          const found = state.profiles.find((p) => p.id === targetId);
          if (found) {
            state.activeProfileId = found.id;
            state.activeModel = found.defaultModel;
          }
        } else if (sel.includes('spotlight-next-btn')) {
          state.tutorialStepIndex = Math.min(3, state.tutorialStepIndex + 1);
        } else if (sel.includes('tutorial-connect-cta')) {
          state.tutorialMainDone = true;
          state.settingsOpen = true;
          state.overlayDepth = 1;
          state.tutorialStage = 'settings';
          state.tutorialStepIndex = 0;
        } else if (sel.includes('spotlight-finish-btn')) {
          state.tutorialSettingsDone = true;
          state.tutorialStage = null;
          state.tutorialStepIndex = 0;
        } else if (sel.includes('replay-tutorial-btn')) {
          state.settingsOpen = false;
          state.overlayDepth = 0;
          state.tutorialMainDone = false;
          state.tutorialSettingsDone = false;
          state.tutorialStage = 'main';
          state.tutorialStepIndex = 0;
        } else if (sel.includes('diagnostics-reload')) {
          state.timeOrigin += 1000;
          state.diagnosticsOpen = false;
          state.historySession = 'stale-session';
          state.overlayDepth = 1;
        } else if (sel.includes('story-menu-trigger')) {
          state.storyMenuOpen = true;
          state.storyMenuItemIndex = 0;
          state.overlayDepth = 2;
        } else if (sel.includes('mobile-library-start-deepseek')) {
          state.drawerOpen = false;
          state.importPanelOpen = true;
          state.overlayDepth = 1;
        } else if (sel.includes('ds-session-preview-trigger')) {
          state.importPreviewOpen = true;
          state.overlayDepth = 2;
        } else if (sel.includes('refresh-balance-btn')) {
          state.balanceText = '¥ 88.80';
        } else if (sel.includes('mode-switch-confirm-btn')) {
          state.modeSwitchDialogOpen = false;
          state.currentMode = 'work';
          state.overlayDepth = 0;
        }
        return true;
      }
      case 'fillInput': {
        const sel = String(args.selector ?? '');
        const val = String(args.value ?? '');
        if (sel.includes('provider-base-url-input')) state.draftBaseUrl = val;
        if (sel.includes('provider-model-input')) state.draftModel = val;
        if (sel.includes('provider-name-input')) state.draftName = val;
        return true;
      }
      case 'queryElementMetrics': {
        const sel = String(args.selector ?? '');
        const isComposer = sel.includes('turn-input') || sel.includes('stage-composer');
        const isConfirm = sel.includes('mode-switch-confirm-btn');
        return {
          rect: isComposer
            ? { left: 24, top: 820, right: 360, bottom: 870, width: 336, height: 50 }
            : isConfirm
              ? { left: 220, top: 520, right: 340, bottom: 564, width: 120, height: 44 }
              : { left: 160, top: 680, right: 320, bottom: 724, width: 160, height: 44 },
          unobscured: true,
          visualViewport: { offsetLeft: 0, offsetTop: 0, scale: 1 },
          dpr: 2.625,
        };
      }
      case 'e2eReadProviderState': {
        const active =
          state.profiles.find((p) => p.id === state.activeProfileId) ?? state.profiles[0];
        return {
          profileCount: state.profiles.length,
          activeProfileId: state.activeProfileId,
          activeBaseUrl: active?.baseUrl ?? '',
          activeModel: state.activeModel,
          profiles: state.profiles.map((p) => ({ ...p })),
        };
      }
      case 'e2eReadTutorialState': {
        const mainIds = [
          'main-welcome-library',
          'main-model-reasoning',
          'main-narrative-presets',
          'main-connect-deepseek',
        ];
        const settingsIds = [
          'settings-connection',
          'settings-usage-overview',
          'settings-narrative-presets',
          'settings-backup-replay',
        ];
        const ids = state.tutorialStage === 'settings' ? settingsIds : mainIds;
        return {
          open: Boolean(state.tutorialStage),
          stage: state.tutorialStage,
          stepIndex: state.tutorialStepIndex,
          stepId: state.tutorialStage ? ids[state.tutorialStepIndex] ?? ids[0] : null,
          cutoutRect: { left: 20, top: 200, right: 220, bottom: 280, width: 200, height: 80 },
          targetRect: { left: 20, top: 200, right: 220, bottom: 280, width: 200, height: 80 },
          nextBtnUnobscured: true,
          skipBtnUnobscured: true,
          mainDone: state.tutorialMainDone,
          settingsDone: state.tutorialSettingsDone,
        };
      }
      case 'e2eSeedStories': {
        const count = Number(args.count ?? 5);
        while (state.stories.length < count) {
          const idx = state.stories.length + 1;
          state.stories.push({
            id: `e2e-seed-${idx}`,
            title: `滑动测试故事 ${idx}`,
            mode: 'story',
            updatedAt: 2000 + idx,
          });
        }
        return state.stories.length;
      }
      case 'e2eReadScrollMetrics':
        return {
          drawerScrollTop: state.drawerScrollTop,
          stageScrollGapPx: state.stageScrollGapPx,
          showScrollToBottom: state.autoScrollPaused,
          stageScrollHeight: 2800,
          stageClientHeight: 460,
        };
      case 'e2eTriggerCrashOverlay':
        state.diagnosticsOpen = true;
        state.overlayDepth = 1;
        return true;
      case 'e2eSetupStageBackScenario':
        if (args.step === 'settings-byok') {
          state.settingsOpen = true;
          state.wizardOpen = true;
          state.overlayDepth = 2;
        } else if (args.step === 'drawer-menu') {
          state.drawerOpen = true;
          state.storyMenuOpen = true;
          state.storyMenuItemIndex = 0;
          state.overlayDepth = 2;
        } else if (args.step === 'import-preview') {
          state.importPanelOpen = true;
          state.importPreviewOpen = true;
          state.overlayDepth = 2;
        }
        return true;
      case 'e2eSendTurn': {
        if (options.failScenario && options.failScenario === args.scenarioId) {
          state.lastErrorBanner = 'FORCED_TEST_FAILURE';
          return {
            ok: false,
            aborted: true,
            errorCode: 'FORCED_TEST_FAILURE',
            content: '',
            reasoningContent: '',
          };
        }
        state.sseForegroundActive = true;
        state.wakeLockObserved = true;
        state.autoScrollPaused = false;
        state.stageScrollGapPx = 0;

        let sseResult = {
          ok: true,
          aborted: false,
          errorCode: null,
          content: '模拟流式响应正常完成。',
          reasoningContent: '',
        };
        if (args.mockUrl) {
          const targetUrl = `${args.mockUrl}${args.endpointPath ?? '/v1/chat/completions'}`;
          sseResult = await consumeSseFromMock(targetUrl, {
            model: state.activeModel || 'deepseek-chat',
            stream: true,
            messages: [{ role: 'user', content: args.prompt ?? 'hello' }],
          });
        }
        state.sseForegroundActive = false;
        if (sseResult.aborted) {
          state.lastErrorBanner = sseResult.errorCode ?? 'CONNECTION_ABORTED';
          state.turns.push({ role: 'user', content: args.prompt ?? '' });
          state.turns.push({ role: 'assistant', content: sseResult.content });
        } else {
          state.lastErrorBanner = null;
          if (args.expectHalfRefusal) {
            state.lastRefusalRoute = 'retry';
          }
          state.turns.push({ role: 'user', content: args.prompt ?? '' });
          state.turns.push({
            role: 'assistant',
            content: sseResult.content,
            reasoningContent: sseResult.reasoningContent,
            refusalRoute: state.lastRefusalRoute,
          });
        }
        return sseResult;
      }
      case 'e2eReadTurnState': {
        const assistantTurns = state.turns.filter((t) => t.role === 'assistant');
        const last = assistantTurns[assistantTurns.length - 1];
        return {
          assistantCount: assistantTurns.length,
          lastAssistantText: last?.content ?? '',
          hasErrorBanner: Boolean(state.lastErrorBanner),
          errorCode: state.lastErrorBanner,
          hasRecoveredBadge: state.lastRefusalRoute === 'retry',
          refusalRoute: state.lastRefusalRoute,
          reasoningPresent: Boolean(last?.reasoningContent),
        };
      }
      case 'e2eImportDeepSeekZip': {
        const importedId = `imported-ds-${state.stories.length + 1}`;
        state.stories.push({
          id: importedId,
          title: '导入的 DeepSeek 故事',
          mode: 'story',
          updatedAt: Date.now(),
        });
        state.activeStoryId = importedId;
        state.importPreviewOpen = false;
        state.importPanelOpen = false;
        state.overlayDepth = 0;
        return { importedId };
      }
      case 'e2eCreateLockedModeDraft': {
        state.lockedMode = args.mode ?? 'story';
        state.currentMode = args.mode ?? 'story';
        state.modeSwitchDialogOpen = true;
        state.overlayDepth = 1;
        state.originalModeDataUntouched = true;
        return { dialogOpen: true };
      }
      case 'e2eReadModeSwitchState':
        return {
          dialogOpen: state.modeSwitchDialogOpen,
          sourceText: state.lockedMode === 'story' ? '文游' : state.lockedMode,
          targetText: '写故事',
          currentMode: state.currentMode,
          originalDataUntouched: state.originalModeDataUntouched,
        };
      case 'smokeSnapshotEntities':
        return {
          storyIds: state.stories.map((s) => s.id),
          workIds: state.works.map((w) => w.id),
          characterIds: state.characters.map((c) => c.id),
        };
      case 'smokeCreateAndSendTurn': {
        if (options.failScenario && options.failScenario === args.scenarioId) {
          state.lastErrorBanner = 'FORCED_SMOKE_FAILURE';
          throw new Error(`Forced smoke failure on ${args.scenarioId}`);
        }
        const mode = args.mode ?? 'story';
        const suffix = `${Date.now()}-${Math.floor(Math.random() * 1000)}`;
        let createdId = null;
        if (args.createEntity !== false) {
          if (mode === 'story') {
            createdId = `smk-story-${suffix}`;
            state.stories.push({
              id: createdId,
              title: `${args.titlePrefix ?? '[SMK-TEST]'} 文游`,
              mode: 'story',
              updatedAt: Date.now(),
            });
          } else if (mode === 'work') {
            createdId = `smk-work-${suffix}`;
            state.works.push({
              id: createdId,
              title: `${args.titlePrefix ?? '[SMK-TEST]'} 作品`,
              updatedAt: Date.now(),
            });
          } else {
            createdId = `smk-char-${suffix}`;
            state.characters.push({
              id: createdId,
              title: `${args.titlePrefix ?? '[SMK-TEST]'} 角色`,
              updatedAt: Date.now(),
            });
          }
        }
        if (args.reasoningEffort) state.reasoningEffort = args.reasoningEffort;
        if (args.presetId) state.activePromptPackId = args.presetId;

        const turn = {
          role: 'assistant',
          content: `真实冒烟短回复 (${mode})`,
          reasoningContent: args.reasoningEffort ? '简短思维链推理内容。' : '',
          hasProposal: Boolean(args.expectProposal),
          proposalApplied: false,
          proposalReverted: false,
          hasResearch: Boolean(args.expectPublicResearch),
        };
        state.turns.push({ role: 'user', content: args.prompt ?? '' });
        state.turns.push(turn);
        return {
          createdId,
          mode,
          assistantText: turn.content,
          hasReasoning: Boolean(turn.reasoningContent),
          hasProposal: turn.hasProposal,
          hasResearch: turn.hasResearch,
          hasErrorBanner: false,
          presetOverridden: Boolean(args.presetId),
        };
      }
      case 'smokeApplyAndCheckProposal': {
        const last = state.turns[state.turns.length - 1];
        if (last) {
          last.proposalApplied = true;
        }
        return {
          applied: Boolean(last?.proposalApplied),
          revertAvailable: Boolean(last?.proposalApplied),
        };
      }
      case 'smokeReadBalance':
        return {
          balanceText: state.balanceText,
          hasError: false,
        };
      case 'smokeListProfilesSafe':
        return {
          activeProfileId: state.activeProfileId,
          profiles: state.profiles.map((p) => ({
            id: p.id,
            name: p.name,
            presetId: p.presetId,
            defaultModel: p.defaultModel,
          })),
        };
      case 'smokeDeleteEntitiesByIds': {
        const sIds = new Set(args.storyIds ?? []);
        const wIds = new Set(args.workIds ?? []);
        const cIds = new Set(args.characterIds ?? []);
        for (const id of sIds) deletedEntities.storyIds.push(id);
        for (const id of wIds) deletedEntities.workIds.push(id);
        for (const id of cIds) deletedEntities.characterIds.push(id);
        state.stories = state.stories.filter((s) => !sIds.has(s.id));
        state.works = state.works.filter((w) => !wIds.has(w.id));
        state.characters = state.characters.filter((c) => !cIds.has(c.id));
        return {
          remainingStoryIds: state.stories.map((s) => s.id),
          remainingWorkIds: state.works.map((w) => w.id),
          remainingCharacterIds: state.characters.map((c) => c.id),
        };
      }
      default:
        return currentSnapshot();
    }
  }

  const client = {
    pid: '4215',
    localPort: '39111',
    target: { id: 'page-1', type: 'page', url: 'http://localhost/' },
    isConnected: () => true,
    onEvent: () => () => {},
    offEvent: () => {},
    onClose: () => () => {},
    getConsoleEvents: () => [
      {
        tsMs: Date.now(),
        method: 'Runtime.consoleAPICalled',
        params: { type: 'log', args: [{ value: 'dry-run ready' }] },
      },
    ],
    getExceptionEvents: () => [],
    getLifecycleEvents: () => [],
    getBufferedEvents: () => [],
    clearEventBuffers: () => {},
    enableDomains: async () => {},
    reconnect: async () => ({ client, pid: '4215', localPort: '39111', target: null }),
    close: async () => {},
    evaluate: async (expr) => {
      evaluatedExpressions.push(expr);
      if (suite === 'smoke' && /\b(loadApiKey|saveApiKey|clearApiKey)\b/.test(expr)) {
        throw new Error('SECURITY VIOLATION: NativeVault key API invoked in .smoke');
      }
      const parsed = parseOpTag(expr);
      if (parsed) {
        return handleOp(parsed.op, parsed.args);
      }
      if (expr.includes('performance.timeOrigin')) {
        return state.timeOrigin;
      }
      if (expr.includes('diagnostics-json') || expr.includes('lfh.diagnostics.v2')) {
        return {
          jsonText: JSON.stringify({
            schemaVersion: 2,
            generatedAt: new Date().toISOString(),
            platform: 'android',
            windowMinutes: 30,
            trigger: 'settings_manual',
            appEnv: {
              platform: 'android',
              appVersion: '0.5.0-beta.1',
              viewport: '412x915',
              activeView: 'stage',
              storyCount: state.stories.length,
            },
            endpointProfile: {
              presetId: 'deepseek',
              endpointKind: suite === 'e2e' ? 'custom' : 'official',
              hostLabel: suite === 'e2e' ? '127.0.0.1' : 'api.deepseek.com',
              model: state.activeModel,
            },
            importRadars: [],
            events: [
              { tsOffsetSec: -1, level: 'info', category: 'llm', action: 'stream_done' },
            ],
          }),
          storageText: null,
        };
      }
      return currentSnapshot();
    },
  };

  return {
    serial: options.serial ?? 'emulator-5554',
    state,
    adbCalls,
    evaluatedExpressions,
    pmClearCalls,
    screenrecordStarts,
    deletedEntities,
    adbRunner,
    cdpFactory: async () => ({
      client,
      pid: '4215',
      localPort: '39111',
      target: { id: 'page-1', type: 'page', url: 'http://localhost/' },
      reconnect: async () => ({ client, pid: '4215', localPort: '39111', target: null }),
      close: async () => {},
    }),
  };
}
