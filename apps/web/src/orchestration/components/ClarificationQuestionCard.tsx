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
  const [showOther, setShowOther] = useState(false);
  const [freeText, setFreeText] = useState("");

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
        <button
          type="button"
          className="button button-ghost orch-question-option"
          disabled={disabled}
          onClick={() => setShowOther((value) => !value)}
          aria-expanded={showOther}
        >
          Other…
        </button>
      </div>
      {showOther && (
        <div className="orch-question-freetext">
          <label htmlFor={`freetext-${question.id}`}>Your own answer</label>
          <div className="orch-question-freetext-row">
            <input
              id={`freetext-${question.id}`}
              value={freeText}
              onChange={(event) => setFreeText(event.target.value)}
              disabled={disabled}
              autoFocus
            />
            <button
              type="button"
              className="button button-primary"
              disabled={disabled || !freeText.trim()}
              onClick={() => onAnswer(freeText.trim())}
            >
              Submit
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
