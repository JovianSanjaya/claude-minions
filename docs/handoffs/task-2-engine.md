# Task 2 handoff: context-aware execution engine

## Source

- Baseline commit: `8d0bd4f14ad1e453d984149aebcdd0bcb4f74178`
- Branch: `codex/task-2-engine`
- Task commit: not created by the coding agent

## Files changed

- Added the Appendix A-exact `apps/server/src/orchestration/contracts.ts`.
- Added all Task 2 engine modules and task-local tests under
  `apps/server/src/orchestration/engine/`.
- Extended `apps/server/src/types.ts`, `agent-service.ts`, `codex-runner.ts`, and
  `container-codex-runner.ts` backward-compatibly, with corresponding baseline
  test updates.
- Added this handoff. No composition-root, HTTP, React, README, environment
  example, or Task 1/3 file was edited.

## Public integration exports

- `ContextAwareExecutionDriver` and `ExecutionEngineOptions` from
  `orchestration/engine/driver.ts`; the class implements the frozen
  `OrchestrationExecutionDriver` port.
- `AgentExecutionCoordinator` from `types.ts`; `AgentService` accepts this as an
  optional fifth constructor argument.
- `RunnerRequest` now requires `executionId` and accepts trusted orchestration,
  task, role, model, Runtime-home, and restricted sandbox metadata.
- `AgentRunner.cancel(executionId)` now targets the exact execution. Both local
  and container runners support concurrent executions belonging to one Agent.
- `TrustedVerificationCheck` and `VerificationExecutor` from
  `orchestration/engine/verification.ts` for composition-time protected/global
  evaluator configuration.
- `RoleModels` from `orchestration/engine/role-executor.ts` for trusted logical
  role-to-model allocation.

## Implemented behavior

- Planner-only intent elaboration and post-confirmation planning with Zod
  structured output and one bounded repair call.
- Adaptive direct, one-worker, and multi-worker routing with explicit reasons
  and safe refusal when forced delegation cannot fit the hard call budget.
- Deterministic, versioned application maps with secret/build/Runtime/protected
  exclusions, file hashes, imports/exports, package boundaries, and bounded
  module summaries.
- Minimum-sufficient context packets, evidence-only packet summaries, and
  bounded traversal/symlink/protected-path-safe expansion.
- Per-role Runtime homes, truthful model fallback (model override is disabled by
  default), stable execution correlation, sink reservations, usage commits,
  and redacted evidence.
- Task-specific snapshots containing allocated context instead of the entire
  repository, read-only worker preflight, planner approval, allowed-path
  manifests, bounded retries/steps/wall time/cancellation, and cleanup/archive
  evidence.
- Versioned artifacts with v1-to-v2 targeted stale detection and focused task
  refresh without transcript sharing.
- Compact failure packets, deterministic classification, planner escalation,
  and material `needs-user` amendments.
- Deterministic non-conflicting reconciliation, focused model conflict packets,
  main-workspace drift checks, protected/global verification outside worker
  authority, rollback-capable best-effort publication, and no publication on a
  failed or missing trusted global evaluator.
- Direct execution uses the same isolated candidate, budget, evidence,
  verification, drift, and publication path.
- Existing direct Playground concurrency, persistence, thread continuation,
  cancellation, and Agent lifecycle behavior remain covered.

## Checks run

- `npm ci` — passed.
- `npm run typecheck -w @launchpad/server` — passed.
- `npm test -w @launchpad/server` — passed: 12 files, 26 tests.
- `npm run typecheck` — passed for server and web.
- `git diff --check` — passed.
- Appendix A extraction diff against the supplied specification — exact.
- `npm run check` — passed after the final handoff audit.

Repository tests use only temporary workspaces, fake `AgentRunner` outputs,
in-memory `OrchestrationSink` instances, and injected deterministic verification
executors. They do not require Ark, a network, Docker, or a globally installed
Codex CLI. The local-runner concurrency test uses a temporary executable fixture.

## Configuration

No environment variables were added in this task. `ExecutionEngineOptions`
requires Final Assembly to provide trusted role model IDs, the configured base
model, Runtime-home/temp/archive/protected roots, and trusted evaluator checks.
Pricing remains owned by Task 1's sink/ledger. Missing model-override capability
truthfully falls back to `baseModelId`; Final Assembly should enable overrides
only after confirming the installed Codex CLI supports `--model`.

## Final Assembly steps

1. Instantiate `ContextAwareExecutionDriver` with the production `AgentRunner`,
   validated role/model settings, trusted roots, and argv-only evaluator checks.
2. Pass that driver to Task 1's control service and pass Task 1's coordinator
   adapter as the optional fifth `AgentService` constructor argument.
3. Ensure the protected evaluator root is mode 0700 and outside Agent,
   orchestration-temp, and Runtime mount roots. Do not expose check commands or
   protected source in browser DTOs.
4. Keep model override disabled unless capability is known. The base Ark model
   remains the honest fallback for every logical role.
5. Register Task 1/3 plugins and lifecycle composition only in `app.ts`/`index.ts`
   during Final Assembly; this branch intentionally does not touch them.
6. Supply at least one trusted global check. Publication is intentionally blocked
   when no global check is configured. Supply protected checks for every
   `protected-test` criterion.

## Known limitations

- This task is not mounted in the application until Final Assembly.
- Multi-worker tasks execute in dependency order; isolation and attribution are
  complete, but independent workers are not launched concurrently in this POC.
- Application-map semantic summaries are bounded deterministic module summaries;
  no extra model call is spent generating prose summaries.
- Isolated workers receive allocated files and project metadata. A project whose
  visible test command requires wider source must obtain a recorded narrow
  expansion or use a trusted task-local check configuration.
- Filesystem publication is rollback-capable best effort on a single host, not a
  transactional distributed filesystem operation.
- Protected tests improve evaluator integrity but are not proof of correctness or
  a hardened multi-tenant sandbox.

## Deviations

- No deviation from Appendix A; the frozen contract is byte-for-byte identical
  apart from line-ending allowance.
- No required Task 2 capability was replaced by a production mock. The execution
  driver requires real runner and evaluator ports at composition time.
