# Task 1 handoff: durable orchestration control plane

## Source

- Base commit: `acaccd8e7f66dba622503efab0607e70d6e80398`
- Working branch: `jovian/task1`
- Original full Task 1 commit: `3466067e5d2cf53545c0251dd4d05070a6113fc0`
- Integrated parallel Task 1 commit: `6bb120a` from `task1-julian`
- The integration merge keeps the complete control-plane scope and incorporates compatible behavior and tests from both implementations.

## Files changed

- `apps/server/src/orchestration/contracts.ts` — exact frozen Appendix A contract.
- `apps/server/src/orchestration/control/store.ts` — validated version-1 atomic JSON persistence and typed control-plane collections.
- `apps/server/src/orchestration/control/redaction.ts` — recursive bounded redaction used before persistence and reads.
- `apps/server/src/orchestration/control/state-machine.ts` — centralized legal transitions and typed conflicts.
- `apps/server/src/orchestration/control/budget-ledger.ts` — conservative reservations, configured/unknown pricing, and role/total actual usage.
- `apps/server/src/orchestration/control/service.ts` — lifecycle, intent/contract/amendment history, driver coordination, sink, cancellation, restart reconciliation, and cleanup metadata.
- `apps/server/src/orchestration/control/read-model.ts` — safe correlated orchestration read model.
- `apps/server/src/orchestration/control/routes.ts` — standalone Fastify route registration for the Task 1 API.
- `apps/server/src/orchestration/control/{store,state-machine,budget-ledger,service,routes}.test.ts` — deterministic task-local tests.
- `apps/server/src/orchestration/control/redaction.test.ts` — focused free-text, secret-key, assignment, and safe-value redaction tests integrated from Julian's branch.
- `docs/handoffs/task-1-control-plane.md` — this handoff.

No composition root, baseline Agent service, runner, React, Task 2, Task 3, README, or environment file was edited.

## Public exports and construction

- `new OrchestrationStore(filePath, optionalAtomicWriter)`
- `new OrchestrationControlService({ store, driver, agentAccess, defaultBudget?, pricing?, clock?, id?, cleanupPolicy? })`
- `registerOrchestrationRoutes(app, service)`
- `createAgentExecutionCoordinator(service)` or `service.coordinator()`
- `AgentAccessPort`, `AgentExecutionCoordinator`, `OrchestrationServiceOptions`, `CreateOrchestrationInput`
- `ModelPricing` and the budget calculation helpers
- `buildReadModel(database, orchestrationId)`
- State-machine transition/query helpers and typed domain errors

The service implements the frozen `OrchestrationSink` interface and calls an injected frozen `OrchestrationExecutionDriver`. The `AgentAccessPort` performs authoritative Agent status/workspace lookup without importing or editing the baseline Agent service.

## Checks

- `diff -u <Appendix A block> apps/server/src/orchestration/contracts.ts` — passed; no differences.
- `npm run typecheck -w @launchpad/server` — passed.
- `npm run test -w @launchpad/server -- --reporter=dot` — passed after integration: 11 files, 35 tests.
- `git diff --check` — passed.
- `npm run check` — passed: server/web typechecks, 10 server test files with 30 tests, web production build, and server build.

## Test adapters

Tests use deterministic in-process `OrchestrationExecutionDriver` fakes and temporary JSON databases/workspace paths. They do not require Ark, network, Docker, a globally installed Codex CLI, or production mocks.

Coverage includes empty/reloaded/corrupt/future stores, serialized and failed persistence, pre-disk/API redaction, all declared state transitions, immutable revisions/contracts/amendments, explicit confirmation, one-active concurrency, stopped-Agent denial, role and total known/unknown pricing, hard budget denial, cancellation/idempotency, driver cancellation, restart reconciliation, route validation/statuses, and inherited bearer-hook protection.

The merge additionally preserves the original raw prompt across intent revisions, accepts Julian's `note` revision DTO alongside `revision`, defaults omitted `requestedMode` to `auto`, and rejects explicit confirmation when the estimate's low end already exceeds a configured hard limit.

## Configuration

No baseline configuration file was changed. Final Assembly should supply:

- the orchestration database path under `config.dataDirectory`;
- bounded default budgets;
- trusted per-role/model pricing entries, if configured;
- cleanup policy (`clean`, `archive`, or `retain`).

Missing pricing intentionally yields `pricingStatus: "unknown"` and null estimated dollars.

## Final Assembly integration

1. Create and initialize `OrchestrationStore` before the server begins listening.
2. Instantiate Task 2's real `OrchestrationExecutionDriver` and inject it with a real `AgentAccessPort` adapter.
3. Inject `createAgentExecutionCoordinator(controlService)` into Task 2's optional Agent-service coordinator port so direct and orchestrated writes cannot race.
4. Register `registerOrchestrationRoutes(app, controlService)` after the existing `/api/*` bearer-token hook.
5. Stop/delete flows must call `cancelForAgent` before changing or archiving an Agent workspace.
6. Task 2 must report final task-workspace cleanup/archive outcomes; Task 1 persists the selected policy and reconciliation evidence but does not manipulate those directories.

## Known limitations

- The JSON store is intentionally single-process. Production multi-process operation needs PostgreSQL or another transactional store plus leases.
- Filesystem worker cleanup/archive is Task 2's responsibility; this task records policy and reconciliation metadata only.
- Cancellation safety depends on the execution driver honoring `AbortSignal` and its `cancel` contract; late outcomes cannot overwrite a terminal control-plane state.
- Pricing is an estimate supplied by trusted configuration, never billed cost.
- Context-expansion and step enforcement rely on Task 2 emitting the frozen correlated sink events consistently.
- The plugin is intentionally not registered in `app.ts` until Final Assembly.

## Deviations

None from Appendix A or Task 1 file ownership. The frozen contract was copied literally.
