import { parseAssistantMessage } from '../harness/index.ts';

interface MessageContentProps {
  content: string;
  showChoices?: boolean;
  disabled?: boolean;
  onSelectChoice?: (choiceText: string) => void;
}

export function MessageContent({
  content,
  showChoices = false,
  disabled = false,
  onSelectChoice,
}: MessageContentProps) {
  const parsed = parseAssistantMessage(content);

  return (
    <div className="message-content">
      {parsed.segments.map((seg, idx) =>
        seg.type === 'codeblock' ? (
          <pre key={idx} className="hud-panel" aria-label="状态面板">
            <code>{seg.code}</code>
          </pre>
        ) : (
          <div key={idx} className="turn-body">
            {seg.content}
          </div>
        ),
      )}

      {showChoices && parsed.choices.length > 0 && onSelectChoice && (
        <div className="choices-row" role="group" aria-label="快捷选项">
          {parsed.choices.map((choice) => (
            <button
              key={choice.key}
              type="button"
              className="btn choice-btn"
              disabled={disabled}
              onClick={() => onSelectChoice(choice.fullText)}
            >
              {choice.fullText}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
