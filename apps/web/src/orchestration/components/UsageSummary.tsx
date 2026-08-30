import type { Orchestration } from "../contracts";
import { formatUsage } from "../view-model";

export interface UsageSummaryProps {
  orchestration: Orchestration;
}

export function UsageSummary({ orchestration }: UsageSummaryProps) {
  const display = formatUsage(orchestration.usage);
  const roles = Object.entries(orchestration.usage.byRole);

  return (
    <section className="orch-usage" aria-labelledby="orch-usage-heading">
      <h3 id="orch-usage-heading">Usage &amp; budget</h3>
      <p className="orch-usage-total">
        {display.tokensLabel} · <span className={display.pricingConfigured ? "" : "orch-muted"}>{display.costLabel}</span>
      </p>
      {roles.length > 0 && (
        <ul className="orch-usage-by-role">
          {roles.map(([role, usage]) => (
            <li key={role}>
              <strong>{role}</strong> ({usage.modelId}): {usage.inputTokens.toLocaleString()} in /{" "}
              {usage.cachedInputTokens.toLocaleString()} cached / {usage.outputTokens.toLocaleString()} out ·{" "}
              {usage.modelCalls} call{usage.modelCalls === 1 ? "" : "s"}
              {usage.estimatedUsd !== null ? ` · $${usage.estimatedUsd.toFixed(4)}` : ""}
            </li>
          ))}
        </ul>
      )}
      <p className="orch-budget-caption">
        Budget: {orchestration.budget.maxModelCalls} calls · {orchestration.budget.maxWorkerAttempts} attempts/task ·{" "}
        {orchestration.budget.maxContextExpansionsPerTask} expansions/task
      </p>
    </section>
  );
}
