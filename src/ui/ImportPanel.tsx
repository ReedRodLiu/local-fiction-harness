import { useRef, useState } from 'react';
import {
  DEFAULT_STORY_TITLE,
  createDefaultBlueprint,
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
import { BannerAlert } from './primitives/BannerAlert.tsx';
import { OverlayPageShell } from './primitives/OverlayPageShell.tsx';
import { DeepSeekImportPanel } from './DeepSeekImportPanel.tsx';
import { toErrorMessage } from './textHelpers.ts';

export type ImportMode = 'deepseek' | 'script';

export interface ImportPanelProps {
  initialMode?: ImportMode;
  resetKey?: number;
  config: ModelConfig;
  transport: LlmTransport;
  binaryDownloader: BinaryDownloader;
  hasCredentials: boolean;
  byokOpen: boolean;
  onRequireByok: (
    actionLabel: string,
    resume: (resolvedConfig: ModelConfig) => void,
    onCancel?: () => void,
  ) => void;
  extractBlueprint?: (
    rawScript: string,
    config: ModelConfig,
    fallbackTitle: string,
    signal: AbortSignal,
  ) => Promise<StoryBlueprint>;
  onConfirmStory?: (input: {
    title: string;
    rawScript: string;
    blueprint: StoryBlueprint;
  }) => Promise<void> | void;
  onCreateSettingStory?: (input: {
    title: string;
    settingMarkdown: string;
  }) => Promise<void> | void;
  onImportDeepSeekBatch: (
    zipBytes: Uint8Array,
    selectedSessionIds: readonly string[],
    scriptRangeOverrides: Record<string, ScriptTurnRange>,
  ) => Promise<DeepSeekImportBatchResult>;
  onDeepSeekImportBusyChange: (busy: boolean) => void;
  onContinueStory: (storyId: string) => void;
  diagnostics: DiagnosticCollector;
  onPackageDiagnostics: () => void;
  onCancel?: () => void;
  existingSessionIds?: readonly string[];
  existingStories?: readonly Pick<Story, 'id' | 'title' | 'sourceSessionId'>[];
}

export function ImportPanel({
  initialMode = 'deepseek',
  resetKey = 0,
  config,
  transport,
  binaryDownloader,
  hasCredentials,
  byokOpen,
  onRequireByok,
  onConfirmStory,
  onCreateSettingStory,
  onImportDeepSeekBatch,
  onDeepSeekImportBusyChange,
  onContinueStory,
  diagnostics,
  onPackageDiagnostics,
  onCancel,
  existingSessionIds,
  existingStories,
}: ImportPanelProps) {
  const importMode = initialMode;
  const [rawText, setRawText] = useState('');
  const [suggestedTitle, setSuggestedTitle] = useState('');
  const [sourceInfo, setSourceInfo] = useState('');
  const [isDragging, setIsDragging] = useState(false);
  const [isConfirming, setIsConfirming] = useState(false);
  const [parseError, setParseError] = useState<string | null>(null);
  const scriptInputRef = useRef<HTMLInputElement>(null);
  const fileSeqRef = useRef(0);

  const handleFile = async (file: File) => {
    setParseError(null);
    const fileSeq = ++fileSeqRef.current;
    if (file.name.toLowerCase().endsWith('.doc')) {
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
    } catch (err) {
      if (fileSeqRef.current === fileSeq) {
        setParseError(toErrorMessage(err, '文件解析失败。'));
      }
    }
  };

  const prepareSettingInput = () => {
    const parsed = parseScriptInput({
      kind: 'paste',
      text: rawText,
      title: suggestedTitle || undefined,
    });
    const fallbackTitle = suggestedTitle.trim() || parsed.suggestedTitle;
    setSuggestedTitle(fallbackTitle);
    return { settingMarkdown: parsed.rawScript, fallbackTitle };
  };

  const handleCreateStory = async () => {
    if (isConfirming) return;
    setParseError(null);
    try {
      const { settingMarkdown, fallbackTitle } = prepareSettingInput();
      setIsConfirming(true);
      const title = fallbackTitle || DEFAULT_STORY_TITLE;
      if (onCreateSettingStory) {
        await onCreateSettingStory({ title, settingMarkdown });
      } else if (onConfirmStory) {
        await onConfirmStory({
          title,
          rawScript: settingMarkdown,
          blueprint: createDefaultBlueprint(title),
        });
      }
    } catch (err) {
      setParseError(toErrorMessage(err, '创建故事失败。'));
    } finally {
      setIsConfirming(false);
    }
  };

  const handleBack = () => {
    if (isConfirming) return;
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
        byokOpen={byokOpen}
        onRequireByok={onRequireByok}
        onImportBatch={onImportDeepSeekBatch}
        onImportBusyChange={onDeepSeekImportBusyChange}
        onContinueStory={onContinueStory}
        diagnostics={diagnostics}
        onPackageDiagnostics={onPackageDiagnostics}
        onCancel={onCancel}
        existingSessionIds={existingSessionIds}
        existingStories={existingStories}
      />
    );
  }

  return (
    <OverlayPageShell
      title="导入故事设定"
      testId="import-panel"
      backDisabled={isConfirming}
      onBack={handleBack}
      footer={(
        <div className="import-footer-actions">
          <button
            type="button"
            className="btn btn-primary import-primary-action"
            data-testid="import-script-submit"
            disabled={!rawText.trim() || isConfirming}
            onClick={() => void handleCreateStory()}
          >
            {isConfirming ? '正在创建…' : '导入并开始'}
          </button>
        </div>
      )}
    >
      {parseError && (
        <BannerAlert tone="danger" testId="import-error">
          <div className="import-error-copy">
            <span>{parseError}</span>
            <button type="button" className="text-action" onClick={onPackageDiagnostics}>
              导出排障日志
            </button>
          </div>
        </BannerAlert>
      )}

      <div
        className="import-step-content"
        data-testid="import-step-content"
        inert={isConfirming}
        aria-busy={isConfirming}
      >
        <div className="import-intro">
          <h2>放入你的故事设定</h2>
          <p>文件仅在本机读取，导入后直接整理为一份「故事设定」Markdown，无需填写额外表单。</p>
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
            <span className="import-file-title">选择设定或文本文件</span>
            <span className="import-file-description">
              支持 .docx、.md、.txt；旧版 .doc 不可直接读取，请另存为 .docx，也可以把文件拖到这里
            </span>
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
          <label htmlFor="import-raw-script">故事设定</label>
          <textarea
            id="import-raw-script"
            name="rawScript"
            rows={8}
            value={rawText}
            placeholder="粘贴故事设定、规则、角色或开场内容…"
            onChange={(event) => {
              setRawText(event.target.value);
              setParseError(null);
            }}
          />
          <span className="status-text">
            {Array.from(rawText.trim()).length} 字 · 将直接保存为「故事设定」
          </span>
        </div>
      </div>
    </OverlayPageShell>
  );
}
