import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  DEFAULT_MODEL_CONFIG,
  computeActiveReviewState,
  createAsyncModelConfigStore,
  createFictionHarness,
  exportStoryBackup,
  getActiveBranchNodes,
  getActiveSummarySnapshot,
  getSiblingBranchInfo,
  importStoryBackup,
  isAbortError,
  type ModelConfig,
  type PlatformRuntime,
  type Story,
  type StoryBlueprint,
  type TurnCallbacks,
  type TurnExecutionResult,
} from '../harness/index.ts';
import {
  clearDevSessionProxy,
  fetchDevTestConfig,
  isDevProxyBaseUrl,
  readDevSessionProxy,
  writeDevSessionProxy,
  type DevTestConfigResponse,
} from '../platform/runtime.ts';
import { ContextOverview } from './ContextOverview.tsx';
import { ImportPanel } from './ImportPanel.tsx';
import { MessageContent } from './MessageContent.tsx';
import { StoryLibrary } from './StoryLibrary.tsx';
import { StoryReview } from './StoryReview.tsx';
import { StoryTree } from './StoryTree.tsx';
import { TurnCard } from './TurnCard.tsx';
import { toErrorMessage } from './textHelpers.ts';

function hasModelCredentials(config: ModelConfig, useDevEnvKey: boolean): boolean {
  if (config.apiKey.trim() || useDevEnvKey || isDevProxyBaseUrl(config.baseUrl)) {
    return true;
  }
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?/i.test(config.baseUrl.trim());
}

function mergeLoadedConfig(
  loaded: ModelConfig,
  isWebDev: boolean,
): { initialConfig: ModelConfig; initialUseDevEnvKey: boolean } {
  if (import.meta.env.DEV && isWebDev) {
    const devProxy = readDevSessionProxy(true);
    if (devProxy) {
      return {
        initialConfig: {
          ...loaded,
          baseUrl: devProxy.baseUrl,
          model: devProxy.model ?? loaded.model,
          apiKey: devProxy.hasEnvKey ? '' : loaded.apiKey,
        },
        initialUseDevEnvKey: devProxy.hasEnvKey,
      };
    }
  }
  if (!isWebDev && !/^https?:\/\//i.test(loaded.baseUrl.trim())) {
    return {
      initialConfig: { ...loaded, baseUrl: DEFAULT_MODEL_CONFIG.baseUrl },
      initialUseDevEnvKey: false,
    };
  }
  return { initialConfig: loaded, initialUseDevEnvKey: false };
}

export interface AppProps {
  runtime: PlatformRuntime;
}

export function App({ runtime }: AppProps) {
  const isWebDev = runtime.platform === 'web' && import.meta.env.DEV;

  const configStore = useMemo(
    () => createAsyncModelConfigStore(runtime.secretStore),
    [runtime],
  );
  const harness = useMemo(
    () =>
      createFictionHarness({
        transport: runtime.transport,
        storage: runtime.storyStorage,
      }),
    [runtime],
  );

  const [config, setConfig] = useState<ModelConfig>(() => {
    const devProxy = import.meta.env.DEV ? readDevSessionProxy(isWebDev) : null;
    if (devProxy) {
      return {
        ...DEFAULT_MODEL_CONFIG,
        baseUrl: devProxy.baseUrl,
        model: devProxy.model ?? DEFAULT_MODEL_CONFIG.model,
      };
    }
    return DEFAULT_MODEL_CONFIG;
  });
  const [useDevEnvKey, setUseDevEnvKey] = useState(() =>
    Boolean(import.meta.env.DEV && readDevSessionProxy(isWebDev)?.hasEnvKey),
  );
  const [showKey, setShowKey] = useState(false);
  const [devTestInfo, setDevTestInfo] = useState<DevTestConfigResponse | null>(null);
  const [stories, setStories] = useState<Story[]>([]);
  const [story, setStory] = useState<Story>(() => harness.createStory({ title: '新故事' }));
  const [showImport, setShowImport] = useState(false);
  const [input, setInput] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [isSummarizing, setIsSummarizing] = useState(false);
  const [streamReasoning, setStreamReasoning] = useState('');
  const [streamContent, setStreamContent] = useState('');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const streamSeqRef = useRef(0);
  const storyOpSeqRef = useRef(0);
  const configEditSeqRef = useRef(0);
  const configSaveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const suppressedAbortRef = useRef<WeakSet<AbortController>>(new WeakSet());

  const abortActiveStream = useCallback((suppressNotice = true) => {
    const controller = abortRef.current;
    if (controller) {
      if (suppressNotice) {
        suppressedAbortRef.current.add(controller);
      }
      abortRef.current = null;
      controller.abort();
    }
    streamSeqRef.current += 1;
    setIsStreaming(false);
    setStreamReasoning('');
    setStreamContent('');
  }, []);

  const refreshStories = useCallback(async () => {
    const list = await harness.listStories();
    setStories(list);
    return list;
  }, [harness]);

  useEffect(() => {
    return () => {
      abortActiveStream(true);
    };
  }, [abortActiveStream]);

  useEffect(() => {
    let cancelled = false;
    const editSeqAtStart = configEditSeqRef.current;
    (async () => {
      try {
        const loaded = await configStore.load();
        if (cancelled || configEditSeqRef.current !== editSeqAtStart) return;
        const merged = mergeLoadedConfig(loaded, isWebDev);
        setConfig(merged.initialConfig);
        setUseDevEnvKey(merged.initialUseDevEnvKey);
      } catch (err) {
        if (!cancelled && configEditSeqRef.current === editSeqAtStart) {
          setErrorMsg(toErrorMessage(err, '读取模型配置失败。'));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [configStore, isWebDev]);

  useEffect(() => {
    let cancelled = false;
    const loadSeq = storyOpSeqRef.current;
    (async () => {
      try {
        const [list, active] = await Promise.all([
          harness.listStories(),
          harness.loadActiveStory(),
        ]);
        if (cancelled || storyOpSeqRef.current !== loadSeq) return;
        setStories(list);
        if (active) {
          setStory(active);
        }
      } catch (err) {
        if (!cancelled && storyOpSeqRef.current === loadSeq) {
          setErrorMsg(toErrorMessage(err, '读取本地故事失败。'));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [harness]);

  useEffect(() => {
    if (!import.meta.env.DEV || !isWebDev) {
      return;
    }
    let cancelled = false;
    void fetchDevTestConfig().then((data) => {
      if (!cancelled && data) {
        setDevTestInfo(data);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [isWebDev]);

  const enqueueConfigSave = (task: () => Promise<void>) => {
    configSaveQueueRef.current = configSaveQueueRef.current
      .then(task)
      .catch((err) => {
        setErrorMsg(toErrorMessage(err, '保存模型配置失败。'));
      });
  };

  const updateConfig = (next: ModelConfig, nextUseDevEnvKey = useDevEnvKey) => {
    configEditSeqRef.current += 1;
    const effectiveUseDevEnvKey =
      import.meta.env.DEV && isWebDev && nextUseDevEnvKey && isDevProxyBaseUrl(next.baseUrl);
    setConfig(next);
    setUseDevEnvKey(effectiveUseDevEnvKey);
    if (import.meta.env.DEV && isWebDev) {
      if (effectiveUseDevEnvKey) {
        writeDevSessionProxy({
          baseUrl: next.baseUrl,
          model: next.model,
          hasEnvKey: true,
        });
        const saveSeq = configEditSeqRef.current;
        enqueueConfigSave(async () => {
          if (configEditSeqRef.current !== saveSeq) return;
          const persisted = await configStore.load();
          await configStore.save({
            ...next,
            baseUrl: isDevProxyBaseUrl(persisted.baseUrl)
              ? DEFAULT_MODEL_CONFIG.baseUrl
              : persisted.baseUrl,
          });
        });
        return;
      }
      clearDevSessionProxy();
    }
    enqueueConfigSave(() => configStore.save(next));
  };

  const applyDevTestConfig = () => {
    if (!import.meta.env.DEV || !devTestInfo || !isWebDev) return;
    configEditSeqRef.current += 1;
    const devModel = devTestInfo.model || config.model;
    writeDevSessionProxy({
      baseUrl: devTestInfo.proxyBaseUrl,
      model: devModel,
      hasEnvKey: devTestInfo.hasEnvKey,
    });
    setConfig({
      baseUrl: devTestInfo.proxyBaseUrl,
      model: devModel,
      apiKey: devTestInfo.hasEnvKey ? '' : config.apiKey,
      memoryOnly: config.memoryOnly,
    });
    setUseDevEnvKey(devTestInfo.hasEnvKey);
    setErrorMsg(null);
  };

  const activeNodes = getActiveBranchNodes(story);
  const activeSummary = getActiveSummarySnapshot(story);
  const contextPreview = useMemo(
    () => harness.assembleContext(story, story.activeLeafNodeId),
    [harness, story],
  );

  const runStreamingExecution = async (
    execute: (callbacks: TurnCallbacks) => Promise<TurnExecutionResult>,
    onErrorRestore?: () => void,
  ) => {
    if (abortRef.current || isStreaming) return;
    setErrorMsg(null);
    setIsStreaming(true);
    setStreamReasoning('');
    setStreamContent('');

    const controller = new AbortController();
    abortRef.current = controller;
    const streamSeq = ++streamSeqRef.current;
    const storySeqAtStart = storyOpSeqRef.current;

    const isStale = () =>
      controller.signal.aborted ||
      abortRef.current !== controller ||
      streamSeqRef.current !== streamSeq ||
      storyOpSeqRef.current !== storySeqAtStart;

    try {
      const result = await execute({
        signal: controller.signal,
        onReasoningDelta: (delta) => {
          if (!isStale()) {
            setStreamReasoning((prev) => prev + delta);
          }
        },
        onContentDelta: (delta) => {
          if (!isStale()) {
            setStreamContent((prev) => prev + delta);
          }
        },
      });
      if (isStale()) {
        return;
      }
      setStory(result.story);
      await refreshStories();
      if (!isStale()) {
        setStreamReasoning('');
        setStreamContent('');
      }
    } catch (err) {
      if (suppressedAbortRef.current.has(controller) || storyOpSeqRef.current !== storySeqAtStart) {
        return;
      }
      if (isAbortError(err)) {
        setErrorMsg('已中止本次生成。');
      } else {
        setErrorMsg(toErrorMessage(err, '生成失败，请检查模型端点与配置。'));
      }
      onErrorRestore?.();
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
        setIsStreaming(false);
      }
    }
  };

  const runStoryTransition = async (
    transition: () => Promise<Story>,
    fallbackError: string,
    opts?: { blockBusy?: boolean; trackSummarizing?: boolean },
  ): Promise<Story | null> => {
    if (opts?.blockBusy !== false && (abortRef.current || isStreaming || isSummarizing)) {
      return null;
    }
    const opSeq = ++storyOpSeqRef.current;
    setErrorMsg(null);
    if (opts?.trackSummarizing) {
      setIsSummarizing(true);
    }
    try {
      const updated = await transition();
      if (storyOpSeqRef.current !== opSeq) return null;
      setStory(updated);
      await refreshStories();
      return updated;
    } catch (err) {
      if (storyOpSeqRef.current === opSeq) {
        setErrorMsg(toErrorMessage(err, fallbackError));
      }
      return null;
    } finally {
      if (opts?.trackSummarizing && storyOpSeqRef.current === opSeq) {
        setIsSummarizing(false);
      }
    }
  };

  const sendAction = async (userPrompt: string, restoreOnError = false) => {
    const trimmed = userPrompt.trim();
    if (!trimmed || abortRef.current || isStreaming || isSummarizing) return;
    if (restoreOnError) {
      setInput('');
    }
    await runStreamingExecution(
      (callbacks) => harness.runTurn(story, trimmed, config, callbacks),
      restoreOnError ? () => setInput(trimmed) : undefined,
    );
  };

  const handleEditAndBranch = async (targetUserNodeId: string, newContent: string) => {
    const trimmed = newContent.trim();
    if (!trimmed || isSummarizing) return;
    await runStreamingExecution((callbacks) =>
      harness.editAndBranch(story, targetUserNodeId, trimmed, config, callbacks),
    );
  };

  const handleRegenerateNode = async (targetAssistantNodeId: string) => {
    if (isSummarizing) return;
    await runStreamingExecution((callbacks) =>
      harness.regenerateNode(story, targetAssistantNodeId, config, callbacks),
    );
  };

  const handleSwitchBranch = async (targetNodeId: string) => {
    const switched = await runStoryTransition(
      () => harness.switchBranch(story, targetNodeId),
      '切换分支失败。',
    );
    if (
      switched &&
      computeActiveReviewState(switched).needsSummaryCompression &&
      hasModelCredentials(config, useDevEnvKey)
    ) {
      const summarySeq = storyOpSeqRef.current;
      setIsSummarizing(true);
      try {
        const summarized = await harness.ensureActiveBranchSummary(switched, config);
        if (storyOpSeqRef.current === summarySeq) {
          setStory(summarized);
          await refreshStories();
        }
      } catch (err) {
        if (storyOpSeqRef.current === summarySeq) {
          setErrorMsg(toErrorMessage(err, '补算支线剧情摘要失败，可稍后重试。'));
        }
      } finally {
        if (storyOpSeqRef.current === summarySeq) {
          setIsSummarizing(false);
        }
      }
    }
  };

  const handleRenameBranch = async (branchEntryNodeId: string, name: string) => {
    await runStoryTransition(
      () => harness.renameBranch(story, branchEntryNodeId, name),
      '重命名分支失败。',
      { blockBusy: false },
    );
  };

  const handleExtractBranchGist = async (branchEntryNodeId: string) => {
    if (!hasModelCredentials(config, useDevEnvKey)) {
      setErrorMsg('请先在左侧配置模型 API Key，再使用「AI 提炼梗概」。');
      return;
    }
    await runStoryTransition(
      () => harness.extractBranchGist(story, branchEntryNodeId, config),
      '提炼分支梗概失败。',
      { trackSummarizing: true },
    );
  };

  const handleComputeActiveSummary = async () => {
    if (!hasModelCredentials(config, useDevEnvKey)) {
      setErrorMsg('请先在左侧配置模型 API Key，再补算超窗支线的剧情摘要。');
      return;
    }
    await runStoryTransition(
      () => harness.ensureActiveBranchSummary(story, config),
      '补算剧情摘要失败。',
      { trackSummarizing: true },
    );
  };

  const handleRewindToNode = (targetNodeId: string) =>
    runStoryTransition(() => harness.rewindToNode(story, targetNodeId), '回溯节点失败。');

  const handleSubmit = (e?: React.FormEvent) => {
    e?.preventDefault();
    void sendAction(input, true);
  };

  const handleConfirmImportedStory = async (imported: {
    title: string;
    rawScript: string;
    blueprint: StoryBlueprint;
  }) => {
    abortActiveStream(true);
    const opSeq = ++storyOpSeqRef.current;
    setErrorMsg(null);
    try {
      const created = await harness.createAndSaveStory(imported);
      if (storyOpSeqRef.current !== opSeq) return;
      setStory(created);
      await refreshStories();
      setShowImport(false);
    } catch (err) {
      if (storyOpSeqRef.current === opSeq) {
        setErrorMsg(toErrorMessage(err, '保存导入故事失败。'));
      }
    }
  };

  const handleSelectStory = async (id: string) => {
    abortActiveStream(true);
    const opSeq = ++storyOpSeqRef.current;
    setErrorMsg(null);
    try {
      const switched = await harness.setActiveStory(id);
      if (storyOpSeqRef.current !== opSeq) return;
      if (switched) {
        setStory(switched);
        setShowImport(false);
      }
    } catch (err) {
      if (storyOpSeqRef.current === opSeq) {
        setErrorMsg(toErrorMessage(err, '切换故事失败。'));
      }
    }
  };

  const handleRenameStory = async (id: string, title: string) => {
    setErrorMsg(null);
    try {
      const updated = await harness.renameStory(id, title);
      if (updated) {
        setStory((prev) => (prev.id === id ? updated : prev));
        await refreshStories();
      }
    } catch (err) {
      setErrorMsg(toErrorMessage(err, '重命名故事失败。'));
    }
  };

  const handleDeleteStory = async (id: string) => {
    abortActiveStream(true);
    const opSeq = ++storyOpSeqRef.current;
    const deletedActiveStory = story.id === id;
    setErrorMsg(null);
    try {
      await harness.deleteStory(id);
      if (storyOpSeqRef.current !== opSeq) return;
      const remaining = await refreshStories();
      if (storyOpSeqRef.current !== opSeq) return;
      if (deletedActiveStory) {
        const next = remaining[0] ?? harness.createStory({ title: '新故事' });
        setStory(next);
        if (remaining[0]) {
          await harness.setActiveStory(remaining[0].id);
        }
      }
    } catch (err) {
      if (storyOpSeqRef.current === opSeq) {
        setErrorMsg(toErrorMessage(err, '删除故事失败。'));
      }
    }
  };

  const handleSaveBlueprintTweak = async (updatedBlueprint: StoryBlueprint): Promise<boolean> => {
    setErrorMsg(null);
    const opSeq = storyOpSeqRef.current;
    try {
      const updated = await harness.updateStoryBlueprint(story, updatedBlueprint);
      if (storyOpSeqRef.current !== opSeq) return false;
      setStory(updated);
      await refreshStories();
      return true;
    } catch (err) {
      if (storyOpSeqRef.current === opSeq) {
        setErrorMsg(toErrorMessage(err, '保存蓝图微调失败。'));
      }
      return false;
    }
  };

  const handleExportBackup = async () => {
    setErrorMsg(null);
    try {
      const json = exportStoryBackup(story);
      const fileName = `${story.title.replace(/[\\/:*?"<>|]+/g, '_') || 'story'}.lfh.json`;
      await runtime.backupExporter.exportJsonFile(fileName, json);
    } catch (err) {
      setErrorMsg(toErrorMessage(err, '导出 JSON 备份失败。'));
    }
  };

  const handleImportBackupFile = async (file: File) => {
    abortActiveStream(true);
    const opSeq = ++storyOpSeqRef.current;
    setErrorMsg(null);
    try {
      const jsonText = await file.text();
      if (storyOpSeqRef.current !== opSeq) return;
      const existing = await harness.listStories();
      if (storyOpSeqRef.current !== opSeq) return;
      const restored = importStoryBackup(
        jsonText,
        existing.map((s) => s.id),
      );
      await harness.saveStory(restored);
      await harness.setActiveStory(restored.id);
      if (storyOpSeqRef.current !== opSeq) return;
      setStory(restored);
      await refreshStories();
      setShowImport(false);
    } catch (err) {
      if (storyOpSeqRef.current === opSeq) {
        setErrorMsg(toErrorMessage(err, '导入 JSON 备份失败。'));
      }
    }
  };

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div>
          <h1 className="app-title">本地优先 AI 文游</h1>
          <p className="app-subtitle">纯客户端 Harness · BYOK 本地原型</p>
        </div>

        <button
          type="button"
          className="btn btn-primary"
          onClick={() => {
            abortActiveStream(true);
            setShowImport((prev) => !prev);
          }}
        >
          {showImport ? '返回游玩界面' : '导入剧本 / 新建故事'}
        </button>

        <StoryLibrary
          stories={stories}
          activeStoryId={story.id}
          onSelectStory={(id) => void handleSelectStory(id)}
          onRenameStory={(id, title) => void handleRenameStory(id, title)}
          onDeleteStory={(id) => void handleDeleteStory(id)}
          onExportBackup={() => void handleExportBackup()}
          onImportBackupFile={(file) => void handleImportBackupFile(file)}
        />

        <div className="notice-box" role="note">
          <strong>安全提示：</strong>
          {runtime.platform === 'android'
            ? 'API Key 将保存在 Android 原生加密存储，故事与节点存档保存在应用私有目录；如需临时使用可勾选「仅当前会话内存保存」，切换时立即清除已存密钥。'
            : (
                <>
                  浏览器 <code>localStorage</code> 与 IndexedDB 并非系统级安全密钥存储；公共或共享设备请勾选「仅当前会话内存保存」，并在用完后关闭页面或清除密钥。
                </>
              )}
        </div>

        <form className="config-form" onSubmit={(e) => e.preventDefault()} aria-label="模型配置">
          <div className="field">
            <label htmlFor="cfg-base-url">模型接口 Base URL</label>
            <input
              id="cfg-base-url"
              name="baseUrl"
              type="text"
              value={config.baseUrl}
              autoCorrect="off"
              autoCapitalize="none"
              spellCheck={false}
              onChange={(e) => updateConfig({ ...config, baseUrl: e.target.value }, false)}
            />
          </div>

          <div className="field">
            <label htmlFor="cfg-model">模型名称</label>
            <input
              id="cfg-model"
              name="model"
              type="text"
              value={config.model}
              autoCorrect="off"
              autoCapitalize="none"
              spellCheck={false}
              onChange={(e) => updateConfig({ ...config, model: e.target.value })}
            />
          </div>

          <div className="field">
            <label htmlFor="cfg-api-key">API Key（BYOK）</label>
            <div className="key-input-row">
              <input
                id="cfg-api-key"
                name="apiKey"
                type={showKey ? 'text' : 'password'}
                value={config.apiKey}
                disabled={useDevEnvKey}
                placeholder={
                  useDevEnvKey ? '当前使用开发代理内置测试 Key' : 'sk-...（本地无鉴权端点可留空）'
                }
                autoComplete="off"
                onChange={(e) => updateConfig({ ...config, apiKey: e.target.value }, false)}
              />
              <button
                type="button"
                className="btn"
                aria-pressed={showKey}
                onClick={() => setShowKey((prev) => !prev)}
              >
                {showKey ? '隐藏' : '显示'}
              </button>
            </div>
          </div>

          {runtime.supportsMemoryOnlySession && (
            <div className="checkbox-row">
              <input
                id="cfg-memory-only"
                name="memoryOnly"
                type="checkbox"
                checked={config.memoryOnly}
                onChange={(e) => updateConfig({ ...config, memoryOnly: e.target.checked })}
              />
              <label htmlFor="cfg-memory-only">仅当前会话内存保存 API Key（刷新即清除）</label>
            </div>
          )}

          {devTestInfo?.available && (
            <button type="button" className="btn" onClick={applyDevTestConfig}>
              使用本地 .env.local 测试代理
            </button>
          )}
        </form>
      </aside>

      <main className="main-stage">
        <header className="stage-header">
          <h2>{story.title}</h2>
          <span className="status-text">
            {config.memoryOnly ? '密钥：仅内存' : '密钥：本地持久化'}
          </span>
        </header>

        {errorMsg && (
          <div className="error-banner" role="alert">
            {errorMsg}
          </div>
        )}

        {showImport ? (
          <ImportPanel
            config={config}
            extractBlueprint={(raw, cfg, title, signal) =>
              harness.extractStoryBlueprint(raw, cfg, title, signal)
            }
            onConfirmStory={handleConfirmImportedStory}
            onCancel={() => setShowImport(false)}
          />
        ) : (
          <>
            <StoryReview
              story={story}
              metrics={contextPreview.metrics}
              isBusy={isStreaming}
              isSummarizing={isSummarizing}
              onComputeSummary={() => void handleComputeActiveSummary()}
            />

            <StoryTree
              story={story}
              isBusy={isStreaming || isSummarizing}
              onSwitchBranch={(id) => void handleSwitchBranch(id)}
              onRenameBranch={handleRenameBranch}
              onExtractBranchGist={handleExtractBranchGist}
            />

            <ContextOverview
              story={story}
              summarySnapshot={activeSummary}
              metrics={contextPreview.metrics}
              isStreaming={isStreaming}
              onSaveBlueprintTweak={handleSaveBlueprintTweak}
            />

            <section className="timeline" aria-label="故事对话记录">
              {activeNodes.length === 0 && !isStreaming && (
                <div className="turn-card">
                  <div className="turn-role">开场引导</div>
                  <div className="turn-body">
                    {story.blueprint.openingHook
                      ? story.blueprint.openingHook
                      : '配置好模型接口或点击左侧「导入剧本 / 新建故事」，即可开始流式演绎。'}
                  </div>
                  {story.blueprint.openingHook && (
                    <div className="composer-actions" style={{ marginTop: '0.75rem' }}>
                      <span className="status-text">已保留原始剧本全文锚定</span>
                      <button
                        type="button"
                        className="btn btn-primary"
                        onClick={() =>
                          void sendAction(
                            '开始故事，请按照剧本开场规则生成第一幕与初始状态栏。',
                          )
                        }
                      >
                        开启第一幕
                      </button>
                    </div>
                  )}
                </div>
              )}

              {activeNodes.map((node) => (
                <TurnCard
                  key={node.id}
                  node={node}
                  isActiveLeaf={node.id === story.activeLeafNodeId}
                  isStreaming={isStreaming || isSummarizing}
                  siblings={getSiblingBranchInfo(story, node.id)}
                  onSelectChoice={(choiceText) => void sendAction(choiceText)}
                  onSwitchBranch={(targetId) => void handleSwitchBranch(targetId)}
                  onEditAndBranch={(nodeId, text) => void handleEditAndBranch(nodeId, text)}
                  onRegenerate={(nodeId) => void handleRegenerateNode(nodeId)}
                  onRewindToNode={(nodeId) => void handleRewindToNode(nodeId)}
                />
              ))}

              {isStreaming && (
                <article className="turn-card assistant" aria-live="polite">
                  <div className="turn-role">叙事 AI（生成中…）</div>
                  {streamReasoning && (
                    <details className="reasoning-details" open>
                      <summary>思考过程（实时流式）</summary>
                      <div className="reasoning-content">{streamReasoning}</div>
                    </details>
                  )}
                  {streamContent ? (
                    <MessageContent content={streamContent} />
                  ) : (
                    <div className="turn-body">正在等待响应…</div>
                  )}
                </article>
              )}
            </section>

            <form className="composer" onSubmit={handleSubmit}>
              <label htmlFor="turn-input">输入你的行动或对话</label>
              <textarea
                id="turn-input"
                name="playerInput"
                rows={3}
                value={input}
                placeholder="输入你的抉择、对话或行动（Ctrl/Cmd + Enter 发送）…"
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    void handleSubmit();
                  }
                }}
              />
              <div className="composer-actions">
                <span className="status-text">已保存轮次：{Math.floor(activeNodes.length / 2)}</span>
                <div>
                  {isStreaming ? (
                    <button
                      key="stop-generation-btn"
                      type="button"
                      className="btn"
                      onClick={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        abortRef.current?.abort();
                      }}
                    >
                      停止生成
                    </button>
                  ) : (
                    <button
                      key="send-action-btn"
                      type="submit"
                      className="btn btn-primary"
                      disabled={!input.trim() || isSummarizing}
                    >
                      发送行动
                    </button>
                  )}
                </div>
              </div>
            </form>
          </>
        )}
      </main>
    </div>
  );
}
