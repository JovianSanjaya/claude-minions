import type { Orchestration } from "../contracts";
import { formatOrchestrationHistoryLabel, sortOrchestrationsByRecency } from "../view-model";

export interface HistoryPickerProps {
  orchestrations: Orchestration[];
  selectedId: string | null;
  onSelect: (orchestrationId: string | null) => void;
  disabled: boolean;
}

const NEW_VALUE = "__new__";

/**
 * A persistent picker for every past orchestration on this Agent (not just
 * the one currently in-flight or most-recently-created) — without it,
 * switching Agents and back, or reloading, only ever re-surfaces a
 * still-active run, silently losing access to everything that already
 * finished even though the server has kept it all along.
 */
export function HistoryPicker({ orchestrations, selectedId, onSelect, disabled }: HistoryPickerProps) {
  if (orchestrations.length === 0) return null;
  const sorted = sortOrchestrationsByRecency(orchestrations);

  return (
    <label className="orch-history-picker">
      <span className="orch-prompt-label">Past runs</span>
      <select
        value={selectedId ?? NEW_VALUE}
        disabled={disabled}
        onChange={(event) => onSelect(event.target.value === NEW_VALUE ? null : event.target.value)}
      >
        <option value={NEW_VALUE}>+ New orchestration</option>
        {sorted.map((orchestration) => (
          <option key={orchestration.id} value={orchestration.id}>
            {formatOrchestrationHistoryLabel(orchestration)}
          </option>
        ))}
      </select>
    </label>
  );
}
