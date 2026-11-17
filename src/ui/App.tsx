import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  DEFAULT_MODEL_CONFIG,
  createFictionHarness,
  createModelConfigStore,
  createOpenAiTransport,
  exportStoryBackup,
  getActiveBranchNodes,
  getActiveSummarySnapshot,
  getSiblingBranchInfo,
  importStoryBackup,
  type FetchLike,
  type ModelConfig,
  type Story,
  type StoryBlueprint,
  type TurnCallbacks,
  type TurnExecutionResult,
} from '../harness/index.ts';
import { ContextOverview } from './ContextOverview.tsx';
import { ImportPanel } from './ImportPanel.tsx';
import { MessageContent } from './MessageContent.tsx';
import { StoryLibrary } from './StoryLibrary.tsx';
import { TurnCard } from './TurnCard.tsx';
import { createIndexedDbStoryStorage } from './indexedDbStorage.ts';

interface DevTestConfigResponse {
  available: boolean;
  proxyBaseUrl: string;
  model: string;
  hasEnvKey: boolean;
}

export function App() {
  const configStore = useMemo(() => createModelConfigStore(window.localStorage), []);
  const storyStorage = useMemo(() => createIndexedDbStoryStorage(), []);
  const useDevEnvKeyRef = useRef(false);

  const harness = useMemo(() => {
    const devAwareFetch: FetchLike = (url, init) => {
      const headers = { ...init.headers };
      if (import.meta.env.DEV && useDevEnvKeyRef.current && url.startsWith('/__dev_llm_proxy')) {
        headers['x-use-dev-env-key'] = '1';
      }
      return fetch(url, {
        method: init.method,
        headers,
        body: init.body,
        signal: init.signal as AbortSignal | undefined,
      });
    };
    return createFictionHarness({
      transport: createOpenAiTransport(devAwareFetch),
      storage: storyStorage,
    });
  }, [storyStorage]);

  const [config, setConfig] = useState<ModelConfig>(() => {
    const loaded = configStore.load();
    if (!import.meta.env.DEV && loaded.baseUrl.startsWith('/__dev_llm_proxy')) {
      return { ...loaded, baseUrl: DEFAULT_MODEL_CONFIG.baseUrl };
    }
    return loaded;
  });
  const [useDevEnvKey, setUseDevEnvKey] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [devTestInfo, setDevTestInfo] = useState<DevTestConfigResponse | null>(null);
  const [stories, setStories] = useState<Story[]>([]);
  const [story, setStory] = useState<Story>(() => harness.createStory({ title: '新故事' }));
  const [showImport, setShowImport] = useState(false);
  const [input, setInput] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamReasoning, setStreamReasoning] = useState('');
  const [streamContent, setStreamContent] = useState('');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);

  const refreshStories = useCallback(async () => {
    const list = await harness.listStories();
    setStories(list);
    return list;
  }, [harness]);

  useEffect(() => {
    useDevEnvKeyRef.current = useDevEnvKey;
  }, [useDevEnvKey]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [list, active] = await Promise.all([
          harness.listStories(),
          harness.loadActiveStory(),
        ]);
        if (cancelled) return;
        setStories(list);
        if (active) {
          setStory(active);
        }
      } catch (err) {
        if (!cancelled) {
          setErrorMsg(err instanceof Error ? err.message : '读取本地故事失败。');
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [harness]);

  useEffect(() => {
    if (!import.meta.env.DEV) {
      return;
    }
    let cancelled = false;
    fetch('/__dev_test_config')
      .then((res) => (res.ok ? (res.json() as Promise<DevTestConfigResponse>) : null))
      .then((data) => {
        if (!cancelled && data?.available) {
          setDevTestInfo(data);
        }
      })
      .catch(() => {
        // Ignore outside dev server
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const updateConfig = (next: ModelConfig, nextUseDevEnvKey = useDevEnvKey) => {
    setConfig(next);
    setUseDevEnvKey(nextUseDevEnvKey);
    useDevEnvKeyRef.current = nextUseDevEnvKey;
    configStore.save(next);
  };

  const applyDevTestConfig = () => {
    if (!devTestInfo) return;
    setConfig({
      baseUrl: devTestInfo.proxyBaseUrl,
      model: devTestInfo.model || config.model,
      apiKey: '',
      memoryOnly: config.memoryOnly,
    });
    setUseDevEnvKey(devTestInfo.hasEnvKey);
    useDevEnvKeyRef.current = devTestInfo.hasEnvKey;
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
    if (isStreaming) return;
    setErrorMsg(null);
    setIsStreaming(true);
    setStreamReasoning('');
    setStreamContent('');

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const result = await execute({
        signal: controller.signal,
        onReasoningDelta: (delta) => setStreamReasoning((prev) => prev + delta),
        onContentDelta: (delta) => setStreamContent((prev) => prev + delta),
      });
      setStory(result.story);
      await refreshStories();
      setStreamReasoning('');
      setStreamContent('');
    } catch (err) {
      if ((err as { name?: string }).name === 'AbortError') {
        setErrorMsg('已中止本次生成。');
      } else {
        setErrorMsg(err instanceof Error ? err.message : '生成失败，请检查模型端点与配置。');
      }
      onErrorRestore?.();
    } finally {
      abortRef.current = null;
      setIsStreaming(false);
    }
  };

  const applyStoryTransition = async (transition: () => Promise<Story>) => {
    if (isStreaming) return;
    try {
      const updated = await transition();
      setStory(updated);
      await refreshStories();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : '切换分支失败。');
    }
  };

  const sendAction = async (userPrompt: string, restoreOnError = false) => {
    const trimmed = userPrompt.trim();
    if (!trimmed) return;
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
    if (!trimmed) return;
    await runStreamingExecution((callbacks) =>
      harness.editAndBranch(story, targetUserNodeId, trimmed, config, callbacks),
    );
  };

  const handleRegenerateNode = async (targetAssistantNodeId: string) => {
    await runStreamingExecution((callbacks) =>
      harness.regenerateNode(story, targetAssistantNodeId, config, callbacks),
    );
  };

  const handleSwitchBranch = (targetNodeId: string) =>
    applyStoryTransition(() => harness.switchBranch(story, targetNodeId));

  const handleRewindToNode = (targetNodeId: string) =>
    applyStoryTransition(() => harness.rewindToNode(story, targetNodeId));

  const handleSubmit = (e?: React.FormEvent) => {
    e?.preventDefault();
    void sendAction(input, true);
  };

  const handleConfirmImportedStory = async (imported: {
    title: string;
    rawScript: string;
    blueprint: StoryBlueprint;
  }) => {
    const created = await harness.createAndSaveStory(imported);
    setStory(created);
    await refreshStories();
    setShowImport(false);
    setErrorMsg(null);
  };

  const handleSelectStory = async (id: string) => {
    const switched = await harness.setActiveStory(id);
    if (switched) {
      setStory(switched);
      setShowImport(false);
      setErrorMsg(null);
    }
  };

  const handleRenameStory = async (id: string, title: string) => {
    const updated = await harness.renameStory(id, title);
    if (updated) {
      if (story.id === id) {
        setStory(updated);
      }
      await refreshStories();
    }
  };

  const handleDeleteStory = async (id: string) => {
    await harness.deleteStory(id);
    const remaining = await refreshStories();
    if (story.id === id) {
      const next = remaining[0] ?? harness.createStory({ title: '新故事' });
      setStory(next);
      if (remaining[0]) {
        await harness.setActiveStory(remaining[0].id);
      }
    }
  };

  const handleSaveBlueprintTweak = async (updatedBlueprint: StoryBlueprint) => {
    const updated = await harness.updateStoryBlueprint(story, updatedBlueprint);
    setStory(updated);
    await refreshStories();
  };

  const handleExportBackup = () => {
    const json = exportStoryBackup(story);
    const blob = new Blob([json], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${story.title.replace(/[\\/:*?"<>|]+/g, '_') || 'story'}.lfh.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleImportBackupFile = async (file: File) => {
    setErrorMsg(null);
    try {
      const jsonText = await file.text();
      const existing = await harness.listStories();
      const restored = importStoryBackup(
        jsonText,
        existing.map((s) => s.id),
      );
      await harness.saveStory(restored);
      await harness.setActiveStory(restored.id);
      setStory(restored);
      await refreshStories();
      setShowImport(false);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : '导入 JSON 备份失败。');
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
          onClick={() => setShowImport((prev) => !prev)}
        >
          {showImport ? '返回游玩界面' : '导入剧本 / 新建故事'}
        </button>

        <StoryLibrary
          stories={stories}
          activeStoryId={story.id}
          onSelectStory={(id) => void handleSelectStory(id)}
          onRenameStory={(id, title) => void handleRenameStory(id, title)}
          onDeleteStory={(id) => void handleDeleteStory(id)}
          onExportBackup={handleExportBackup}
          onImportBackupFile={(file) => void handleImportBackupFile(file)}
        />

        <div className="notice-box" role="note">
          <strong>安全提示：</strong>
          浏览器 <code>localStorage</code> 与 IndexedDB 并非系统级安全密钥存储；公共或共享设备请勾选「仅当前会话内存保存」，并在用完后关闭页面或清除密钥。
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
            onConfirmStory={(imported) => void handleConfirmImportedStory(imported)}
            onCancel={() => setShowImport(false)}
          />
        ) : (
          <>
            <ContextOverview
              story={story}
              summarySnapshot={activeSummary}
              metrics={contextPreview.metrics}
              isStreaming={isStreaming}
              onSaveBlueprintTweak={handleSaveBlueprintTweak}
              onSwitchBranch={(id) => void handleSwitchBranch(id)}
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
                  isStreaming={isStreaming}
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
                      type="button"
                      className="btn"
                      onClick={() => abortRef.current?.abort()}
                    >
                      停止生成
                    </button>
                  ) : (
                    <button type="submit" className="btn btn-primary" disabled={!input.trim()}>
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
