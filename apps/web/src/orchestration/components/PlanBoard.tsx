import type {
  ContextPacketSummary,
  FailurePacket,
  OrchestrationReadModel,
  PlanSummary,
  SharedArtifact,
  VerificationRecord,
  WorkerAttempt,
  WorkspaceDisposition,
} from "../contracts";
import { formatTokens, taskStatusPresentation } from "../view-model";
import { BulletList, Fact, StatusBadge } from "./StatusBadge";

/** Route decision plus an explicit Start action (specification 8.5). */
export function PlanBoard({
  plan,
  view,
  canStart,
  onStart,
  busy,
}: {
  plan: PlanSummary | null;
  view: OrchestrationReadModel;
  canStart: boolean;
  onStart: () => void;
  busy: boolean;
}) {
  const packetsByTask = new Map<string, ContextPacketSummary>();
  for (const packet of view.contextPackets) packetsByTask.set(packet.taskId, packet);

  return (
    <section className="orch-panel" aria-labelledby="orch-plan-heading">
      <header>
        <div>
          <span className="eyebrow">Route decision</span>
          <h3 id="orch-plan-heading">
            {plan ? routeLabel(plan.selectedMode) : "Planning has not produced a route yet"}
          </h3>
        </div>
        {canStart && (
          <button className="button button-primary" onClick={onStart} disabled={busy}>
            Start execution
          </button>
        )}
      </header>

      {plan?.routeReason && <p>{plan.routeReason}</p>}

      <dl className="orch-facts">
        <Fact term="Tasks">{view.tasks.length}</Fact>
        <Fact term="Application map">
          {plan?.applicationMap
            ? "v" +
              plan.applicationMap.version +
              " · " +
              plan.applicationMap.fileCount +
              " files"
            : "not recorded"}
        </Fact>
        <Fact term="Map hash">
          <span className="orch-code">
            {plan?.applicationMap?.repositoryHash.slice(0, 12) ?? "unknown"}
          </span>
        </Fact>
      </dl>

      {view.tasks.length === 0 ? (
        <p className="orch-note">No tasks have been planned yet.</p>
      ) : (
        <ul className="orch-plain-list">
          {view.tasks.map((task) => {
            const packet = packetsByTask.get(task.id);
            const contextBytes = packet
              ? packet.sourceFiles.reduce((total, file) => total + file.bytes, 0)
              : 0;
            return (
              <li className="orch-card" key={task.id}>
                <div className="orch-card-head">
                  <strong>{task.title || task.id}</strong>
                  <StatusBadge presentation={taskStatusPresentation(task.status)} />
                </div>
                <p className="orch-note">{task.objective}</p>
                <div className="orch-meta">
                  <span>attempt {task.attemptCount}</span>
                  <span>map v{task.applicationMapVersion}</span>
                  {task.dependsOn.length > 0 && (
                    <span>depends on {task.dependsOn.join(", ")}</span>
                  )}
                  {task.acceptanceCriterionIds.length > 0 && (
                    <span>criteria {task.acceptanceCriterionIds.join(", ")}</span>
                  )}
                  {packet && (
                    <span>
                      context {packet.sourceFiles.length} files ·{" "}
                      {formatTokens(contextBytes)} bytes · ~
                      {formatTokens(packet.estimatedTokens)} tokens
                    </span>
                  )}
                </div>
                {task.allowedPaths.length > 0 && (
                  <div className="orch-meta">
                    <span>
                      allowed paths:{" "}
                      {task.allowedPaths.map((item) => (
                        <span className="orch-code" key={item}>
                          {item}
                        </span>
                      ))}
                    </span>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function routeLabel(mode: PlanSummary["selectedMode"]): string {
  if (mode === "direct") return "Direct execution selected";
  if (mode === "one-worker") return "One focused worker selected";
  return "Multiple workers selected";
}

/** Artifacts, attempts, context packets, and temporary-state disposition. */
export function CoordinationEvidence({
  artifacts,
  attempts,
  contextPackets,
  workspaceDispositions = [],
}: {
  artifacts: SharedArtifact[];
  attempts: WorkerAttempt[];
  contextPackets: ContextPacketSummary[];
  workspaceDispositions?: WorkspaceDisposition[];
}) {
  return (
    <section className="orch-panel" aria-labelledby="orch-coordination-heading">
      <header>
        <div>
          <span className="eyebrow">Coordination</span>
          <h3 id="orch-coordination-heading">Shared artifacts and worker attempts</h3>
        </div>
      </header>

      <h4>Versioned artifacts</h4>
      {artifacts.length === 0 ? (
        <p className="orch-note">No shared artifact has been published yet.</p>
      ) : (
        <ul className="orch-plain-list">
          {artifacts.map((artifact) => (
            <li className="orch-card" key={artifact.id}>
              <div className="orch-card-head">
                <strong>{artifact.name}</strong>
                <span className="orch-code">
                  {artifact.kind} · v{artifact.version}
                </span>
              </div>
              <p className="orch-note">{artifact.payload}</p>
              <div className="orch-meta">
                <span>produced by task {artifact.producerTaskId}</span>
              </div>
            </li>
          ))}
        </ul>
      )}

      <h4>Worker attempts</h4>
      {attempts.length === 0 ? (
        <p className="orch-note">No worker attempt has been recorded yet.</p>
      ) : (
        <ul className="orch-plain-list">
          {attempts.map((attempt) => (
            <li className="orch-card" key={attempt.id}>
              <div className="orch-card-head">
                <strong>
                  Task {attempt.taskId} · attempt {attempt.number}
                </strong>
                <span className="orch-code">{attempt.status}</span>
              </div>
              <div className="orch-meta">
                <span>model {attempt.modelId}</span>
                <span>execution {attempt.executionId}</span>
                <span>
                  {formatTokens(attempt.usage.inputTokens)} in ·{" "}
                  {formatTokens(attempt.usage.outputTokens)} out
                </span>
                <span>{attempt.contextFileHashes.length} context file hashes</span>
              </div>
              {attempt.changedFiles.length > 0 && (
                <div className="orch-meta">
                  <span>
                    changed:{" "}
                    {attempt.changedFiles.map((file) => (
                      <span className="orch-code" key={file}>
                        {file}
                      </span>
                    ))}
                  </span>
                </div>
              )}
              {attempt.errorSummary && (
                <p className="orch-note">{attempt.errorSummary}</p>
              )}
            </li>
          ))}
        </ul>
      )}

      <h4>Context packets</h4>
      {contextPackets.length === 0 ? (
        <p className="orch-note">No context packet has been recorded yet.</p>
      ) : (
        <ul className="orch-plain-list">
          {contextPackets.map((packet) => (
            <li className="orch-card" key={packet.taskId + ":" + packet.contractVersion}>
              <div className="orch-card-head">
                <strong>Task {packet.taskId}</strong>
                <span className="orch-code">
                  map v{packet.applicationMapVersion} · contract v{packet.contractVersion}
                </span>
              </div>
              <div className="orch-meta">
                <span>{packet.sourceFiles.length} source files</span>
                <span>~{formatTokens(packet.estimatedTokens)} tokens</span>
              </div>
              <BulletList
                items={packet.sourceFiles.map(
                  (file) => file.path + " · " + file.sha256.slice(0, 10) + " · " + file.bytes + "B",
                )}
                empty="No source file was attached."
              />
            </li>
          ))}
        </ul>
      )}
      <p className="orch-note">
        File contents are never shown here. Only paths, hashes, and sizes are recorded, so
        the evidence stays bounded and no repository source is copied into the browser.
      </p>

      <h4>Temporary worker state</h4>
      {workspaceDispositions.length === 0 ? (
        <p className="orch-note">No cleanup or archive decision has been recorded yet.</p>
      ) : (
        <ul className="orch-plain-list">
          {workspaceDispositions.map((disposition, index) => (
            <li className="orch-card" key={index + ":" + (disposition.taskId ?? "all")}>
              <div className="orch-card-head">
                <strong>{disposition.taskId ? "Task " + disposition.taskId : "Orchestration"}</strong>
                <span className="orch-code">{disposition.policy}</span>
              </div>
              <p className="orch-note">{disposition.reason}</p>
              {disposition.location && (
                <div className="orch-meta">
                  <span className="orch-code">{disposition.location}</span>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Verification records, separated by authority. */
export function VerificationPanel({ records }: { records: VerificationRecord[] }) {
  const groups: Array<{ scope: VerificationRecord["scope"]; title: string; note: string }> = [
    {
      scope: "worker-visible",
      title: "Worker-visible checks",
      note: "These help a worker iterate. They do not decide project success.",
    },
    {
      scope: "protected",
      title: "Protected checks",
      note: "Run outside worker authority. Workers can read the criterion, never the implementation.",
    },
    { scope: "global", title: "Global checks", note: "Run on the combined candidate before publishing." },
    { scope: "manual", title: "Manual criteria", note: "Recorded explicitly instead of faking an automated oracle." },
  ];

  return (
    <section className="orch-panel" aria-labelledby="orch-verification-heading">
      <header>
        <div>
          <span className="eyebrow">Verification</span>
          <h3 id="orch-verification-heading">A worker's claim is not proof</h3>
        </div>
      </header>
      {groups.map((group) => {
        const scoped = records.filter((item) => item.scope === group.scope);
        return (
          <div key={group.scope}>
            <h4>{group.title}</h4>
            <p className="orch-note">{group.note}</p>
            {scoped.length === 0 ? (
              <p className="orch-note">Nothing recorded.</p>
            ) : (
              <ul className="orch-plain-list">
                {scoped.map((item) => (
                  <li className="orch-card" key={item.id}>
                    <div className="orch-card-head">
                      <strong className="orch-code">{item.commandOrCheck}</strong>
                      <StatusBadge
                        presentation={{
                          label: item.status,
                          icon:
                            item.status === "passed"
                              ? "✓"
                              : item.status === "failed"
                                ? "✕"
                                : "–",
                          tone:
                            item.status === "passed"
                              ? "success"
                              : item.status === "failed"
                                ? "danger"
                                : "pending",
                        }}
                      />
                    </div>
                    <p className="orch-note">{item.outputSummary}</p>
                    {item.taskId && (
                      <div className="orch-meta">
                        <span>task {item.taskId}</span>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      })}
    </section>
  );
}

/** Compact failure packets, never full transcripts. */
export function FailurePanel({ packets }: { packets: FailurePacket[] }) {
  if (packets.length === 0) return null;
  return (
    <section className="orch-panel" aria-labelledby="orch-failure-heading">
      <header>
        <div>
          <span className="eyebrow">Failure evidence</span>
          <h3 id="orch-failure-heading">Compressed failure packets</h3>
        </div>
      </header>
      <ul className="orch-plain-list">
        {packets.map((packet) => (
          <li className="orch-card" key={packet.taskId + ":" + packet.attemptCount}>
            <div className="orch-card-head">
              <strong>Task {packet.taskId}</strong>
              <span className="orch-code">
                {packet.attemptCount} attempts · contract v{packet.contractVersion}
              </span>
            </div>
            <p className="orch-note">{packet.lastError}</p>
            <h4>Failing checks</h4>
            <BulletList items={packet.failingChecks} />
            <h4>Diagnosis</h4>
            <p className="orch-note">{packet.workerDiagnosis || "No diagnosis recorded."}</p>
            <div className="orch-meta">
              <span>{packet.changedFiles.length} changed files</span>
              <span>
                {formatTokens(packet.usage.inputTokens)} in ·{" "}
                {formatTokens(packet.usage.outputTokens)} out
              </span>
            </div>
            <p className="orch-note">{packet.diffSummary}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}
