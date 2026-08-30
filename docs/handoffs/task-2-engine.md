# Task 2 handoff — context-aware, model-aware execution engine

## Final Assembly status: DONE (this session)

`apps/server/src/orchestration/composition.ts` builds the real
`EngineConfig` (per-role model IDs and pricing from new optional
`config.ts` env vars — `PLANNER_MODEL_ID`/`WORKER_MODEL_ID`/
`VERIFIER_MODEL_ID`/`INTEGRATOR_MODEL_ID`, `ARK_*_PRICE_PER_TOKEN`,
`ORCHESTRATION_SCRATCH_ROOT`, `GLOBAL_CHECK_COMMAND`) and calls
`createEngineDriver(engineConfig)`. No protected-evaluator storage or
default protected checks were wired (still a documented limitation — only
one optional example `globalChecks` entry exists, from
`GLOBAL_CHECK_COMMAND`). A real boot smoke test confirmed the driver's
`elaborateIntent` prompt construction, application-map scan, and read-only
sandbox request all execute for real against a live-composed server; it
only failed to reach ModelArk because the local shell's Codex CLI install
is broken, not due to anything in this module.

## Base commit / branch

Built on top of the upgraded Task 1 control plane in this same session (see
`docs/handoffs/task-1-control-plane.md` v2), branch `task1-julian`.

## What this is

The real `OrchestrationExecutionDriver` behind Task 1's frozen port:
`apps/server/src/orchestration/engine/driver.ts` composes a router,
deterministic application map, context broker, isolated worker workspaces,
read-only preflight, a bounded worker loop, an artifact registry,
worker-visible/protected/global verification, and deterministic-first
integration. It never bypasses Task 1's grounding/confirmation authority:
`plan()`/`execute()` both take an already-confirmed `ExecutionContract` as a
required argument (enforced at the type level, not just by convention), and
a worker that discovers a material conflict with the confirmed contract
returns structured evidence that becomes `{kind: "needs-user", amendment}` —
it never silently reinterprets or weakens the contract to force a pass.

## Files added

```
apps/server/src/orchestration/engine/structured-output.ts   Zod parse + one bounded repair
apps/server/src/orchestration/engine/role-executor.ts         budget-reserved AgentRunner calls, per role
apps/server/src/orchestration/engine/application-map.ts        deterministic repo scan (real fs, no model)
apps/server/src/orchestration/engine/router.ts                  deterministic adaptive routing
apps/server/src/orchestration/engine/context-broker.ts            minimum-sufficient context packets + expansion
apps/server/src/orchestration/engine/worker-workspaces.ts          isolated snapshot workspaces, manifests, diff
apps/server/src/orchestration/engine/preflight.ts                   read-only plan + scope-based approval
apps/server/src/orchestration/engine/worker-loop.ts                   bounded attempt loop tying the above together
apps/server/src/orchestration/engine/artifact-registry.ts              versioning + dependency-drift detection
apps/server/src/orchestration/engine/verification.ts                    worker-visible / protected / global checks
apps/server/src/orchestration/engine/failure-packet.ts                   compression + deterministic classification
apps/server/src/orchestration/engine/integrator.ts                        deterministic-first merge + publish
apps/server/src/orchestration/engine/driver.ts                             composes everything into the driver
apps/server/src/orchestration/engine/test-doubles.ts                        shared in-memory sink + fake runner (test-only)
apps/server/src/orchestration/engine/*.test.ts                              13 test files
docs/handoffs/task-2-engine.md                                              this file
```

Also touched (explicitly permitted — "Task 2 alone may edit baseline
Runtime files such as types.ts ... runner implementations ... and their
tests"):

```
apps/server/src/types.ts               RunnerRequest gained executionId, sandboxMode (both optional)
apps/server/src/codex-runner.ts        keys active-process map by executionId ?? agentId; effectiveSandboxMode()
apps/server/src/container-codex-runner.ts   same keying change; containerName() takes an executionId suffix
```

## Why the runner needed extending (architecture decision, not scope creep)

`CodexRunner.run()` rejects a second concurrent call for the same
`agentId` (`this.active.has(request.agentId)` throws). Multi-worker
execution calls the runner concurrently for the *same* Agent from separate
isolated workspaces — without a distinguishing key, that would collide
against the real runner (it would work fine against the fakes used in every
test here, silently hiding the bug). The fix is minimal and strictly
additive:

- `RunnerRequest.executionId?: string` — runners key their active-process
  bookkeeping by `executionId ?? agentId`, so direct Playground execution
  (which never sets it) is byte-for-byte unchanged.
- `RunnerRequest.sandboxMode?: "read-only" | "workspace-write"` — lets a
  call (e.g. a worker preflight) request a **more restrictive** sandbox
  than the server's configured default; `effectiveSandboxMode()` in
  `codex-runner.ts` can only tighten, never escalate past
  `CODEX_SANDBOX_MODE`. This is what makes "read-only worker preflight" a
  real constraint on the real runner, not just a naming convention.
- `AgentRunner.cancel(agentId, executionId?)` — with `executionId`, cancels
  only that execution; without it, cancels every active execution for the
  Agent (the original single-run behavior, unchanged for existing callers).
- `containerName()` gained an optional execution-id suffix, and
  `buildContainerRunArgs` adds an `io.codejam.execution-id` label when
  present, for container-name/log correlation per the original spec
  ("Container names must contain a sanitized execution ID").

None of baseline `AgentService`, `app.ts`, or their tests were touched —
`sendMessage`'s direct-execution call site doesn't pass `executionId`/
`sandboxMode`, so it hits exactly the old code path.

## Design decisions worth flagging

1. **No structured "list of edits" convention for writable execution.** The
   real Codex CLI edits files directly as a side effect of running inside a
   sandboxed workspace — it does not return a JSON diff as its message. So
   `worker-loop.ts`'s writable step is a plain `callRole` (free-text prompt,
   free-text response) against the worker's **isolated workspace copy**,
   and the actual change is discovered via a real before/after manifest
   diff (`worker-workspaces.ts`). Every fake `AgentRunner` in this test
   suite simulates the real tool by writing files into
   `request.workspacePath` as a side effect of `.run()` — this is a
   faithful test double, not a shortcut.
2. **Deterministic, not model-based, routing/decomposition/classification.**
   No live Ark credentials exist in this environment, and the spec requires
   tests that don't need them. `router.ts` clusters functional criteria by
   which top-level application-map directory their description mentions;
   `failure-packet.ts`'s `classifyFailure` is keyword-based. Both are real,
   tested, reusable logic — not stubs — but they are explicitly a simpler
   substitute for what a live planner model call could do with actual
   semantic understanding. Flagged here so it isn't mistaken for the full
   ambition of "model capability as an allocated resource": the *budgeting,
   isolation, verification, and integration* machinery around model calls
   is real and load-bearing; the *routing heuristic itself* is deterministic
   by necessity in this environment.
3. **Application-map summaries are deterministic text (file/directory
   counts), not model-generated semantic descriptions.** Same reasoning:
   fabricating a "this module is for X" summary without a live model call
   backing it would violate "do not let the model fabricate repository
   evidence" in spirit even though it's not literally a hallucinated fact.
   Every other field (paths, hashes, imports, exports) is read directly off
   disk.
4. **Context expansion is wired into the live worker loop, not just
   unit-tested as a pure function.** After preflight, each entry in the
   worker's `missingContextRequests` goes through `resolveExpansion`
   (bounded by `budget.maxContextExpansionsPerTask`, tracked **across**
   retry attempts within one task, not reset per attempt); granted paths
   are named in the write prompt, denials are recorded as events. Verified
   end-to-end in `worker-loop.test.ts`, not only at the `context-broker.ts`
   pure-function level.
5. **Artifact-driven dependency refresh is real but narrower than a full
   dependency graph.** `plan()`'s task decomposition does not automatically
   wire `requiredArtifactIds` between clusters (no static analysis infers
   "task B depends on task A's output"). What is real and tested:
   `artifact-registry.ts`'s versioning and `detectStaleTasks` (the actual
   "only affected dependent work" logic), and `driver.execute()` resolving
   each task's `observedArtifactVersions` from the registry's *current*
   version just before that task starts (so if task decomposition or a
   future refinement does wire a dependency, refresh is automatically
   just-in-time — no separate "check for staleness" pass is needed). Every
   completed worker also publishes a `test-result` artifact as real
   evidence. Full automatic cross-task dependency inference during planning
   is not implemented; flagged rather than silently narrowed.
6. **Integrator conflict resolution and the direct-mode call both use the
   same side-effect convention as the worker loop** — a role call against a
   workspace path, diffed/read afterward — for the same reason (item 1).
7. **`plan()` records the application map summary via its return value**
   (`PlanResult.applicationMap`), not via `sink.recordApplicationMap` from
   inside the driver — Task 1's `runPlanAndExecute` already persists
   `plan.applicationMap` after `plan()` returns. Calling
   `sink.recordApplicationMap` from inside `plan()` as well would have
   double-persisted the same map.
8. **Shared `CODEX_HOME` across concurrent role executions is an
   acknowledged gap.** The original fuller spec calls for separate trusted
   Runtime/Codex state directories per role so concurrent planner/worker/
   verifier/integrator executions can't corrupt or inherit each other's
   sessions. That was not implemented — it would need a `codexHomeOverride`
   threaded through `RunnerRequest` and per-role temp `CODEX_HOME`
   directories created by the driver, which was judged lower priority than
   the isolation/verification/integration machinery given the time
   available. Filesystem-level worker isolation (separate workspace
   copies) *is* real; only the Codex CLI's own auth/session directory is
   shared.

## Protected/global verification: what's real vs. what Final Assembly wires

`verification.ts`'s `runChecks`/`allPassed` and the
`createTrustedCommandRunner` factory are real and production-shaped: a
worker or the browser can never supply a command string — only a check
*name*, looked up against a server-side `TrustedCommand[]` allowlist,
executed via `execFile` (never a shell) with bounded timeout/output. No
protected-evaluator storage path (mode-0700, outside worker snapshots) was
created in this session — `protectedChecks`/`globalChecks` are passed into
`EngineConfig` as plain arrays; Final Assembly should point them at real
trusted commands (e.g. `["npm", "run", "typecheck"]`,
`["npm", "test", "--", "protected/"]`) and decide where any genuinely
hidden fixtures live on disk. No test in this suite exercises
`createTrustedCommandRunner` against the real repo's own build (that would
be slow/circular); one test runs `node --version` as a real subprocess to
prove the runner itself works, and it's the only place in the whole Task 2
suite that shells out for real.

## How Task 2 stays inside Task 1's grounding boundary

- `elaborateIntent` returns structured analysis (claims with provenance/
  materiality, candidate clarification questions with a delegate option)
  but never decides whether more user interaction is required — that's
  entirely Task 1's `applyClarificationPolicy` + `confirmIntent`'s
  `openQuestions.length > 0` check.
- `plan(input: PlanInput)` requires `input.contract: ExecutionContract` —
  there is no code path to call it without one; Task 1 only ever calls it
  from `status === "planning"`, itself only reachable via `confirmIntent`.
- `execute(input: ExecuteInput)` requires `input.contract` and
  `input.plan`; a worker's writable call never happens before
  `reviewPreflight` approves (verified directly in `worker-loop.test.ts`:
  the fake runner's write handler is simply never registered/called when
  preflight is rejected).
- No worker, verifier, planner, or integrator role can mark its own result
  passed — pass/fail comes from `runChecks`/`allPassed` against
  independently-run checks, and only `deps.checkRunner`'s return value
  (never the model's own claim) determines status.
- A worker's `classifyFailure(...) === "ambiguous-contract"` is the only
  path that produces `{kind: "needs-user", amendment}`; every other failure
  produces a plain `{kind: "failed", reason}` that never touches the
  contract.

## Tests

166 tests total across the whole server package; the engine's own share:

```
structured-output.test.ts     6   parse success / fence extraction / bounded repair / hard failure
role-executor.test.ts         7   reserve+commit, model fallback, budget denial, cancellation, repair
application-map.test.ts       4   real fs scan, exclusions, hash stability, versioning
worker-workspaces.test.ts     8   isolated copy, diff (edit/add/delete), concurrent isolation,
                                   isPathWithinAllowed, safe cleanup + unsafe-target refusal
router.test.ts                5   direct/one-worker/multi-worker routing incl. requestedMode overrides
context-broker.test.ts        7   minimum-sufficient packet, no full-source duplication,
                                   expansion allow/traversal-deny/protected-deny/budget-deny
artifact-registry.test.ts     4   versioning, v1->v2 drift affects only the dependent task
failure-packet.test.ts        7   compression bounds, all 8 classification categories
verification.test.ts          4   sink recording, allPassed, trusted-allowlist runner (real subprocess)
preflight.test.ts             3   scope approval/rejection, real read-only sandboxMode request
worker-loop.test.ts          12   pass/retry/exhaust/preflight-reject/scope-violation/budget-stop/
                                   cancel-before-start/context-expansion grant+deny
integrator.test.ts            4   non-conflicting merge+publish, focused conflict resolution,
                                   drift halts untouched, failed verification leaves workspace untouched
driver.test.ts               20   schema-validated elaboration, material/trivial/delegable questions,
                                   bounded-repair recovery, direct & multi-worker routing, direct
                                   completion+verification, direct verification-failure, budget-exhausted
                                   mapping, multi-worker publish+artifacts, ambiguous-contract->needs-user
                                   (workspace left untouched), plain failure (not needs-user), genuine
                                   cross-worker conflict resolved and published, cancel() before start,
                                   mid-execution abort with cleanup
```

All engine tests use the in-memory `createInMemorySink` (itself built on
Task 1's real `reserveModelCall`/`commitModelUsage` pure functions, not a
separate approximation) and `createFakeAgentRunner` from
`test-doubles.ts` — no live Ark credentials, network, Docker, or a globally
installed Codex CLI required anywhere in this suite. `test-doubles.ts` is
not imported by any production code path.

## Checks run

```
npm run typecheck   -> pass (server + web)
npm run test          -> 166 passed / 24 test files
npm run build           -> pass (web + server)
npm run check            -> pass end-to-end
```

## Required-test-list coverage (Phase B instructions, 22 items)

1. ✅ schema-validated (`driver.test.ts`, `structured-output.test.ts`)
2. ✅ bounded repair (`structured-output.test.ts`, `role-executor.test.ts`, `driver.test.ts`)
3. ✅ material ambiguity identified (`driver.test.ts`)
4. ✅ inconsequential/delegable choice identified (`driver.test.ts`; auto-resolution itself lives in Task 1's `clarification-policy.ts`, tested there)
5. Structurally enforced (`plan`/`execute` require a contract argument by type), exercised at the Task 1 level (`service.test.ts`: "cannot start before a confirmed contract exists")
6. ✅ no write before preflight approval (`worker-loop.test.ts`)
7. ✅ material conflict -> needs-user evidence (`driver.test.ts`)
8. ✅ tiny/coupled -> direct (`router.test.ts`, `driver.test.ts`)
9. ✅ modular -> multi-worker (`router.test.ts`, `driver.test.ts`)
10. ✅ minimum relevant context, not repo-wide (`context-broker.test.ts`)
11. ✅ narrow expansion works; traversal/protected fail (`context-broker.test.ts`, `worker-loop.test.ts`)
12. ✅ isolated workspaces (`worker-workspaces.test.ts`, `integrator.test.ts`)
13. ✅ scope violations detected (`worker-loop.test.ts`)
14. ✅ bounded retries/tokens/expansions/time (`worker-loop.test.ts`, `role-executor.test.ts`; wall-clock budget itself is declared in `BudgetPolicy` but not separately enforced by a timer in this build — see limitations)
15. ✅ v1->v2 artifact drift refreshes only the affected task (`artifact-registry.test.ts`)
16. ✅ compact escalation/failure packet on repeated failure (`worker-loop.test.ts`, `failure-packet.test.ts`)
17. ✅ deterministic integration for non-conflicting work (`integrator.test.ts`, `driver.test.ts`)
18. ✅ protected/global verification blocks publish (`integrator.test.ts`, `driver.test.ts`)
19. ✅ failed verification leaves main workspace unchanged (`integrator.test.ts`, `driver.test.ts`)
20. ✅ success publishes + records evidence (`integrator.test.ts`, `driver.test.ts`)
21. ✅ cancellation + cleanup (`driver.test.ts`; `cleanupTaskWorkspace` refuses unsafe targets, `worker-workspaces.test.ts`)
22. Existing direct Agent behavior/regressions: verified by the **unchanged** baseline suite (agent-service/app/codex-runner/container-codex-runner tests, still 100% passing) — Task 2's engine-mediated "direct" mode (routed through the driver, budgeted/verified) is a distinct new code path from baseline `AgentService.sendMessage`, which this session did not touch.

## Known limitations

- Wall-clock budget (`BudgetPolicy.maxWallClockMs`) is declared and
  threaded through but not enforced by an active timer/deadline inside the
  worker loop or role-executor in this build — a call that hangs
  indefinitely is only stoppable via explicit cancellation, not an
  automatic timeout. (The underlying `CodexRunner`/`ContainerCodexRunner`
  do have their own per-call `CODEX_TIMEOUT_MS`, which bounds a real Codex
  process; this is about the *orchestration-level* wall-clock budget
  specifically.)
- No dedicated protected-evaluator storage path was created; see
  "Protected/global verification" above.
- Deterministic routing/classification/summarization in place of live model
  calls, documented above — genuine, tested, reusable logic, but a
  simplification relative to a live-model version of the same components.
- Shared `CODEX_HOME` across concurrent role executions (see item 8 above).
- No automatic cross-task artifact-dependency inference during planning
  (see item 5 above) — the registry and drift-detection primitives are
  real; wiring them into automatic task-graph dependencies is not.

## What Final Assembly / Task 3 must wire

1. Construct `EngineConfig` in the composition root: the real `AgentRunner`
   (from `runner-factory.ts`), per-role `modelIds` (or leave empty to
   truthfully fall back to a single configured model), a trusted,
   orchestration-scoped `scratchRoot` under `config.dataDirectory`, a real
   `createTrustedCommandRunner([...])` with actual protected/global check
   commands, and `protectedChecks`/`globalChecks` arrays.
2. `createEngineDriver(config)` implements `OrchestrationExecutionDriver`;
   pass it to `new OrchestrationControlService(store, agentAccess, driver,
   pricing?, clarificationPolicy?)`.
3. Decide on and create the protected-evaluator storage location (mode-0700,
   outside any worker-accessible path) if hidden checks are wanted for the
   demo, and point a `TrustedCommand` at it.
4. If true concurrent multi-worker execution against the **real** Codex CLI
   is part of the demo, verify `CODEX_HOME` sharing (item 8) is acceptable
   for the demo's scope, or add the per-role state directory split.
