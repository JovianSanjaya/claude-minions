import type { BudgetPolicy, CostEstimate, UsageLedger } from "../contracts";
import type { EvidenceCounters } from "../view-model";
import {
  PRICING_NOT_CONFIGURED,
  budgetGauges,
  compareEstimateToActual,
  formatDuration,
  formatTokens,
  summarizeUsage,
} from "../view-model";
import { Fact } from "./StatusBadge";

/** Ported from devan/task123's Accounting panel. */
export function UsagePanel({
  usage,
  budget,
  estimate,
  counters,
  elapsedMs,
  budgetStopReason,
}: {
  usage: UsageLedger;
  budget: BudgetPolicy;
  estimate: CostEstimate | null;
  counters: EvidenceCounters;
  elapsedMs: number;
  budgetStopReason: string | null;
}) {
  const summary = summarizeUsage(usage);
  const gauges = budgetGauges(usage, budget, summary.totalModelCalls);
  const comparison = compareEstimateToActual(estimate, usage);

  return (
    <section className="orch-panel" aria-labelledby="orch-usage-heading">
      <header>
        <div>
          <span className="eyebrow">Accounting · Live</span>
          <h3 id="orch-usage-heading">Usage, budget, and estimated cost</h3>
        </div>
        <span className="orch-note">
          {summary.totalEstimatedUsd === null
            ? PRICING_NOT_CONFIGURED
            : `estimated cost $${summary.totalEstimatedUsd.toFixed(4)}`}
        </span>
      </header>

      {budgetStopReason && (
        <p className="orch-error" role="alert">
          <span>Budget stop: {budgetStopReason}</span>
        </p>
      )}

      <div className="orch-table-scroll">
        <table className="orch-table">
          <caption>
            Token usage by logical role. The model column records what actually ran.
          </caption>
          <thead>
            <tr>
              <th scope="col">Role</th>
              <th scope="col">Model</th>
              <th scope="col">Input</th>
              <th scope="col">Cached</th>
              <th scope="col">Output</th>
              <th scope="col">Codex runs</th>
              <th scope="col">Ark turns</th>
              <th scope="col">Tools</th>
              <th scope="col">Estimated cost</th>
            </tr>
          </thead>
          <tbody>
            {summary.rows.length === 0 ? (
              <tr>
                <td colSpan={9}>No model usage recorded yet.</td>
              </tr>
            ) : (
              summary.rows.map((row) => (
                <tr key={row.role}>
                  <th scope="row">{row.role}</th>
                  <td>{row.modelId}</td>
                  <td>{formatTokens(row.inputTokens)}</td>
                  <td>{formatTokens(row.cachedInputTokens)}</td>
                  <td>{formatTokens(row.outputTokens)}</td>
                  <td>{formatTokens(row.modelCalls)}</td>
                  <td>{formatTokens(row.arkApiTurns ?? 0)}</td>
                  <td>{formatTokens(row.toolCalls ?? 0)}</td>
                  <td>
                    {row.estimatedUsd === null
                      ? PRICING_NOT_CONFIGURED
                      : `$${row.estimatedUsd.toFixed(4)}`}
                  </td>
                </tr>
              ))
            )}
          </tbody>
          <tfoot>
            <tr>
              <td>Total</td>
              <td />
              <td>{formatTokens(summary.totalInputTokens)}</td>
              <td>{formatTokens(summary.totalCachedInputTokens)}</td>
              <td>{formatTokens(summary.totalOutputTokens)}</td>
              <td>{formatTokens(summary.totalModelCalls)}</td>
              <td>{formatTokens(summary.totalArkApiTurns)}</td>
              <td>{formatTokens(summary.totalToolCalls)}</td>
              <td>
                {summary.totalEstimatedUsd === null
                  ? PRICING_NOT_CONFIGURED
                  : `$${summary.totalEstimatedUsd.toFixed(4)}`}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>

      <h4>Hard limits</h4>
      <div className="orch-gauges">
        {gauges.map((gauge) => (
          <div className="orch-gauge" key={gauge.label} data-exceeded={gauge.exceeded}>
            <div className="orch-gauge-label">
              <span>{gauge.label}</span>
              <span>
                {gauge.display}
                {gauge.exceeded ? " · limit reached" : ""}
              </span>
            </div>
            <div
              className="orch-gauge-track"
              role="meter"
              aria-label={gauge.label}
              aria-valuenow={Math.round((gauge.ratio ?? 0) * 100)}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuetext={gauge.display}
            >
              <div
                className="orch-gauge-fill"
                style={{ width: `${Math.round((gauge.ratio ?? 0) * 100)}%` }}
              />
            </div>
          </div>
        ))}
      </div>

      {comparison && (
        <>
          <h4>Estimate versus actual</h4>
          <dl className="orch-facts">
            <Fact term="Estimated tokens">{comparison.tokenRange}</Fact>
            <Fact term="Actual tokens">{formatTokens(comparison.actualTokens)}</Fact>
            <Fact term="Estimated cost range">{comparison.costRange}</Fact>
            <Fact term="Actual estimated cost">{comparison.actualCost}</Fact>
          </dl>
          {comparison.overHighEstimate && (
            <p className="orch-note">
              Actual token use exceeded the high end of the pre-execution estimate.
            </p>
          )}
        </>
      )}

      <h4>Evidence counters</h4>
      <dl className="orch-facts">
        <Fact term="Tasks">{counters.tasks}</Fact>
        <Fact term="Attempts">{counters.attempts}</Fact>
        <Fact term="Context expansions">{counters.contextExpansions}</Fact>
        <Fact term="Escalations">{counters.escalations}</Fact>
        <Fact term="Integration failures">{counters.integrationFailures}</Fact>
        <Fact term="Verifications">
          {counters.verifications} ({counters.failedVerifications} failed)
        </Fact>
        <Fact term="Artifacts">{counters.artifacts}</Fact>
        <Fact term="Codex executions">{summary.totalModelCalls}</Fact>
        <Fact term="Completed Ark turns">{summary.totalArkApiTurns}</Fact>
        <Fact term="Tool calls">{summary.totalToolCalls}</Fact>
        <Fact term="Stream retries observed">{summary.totalStreamRetries}</Fact>
        <Fact term="Peak request context">{formatTokens(summary.peakContextTokens)} tokens</Fact>
        <Fact term="Stale refreshes">{counters.staleRefreshes}</Fact>
        <Fact term="Elapsed time">{formatDuration(elapsedMs)} · informational only</Fact>
      </dl>
    </section>
  );
}
