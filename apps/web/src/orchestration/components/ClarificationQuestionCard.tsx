import { useState } from "react";
import type { ClarificationQuestion } from "../contracts";

export interface ClarificationQuestionCardProps {
  question: ClarificationQuestion;
  onAnswer: (answer: { optionId?: string; freeText?: string }) => void;
  disabled: boolean;
}

export function ClarificationQuestionCard({ question, onAnswer, disabled }: ClarificationQuestionCardProps) {
  const [showOther, setShowOther] = useState(false);
  const [freeText, setFreeText] = useState("");

  return (
    <li className="orch-question-card">
      <div className="orch-question-heading">
        <span className="orch-badge orch-badge-material">material</span>
        <p className="orch-question-prompt">{question.prompt}</p>
      </div>
      <p className="orch-question-consequence">If wrong: {question.consequenceIfWrong}</p>
      <div className="orch-question-options" role="group" aria-label={`Answer: ${question.prompt}`}>
        {question.options.map((option) => (
          <button
            key={option.id}
            type="button"
            className={"button button-ghost orch-question-option" + (option.delegate ? " orch-delegate-option" : "")}
            disabled={disabled}
            onClick={() => onAnswer({ optionId: option.id })}
          >
            {option.delegate ? "🤝 " : ""}
            {option.label}
          </button>
        ))}
        <button
          type="button"
          className="button button-ghost orch-question-option"
          disabled={disabled}
          onClick={() => setShowOther((value) => !value)}
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
            />
            <button
              type="button"
              className="button button-primary"
              disabled={disabled || !freeText.trim()}
              onClick={() => onAnswer({ freeText: freeText.trim() })}
            >
              Submit
            </button>
          </div>
        </div>
      )}
    </li>
  );
}
