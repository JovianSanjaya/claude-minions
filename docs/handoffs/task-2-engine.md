# Task 2 handoff - Context-aware, model-aware execution engine

## Base commit and branch

Single shared checkout, no branch. Task 2 was implemented in place in
`/root/work/codejam` alongside Task 1 and Task 3, staying inside the file
ownership boundaries of section 4.2 of the specification.

`apps/server/src/orchestration/contracts.ts` (Appendix A) was already present
and was **not modified**. The engine imports types from it only.

---

## Files changed

### New files (Task 2 owned)

| File | Purpose |
| --- | --- |
| `apps/server/src/orchestration/engine/driver.ts` | `OrchestrationEngineDriver implements OrchestrationExecutionDriver` - the central deliverable |
| `apps/server/src/orchestration/engine/role-executor.ts` | One budgeted, cancellable, evidence-emitting call per logical role |
| `apps/server/src/orchestration/engine/structured-output.ts` | Zod parsing of model output plus one bounded repair |
| `apps/server/src/orchestration/engine/router.ts` | Adaptive direct / one-worker / multi-worker routing |
| `apps/server/src/orchestration/engine/application-map.ts` | Deterministic versioned repository map with exclusions |
| `apps/server/src/orchestration/engine/context-broker.ts` | Minimum-sufficient context packets and narrow expansion |
| `apps/server/src/orchestration/engine/worker-workspaces.ts` | Isolated per-task snapshots, manifests, safe cleanup |
| `apps/server/src/orchestration/engine/preflight.ts` | Typed read-only preflight and deterministic planner review |
| `apps/server/src/orchestration/engine/worker-loop.ts` | Bounded preflight/write/check/retry loop and `BudgetTracker` |
| `apps/server/src/orchestration/engine/artifact-registry.ts` | Versioned shared artifacts and dependency-drift detection |
| `apps/server/src/orchestration/engine/verification.ts` | Trusted worker-visible / protected / global / manual verification |
| `apps/server/src/orchestration/engine/integrator.ts` | Deterministic-first merge, drift detection, publish with rollback |
| `apps/server/src/orchestration/engine/failure-packet.ts` | Compact failure packets and deterministic classification |
| `apps/server/src/orchestration/engine/*.test.ts` | 11 task-local test files (see "Checks run") |
| `docs/handoffs/task-2-engine.md` | This file |

### Baseline files edited (the section 4.2 / 7.3 exception)

| File | Change |
| --- | --- |
| `apps/server/src/types.ts` | Added `executionId` (required), optional `orchestrationId` / `taskId` / `role` / `modelId` / `runtimeHomePath` / `sandboxMode` to `RunnerRequest`; `AgentRunner.cancel` now takes an `executionId`; added `ExecutionSandboxMode`, `ExecutionRole`, `AgentExecutionCoordinator`, `noopAgentExecutionCoordinator` |
| `apps/server/src/agent-service.ts` | Optional 5th constructor parameter `coordinator` (defaults to no-op); direct Runs pass `executionId: run.id`; cancellation targets that exact execution; `stopAgent` / `deleteAgent` call `coordinator.cancelForAgent`; `sendMessage` calls `coordinator.assertAgentAvailableForDirect` |
| `apps/server/src/config.ts` | Added the whole optional `config.orchestration` block (model roles, pricing, roots, cleanup policy, budget defaults) and `defaultBudgetPolicy()` |
| `apps/server/src/codex-runner.ts` | Active-process map keyed by `executionId`; added `resolveSandboxMode()`; `--model` argv only when a trusted `modelId` is supplied; per-role `CODEX_HOME` via `runtimeHomePath`; added `supportsModelOverride()` |
| `apps/server/src/container-codex-runner.ts` | Active-container map keyed by `executionId`; container name contains the sanitized execution ID; orchestration / task / role labels; per-role Runtime home mount; sandbox narrowing; added `supportsModelOverride()` |
| `apps/server/src/codex-runner.test.ts` | Updated for the new `RunnerRequest` field; added model-override, sandbox-narrowing and execution-ID concurrency/cancellation tests |
| `apps/server/src/container-codex-runner.test.ts` | Updated for the new field; added per-role Runtime home and correlation-label tests |
| `apps/server/src/agent-service.test.ts` | Added `AgentExecutionCoordinator` port tests and direct-path `executionId` assertions |

`apps/server/src/runner-factory.ts` needed **no change** - both runners still
satisfy the extended `AgentRunner` interface.

Not touched: `app.ts`, `index.ts`, `store.ts`, `workspace.ts`, `errors.ts`,
anything under `orchestration/control/` or `orchestration/benchmark/`, and
anything under `apps/web/`.

---

## Public exports and constructors

### The driver (what Final Assembly instantiates)

```ts
import { OrchestrationEngineDriver } from "./orchestration/engine/driver.js";

new OrchestrationEngineDriver({
  runner,                        // AgentRunner - the existing createRunner(config) instance
  tempRoot,                      // config.orchestration.tempRoot
  archiveRoot,                   // config.orchestration.archiveRoot
  runtimeHomeRoot,               // config.orchestration.runtimeHomeRoot
  protectedEvaluatorRoot,        // config.orchestration.protectedEvaluatorRoot
  models,                        // config.orchestration.models (ModelRoleConfig)
  checkCatalog,                  // optional Record<criterionId, TrustedCheckDefinition>
  pricing,                       // optional config.orchestration.pricing
  cleanupPolicy,                 // optional "cleanup" | "archive" | "retain" (default "archive")
  commandExecutor,               // optional CommandExecutor (default ProcessCommandExecutor)
  modelCapabilityProbe,          // optional (default: probes the runner)
  clock,                         // optional () => Date
  idFactory,                     // optional () => string
});
```

It implements the frozen `OrchestrationExecutionDriver`:
`elaborateIntent(input, sink, signal)`, `plan(input, sink, signal)`,
`execute(input, sink, signal)`, `cancel(orchestrationId)`.

Also exported from `driver.ts`: `OrchestrationPlanError` (thrown when planning
fails or no route fits the hard budget - Task 1 should map it to a `failed`
orchestration, not an HTTP 500), `topologicalOrder`, and the
`OrchestrationEngineOptions` type.

### The `AgentExecutionCoordinator` port (what Task 1 must implement)

Declared in `apps/server/src/types.ts`:

```ts
export interface AgentExecutionCoordinator {
  assertAgentAvailableForDirect(agentId: string): Promise<void>; // throw HttpError(409) to refuse
  hasActiveOrchestration(agentId: string): Promise<boolean>;
  cancelForAgent(agentId: string): Promise<void>;
}

export const noopAgentExecutionCoordinator: AgentExecutionCoordinator;
```

Wired into `AgentService` as an optional fifth constructor argument:

```ts
new AgentService(config, store, workspaces, runner /*, coordinator? */);
```

- `assertAgentAvailableForDirect` is called at the top of `sendMessage`, before
  any Run or Message is persisted. Throwing `HttpError(409, ...)` cleanly
  refuses the direct Run and leaves Agent state untouched.
- `cancelForAgent` is called at the start of `stopAgent` and `deleteAgent`,
  before the workspace is archived.
- Omitting the argument keeps the exact previous behavior.

### Other exports Final Assembly or Task 3 may want

- `role-executor.ts`: `RoleExecutor`, `ModelRoleConfig`, `ModelCapabilityProbe`,
  `runnerCapabilityProbe(runner)`, `emptyUsage`, `addUsage`, `toTokenUsage`.
- `verification.ts`: `VerificationService`, `TrustedCheckDefinition`,
  `CommandExecutor`, `ProcessCommandExecutor`, `workerVisibleChecks`,
  `globalChecks`.
- `worker-workspaces.ts`: `WorkerWorkspaceManager`, `hashDirectory`,
  `manifestHash`, `diffManifests`, `copyWorkspace` (useful for Task 3's
  same-snapshot benchmark cloning).
- `application-map.ts`: `buildApplicationMap`, `toApplicationMapSummary`,
  `renderMapForModel`, `isWithin`.
- `router.ts`: `decideRoute`, `RouteSignals`.
- `integrator.ts`: `planDeterministicMerge`, `applyMergePlan`,
  `detectMainWorkspaceDrift`, `publishToMainWorkspace`.
- `config.ts`: `defaultBudgetPolicy(config)`, `ModelPricingTable`.

---

## Checks run and results

From `/root/work/codejam`:

```
npx tsc -p apps/server/tsconfig.json --noEmit        # clean, exit 0
```

From `/root/work/codejam/apps/server`:

```
npx vitest run src/                                  # 26 files, 231 tests, all passing
```

That run includes the pre-existing baseline suites (`agent-service.test.ts`,
`codex-runner.test.ts`, `container-codex-runner.test.ts`, `store.test.ts`,
`app.test.ts`) and Task 1 / Task 3 suites present in the shared checkout.

Task 2's own scope (engine tests plus the three baseline suites it edited) is
**15 files / 124 tests passing**.

`npm run check` at the repository root was deliberately **not** run - per the
brief that belongs to Final Assembly, since it also builds `apps/web`.

### What the engine tests cover

- `driver.test.ts` - the two section 7.17 acceptance tests plus budget-stop,
  cancellation, direct route and user-workspace drift.
- `role-executor.test.ts` - role/model selection, truthful fallback, reserve
  before call, commit actual usage, budget denial without a Runtime call,
  cancellation, one bounded repair, explicit failure after repair, evidence
  contains no prompt or response body.
- `router.test.ts` - tiny / coupled / modular routing, budget degradation,
  forced delegation, non-decomposable refusal.
- `application-map.test.ts` - exclusions, protected-root exclusion, symlink
  escape, determinism, versioning, changed files, dependency edges.
- `context-broker.test.ts` - allowed-path globbing, packet minimization, hashes
  instead of source, criterion filtering, expansion allow/deny for traversal,
  symlink escape, credential and protected paths, budget exhaustion.
- `worker-workspaces.test.ts` - snapshot isolation, changed-file attribution,
  scope violations, symlink exclusion, archive/cleanup/retain, and refusal to
  clean `/`, the temp root, the orchestration root, or the Agent workspace.
- `preflight.test.ts` - schema bounds and every planner review decision.
- `verification.test.ts` - mode-0700/0600 protected storage, worker-visible
  checks never installed as protected, protected argv and output never leaked,
  output truncation, manual and uncovered criteria recorded explicitly,
  argv-only execution with no shell interpretation.
- `artifact-registry.test.ts` - versioning, payload bounds, v1 to v2 drift with
  one affected and two unaffected tasks.
- `failure-packet.test.ts` - compression bounds and all eight classifications.
- `integrator.test.ts` - non-conflicting merge, conflict only on differing
  content, conflict context limited to conflicting files, staging escape
  refusal, drift detection, publish, and rollback leaving the workspace intact.
- `structured-output.test.ts` - fenced/bare JSON, braces inside strings,
  explicit failure instead of invention.
- `codex-runner.test.ts` - concurrent executions for one Agent, duplicate
  execution ID refused, exact cancellation of one of two live executions.

All tests use fakes: an in-memory `OrchestrationSink`, a scripted
`AgentRunner`, a fixture `CommandExecutor`, and temporary directories. Nothing
requires Ark, network, Docker, or a globally installed Codex CLI. The runner
concurrency tests spawn a tiny local shell script that emits Codex-shaped JSON
lines.

---

## Configuration added

All fields are optional with safe defaults, and all live under
`config.orchestration`. Final Assembly may centralize or rename them; nothing
outside `config.ts` reads `process.env` directly.

| Environment variable | Default | Meaning |
| --- | --- | --- |
| `ORCHESTRATION_PLANNER_MODEL` | unset | Trusted model ID for the planner role |
| `ORCHESTRATION_WORKER_MODEL` | unset | Trusted model ID for the worker role |
| `ORCHESTRATION_VERIFIER_MODEL` | unset | Trusted model ID for the verifier role |
| `ORCHESTRATION_INTEGRATOR_MODEL` | unset | Trusted model ID for the integrator role |
| `ORCHESTRATION_MODEL_PRICING` | unset | JSON `{"<modelId>":{"input":n,"cachedInput":n,"output":n}}`, USD per million tokens |
| `ORCHESTRATION_TEMP_ROOT` | `<dataDir>/orchestration/temp` | Worker snapshot root |
| `ORCHESTRATION_ARCHIVE_ROOT` | `<dataDir>/orchestration/archive` | Archived snapshots |
| `ORCHESTRATION_RUNTIME_HOME_ROOT` | `<dataDir>/orchestration/runtime-homes` | Per-role Codex state directories |
| `PROTECTED_EVALUATOR_ROOT` | `<dataDir>/protected-evaluators` | Mode-0700 protected check storage |
| `ORCHESTRATION_CLEANUP_POLICY` | `archive` | `cleanup` / `archive` / `retain` |
| `ORCHESTRATION_MAX_INPUT_TOKENS` | unset (null) | Hard input-token budget |
| `ORCHESTRATION_MAX_OUTPUT_TOKENS` | unset (null) | Hard output-token budget |
| `ORCHESTRATION_MAX_ESTIMATED_USD` | unset (null) | Hard estimated-dollar budget |
| `ORCHESTRATION_MAX_MODEL_CALLS` | 40 | Hard model-call budget |
| `ORCHESTRATION_MAX_STEPS` | 80 | Hard step budget |
| `ORCHESTRATION_MAX_WORKER_ATTEMPTS` | 3 | Attempts per task |
| `ORCHESTRATION_MAX_CONTEXT_EXPANSIONS` | 2 | Expansions per task |
| `ORCHESTRATION_MAX_WALL_CLOCK_MS` | 900000 | Wall-clock budget |

`defaultBudgetPolicy(config)` returns exactly a frozen-contract `BudgetPolicy`,
so Task 1 can use it as the server-side default when creating an orchestration.

The **check catalog** is deliberately *not* environment configuration. It is a
typed `Record<contractCriterionId, TrustedCheckDefinition>` passed to the driver
constructor, where each definition is an argv pair (`command` + `args[]`) and a
scope. This keeps browser input from ever choosing a command string. Final
Assembly should supply a small catalog for the demo workspace, for example a
`worker-visible` `npm test` entry and a `protected` acceptance script kept under
`PROTECTED_EVALUATOR_ROOT`.

---

## Fake and test adapters used

Test-only, defined inside `*.test.ts` files, never importable from `src`
production paths:

- `FakeSink` / `RecordingSink` - in-memory `OrchestrationSink` that records
  reservations, commits, events, tasks, maps, packets, attempts, artifacts and
  verifications, with a `denyAfter` switch to simulate budget denial.
- `ScriptedCodexRunner` / `ScriptedRunner` - `AgentRunner` doubles that dispatch
  on `request.role`, `request.taskId` and `request.sandboxMode`, really write
  files into the snapshot they were handed, and report
  `supportsModelOverride() === false` (matching a sandbox with no Codex CLI).
- `FixtureCommandExecutor` / `ScriptedExecutor` - `CommandExecutor` doubles that
  inspect the candidate workspace instead of spawning a real toolchain.
- A generated `fake-codex.sh` for the real-process runner tests.

---

## Known limitations and deliberate narrowing

Documented rather than faked, per section 5:

1. **Planner review of preflight is deterministic, not a model call.** Scope,
   dependency, check-allowlist and expansion-budget rules are enforced in code
   (`reviewPreflight`). This makes the "no worker edit before approval"
   invariant enforceable rather than persuadable, but it means the planner does
   not currently give free-form feedback on a preflight plan.
2. **Failure classification is a deterministic classifier, not a planner call.**
   `classifyFailure` runs even when the budget is gone. A planner-model second
   opinion on a failure packet is not wired in; the packet is built and
   escalated, and execution stops with the classification in evidence.
3. **Escalation stops the orchestration; it does not auto-replan.** A failed
   task produces a compact packet, a classification and a `failed` (or
   `needs-user`, for `material-amendment`) outcome. Automatic focused replanning
   and "retry with a stronger model" are recorded as recommended actions but not
   executed. Recovery goes back through the user, which is the safer POC
   behavior.
4. **Model-override support is probed, not assumed.** Neither runner passes a
   `--model` argument unless the installed Runtime advertises `--model`. In this
   environment it does not, so every role truthfully reports
   `modelFallback: true` with the reason, and the estimate assumptions say so.
   No multi-model cost saving is fabricated. Per-role *model* separation is
   therefore currently only real if a model-flag-capable Codex build is
   installed; per-role *state* separation (separate `CODEX_HOME` per role) is
   real today.
5. **Tasks run sequentially.** Workspaces, executions and the runner map are all
   isolated per execution ID and support concurrency, but `execute` iterates
   tasks in topological order for deterministic evidence ordering. Making
   independent tasks concurrent is a small change in `driver.execute`.
6. **Dependency refresh re-runs an affected task once per drift event.** There
   is no iterative refresh-until-stable loop; a second drift on the same task
   would re-run it again, bounded by the model-call and wall-clock budgets.
7. **Engine-local budget enforcement is a second gate, not the ledger.** The
   control plane's `reserveModelCall` stays authoritative. `BudgetTracker`
   additionally enforces wall-clock, steps and expansions, which the sink
   cannot see, and computes estimated dollars only when pricing is configured.
8. **`.gitignore`-style ignore files are not consulted** by the application map;
   the exclusion list is a fixed, auditable set (`EXCLUDED_DIRECTORIES`,
   `EXCLUDED_FILE_PATTERNS`).
9. **Import extraction is regex-based**, not a TypeScript AST parse. It is used
   only for dependency-hop context selection, never as a correctness oracle.
10. **Redaction is Task 1's responsibility.** The engine keeps evidence small and
    structured (no prompts, no raw model bodies, no protected argv or output,
    no file contents), but it does not itself scan strings for secret patterns.
11. **`ContextPacketSummary.estimatedTokens` is a `length / 4` heuristic,** not a
    tokenizer count.

---

## Integration steps for Final Assembly

1. **Instantiate the driver in `index.ts`:**

   ```ts
   const engine = new OrchestrationEngineDriver({
     runner,                                                   // existing createRunner(config)
     tempRoot: config.orchestration.tempRoot,
     archiveRoot: config.orchestration.archiveRoot,
     runtimeHomeRoot: config.orchestration.runtimeHomeRoot,
     protectedEvaluatorRoot: config.orchestration.protectedEvaluatorRoot,
     models: config.orchestration.models,
     pricing: config.orchestration.pricing,
     cleanupPolicy: config.orchestration.cleanupPolicy,
     checkCatalog: DEMO_CHECK_CATALOG,                         // trusted argv definitions
   });
   ```

   Pass it as Task 1's `OrchestrationExecutionDriver`. Task 1's
   `ControlPlaneSink` extends the frozen `OrchestrationSink` additively, so the
   engine (which is typed against the frozen interface) accepts it unchanged.
   If you want the engine to use the extra methods later, the natural mapping
   is: `reserveWorkerAttempt` at the top of `WorkerLoop`'s attempt loop,
   `requestContextExpansion` alongside `ContextBroker.evaluateExpansion`,
   `markIntegrating` / `markVerifying` around the integration and global
   verification blocks in `driver.execute`, and `recordWorkspaceDisposition` in
   `cleanupWorkspaces`. All four are currently covered by engine-emitted events
   (`task.*`, `context.expansion-*`, `integration.*`, `verification.*`,
   `worker.workspace-*`), so nothing is missing without them.

2. **Connect the coordinator:** build Task 1's exported coordinator adapter and
   pass it as the fifth argument to `AgentService`:

   ```ts
   const service = new AgentService(config, store, workspaces, runner, controlCoordinator);
   ```

   That is what makes "a direct Run and an active orchestration cannot write the
   same workspace" and "deleting or stopping an Agent cancels its orchestration"
   true end to end.

3. **Create the roots before listening** (or rely on the engine's lazy
   `mkdir`): temp, archive, runtime-home and protected-evaluator roots. The
   protected root must stay outside every Agent workspace - the engine records
   `isolatedFromWorkspace` in evidence but will not relocate it for you.

4. **Provide a check catalog** keyed by the contract criterion IDs Task 1's
   confirmation step emits. Without a catalog entry a criterion is recorded as
   an explicit `skipped` verification ("no trusted automated check is
   configured") rather than silently counting as a pass.

5. **Map `OrchestrationPlanError`** to a `failed` orchestration with the error
   message as the reason (it carries the route or planning failure text), not to
   an HTTP 500.

6. **Restart reconciliation:** the engine holds no durable state. On restart,
   Task 1 marks interrupted orchestrations cancelled; leftover directories under
   the temp root can be swept with
   `new WorkerWorkspaceManager(tempRoot, archiveRoot).cleanup(dir, policy)`,
   which refuses any target that is not a task-specific directory.

7. **For Task 3's benchmark**, `copyWorkspace(source, destination)` and
   `hashDirectory(path)` give same-snapshot cloning and a comparable snapshot
   hash for both arms.

---

## Deviations from Appendix A and the required capabilities

- **No deviation from Appendix A.** `contracts.ts` is untouched; the driver
  implements `OrchestrationExecutionDriver` exactly, and every persisted shape
  (`OrchestrationTask`, `ApplicationMapSummary`, `ContextPacketSummary`,
  `SharedArtifact`, `WorkerAttempt`, `FailurePacket`, `VerificationRecord`,
  `OrchestrationEvent`) is produced verbatim.
- **One backward-compatibility note on the frozen baseline types:**
  `RunnerRequest.executionId` is *required*, as section 7.3 specifies. Any code
  constructing a `RunnerRequest` must supply it; the direct Playground path
  passes the Run ID. `AgentRunner.cancel` now means "cancel this execution",
  not "cancel this Agent" - `AgentService` tracks the active execution ID per
  Agent and still enforces one direct Run per Agent at its own level.
- **Capability narrowing** is listed under "Known limitations" above; the
  affected items are planner-reviewed preflight (deterministic), planner
  diagnosis of failure packets (deterministic), automatic recovery actions
  (recorded, not executed), and real per-role *models* (blocked by the installed
  Codex CLI, truthfully reported as a fallback rather than faked).
