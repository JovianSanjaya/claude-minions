import type { PlaygroundMode } from "../view-model";

const MODES: Array<{ id: PlaygroundMode; label: string; hint: string }> = [
  { id: "direct", label: "Direct", hint: "One strong model call against your Agent's own workspace." },
  { id: "auto", label: "Auto", hint: "The planner chooses direct, one worker, or multiple workers." },
  { id: "orchestrated", label: "Orchestrated", hint: "Always delegates to one or more isolated workers." },
];

export interface ModeSelectorProps {
  mode: PlaygroundMode;
  onModeChange: (mode: PlaygroundMode) => void;
  prompt: string;
  onPromptChange: (value: string) => void;
  onSubmit: () => void;
  disabled: boolean;
  busy: boolean;
}

export function ModeSelector({ mode, onModeChange, prompt, onPromptChange, onSubmit, disabled, busy }: ModeSelectorProps) {
  return (
    <form
      className="orch-mode-selector"
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <fieldset className="orch-mode-fieldset" disabled={disabled}>
        <legend>Execution mode</legend>
        <div className="orch-mode-options" role="radiogroup" aria-label="Execution mode">
          {MODES.map((option) => (
            <label key={option.id} className={"orch-mode-option" + (mode === option.id ? " selected" : "")}>
              <input
                type="radio"
                name="orchestration-mode"
                value={option.id}
                checked={mode === option.id}
                onChange={() => onModeChange(option.id)}
              />
              <span className="orch-mode-option-label">{option.label}</span>
              <span className="orch-mode-option-hint">{option.hint}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <label className="orch-prompt-label" htmlFor="orchestration-prompt">
        Task
      </label>
      <textarea
        id="orchestration-prompt"
        className="orch-prompt-input"
        value={prompt}
        onChange={(event) => onPromptChange(event.target.value)}
        placeholder="Describe the coding task…"
        rows={3}
        disabled={disabled}
      />
      <button className="button button-primary" type="submit" disabled={disabled || busy || !prompt.trim()}>
        {busy ? "Submitting…" : mode === "direct" ? "Send" : "Start grounding"}
      </button>
    </form>
  );
}
