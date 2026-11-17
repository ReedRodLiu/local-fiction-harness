import { useEffect, useMemo, useRef, useState } from 'react';
import {
  DEFAULT_MODEL_CONFIG,
  createFictionHarness,
  createModelConfigStore,
  createOpenAiTransport,
  getActiveBranchNodes,
  type FetchLike,
  type ModelConfig,
  type Story,
  type StoryBlueprint,
} from '../harness/index.ts';
import { ImportPanel } from './ImportPanel.tsx';

interface DevTestConfigResponse {
  available: boolean;
  proxyBaseUrl: string;
  model: string;
  hasEnvKey: boolean;
}

export function App() {
  const configStore = useMemo(() => createModelConfigStore(window.localStorage), []);
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
    return createFictionHarness({ transport: createOpenAiTransport(devAwareFetch) });
  }, []);

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
  const [story, setStory] = useState<Story>(() =>
    harness.createStory({ title: '新故事（最小测试）' }),
  );
  const [showImport, setShowImport] = useState(false);
  const [input, setInput] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamReasoning, setStreamReasoning] = useState('');
  const [streamContent, setStreamContent] = useState('');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    useDevEnvKeyRef.current = useDevEnvKey;
  }, [useDevEnvKey]);

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

  const sendAction = async (userPrompt: string, restoreOnError = false) => {
    const trimmed = userPrompt.trim();
    if (!trimmed || isStreaming) {
      return;
    }

    setErrorMsg(null);
    setIsStreaming(true);
    setStreamReasoning('');
    setStreamContent('');
    if (restoreOnError) {
      setInput('');
    }

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const result = await harness.runTurn(story, trimmed, config, {
        signal: controller.signal,
        onReasoningDelta: (delta) => setStreamReasoning((prev) => prev + delta),
        onContentDelta: (delta) => setStreamContent((prev) => prev + delta),
      });
      setStory(result.story);
      setStreamReasoning('');
      setStreamContent('');
    } catch (err) {
      if ((err as { name?: string }).name === 'AbortError') {
        setErrorMsg('已中止本次生成。');
      } else {
        setErrorMsg(err instanceof Error ? err.message : '生成失败，请检查模型端点与配置。');
      }
      if (restoreOnError) {
        setInput(trimmed);
      }
    } finally {
      abortRef.current = null;
      setIsStreaming(false);
    }
  };

  const handleSubmit = (e?: React.FormEvent) => {
    e?.preventDefault();
    void sendAction(input, true);
  };

  const handleConfirmImportedStory = (imported: {
    title: string;
    rawScript: string;
    blueprint: StoryBlueprint;
  }) => {
    const created = harness.createStory(imported);
    setStory(created);
    setShowImport(false);
    setErrorMsg(null);
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
            onConfirmStory={handleConfirmImportedStory}
            onCancel={() => setShowImport(false)}
          />
        ) : (
          <>
            {(story.rawScript || story.blueprint.worldRules.length > 0) && (
              <details className="reasoning-details">
                <summary>
                  故事蓝图与原始剧本锚定（原文 {story.rawScript.length} 字符）
                </summary>
                <div className="blueprint-summary">
                  {story.blueprint.protagonist && (
                    <p>
                      <strong>主角：</strong>
                      {story.blueprint.protagonist}
                    </p>
                  )}
                  {story.blueprint.worldRules.length > 0 && (
                    <p>
                      <strong>规则：</strong>
                      {story.blueprint.worldRules.join('；')}
                    </p>
                  )}
                  {story.blueprint.taboos.length > 0 && (
                    <p>
                      <strong>禁忌：</strong>
                      {story.blueprint.taboos.join('；')}
                    </p>
                  )}
                  {story.blueprint.npcs.length > 0 && (
                    <p>
                      <strong>角色：</strong>
                      {story.blueprint.npcs
                        .map((n) => `${n.name}${n.role ? `(${n.role})` : ''}`)
                        .join('、')}
                    </p>
                  )}
                </div>
              </details>
            )}

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
                        onClick={() => void sendAction('开始故事，请按照剧本开场规则生成第一幕与初始状态栏。')}
                      >
                        开启第一幕
                      </button>
                    </div>
                  )}
                </div>
              )}

              {activeNodes.map((node) => (
                <article key={node.id} className={`turn-card ${node.role}`}>
                  <div className="turn-role">{node.role === 'user' ? '玩家' : '叙事 AI'}</div>
                  {node.reasoningContent && (
                    <details className="reasoning-details">
                      <summary>思考过程（不回传后续上下文）</summary>
                      <div className="reasoning-content">{node.reasoningContent}</div>
                    </details>
                  )}
                  <div className="turn-body">{node.content}</div>
                </article>
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
                  <div className="turn-body">{streamContent || '正在等待响应…'}</div>
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
