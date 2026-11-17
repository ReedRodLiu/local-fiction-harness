import { useRef, useState } from 'react';
import {
  createDefaultBlueprint,
  parseScriptInput,
  type ModelConfig,
  type StoryBlueprint,
} from '../harness/index.ts';

interface ImportPanelProps {
  config: ModelConfig;
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
  }) => void;
  onCancel?: () => void;
}

function formatNpcsLines(npcs: StoryBlueprint['npcs']): string {
  return npcs.map((n) => [n.name, n.role, n.traits].filter(Boolean).join(' | ')).join('\n');
}

function parseNpcsLines(text: string): StoryBlueprint['npcs'] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [name = '', role = '', traits = ''] = line.split('|').map((s) => s.trim());
      return { name, role, traits };
    })
    .filter((npc) => npc.name.length > 0);
}

export function ImportPanel({
  config,
  extractBlueprint,
  onConfirmStory,
  onCancel,
}: ImportPanelProps) {
  const [rawText, setRawText] = useState('');
  const [suggestedTitle, setSuggestedTitle] = useState('');
  const [sourceInfo, setSourceInfo] = useState<string>('');
  const [blueprint, setBlueprint] = useState<StoryBlueprint | null>(null);
  const [isExtracting, setIsExtracting] = useState(false);
  const [parseError, setParseError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const handleFile = async (file: File) => {
    setParseError(null);
    try {
      const buffer = await file.arrayBuffer();
      const parsed = await parseScriptInput({
        kind: 'file',
        fileName: file.name,
        bytes: new Uint8Array(buffer),
      });
      setRawText(parsed.rawScript);
      setSuggestedTitle(parsed.suggestedTitle);
      setSourceInfo(`已解析 ${file.name}（${parsed.sourceType.toUpperCase()}，${parsed.rawScript.length} 字符）`);
      setBlueprint(null);
    } catch (err) {
      setParseError(err instanceof Error ? err.message : '文件解析失败。');
    }
  };

  const handleExtract = async () => {
    setParseError(null);
    try {
      const parsed = await parseScriptInput({
        kind: 'paste',
        text: rawText,
        title: suggestedTitle || undefined,
      });
      const fallbackTitle = suggestedTitle.trim() || parsed.suggestedTitle;
      setSuggestedTitle(fallbackTitle);
      setIsExtracting(true);
      const controller = new AbortController();
      abortRef.current = controller;

      const extracted = await extractBlueprint(
        parsed.rawScript,
        config,
        fallbackTitle,
        controller.signal,
      );
      setBlueprint(extracted);
    } catch (err) {
      if ((err as { name?: string }).name === 'AbortError') {
        setParseError('已中止蓝图拆解。');
      } else {
        setParseError(err instanceof Error ? err.message : '拆解蓝图失败。');
      }
    } finally {
      abortRef.current = null;
      setIsExtracting(false);
    }
  };

  const handleSkipToManual = async () => {
    setParseError(null);
    try {
      const parsed = await parseScriptInput({
        kind: 'paste',
        text: rawText,
        title: suggestedTitle || undefined,
      });
      const title = suggestedTitle.trim() || parsed.suggestedTitle;
      setSuggestedTitle(title);
      setBlueprint(createDefaultBlueprint(title));
    } catch (err) {
      setParseError(err instanceof Error ? err.message : '剧本文本不能为空。');
    }
  };

  return (
    <section className="import-panel" aria-label="导入剧本与故事蓝图拆解">
      <div className="panel-header">
        <h3>导入自由格式剧本</h3>
        {onCancel && (
          <button type="button" className="btn" onClick={onCancel}>
            返回当前故事
          </button>
        )}
      </div>

      {parseError && (
        <div className="error-banner" role="alert">
          {parseError}
        </div>
      )}

      <div className="field">
        <label htmlFor="import-file">选择剧本文件（支持 .docx / .md / .txt）</label>
        <input
          id="import-file"
          name="scriptFile"
          type="file"
          accept=".docx,.md,.txt"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) {
              void handleFile(file);
            }
          }}
        />
        {sourceInfo && <span className="status-text">{sourceInfo}</span>}
      </div>

      <div className="field">
        <label htmlFor="import-title">故事标题（可选，默认自动提取）</label>
        <input
          id="import-title"
          name="storyTitle"
          type="text"
          value={suggestedTitle}
          placeholder="例如：宫闱浮沉录"
          onChange={(e) => setSuggestedTitle(e.target.value)}
        />
      </div>

      <div className="field">
        <label htmlFor="import-raw-script">原始剧本文本（也可直接粘贴，对话期全文保留锚定）</label>
        <textarea
          id="import-raw-script"
          name="rawScript"
          rows={7}
          value={rawText}
          placeholder="粘贴任意格式的文游设定、规则、表格或伪代码块模板…"
          onChange={(e) => {
            setRawText(e.target.value);
            setBlueprint(null);
          }}
        />
      </div>

      <div className="composer-actions">
        <span className="status-text">当前字符数：{rawText.trim().length}</span>
        <div className="btn-group">
          {isExtracting ? (
            <button type="button" className="btn" onClick={() => abortRef.current?.abort()}>
              停止拆解
            </button>
          ) : (
            <>
              <button
                type="button"
                className="btn"
                disabled={!rawText.trim()}
                onClick={() => void handleSkipToManual()}
              >
                跳过模型拆解
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={!rawText.trim()}
                onClick={() => void handleExtract()}
              >
                拆解故事蓝图
              </button>
            </>
          )}
        </div>
      </div>

      {blueprint && (
        <div className="blueprint-editor" aria-label="确认故事蓝图">
          <div className="panel-header">
            <h4>故事蓝图预览与微调</h4>
            <span className="badge">
              {blueprint.extractionStatus === 'complete' ? '已完整拆解' : '兜底模式（可手动补充）'}
            </span>
          </div>

          <div className="field">
            <label htmlFor="bp-title">确认标题</label>
            <input
              id="bp-title"
              type="text"
              value={blueprint.title}
              onChange={(e) => setBlueprint({ ...blueprint, title: e.target.value })}
            />
          </div>

          <div className="field">
            <label htmlFor="bp-protagonist">主角设定</label>
            <input
              id="bp-protagonist"
              type="text"
              value={blueprint.protagonist}
              onChange={(e) => setBlueprint({ ...blueprint, protagonist: e.target.value })}
            />
          </div>

          <div className="field">
            <label htmlFor="bp-rules">核心规则（每行一条）</label>
            <textarea
              id="bp-rules"
              rows={3}
              value={blueprint.worldRules.join('\n')}
              onChange={(e) =>
                setBlueprint({
                  ...blueprint,
                  worldRules: e.target.value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean),
                })
              }
            />
          </div>

          <div className="field">
            <label htmlFor="bp-taboos">禁忌条款（每行一条）</label>
            <textarea
              id="bp-taboos"
              rows={2}
              value={blueprint.taboos.join('\n')}
              onChange={(e) =>
                setBlueprint({
                  ...blueprint,
                  taboos: e.target.value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean),
                })
              }
            />
          </div>

          <div className="field">
            <label htmlFor="bp-npcs">关键角色（每行格式：姓名 | 身份 | 特征）</label>
            <textarea
              id="bp-npcs"
              rows={3}
              value={formatNpcsLines(blueprint.npcs)}
              onChange={(e) =>
                setBlueprint({
                  ...blueprint,
                  npcs: parseNpcsLines(e.target.value),
                })
              }
            />
          </div>

          <div className="field">
            <label htmlFor="bp-hook">开场提示</label>
            <textarea
              id="bp-hook"
              rows={2}
              value={blueprint.openingHook}
              onChange={(e) => setBlueprint({ ...blueprint, openingHook: e.target.value })}
            />
          </div>

          <div className="composer-actions">
            <span className="status-text">原始剧本全文将作为固定锚定保留在上下文中</span>
            <button
              type="button"
              className="btn btn-primary"
              onClick={() =>
                onConfirmStory({
                  title: blueprint.title.trim() || suggestedTitle.trim() || '未命名剧本',
                  rawScript: rawText.trim(),
                  blueprint,
                })
              }
            >
              确认蓝图并开始故事
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
