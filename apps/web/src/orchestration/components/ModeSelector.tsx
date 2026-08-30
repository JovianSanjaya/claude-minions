import { EXECUTION_MODE_DESCRIPTORS } from "../view-model";
import type { ExecutionMode } from "../view-model";

/**
 * Execution-mode control (specification 8.4).
 *
 * Direct delegates to the host application's existing message path; Auto and
 * Orchestrated create a real orchestration. The control never marks server
 * state optimistically: it only reports what the caller told it is in flight.
 */
export function ModeSelector({
  mode,
  onModeChange,
  prompt,
  onPromptChange,
  onSubmit,
  submitting,
  disabled,
  disabledReason,
  directAvailable,
}: {
  mode: ExecutionMode;
  onModeChange: (mode: ExecutionMode) => void;
  prompt: string;
  onPromptChange: (prompt: string) => void;
  onSubmit: () => void;
  submitting: boolean;
  disabled: boolean;
  disabledReason: string | null;
  directAvailable: boolean;
}) {
  const descriptor =
    EXECUTION_MODE_DESCRIPTORS.find((item) => item.mode === mode) ??
    EXECUTION_MODE_DESCRIPTORS[0];
  const blocked = disabled || submitting;

  return (
    <section className="orch-panel" aria-labelledby="orch-mode-heading">
      <header>
        <div>
          <span className="eyebrow">Execution mode</span>
          <h3 id="orch-mode-heading">How should this task run?</h3>
        </div>
      </header>

      <div className="orch-modes" role="group" aria-label="Execution mode">
        {EXECUTION_MODE_DESCRIPTORS.map((item) => (
          <button
            key={item.mode}
            type="button"
            className="orch-mode"
            aria-pressed={item.mode === mode}
            disabled={
              blocked || (item.mode === "direct" && !directAvailable)
            }
            onClick={() => onModeChange(item.mode)}
          >
            {item.label}
          </button>
        ))}
      </div>
      <p className="orch-mode-hint">{descriptor?.hint}</p>

      <form
        className="orch-inline-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (!blocked && prompt.trim()) onSubmit();
        }}
      >
        <label htmlFor="orch-prompt">
          Task for this Agent
          <textarea
            id="orch-prompt"
            value={prompt}
            rows={3}
            onChange={(event) => onPromptChange(event.target.value)}
            placeholder="Describe the change you want. Auto and Orchestrated will confirm their interpretation with you first."
            disabled={blocked}
          />
        </label>
        <div className="orch-actions orch-actions--end">
          {disabledReason && (
            <span className="orch-note" role="status">
              {disabledReason}
            </span>
          )}
          <button
            type="submit"
            className="button button-primary"
            disabled={blocked || !prompt.trim()}
          >
            {submitting
              ? "Submitting…"
              : mode === "direct"
                ? "Send directly"
                : "Draft intent"}
          </button>
        </div>
      </form>
    </section>
  );
}
