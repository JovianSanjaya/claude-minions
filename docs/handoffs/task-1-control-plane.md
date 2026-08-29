# Task 1 handoff — control plane (restricted scope)

## Scope of this delivery

This branch implements **only** the four capability-matrix rows the user explicitly
requested, not the full Task 1 spec in `read.md`:

- Intent draft / revision / confirmation
- Immutable contract versions / amendments
- Acceptance criteria categories
- Estimate and hard budget

Everything else in section 6 of the spec (cancellation routes, restart
reconciliation, the full event/timeline read model, task/artifact/verification
persistence, the `/start` and `/cancel` routes) is **out of scope** and was
deliberately not built. See "Deliberate deviations" below.

## Base commit / branch

- Base branch: `task1-julian`, on top of commit `acaccd8` ("base code").
- No merge from Task 2 or Task 3 has happened; this is a standalone build,
  tested with a deterministic fake `OrchestrationExecutionDriver` per spec
  section 4.4.

## Files changed

```
apps/server/src/orchestration/contracts.ts            (Appendix A, literal)
apps/server/src/orchestration/control/state-machine.ts
apps/server/src/orchestration/control/redaction.ts
apps/server/src/orchestration/control/budget-ledger.ts
apps/server/src/orchestration/control/store.ts
apps/server/src/orchestration/control/read-model.ts
apps/server/src/orchestration/control/service.ts
apps/server/src/orchestration/control/routes.ts
apps/server/src/orchestration/control/*.test.ts        (6 test files)
docs/handoffs/task-1-control-plane.md                  (this file)
```

No baseline file was edited (`app.ts`, `index.ts`, `agent-service.ts`,
`types.ts`, `store.ts`, `errors.ts`, React files, etc. are all untouched).
`errors.ts`'s existing `HttpError` class is imported, not modified.

## Public exports / constructors

- `contracts.ts` — literal Appendix A, unmodified.
- `OrchestrationStore` (`control/store.ts`) — `initialize()`, `snapshot()`,
  `mutate()`. Separate JSON file (`orchestrations.json`), same
  atomic-temp-file-plus-rename pattern as the baseline `JsonStore`.
- `OrchestrationControlService` (`control/service.ts`):
  - `createOrchestration(input)`, `reviseIntent(id, note)`,
    `confirmIntent(input)`, `proposeAmendment(input)`,
    `confirmAmendment(orchestrationId, amendmentId)`,
    `rejectAmendment(orchestrationId, amendmentId)`,
    `listOrchestrations(agentId)`, `getOrchestration(id)`,
    `getReadModel(id)`.
  - `waitForPendingWork(orchestrationId)` — **test-only hook**, not part of
    the product surface. Background intent elaboration is fire-and-forget
    (so the HTTP layer can return 202 immediately); this lets tests await
    the outcome deterministically instead of racing a background task.
  - Constructor: `(store, agents: AgentAccessPort, driver:
    OrchestrationExecutionDriver, pricing?: PricingTable)`.
- `AgentAccessPort` (`control/service.ts`) — injected Agent lookup
  (`getAgent(id): {id,status,workspacePath} | null`), per spec section 6.1.
- `createOrchestrationCoordinator(store)` (`control/service.ts`) — the
  cross-task adapter from spec 6.1, exposing
  `assertAgentAvailableForDirect`, `hasActiveOrchestration`,
  `cancelForAgent`. See "Deliberate deviations" for its reduced scope.
- `registerOrchestrationRoutes(app, service)` (`control/routes.ts`).
- `budgetPolicySchema`, `budgetPolicyOverrideSchema`, `DEFAULT_BUDGET_POLICY`,
  `reserveModelCall`, `commitModelUsage`, `estimateExceedsBudget`,
  `createEmptyUsageLedger`, `PricingTable` (`control/budget-ledger.ts`).
- `redactDeep` (`control/redaction.ts`).
- `isLegalTransition`, `assertLegalTransition`, `IllegalTransitionError`,
  `TERMINAL_STATUSES` (`control/state-machine.ts`) — implements the **full**
  canonical transition table from spec 6.4 (not just the reachable subset),
  so Task 2's execution states can rely on it unmodified.

## Registered routes

```
POST   /api/agents/:agentId/orchestrations
GET    /api/agents/:agentId/orchestrations
GET    /api/orchestrations/:orchestrationId
PATCH  /api/orchestrations/:orchestrationId/intent
POST   /api/orchestrations/:orchestrationId/confirm
POST   /api/orchestrations/:orchestrationId/amendments            (addition, see below)
POST   /api/orchestrations/:orchestrationId/amendments/:id/confirm
POST   /api/orchestrations/:orchestrationId/amendments/:id/reject
```

`/amendments` (propose) is **not** in the spec's minimum route list (section
6.8), because in the full design amendments are normally raised by the
execution driver's `ExecutionOutcome` (`{kind: "needs-user", amendment}`),
not by a direct user action. Since `execute()` is out of this restricted
scope, this route exists so the amendment capability is independently
reachable and testable over HTTP. Final Assembly should decide whether to
keep it once Task 2's `execute()` path exists, since that path will also be
able to produce amendments via the sink/outcome, not just via this route.

Not implemented (out of scope): `/start`, `/cancel`, `/events`, `/tasks`,
`/artifacts`, `/verifications`.

The plugin assumes the host app's existing bearer-token hook already
protects `/api/*` (verified indirectly: `routes.test.ts` builds its own
minimal Fastify app + error handler mirroring `app.ts`'s, without touching
`app.ts` itself, per the file-ownership rule).

## Checks run

```
npm run typecheck   -> pass (server + web)
npm run test         -> 68 passed (61 new orchestration tests + 7 pre-existing baseline tests)
npm run build         -> pass (web + server)
npm run check          -> pass end-to-end
```

Ran via `nvm use 22` (Node v22.23.2) since `node`/`npm` were not on PATH by
default in this environment.

## Configuration added

None. Pricing (`PricingTable`) and non-default `BudgetPolicy` values are
constructor/request parameters, not environment variables — wiring them from
`config.ts`/`.env` is a Final Assembly concern (spec section 9.3), which this
branch does not touch.

## Fake/test adapters used

- A hand-rolled fake `OrchestrationExecutionDriver` per test file
  (`service.test.ts`, `routes.test.ts`) implementing only `elaborateIntent`
  meaningfully; `plan`/`execute` throw ("out of scope for this restricted
  build") since nothing in this delivery calls them.
- A hand-rolled `AgentAccessPort` fake (in-memory record of agent id ->
  snapshot).
- `routes.test.ts` builds its own Fastify instance + a copy of `app.ts`'s
  error-mapping logic (HttpError/ZodError -> status code), since Task 1 must
  not edit `app.ts` and still needs to prove its own HTTP contract
  standalone (spec 4.4).

No production mocks exist; all fakes live in `*.test.ts` files.

## Deliberate deviations / scope reductions (read before wiring Task 2/3)

1. **`budget-exhausted` is unreachable in this build.** The frozen state
   table (spec 6.4) only allows `running -> budget-exhausted`, and `running`
   is Task 2's territory. So "hard budget enforcement" here is implemented
   two ways that don't require a `budget-exhausted` transition:
   - `confirmIntent` compares the stored `CostEstimate` against the
     orchestration's `BudgetPolicy` (`estimateExceedsBudget`) and denies
     confirmation with **422** if the low-end estimate already exceeds the
     hard budget. The orchestration stays in `awaiting-confirmation`
     unchanged — no illegal transition, no silent weakening.
   - The `OrchestrationSink` implementation backing `driver.elaborateIntent`
     wires `reserveModelCall`/`commitModelUsage` to a real per-orchestration
     `UsageLedger`, enforced via the pure functions in `budget-ledger.ts`. A
     driver that reserves more than the remaining budget gets `{allowed:
     false, reason}` back and must handle that itself; in this build, if the
     fake/real driver throws in response, the orchestration is left in
     `drafting-intent` with `.error` set (see point 2).
   - `budget-ledger.ts`'s `reserveModelCall`/`commitModelUsage` are also
     unit-tested directly as pure functions, independent of any orchestration
     status, so Task 2 can trust their budget math once it starts making
     real reserve/commit calls from `running` state.

2. **No `drafting-intent -> failed` edge exists** (also not in the frozen
   table). If `driver.elaborateIntent` throws — whether from a real error or
   from a denied budget reservation — the orchestration stays at whatever
   status it was in before the call (`drafting-intent`), with `.error` set to
   the redacted failure message. There is currently no route to retry or
   surface this beyond reading the orchestration; Task 3 will want a way to
   re-trigger elaboration (e.g. treat a `drafting-intent` orchestration with
   a non-null `.error` as retryable) if this matters for the demo.

3. **Acceptance criteria are auto-derived, not driver-supplied.** Appendix A
   gives `elaborateIntent` no way to return `ContractCriterion[]`, and
   `PlanResult` (Task 2's territory) doesn't carry them either. So
   `confirmIntent`/`confirmAmendment` derive one typed criterion per
   requirement (`functional`), architecture decision (`architectural`),
   non-goal (`scope`), and manual expectation (`manual`), plus one fixed
   baseline `runtime`/`protected-test` criterion ("existing Agent CRUD,
   lifecycle, and direct Playground behavior must continue to pass"). Callers
   may override with an explicit `criteria` array on confirm/amend instead.
   This is a design decision, not a bug — flag it in review if Task 2/3
   expected criteria to come from the driver.

4. **Revision instructions ride along in the frozen `prompt` field.**
   `ElaborateIntentInput` has no separate "revision note" field. `reviseIntent`
   passes the user's revision note as `prompt` for that one driver call, while
   `Orchestration.prompt` (the original user request) is never mutated. A
   real driver implementation needs to know this convention.

5. **`OrchestrationSink`'s non-budget/non-event methods are no-ops**
   (`upsertTask`, `recordApplicationMap`, `recordContextPacket`,
   `recordAttempt`, `publishArtifact`, `recordVerification`), and
   `recordEvent` is also a no-op — no `OrchestrationEvent` timeline is
   persisted in this build. The frozen interface is still fully satisfiable
   by a real driver (Task 2) that calls these; the calls just have no effect
   here. Full event-timeline persistence, plus a proper redacted read model
   for it, is part of Task 1's fuller scope and was intentionally left out.

6. **Reservations are held in memory only**, in a
   `Map<reservationId, {orchestrationId, role, modelId}>` on the service
   instance. A process restart between `reserveModelCall` and
   `commitModelUsage` orphans the reservation (no leak of committed budget,
   just a dropped in-flight one). Acceptable for a single-process POC; not
   restart-safe.

7. **`createOrchestrationCoordinator(store).cancelForAgent` is a
   status-only stub.** It flips any non-terminal orchestration for the given
   Agent straight to `cancelled` in the store, but has no reference to the
   execution driver, so it cannot abort in-flight model calls or reconcile
   worker processes. Full cancellation (AbortController wiring,
   `driver.cancel`, restart reconciliation marking interrupted runs
   `cancelled` on boot) is explicitly out of scope for this delivery.

8. **No restart reconciliation.** `OrchestrationStore.initialize()` only
   loads and validates the file; it does not scan for orchestrations left in
   a non-terminal status from a previous process and mark them `cancelled`
   the way baseline `AgentService.initialize()` does for Runs. Out of scope
   per the user's requested rows.

## Integration steps for Final Assembly

1. In `apps/server/src/index.ts` / `app.ts`: construct an `OrchestrationStore`
   under `config.dataDirectory` (e.g. `orchestrations.json`), call
   `.initialize()` before listening, construct the real
   `AgentAccessPort` from `AgentService`/`JsonStore`, construct/obtain the
   real `OrchestrationExecutionDriver` (Task 2), and register
   `registerOrchestrationRoutes(app, service)` **after** the existing
   bearer-token `onRequest` hook.
2. Wire `createOrchestrationCoordinator(store)` into `AgentService` via the
   optional `AgentExecutionCoordinator` port Task 2 is expected to add (spec
   7.3) — call `assertAgentAvailableForDirect` before accepting a direct Run,
   and `cancelForAgent` when stopping/deleting an Agent. Given point 7 above,
   this only prevents new direct/orchestrated races going forward; it does
   not abort whatever Task 2's driver is doing mid-flight.
3. Decide whether to keep the extra `POST .../amendments` route once Task
   2's `execute()` can also produce amendments via `ExecutionOutcome`.
4. Wire a real `PricingTable` from `config.ts` env vars if/when Task 2/3 want
   dollar estimates instead of `pricingStatus: "unknown"`.
5. If Task 1's fuller scope (events, cancellation, restart reconciliation,
   task/artifact/verification persistence) gets built later, it slots into
   the same `control/` directory; nothing here needs to be reworked to add
   it, only extended (the `OrchestrationSink` no-ops are the extension
   points).

## Known limitations (restated for the demo/docs)

- No cancellation, restart reconciliation, or execution/evidence timeline in
  this build — an orchestration can be created, revised, confirmed, and
  amended, but nothing here ever runs a worker or reaches `running` /
  `completed`.
- `budget-exhausted` and `failed` are unreachable states in this restricted
  build (see deviation 1–2 above); denial is expressed via `422` at confirm
  time and via `.error` + staying in `drafting-intent` on an elaboration
  failure.
- Estimated dollar cost is always `pricingStatus: "unknown"` unless a caller
  explicitly constructs the service with a `PricingTable` (no env wiring
  exists yet).
