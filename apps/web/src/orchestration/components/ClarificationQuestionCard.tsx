import { useState } from "react";
import type { ClarificationQuestionView } from "../contracts";

export interface ClarificationQuestionCardProps {
  question: ClarificationQuestionView;
  onAnswer: (answer: string) => void;
  disabled: boolean;
}

/** Ported from task1-julian and adapted to the frozen materialQuestions boundary. */
export function ClarificationQuestionCard({
  question,
  onAnswer,
  disabled,
}: ClarificationQuestionCardProps) {
  const [freeText, setFreeText] = useState("");

  const submitFreeText = () => {
    const answer = freeText.trim();
    if (!answer || disabled) return;
    onAnswer(answer);
  };

  return (
    <div className="orch-question-card">
      <div className="orch-question-heading">
        <span className="orch-badge orch-badge-material">Needs your choice</span>
        <p className="orch-question-prompt">{question.prompt}</p>
      </div>
      <p className="orch-question-consequence">
        If wrong: {question.consequenceIfWrong}
      </p>
      <div
        className="orch-question-options"
        role="group"
        aria-label={`Answer: ${question.prompt}`}
      >
        {question.options.map((item) => (
          <button
            key={item.id}
            type="button"
            className={
              "button button-ghost orch-question-option" +
              (item.delegate ? " orch-delegate-option" : "")
            }
            disabled={disabled}
            onClick={() => onAnswer(item.resolutionText)}
          >
            {item.delegate ? "◇ " : ""}
            {item.label}
          </button>
        ))}
      </div>
      <form
        className="orch-question-freetext"
        onSubmit={(event) => {
          event.preventDefault();
          submitFreeText();
        }}
      >
        <label htmlFor={`freetext-${question.id}`}>Or write your own answer</label>
        <div className="orch-question-freetext-row">
          <textarea
            id={`freetext-${question.id}`}
            value={freeText}
            onChange={(event) => setFreeText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                submitFreeText();
              }
            }}
            disabled={disabled}
            rows={3}
            placeholder="Add context or provide an answer that is not listed above…"
          />
          <button
            type="submit"
            className="button button-primary"
            disabled={disabled || !freeText.trim()}
          >
            Send answer
          </button>
        </div>
        <small>Press ⌘ Enter or Ctrl Enter to send.</small>
      </form>
    </div>
  );
}
