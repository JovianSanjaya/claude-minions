import { useState } from "react";
import type { BenchmarkRecord } from "../contracts";
import {
  PRICING_NOT_CONFIGURED,
  formatDuration,
  formatTokens,
  presentBenchmark,
} from "../view-model";
import { Fact, StatusBadge } from "./StatusBadge";

/**
 * Direct-versus-orchestrated benchmark view (specification 8.9).
 *
 * Quality is always rendered above cost, and the cost line explicitly says the
 * comparison is withheld whenever the arms are not verified-equivalent.
 */
export function BenchmarkPanel({
  record,
  running,
  onRun,
  onCancel,
  busy,
  disabled,
  disabledReason,
}: {
  record: BenchmarkRecord | null;
  running: boolean;
  onRun: (prompt: string) => void;
  onCancel: () => void;
  busy: boolean;
  disabled: boolean;
  disabledReason: string | null;
}) {
  const [prompt, setPrompt] = useState("");
  const presentation = record ? presentBenchmark(record) : null;

  return (
    <section className="orch-panel" aria-labelledby="orch-benchmark-heading">
      <header>
        <div>
          <span className="eyebrow">Benchmark</span>
          <h3 id="orch-benchmark-heading">Direct versus orchestrated</h3>
        </div>
        {presentation && <StatusBadge presentation={presentation.status} />}
      </header>

      <p className="orch-note">
        Both arms start from one copy of the same Agent workspace snapshot, receive the
        same prompt and the same confirmed criteria, and are graded by the same trusted
        checks. The second arm never sees the first arm's output. A result where direct
        execution wins is a valid outcome and is reported as such.
      </p>

      <form
        className="orch-inline-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (prompt.trim()) onRun(prompt.trim());
        }}
      >
        <label htmlFor="orch-benchmark-prompt">
          Benchmark task
          <textarea
            id="orch-benchmark-prompt"
            rows={2}
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            disabled={busy || disabled || running}
            placeholder="Use one small coupled task and one modular task to get an honest picture."
          />
        </label>
        <div className="orch-actions orch-actions--end">
          {disabledReason && <span className="orch-note">{disabledReason}</span>}
          {running && (
            <button type="button" className="button button-ghost" onClick={onCancel}>
              Cancel benchmark
            </button>
          )}
          <button
            type="submit"
            className="button button-primary"
            disabled={busy || disabled || running || !prompt.trim()}
          >
            Run both arms
          </button>
        </div>
      </form>

      {presentation && record && (
        <>
          <h4>1. Quality and verification</h4>
          <p className="orch-quality-headline">{presentation.qualityHeadline}</p>

          <h4>2. Cost and tokens</h4>
          <p className="orch-cost-headline">{presentation.costHeadline}</p>

          <dl className="orch-facts">
            <Fact term="Snapshot">{presentation.snapshotLine}</Fact>
            <Fact term="Pricing">
              {record.comparison?.pricingStatus === "configured"
                ? "configured"
                : PRICING_NOT_CONFIGURED}
            </Fact>
            <Fact term="Token delta">
              {record.comparison?.totalTokenDelta === null ||
              record.comparison?.totalTokenDelta === undefined
                ? "not comparable"
                : formatTokens(record.comparison.totalTokenDelta) +
                  " (orchestrated minus direct)"}
            </Fact>
          </dl>

          <div className="orch-benchmark-arms">
            {presentation.arms.map((arm) => (
              <article className="orch-card" key={arm.arm}>
                <div className="orch-card-head">
                  <strong>{arm.label}</strong>
                  <StatusBadge presentation={arm.status} />
                </div>
                <p className="orch-note">{arm.qualityLine}</p>
                <div className="orch-meta">
                  <span>route {arm.route}</span>
                  <span>{formatDuration(arm.wallClockMs)}</span>
                  <span>{formatTokens(arm.usage.totalTokens)} tokens</span>
                  <span>{arm.usage.costLabel}</span>
                  <span>{arm.counters.modelCalls} model calls</span>
                  <span>{arm.counters.attempts} attempts</span>
                  <span>{arm.counters.contextExpansions} expansions</span>
                  <span>{arm.counters.escalations} escalations</span>
                  <span>{arm.counters.integrationFailures} integration failures</span>
                </div>
                {arm.verifications.length > 0 && (
                  <ul className="orch-list">
                    {arm.verifications.map((check, index) => (
                      <li key={index + check.commandOrCheck}>
                        [{check.status === "passed" ? "✓" : check.status === "failed" ? "✕" : "–"}]{" "}
                        {check.scope}: {check.commandOrCheck}
                      </li>
                    ))}
                  </ul>
                )}
                {arm.error && <p className="orch-note">{arm.error}</p>}
              </article>
            ))}
          </div>

          {presentation.warnings.length > 0 && (
            <>
              <h4>Comparability warnings</h4>
              <ul className="orch-warnings">
                {presentation.warnings.map((warning, index) => (
                  <li key={index}>{warning}</li>
                ))}
              </ul>
            </>
          )}

          {presentation.limitations.length > 0 && (
            <>
              <h4>Limitations</h4>
              <ul className="orch-limitations">
                {presentation.limitations.map((limitation, index) => (
                  <li key={index}>{limitation}</li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </section>
  );
}
