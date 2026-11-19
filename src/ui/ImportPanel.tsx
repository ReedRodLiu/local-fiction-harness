import { useEffect, useMemo, useRef, useState } from 'react';
import {
  DEFAULT_STORY_TITLE,
  createDefaultBlueprint,
  isAbortError,
  parseScriptInput,
  type BinaryDownloader,
  type DeepSeekImportBatchResult,
  type DiagnosticCollector,
  type LlmTransport,
  type ModelConfig,
  type ScriptTurnRange,
  type Story,
  type StoryBlueprint,
} from '../harness/index.ts';
import { StoryBlueprintCard } from './StoryBlueprintCard.tsx';
import { BannerAlert } from './primitives/BannerAlert.tsx';
import { OverlayPageShell } from './primitives/OverlayPageShell.tsx';
import { DeepSeekImportPanel } from './DeepSeekImportPanel.tsx';
import { splitNonEmptyLines, toErrorMessage } from './textHelpers.ts';

export type ImportMode = 'deepseek' | 'script';

interface ImportPanelProps {
  initialMode?: ImportMode;
  resetKey?: number;
  config: ModelConfig;
  transport: LlmTransport;
  binaryDownloader: BinaryDownloader;
  hasCredentials: boolean;
  onRequireByok: (actionLabel: string, resume: (resolvedConfig: ModelConfig) => void) => void;
  extractBlueprint: (
    rawScript: string,
    config: ModelConfig,
    fallbackTitle: string,
    signal: AbortSignal,
  ) => Promise<StoryBlueprint>;
  onConfirmStory: (input: {
    title: string;
    rawScript: string;
    blueprint: StoryBlueprint;
  }) => Promise<void> | void;
  onImportDeepSeekBatch: (
    zipBytes: Uint8Array,
    selectedSessionIds: readonly string[],
    scriptRangeOverrides: Record<string, ScriptTurnRange>,
  ) => Promise<DeepSeekImportBatchResult>;
  onContinueStory: (storyId: string) => void;
  diagnostics: DiagnosticCollector;
  onPackageDiagnostics: () => void;
  onCancel?: () => void;
}

interface BlueprintDraft {
  blueprint: StoryBlueprint;
}

function makeBlueprintPreview(rawScript: string, blueprint: StoryBlueprint): Story {
  return {
    id: 'import-blueprint-preview',
    title: blueprint.title,
    sourceKind: 'manual_script',
    rawScript,
    blueprint,
    nodes: {},
    rootNodeIds: [],
    activeLeafNodeId: null,
    createdAt: 0,
    updatedAt: 0,
  };
}

export function ImportPanel({
  initialMode = 'deepseek',
  resetKey = 0,
  config,
  transport,
  binaryDownloader,
  hasCredentials,
  onRequireByok,
  extractBlueprint,
  onConfirmStory,
  onImportDeepSeekBatch,
  onContinueStory,
  diagnostics,
  onPackageDiagnostics,
  onCancel,
}: ImportPanelProps) {
  const importMode = initialMode;
  const [step, setStep] = useState<1 | 2>(1);
  const [rawText, setRawText] = useState('');
  const [suggestedTitle, setSuggestedTitle] = useState('');
  const [sourceInfo, setSourceInfo] = useState('');
  const [isDragging, setIsDragging] = useState(false);
  const [draft, setDraft] = useState<BlueprintDraft | null>(null);
  const [editingBlueprint, setEditingBlueprint] = useState(false);
  const [editBaseline, setEditBaseline] = useState<StoryBlueprint | null>(null);
  const [isExtracting, setIsExtracting] = useState(false);
  const [isConfirming, setIsConfirming] = useState(false);
  const [parseError, setParseError] = useState<string | null>(null);
  const scriptInputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const extractSeqRef = useRef(0);
  const fileSeqRef = useRef(0);

  const abortInFlightExtraction = () => {
    extractSeqRef.current += 1;
    const controller = abortRef.current;
    abortRef.current = null;
    controller?.abort();
  };

  useEffect(() => {
    return () => {
      abortInFlightExtraction();
    };
  }, []);

  const handleFile = async (file: File) => {
    abortInFlightExtraction();
    setIsExtracting(false);
    setParseError(null);
    const fileSeq = ++fileSeqRef.current;
    if (file.name.toLowerCase().endsWith('.doc')) {
      setDraft(null);
      setParseError('旧版 .doc 暂不支持直接读取。请在 Word 或 WPS 中另存为 .docx 后再导入。');
      return;
    }
    try {
      const buffer = await file.arrayBuffer();
      if (fileSeqRef.current !== fileSeq) return;
      const parsed = parseScriptInput({
        kind: 'file',
        fileName: file.name,
        bytes: new Uint8Array(buffer),
      });
      setRawText(parsed.rawScript);
      setSuggestedTitle(parsed.suggestedTitle);
      setSourceInfo(`已读取 ${file.name}（${parsed.sourceType.toUpperCase()}，${parsed.rawScript.length} 字）`);
      setDraft(null);
      setStep(1);
    } catch (err) {
      if (fileSeqRef.current === fileSeq) {
        setParseError(toErrorMessage(err, '文件解析失败。'));
      }
    }
  };

  const preparePasteScript = () => {
    const parsed = parseScriptInput({
      kind: 'paste',
      text: rawText,
      title: suggestedTitle || undefined,
    });
    const fallbackTitle = suggestedTitle.trim() || parsed.suggestedTitle;
    setSuggestedTitle(fallbackTitle);
    return { rawScript: parsed.rawScript, fallbackTitle };
  };

  const runExtractWithConfig = async (activeCfg: ModelConfig) => {
    if (isExtracting) return;
    setParseError(null);
    let controller: AbortController | null = null;
    const seq = ++extractSeqRef.current;
    try {
      const { rawScript, fallbackTitle } = preparePasteScript();
      setIsExtracting(true);
      controller = new AbortController();
      abortRef.current = controller;

      const extracted = await extractBlueprint(
        rawScript,
        activeCfg,
        fallbackTitle,
        controller.signal,
      );
      if (extractSeqRef.current !== seq || controller.signal.aborted) return;
      setDraft({ blueprint: extracted });
      setEditBaseline(null);
      setEditingBlueprint(false);
      setStep(2);
    } catch (err) {
      if (extractSeqRef.current !== seq) return;
      if (isAbortError(err)) {
        setParseError('已中止蓝图拆解。');
      } else {
        setParseError(toErrorMessage(err, '拆解蓝图失败。'));
      }
    } finally {
      if (controller && abortRef.current === controller) {
        abortRef.current = null;
        setIsExtracting(false);
      }
    }
  };

  const handleExtract = () => {
    if (isExtracting) return;
    setParseError(null);
    try {
      preparePasteScript();
    } catch (err) {
      setParseError(toErrorMessage(err, '剧本文本不能为空。'));
      return;
    }
    if (!hasCredentials) {
      onRequireByok('拆解故事蓝图', (resolved) => {
        void runExtractWithConfig(resolved);
      });
      return;
    }
    void runExtractWithConfig(config);
  };

  const handleStartWithoutExtraction = async () => {
    if (isConfirming) return;
    setParseError(null);
    try {
      const { rawScript, fallbackTitle } = preparePasteScript();
      setIsConfirming(true);
      const title = fallbackTitle || DEFAULT_STORY_TITLE;
      await onConfirmStory({
        title,
        rawScript,
        blueprint: createDefaultBlueprint(title),
      });
    } catch (err) {
      setParseError(toErrorMessage(err, '无法直接开始故事。'));
    } finally {
      setIsConfirming(false);
    }
  };

  const handleConfirm = async () => {
    if (!draft || isConfirming) return;
    setParseError(null);
    setIsConfirming(true);
    try {
      const finalizedBlueprint: StoryBlueprint = {
        ...draft.blueprint,
        title: draft.blueprint.title.trim() || suggestedTitle.trim() || DEFAULT_STORY_TITLE,
      };
      await onConfirmStory({
        title: finalizedBlueprint.title,
        rawScript: rawText.trim(),
        blueprint: finalizedBlueprint,
      });
    } catch (err) {
      setParseError(toErrorMessage(err, '保存导入故事失败。'));
    } finally {
      setIsConfirming(false);
    }
  };

  const previewStory = useMemo(
    () => (draft ? makeBlueprintPreview(rawText.trim(), draft.blueprint) : null),
    [draft, rawText],
  );

  const updateBlueprint = (change: Partial<StoryBlueprint>) => {
    setDraft((current) => current
      ? { blueprint: { ...current.blueprint, ...change } }
      : current);
  };

  const handleBack = () => {
    if (isConfirming) return;
    if (step === 2) {
      setStep(1);
      setEditingBlueprint(false);
      return;
    }
    abortInFlightExtraction();
    setIsExtracting(false);
    onCancel?.();
  };

  if (importMode === 'deepseek') {
    return (
      <DeepSeekImportPanel
        key={resetKey}
        config={config}
        transport={transport}
        binaryDownloader={binaryDownloader}
        hasCredentials={hasCredentials}
        onRequireByok={onRequireByok}
        onImportBatch={onImportDeepSeekBatch}
        onContinueStory={onContinueStory}
        diagnostics={diagnostics}
        onPackageDiagnostics={onPackageDiagnostics}
        onCancel={onCancel}
      />
    );
  }

  return (
    <OverlayPageShell
      title="导入自由剧本"
      testId="import-panel"
      step={step}
      stepCount={2}
      backDisabled={isConfirming}
      onBack={handleBack}
      footer={step === 1 ? (
        <div className="import-footer-actions">
          {isExtracting ? (
            <button type="button" className="btn btn-primary import-primary-action" onClick={() => abortRef.current?.abort()}>
              停止拆解
            </button>
          ) : (
            <>
              <button
                type="button"
                className="btn btn-primary import-primary-action"
                disabled={!rawText.trim() || isConfirming}
                onClick={handleExtract}
              >
                {isConfirming ? '正在创建…' : '拆解故事蓝图'}
              </button>
              <button
                type="button"
                className="btn import-secondary-action"
                disabled={!rawText.trim() || isConfirming}
                onClick={() => void handleStartWithoutExtraction()}
              >
                暂不拆解，直接开始
              </button>
            </>
          )}
        </div>
      ) : (
        <div className="import-footer-actions">
          <button
            type="button"
            className="btn btn-primary import-primary-action"
            disabled={!draft || isConfirming}
            onClick={() => void handleConfirm()}
          >
            {isConfirming ? '正在创建…' : '确认并开启第一幕'}
          </button>
        </div>
      )}
    >
      {parseError && (
        <BannerAlert tone="danger" testId="import-error">
          <div className="import-error-copy">
            <span>{parseError}</span>
            {step === 1 && rawText.trim() && !isExtracting && (
              <button type="button" className="text-action" onClick={() => void handleStartWithoutExtraction()}>
                暂不拆解，直接开始
              </button>
            )}
            {step === 1 && rawText.trim() && !isExtracting && (
              <button type="button" className="text-action" onClick={handleExtract}>重试拆解</button>
            )}
            <button type="button" className="text-action" onClick={onPackageDiagnostics}>打包排障日志</button>
          </div>
        </BannerAlert>
      )}

      {step === 1 ? (
        <div
          className="import-step-content"
          inert={isConfirming}
          aria-busy={isConfirming}
        >
          <div className="import-intro">
            <h2>先放入你的原始剧本</h2>
            <p>文件在本机读取。故事蓝图拆解需要连接你自己的 DeepSeek 密钥；也可以跳过拆解直接开始。</p>
          </div>

          <div
            className={`import-file-card${isDragging ? ' is-dragging' : ''}`}
            onDragOver={(event) => {
              event.preventDefault();
              setIsDragging(true);
            }}
            onDragLeave={() => setIsDragging(false)}
            onDrop={(event) => {
              event.preventDefault();
              setIsDragging(false);
              if (isConfirming) return;
              const file = event.dataTransfer.files?.[0];
              if (file) void handleFile(file);
            }}
          >
            <button
              type="button"
              className="import-file-picker"
              data-testid="import-script-picker"
              onClick={() => scriptInputRef.current?.click()}
            >
              <span className="import-file-title">选择剧本文件</span>
              <span className="import-file-description">支持 .docx、.md、.txt；旧版 .doc 不可解析，请另存为 .docx，也可以把文件拖到这里</span>
              <span className="import-file-action">选择文件</span>
            </button>
            <input
              ref={scriptInputRef}
              id="import-file"
              name="scriptFile"
              className="visually-hidden"
              type="file"
              tabIndex={-1}
              accept=".doc,.docx,.md,.txt"
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = '';
                if (file) void handleFile(file);
              }}
            />
            {sourceInfo && <span className="status-text">{sourceInfo}</span>}
          </div>

          <details className="import-title-details">
            <summary>填写故事标题（可选）</summary>
            <div className="field">
              <label htmlFor="import-title">故事标题</label>
              <input
                id="import-title"
                name="storyTitle"
                type="text"
                value={suggestedTitle}
                placeholder="例如：宫闱浮沉录"
                onChange={(event) => setSuggestedTitle(event.target.value)}
              />
            </div>
          </details>

          <div className="field import-script-field">
            <label htmlFor="import-raw-script">原始剧本</label>
            <textarea
              id="import-raw-script"
              name="rawScript"
              rows={8}
              value={rawText}
              placeholder="粘贴故事设定、规则、角色或开场内容…"
              onChange={(event) => {
                if (isExtracting) {
                  abortInFlightExtraction();
                  setIsExtracting(false);
                }
                setRawText(event.target.value);
                setDraft(null);
                setParseError(null);
              }}
            />
            <span className="status-text">{Array.from(rawText.trim()).length} 字 · 原文将完整保留在故事上下文中</span>
          </div>
        </div>
      ) : (
        <div
          className="import-step-content"
          inert={isConfirming}
          aria-busy={isConfirming}
        >
          <div className="import-intro">
            <h2>确认故事蓝图</h2>
            <p>拆解结果默认只读。确认后，原始剧本会作为锚定内容保留。</p>
          </div>
          {draft && previewStory && (
            <>
              <div className="import-blueprint-actions">
                <span className="badge">
                  {draft.blueprint.extractionStatus === 'complete' ? '已完整拆解' : '基础蓝图'}
                </span>
                {!editingBlueprint && (
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() => {
                      setEditBaseline(draft.blueprint);
                      setEditingBlueprint(true);
                    }}
                  >
                    微调
                  </button>
                )}
              </div>
              <StoryBlueprintCard story={previewStory} />
              {editingBlueprint && (
                <section className="import-blueprint-editor" aria-label="微调故事蓝图">
                  <div className="field">
                    <label htmlFor="bp-title">故事标题</label>
                    <input
                      id="bp-title"
                      value={draft.blueprint.title}
                      onChange={(event) => updateBlueprint({ title: event.target.value })}
                    />
                  </div>
                  <div className="field">
                    <label htmlFor="bp-protagonist">主角设定</label>
                    <input
                      id="bp-protagonist"
                      value={draft.blueprint.protagonist}
                      onChange={(event) => updateBlueprint({ protagonist: event.target.value })}
                    />
                  </div>
                  <div className="field">
                    <label htmlFor="bp-rules">背景规则（每行一条）</label>
                    <textarea
                      id="bp-rules"
                      rows={3}
                      value={draft.blueprint.worldRules.join('\n')}
                      onChange={(event) => updateBlueprint({ worldRules: splitNonEmptyLines(event.target.value) })}
                    />
                  </div>
                  <fieldset className="import-npc-editor" id="bp-npcs" aria-label="关键角色">
                    <legend>关键角色</legend>
                    {draft.blueprint.npcs.map((npc, index) => (
                      <div className="import-npc-row" key={`${index}-${npc.name}`}>
                        <div className="field">
                          <label htmlFor={`bp-npcs-name-${index}`}>姓名</label>
                          <input
                            id={`bp-npcs-name-${index}`}
                            value={npc.name}
                            onChange={(event) => updateBlueprint({
                              npcs: draft.blueprint.npcs.map((item, itemIndex) => itemIndex === index
                                ? { ...item, name: event.target.value }
                                : item),
                            })}
                          />
                        </div>
                        <div className="field">
                          <label htmlFor={`bp-npcs-role-${index}`}>身份</label>
                          <input
                            id={`bp-npcs-role-${index}`}
                            value={npc.role}
                            onChange={(event) => updateBlueprint({
                              npcs: draft.blueprint.npcs.map((item, itemIndex) => itemIndex === index
                                ? { ...item, role: event.target.value }
                                : item),
                            })}
                          />
                        </div>
                        <div className="field">
                          <label htmlFor={`bp-npcs-traits-${index}`}>特征</label>
                          <input
                            id={`bp-npcs-traits-${index}`}
                            value={npc.traits}
                            onChange={(event) => updateBlueprint({
                              npcs: draft.blueprint.npcs.map((item, itemIndex) => itemIndex === index
                                ? { ...item, traits: event.target.value }
                                : item),
                            })}
                          />
                        </div>
                        <button
                          type="button"
                          className="btn btn-sm"
                          aria-label={`删除角色 ${npc.name || index + 1}`}
                          onClick={() => updateBlueprint({
                            npcs: draft.blueprint.npcs.filter((_, itemIndex) => itemIndex !== index),
                          })}
                        >
                          删除角色
                        </button>
                      </div>
                    ))}
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() => updateBlueprint({
                        npcs: [...draft.blueprint.npcs, { name: '', role: '', traits: '' }],
                      })}
                    >
                      添加角色
                    </button>
                  </fieldset>
                  <div className="field">
                    <label htmlFor="bp-taboos">禁忌条款（每行一条）</label>
                    <textarea
                      id="bp-taboos"
                      rows={3}
                      value={draft.blueprint.taboos.join('\n')}
                      onChange={(event) => updateBlueprint({ taboos: splitNonEmptyLines(event.target.value) })}
                    />
                  </div>
                  <div className="field">
                    <label htmlFor="bp-hook">开场提示</label>
                    <textarea
                      id="bp-hook"
                      rows={3}
                      value={draft.blueprint.openingHook}
                      onChange={(event) => updateBlueprint({ openingHook: event.target.value })}
                    />
                  </div>
                  <div className="btn-group import-blueprint-editor-actions">
                    <button
                      type="button"
                      className="btn btn-primary"
                      onClick={() => {
                        setEditingBlueprint(false);
                        setEditBaseline(null);
                      }}
                    >
                      保存蓝图微调
                    </button>
                    <button
                      type="button"
                      className="btn"
                      onClick={() => {
                        if (editBaseline) setDraft({ blueprint: editBaseline });
                        setEditingBlueprint(false);
                        setEditBaseline(null);
                      }}
                    >
                      取消
                    </button>
                  </div>
                </section>
              )}
            </>
          )}
        </div>
      )}
    </OverlayPageShell>
  );
}
