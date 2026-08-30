import type { Orchestration } from "../contracts";
import { budgetTone, computeBudgetUsage, formatUsage, type BudgetMeter } from "../view-model";

export interface UsageSummaryProps {
  orchestration: Orchestration;
}

function BudgetMeterBar({ meter, formatValue = (value: number) => value.toLocaleString() }: { meter: BudgetMeter; formatValue?: (value: number) => string }) {
  const tone = budgetTone(meter.percent);
  return (
    <div className="orch-budget-meter">
      <div className="orch-budget-meter-label">
        <span>{meter.label}</span>
        <span className="orch-muted">
          {meter.max !== null ? `${formatValue(meter.used)} / ${formatValue(meter.max)} · ${meter.percent}%` : `${formatValue(meter.used)} · no limit set`}
        </span>
      </div>
      {meter.max !== null && (
        <div className="orch-progress-track" role="progressbar" aria-valuenow={meter.percent ?? 0} aria-valuemin={0} aria-valuemax={100} aria-label={meter.label}>
          <div className={"orch-progress-fill orch-tone-" + tone} style={{ width: `${meter.percent}%` }} />
        </div>
      )}
    </div>
  );
}

export function UsageSummary({ orchestration }: UsageSummaryProps) {
  const display = formatUsage(orchestration.usage);
  const budgetUsage = computeBudgetUsage(orchestration.usage, orchestration.budget);
  const roles = Object.entries(orchestration.usage.byRole);

  return (
    <section className="orch-usage" aria-labelledby="orch-usage-heading">
      <h3 id="orch-usage-heading">Usage &amp; budget</h3>
      <p className="orch-usage-total">
        {display.tokensLabel} · <span className={display.pricingConfigured ? "" : "orch-muted"}>{display.costLabel}</span>
      </p>

      <div className="orch-budget-meters">
        <BudgetMeterBar meter={budgetUsage.modelCalls} />
        <BudgetMeterBar meter={budgetUsage.inputTokens} />
        <BudgetMeterBar meter={budgetUsage.outputTokens} />
        {budgetUsage.estimatedUsd.max !== null && (
          <BudgetMeterBar meter={budgetUsage.estimatedUsd} formatValue={(value) => `$${value.toFixed(4)}`} />
        )}
      </div>

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
        Up to {orchestration.budget.maxWorkerAttempts} attempt{orchestration.budget.maxWorkerAttempts === 1 ? "" : "s"} and{" "}
        {orchestration.budget.maxContextExpansionsPerTask} context expansion{orchestration.budget.maxContextExpansionsPerTask === 1 ? "" : "s"} per task.
      </p>
    </section>
  );
}
