# Task 2 handoff: context-aware model-aware execution engine

## Source and scope

- Base commit: `87ed51908c4aa11fbe200e09c320af152db2ec1f`
- Working branch: `jovian/task1task2`
- The branch already contained completed Task 1. This delivery changes only Task 2-owned engine/Runtime files and this unique handoff.
- No composition root, Task 1 control file, React file, README, or Task 3 file was edited.

## Files changed

Engine modules created under `apps/server/src/orchestration/engine/`:

- `driver.ts` — real frozen `OrchestrationExecutionDriver` implementation.
- `role-executor.ts` — budgeted logical roles, stable executions, distinct Runtime homes, exact cancellation, usage, model/fallback evidence, and one JSON repair.
- `structured-output.ts` — JSON extraction and Zod validation.
- `router.ts` — budget-aware direct/one-worker/multi-worker selection.
- `application-map.ts` — deterministic paths, hashes, import/export facts, boundaries, exclusions, and versioning.
- `context-broker.ts` — minimum context packets and bounded traversal/symlink/protected-path-safe expansion.
- `worker-workspaces.ts` — isolated snapshots, manifests, scope checks, cleanup/archive safety.
- `preflight.ts` — typed read-only worker preflight and contract/scope review.
- `worker-loop.ts` — bounded preflight/write/visible-check/retry loop and attempt evidence.
- `artifact-registry.ts` — structured artifact versions, targeted stale detection, and focused refresh.
- `verification.ts` — trusted visible/protected/global/manual checks with argv-only command allowlisting.
- `integrator.ts` — deterministic non-conflicting integration, focused conflict resolution, drift detection, rollback, and publish.
- `failure-packet.ts` — compact failure evidence and classification.
- `engine.test.ts`, `driver.test.ts` — deterministic component and end-to-end acceptance tests.

Allowed baseline Runtime files changed:

- `apps/server/src/types.ts`
- `apps/server/src/agent-service.ts` and test
- `apps/server/src/config.ts`
- `apps/server/src/codex-runner.ts` and test
- `apps/server/src/container-codex-runner.ts` and test

`runner-factory.ts` required no change because both concrete runners retain the `AgentRunner` interface.

## Public exports and construction

- `new ContextAwareExecutionDriver(options: EngineDriverOptions)`
- `new RoleExecutor(runner, sink, models, runtimeHomeRoot, optionalIdProvider)`
- `buildApplicationMap`, `ContextBroker`, `WorkerWorkspaceManager`
- `BoundedWorkerLoop`, `ArtifactRegistry`, `VerificationService`
- `DeterministicIntegrator`, failure-packet helpers, preflight helpers, and `selectRoute`

Final Assembly should instantiate the driver with:

- the existing `AgentRunner`;
- trusted planner/worker/verifier/integrator model IDs;
- trusted Runtime-home, orchestration-temp, archive, and protected-evaluator roots;
- trusted verification checks and executable allowlist;
- a cleanup policy.

The resulting instance is passed directly into Task 1's `OrchestrationControlService` as its frozen driver port.

## Runtime contract extensions

`RunnerRequest` now requires a stable `executionId` and supports optional orchestration/task/role/model/Runtime-home/sandbox metadata. Both runners key active work and cancellation by execution ID, allowing concurrent roles for one Agent without cancellation collisions.

Direct `AgentService` now:

- passes the Run ID as `executionId`;
- cancels that exact Run;
- accepts an optional default-no-op `AgentExecutionCoordinator`;
- checks direct admission before persistence;
- cancels orchestration work before stopping or deleting an Agent.

Existing direct sessions still pass the stored Codex thread ID and retain their baseline behavior.

## Configuration added

- `CODEX_MODEL_OVERRIDE_SUPPORTED` (`true` by default); when false, role requests truthfully fall back to `ARK_MODEL` and evidence marks the fallback.
- `ORCHESTRATION_PLANNER_MODEL`
- `ORCHESTRATION_WORKER_MODEL`
- `ORCHESTRATION_VERIFIER_MODEL`
- `ORCHESTRATION_INTEGRATOR_MODEL`
- `ORCHESTRATION_RUNTIME_HOME_ROOT`
- `ORCHESTRATION_TEMP_ROOT`
- `ORCHESTRATION_ARCHIVE_ROOT`
- `ORCHESTRATION_PROTECTED_EVALUATOR_ROOT`

Role models fall back to `ARK_MODEL` when not separately configured. Final Assembly owns pricing and full environment documentation.

## Checks and deterministic evidence

- `npm run typecheck -w @launchpad/server` — passed.
- `npm run test -w @launchpad/server -- --reporter=dot` — passed before final check; the final suite contains 13 files and 53 tests.
- `git diff --check` — passed.
- `npm run check` — passed: server/web typechecks, 13 server test files with 53 tests, web production build, and server build.

The success acceptance test proves:

```text
confirmed contract
-> modular plan and multi-worker route
-> versioned deterministic application map
-> minimum context packets
-> read-only approved preflights before writable calls
-> isolated scoped edits
-> visible checks
-> artifact v1 -> v2
-> focused dependent-task refresh
-> deterministic integration
-> protected/global verification
-> verified publish
-> application map v2 and safe cleanup
```

Failure tests prove bounded retries, compact planner escalation, global-verification publication blocking, main-workspace drift blocking, exact direct cancellation, scope/path/symlink denial, safe cleanup, and unchanged main workspaces after failure.

## Test adapters

- In-memory frozen `OrchestrationSink` fakes.
- `AgentRunner` fakes that return typed role output and make real edits only inside temporary isolated workspaces.
- Injected trusted verification callbacks operating on temporary candidates.
- No Ark, network, Docker, globally installed Codex CLI, or production mock is required.

## Final Assembly steps

1. Instantiate `ContextAwareExecutionDriver` from the new validated configuration and the existing runner.
2. Pass it to Task 1's control service.
3. Inject Task 1's real coordinator adapter into `AgentService`.
4. Supply protected/global checks from trusted server configuration; never browser command strings.
5. Initialize protected/temp/archive/runtime-home roots before serving requests (the services also create them defensively).
6. Register Task 1 routes only during Final Assembly and test the complete browser-to-publish journey.
7. Reconcile artifact persistence semantics noted below before declaring artifact-history evidence complete.

## Known limitations and integration note

- Task 1's current `publishArtifact` store adapter upserts solely by `artifact.id`; Task 2 treats that ID as a stable artifact lineage and emits v1, v2, and later versions. Final Assembly should change Task 1 persistence to retain entries by `(id, version)` so historical versions are not overwritten. Task 2 control-file ownership prevented changing it here.
- Protected evaluator definitions and the trusted command catalog must be provisioned by Final Assembly. The engine enforces their boundary and never mounts or returns the protected root to workers.
- Multi-worker batches run concurrently only when dependencies are satisfied and write scopes do not collide. Colliding writers are serialized automatically, and every later wave starts from the staged output of completed waves.
- The publish path provides best-effort per-file rollback suitable for the single-user POC, not a cross-process filesystem transaction.
- Ordinary local/container execution remains a hackathon POC trust boundary, not hardened multi-tenant isolation.
- Model pricing and dollar accounting remain Task 1/Final Assembly configuration; Task 2 reserves and commits every role call through the frozen sink.

## Deviations

No Appendix A changes and no Task 1/Task 3 ownership violations. Final Assembly is intentionally not performed because Task 3 is not present.
