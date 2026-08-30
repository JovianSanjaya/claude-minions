# Task 1 handoff — control plane (upgraded: common-ground grounding + full lifecycle)

## Final Assembly status: DONE (this session)

Final Assembly wired this control plane into the real running app:
`apps/server/src/orchestration/composition.ts` constructs the real
`OrchestrationStore`, the real `createEngineDriver` (Task 2), and this
`OrchestrationControlService`, calling `.initialize()` before the server
starts listening (`index.ts`). `registerOrchestrationRoutes` is registered
in `app.ts` after the bearer-token hook. `createOrchestrationCoordinator`
is wired into `AgentService` via a new optional `AgentExecutionCoordinator`
port (`agent-service.ts`), so direct execution and orchestrations now
genuinely cannot race on the same Agent workspace — verified by a live
integration test
(`apps/server/src/orchestration/composition.test.ts`) that walks a full
create → elaborate → confirm → plan → start → execute → completed cycle
through real HTTP routes against the real composed app (with a fake
`AgentRunner`, per the no-live-Ark-in-tests rule), plus tests for bearer-
token protection on every new route, Agent deletion cancelling an active
orchestration, and direct/orchestrated mutual exclusion. A manual smoke
test (real `node dist/index.js`, real HTTP calls) additionally confirmed
the composed server boots and a created orchestration genuinely attempts
to invoke the real Codex CLI with the expected planner prompt — it only
failed locally because this shell's Codex CLI isn't runnable, not because
of anything in the orchestration code.

## Revision history

- **v1 (restricted scope):** intent draft/revision/confirmation, immutable
  contract versions/amendments, acceptance criteria categories, estimate and
  hard budget — the four capability-matrix rows explicitly requested first.
- **v2 (this revision):** upgraded to the common-ground/intent-grounding
  design (provenance, materiality, clarification questions, delegation),
  plus the remaining original Task 1 scope: event/timeline persistence,
  task/artifact/verification data, cancellation, restart reconciliation, and
  the plan/execute lifecycle routes. Built together with a real Task 2
  engine in the same session (see `docs/handoffs/task-2-engine.md`).

## Core design change: common-ground grounding

The original intent-elaboration framing was roughly `prompt → planner draft →
confirm`. That collapsed every planner assumption into an apparent user
requirement and had no way to say "the user explicitly asked for X" versus
"the planner guessed X." This revision makes Task 1 the **authority on
whether intent is grounded enough to proceed** — Task 2 supplies model
intelligence (structured analysis with provenance/materiality/candidate
clarifications), but only Task 1 decides whether confirmation is legally
allowed.

### Provenance and materiality (frozen-contract extension)

`apps/server/src/orchestration/contracts.ts` gained (documented at the top
of the file itself, per the "smallest coherent change" rule):

- `IntentProvenance = "user-explicit" | "planner-inferred" | "repository-derived" | "user-delegated"`
- `IntentMateriality = "trivial" | "material"` — two levels only, deliberately;
  this is a control input, not a cosmetic confidence score.
- `IntentClaim { id, text, provenance, materiality, rationale, supersedes }`
  — `IntentDraft`'s five arrays (`requirements`, `assumptions`, `nonGoals`,
  `architectureDecisions`, `manualExpectations`) now hold these instead of
  plain strings.
- `ClarificationOption { id, label, resolutionText, delegate }` and
  `ClarificationQuestion { id, prompt, materiality, consequenceIfWrong,
  options, category, relatedClaimIds }` — `IntentDraft.materialQuestions:
  string[]` was renamed/retyped to `openQuestions: ClarificationQuestion[]`.
- `ContractCriterion` gained `provenance` and `sourceClaimId` — a confirmed
  contract can answer "why does the system believe this is part of the
  contract" by tracing a criterion back to its source claim.
- `ElaborateIntentInput` gained `priorDraft: IntentDraft | null` so a
  revision call is grounded in what was already established instead of
  starting over.

Nothing else in Appendix A changed — `Orchestration`, `ExecutionContract`,
`ContractAmendment`, `PlanResult`, task/artifact/verification/sink types,
and all four driver method signatures are unchanged.

### The deterministic clarification policy

`apps/server/src/orchestration/control/clarification-policy.ts` (new) is
the enforcement point for **"the control plane, not a raw model response,
must determine whether unresolved material questions prevent
confirmation"**:

- A driver's per-question `materiality` claim is the primary signal (Task 1
  has no semantic understanding of task content).
- A small keyword safety net (`destructive`, `delete`, `public api`,
  `security`, `migration`, `production`, …) can only **escalate** a
  driver-claimed "trivial" question to material — it never downgrades a
  material one.
- Every question the policy judges trivial is auto-resolved immediately
  into a `planner-inferred` claim (via the question's `delegate` option, or
  its first option) and **never shown to the user** — it does not appear in
  `openQuestions` and cannot block confirmation.
- Every question judged material stays in `openQuestions` and blocks
  confirmation until answered.

This is a pure function (`applyClarificationPolicy`), fully unit-tested,
called from `runElaboration` after every `driver.elaborateIntent` call.

### Answering and delegating

New service method `answerClarification({orchestrationId, questionId,
optionId?, freeText?})` and route `POST
/api/orchestrations/:orchestrationId/intent/questions/:questionId/answer`:

- Picking a concrete option (not the delegate one) produces a claim with
  provenance `user-explicit`.
- Picking the `delegate` option produces a claim with provenance
  `user-delegated`, using **the option's own pre-supplied `resolutionText`**
  — the user is never required to specify the implementation choice
  themselves; delegating hands the planner's own recommended default
  authority to proceed.
- Free text (when no listed option fits) also produces `user-explicit`.
- Every answer creates a **new draft revision** (immutable history — the
  prior revision still shows the question exactly as asked); it does not
  call the driver again (pure, fast, deterministic bookkeeping), so
  answering is synchronous (200, not 202).

### Criteria stay provenance-tagged end to end

`deriveCriteria` builds one criterion per claim (`functional` from
requirements, `architectural` from architecture decisions, `scope` from
non-goals, `manual` from manual expectations, plus one fixed baseline
`runtime`/`protected-test` criterion with provenance `repository-derived`),
carrying the source claim's `provenance` and `sourceClaimId` forward. A
`planner-inferred` claim can never silently become a criterion tagged
`user-explicit` — verified directly by tests.

### Amendments as common-ground repair during execution

The amendment mechanism now serves two purposes, matching the spec exactly:

1. **Ordinary contract versioning** — a user- or API-initiated
   `proposeAmendment` (unchanged behavior from v1, wraps plain strings as
   `user-explicit` claims).
2. **Execution-time repair** — when Task 2's `execute()` returns
   `{kind: "needs-user", amendment}` (e.g. a worker discovers the confirmed
   contract requires a public API change or conflicts with a protected
   check), the new private `recordDriverAmendment` persists it with
   `status: "pending"`, `decidedAt: null` **always overridden by Task 1**
   (never trusted from the driver), and the orchestration transitions
   `running → needs-user`. Confirming it produces a new contract version
   (`supersedesContractId` pointing at the prior one, which is left
   byte-for-byte untouched); rejecting it leaves the active contract alone.
   Verified by an end-to-end test with the real Task 2 engine.

## Full lifecycle now implemented (beyond the original 4 rows)

- **Plan/execute lifecycle:** `startOrchestration(orchestrationId)` (route:
  `POST /orchestrations/:id/start`, 202) validates a confirmed contract
  exists, then runs `driver.plan()` followed immediately by `driver.execute()`
  in the background, sweeping `planning → ready → running` in one atomic
  mutation (avoids a window where an illegal `ready → failed` transition
  could be attempted — the frozen table only allows `ready → running`).
  The final `ExecutionOutcome` maps to `completed` (chained instantly
  through `integrating → verifying → completed`, all legal hops — see
  `runPlanAndExecute` in `control/service.ts`), `needs-user`,
  `budget-exhausted`, `cancelled`, or `failed`.
- **Cancellation:** `cancelOrchestration(orchestrationId)` (route: `POST
  /orchestrations/:id/cancel`) is authoritative and immediate — it aborts
  the tracked `AbortController`, calls `driver.cancel()` best-effort, and
  marks the orchestration `cancelled` **without waiting** for the
  background driver call to actually unwind (so a driver that ignores its
  abort signal can never hang cancellation). The background task's own
  completion handler checks for an already-terminal status before writing
  an outcome, so it can never clobber a cancellation decided first.
  `createOrchestrationCoordinator` now wraps the **service** (not the raw
  store) so `cancelForAgent` performs this real cancellation instead of a
  status-only stub.
- **Restart reconciliation:** `initialize()` sweeps every non-terminal
  orchestration to `cancelled` with `error: "Server restarted while this
  orchestration was active"` — mirrors baseline `AgentService.initialize()`
  exactly. A genuinely completed orchestration is left untouched. Tested by
  reloading a real `OrchestrationStore` file across two service instances.
- **Event/timeline persistence:** `OrchestrationDb` gained `events`,
  `tasks`, `applicationMaps`, `contextPackets`, `attempts`, `artifacts`,
  `verifications` collections (all real now, not no-ops). `buildSink()`'s
  `recordEvent`/`upsertTask`/`recordApplicationMap`/`recordContextPacket`/
  `recordAttempt`/`publishArtifact`/`recordVerification` all persist for
  real. Task 1 also emits its own events (create/revise/confirm/answer/
  amendment propose+confirm+reject/planned/execution-completed/cancelled/
  restart-reconciled/budget-denied) so the timeline is correlated across
  both Task 1's own lifecycle actions and Task 2's execution evidence.
- **Read model:** `buildOrchestrationReadModel` now returns `events`,
  `tasks`, `applicationMap` (latest by version), `artifacts`,
  `verifications`, `attempts` alongside the v1 fields.
- **Routes added:** `POST .../intent/questions/:questionId/answer`,
  `POST .../start`, `POST .../cancel`, `GET .../events`, `GET .../tasks`,
  `GET .../artifacts`, `GET .../verifications`.

## Files changed / added this revision

```
apps/server/src/orchestration/contracts.ts                 (extended, documented deviations at top)
apps/server/src/orchestration/control/clarification-policy.ts   (new)
apps/server/src/orchestration/control/service.ts             (major rewrite)
apps/server/src/orchestration/control/store.ts                (7 new collections)
apps/server/src/orchestration/control/read-model.ts            (extended)
apps/server/src/orchestration/control/routes.ts                 (6 new routes)
apps/server/src/orchestration/control/*.test.ts                  (rewritten/extended)
docs/handoffs/task-1-control-plane.md                              (this file)
```

Baseline runner files (`apps/server/src/types.ts`, `codex-runner.ts`,
`container-codex-runner.ts`) were also touched — but that work is owned and
documented by Task 2 (see its handoff), since it's the `AgentRunner`
extension the engine needed (`executionId`, `sandboxMode`).

## Public exports / constructors (delta from v1)

- `OrchestrationControlService`: added `answerClarification(input)`,
  `startOrchestration(orchestrationId)`, `cancelOrchestration(orchestrationId)`.
  Constructor gained an optional 5th parameter,
  `clarificationPolicy?: ClarificationPolicyConfig` (defaults to
  `DEFAULT_CLARIFICATION_POLICY`).
- `createOrchestrationCoordinator(service: OrchestrationControlService)` —
  **signature changed** from v1 (`(store: OrchestrationStore)`). Now wraps
  the service so `cancelForAgent` performs real cancellation.
- `applyClarificationPolicy`, `DEFAULT_CLARIFICATION_POLICY`,
  `ClarificationPolicyConfig` (`control/clarification-policy.ts`).
- `contractCriterionSchema` / `criteriaOverrideSchema` (`control/service.ts`)
  — updated to include `provenance` (defaults `"user-explicit"`) and
  `sourceClaimId` (defaults `null`).
- `waitForPendingWork(orchestrationId)` — still test-only; now also covers
  the plan+execute background task, not just elaboration.

## Checks run

```
npm run typecheck   -> pass (server + web)
npm run test          -> 166 passed (24 test files: Task 1 control-plane +
                          Task 2 engine + baseline, see Task 2 handoff for the split)
npm run build          -> pass (web + server)
npm run check           -> pass end-to-end
```
Ran via `nvm use 22` (Node v22.23.2).

## Deliberate deviations / scope reductions (updated from v1)

Most v1 limitations are now resolved (cancellation, restart reconciliation,
events, task/artifact/verification persistence, plan/execute lifecycle).
What remains:

1. **`drafting-intent → failed` is still not a table edge.** If
   `driver.elaborateIntent` throws — including a denied budget reservation
   — the orchestration stays at `drafting-intent` with `.error` set,
   rather than moving to a terminal state. There is still no explicit
   "retry elaboration" route beyond calling create/revise again; Task 3
   should treat a `drafting-intent` orchestration with a non-null `.error`
   as retryable in the UI.
2. **Reservations are held in memory only**
   (`Map<reservationId, {orchestrationId, role, modelId}>` on the service
   instance). A process restart between `reserveModelCall` and
   `commitModelUsage` orphans the reservation. Acceptable for a
   single-process POC.
3. **`estimatedUsd` is always `null`/`"unknown"` unless a `PricingTable` is
   explicitly passed to the `OrchestrationControlService` constructor** —
   there is still no environment-variable wiring for per-role pricing; that
   is a Final Assembly concern (spec §9.3).
4. **Acceptance criteria are still auto-derived by Task 1's
   `deriveCriteria`, not returned by `plan()`.** Appendix A's `PlanResult`
   has no field for criteria; `confirmIntent`/`confirmAmendment` remain the
   single place criteria get constructed, now provenance-tagged from the
   grounded intent draft.
5. **The extra `POST .../amendments` route (propose) from v1 is still
   present** alongside the driver-originated `needs-user` path. Both are
   exercised by tests. Final Assembly should decide whether the manual
   propose route is still needed for the Task 3 UI or whether execution-time
   amendments alone cover the demo.

## Known limitations (restated for the demo/docs)

- No real identity/RBAC; the shared bearer token remains the only access
  control, per spec.
- `estimateExceedsBudget` at confirm time and `reserveModelCall`/
  `commitModelUsage` during elaboration/planning/execution are the two
  enforcement layers for "hard budget" — see the Task 2 handoff for how
  `budget-exhausted` is now genuinely reachable (via `running →
  budget-exhausted`) once real execution exists.
- Grounding quality (whether the planner's provenance/materiality
  judgments are actually good) depends entirely on Task 2's driver — Task 1
  only guarantees the *lifecycle and enforcement* around whatever the
  driver reports, not the semantic quality of that report.
