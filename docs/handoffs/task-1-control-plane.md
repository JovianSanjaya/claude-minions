# Task 1 handoff - Durable orchestration control plane

## Base commit and branch

Single shared checkout, no branch. Started from the repository as delivered, with
`apps/server/src/orchestration/contracts.ts` (frozen Appendix A) already present and
**unmodified** by this task.

## Scope

Implements section 6 of the parallel three-task specification: the trusted, persistent
control plane that owns lifecycle transitions, intent and contract versions, event
recording, redaction, usage/budget accounting, cancellation, restart reconciliation and
a Fastify route plugin. It calls an injected `OrchestrationExecutionDriver` and contains
**no** planner/worker/verifier/integrator model logic.

## Files changed

Created (all owned by Task 1):

```text
apps/server/src/orchestration/control/redaction.ts        199 lines
apps/server/src/orchestration/control/state-machine.ts    134 lines
apps/server/src/orchestration/control/store.ts            572 lines
apps/server/src/orchestration/control/budget-ledger.ts    503 lines
apps/server/src/orchestration/control/read-model.ts       218 lines
apps/server/src/orchestration/control/service.ts        2 413 lines
apps/server/src/orchestration/control/routes.ts           218 lines
apps/server/src/orchestration/control/redaction.test.ts
apps/server/src/orchestration/control/state-machine.test.ts
apps/server/src/orchestration/control/store.test.ts
apps/server/src/orchestration/control/budget-ledger.test.ts
apps/server/src/orchestration/control/service.test.ts
apps/server/src/orchestration/control/routes.test.ts
docs/handoffs/task-1-control-plane.md
```

Modified: **none**. `app.ts`, `index.ts`, `agent-service.ts`, `types.ts`, `config.ts`,
runner files, `contracts.ts`, all React files and all Task 2/Task 3 directories are
untouched. `routes.test.ts` *imports* `createApp` from `app.ts` to prove bearer-token
inheritance, but does not edit it.

---

## Public exports and constructors

### `control/service.ts` - the composition surface

```ts
export interface AgentAccessSummary {
  id: string;
  status: "ready" | "busy" | "stopped" | "error";
  workspacePath: string;
}

/** Small injected port for authoritative Agent lookup, status and workspace path. */
export interface AgentAccessPort {
  getAgent(agentId: string): Promise<AgentAccessSummary | null>;
}

/** Consumed by AgentService after Final Assembly (see "Integration steps"). */
export interface AgentExecutionCoordinator {
  assertAgentAvailableForDirect(agentId: string): Promise<void>; // throws HttpError(409)
  hasActiveOrchestration(agentId: string): Promise<boolean>;
  cancelForAgent(agentId: string): Promise<number>;              // returns count cancelled
}

export function createAgentExecutionCoordinator(
  service: OrchestrationControlService,
): AgentExecutionCoordinator;

export interface OrchestrationControlServiceOptions {
  store: OrchestrationStore;
  driver: OrchestrationExecutionDriver;   // Appendix A, Task 2 supplies the real one
  agents: AgentAccessPort;
  pricing?: PricingTable | undefined;     // {} or omitted => every dollar figure is null
  defaultBudget?: BudgetPolicy | undefined;
  clock?: (() => Date) | undefined;
  newId?: (() => string) | undefined;
  logger?: { error(message: string, error?: unknown): void } | undefined;
}

export class OrchestrationControlService {
  constructor(options: OrchestrationControlServiceOptions);

  initialize(): Promise<void>;                       // loads store + restart reconciliation
  createOrchestration(input: CreateOrchestrationInput): Promise<Orchestration>;
  listOrchestrations(agentId: string): Promise<Orchestration[]>;
  getOrchestration(orchestrationId: string): OrchestrationReadModel;   // throws 404
  listEvents(id: string, options?: { limit?: number; afterEventId?: string }): OrchestrationEvent[];
  listTasks(id: string): OrchestrationTask[];
  listArtifacts(id: string): SharedArtifact[];
  listVerifications(id: string): VerificationRecord[];
  reviseIntent(id: string, feedback: string): Promise<Orchestration>;
  confirmIntent(id: string, input: ConfirmIntentInput):
    Promise<{ orchestration: Orchestration; contract: ExecutionContract }>;
  startExecution(id: string): Promise<Orchestration>;
  cancel(id: string, reason?: string): Promise<Orchestration>;
  confirmAmendment(id: string, amendmentId: string):
    Promise<{ orchestration: Orchestration; contract: ExecutionContract }>;
  rejectAmendment(id: string, amendmentId: string, reason?: string): Promise<Orchestration>;
  createSink(orchestrationId: string): ControlPlaneSink;   // used internally; exposed for tests
  whenSettled(orchestrationId: string): Promise<void>;     // resolves when no phase is in flight

  // Coordinator operations, also available via createAgentExecutionCoordinator()
  assertAgentAvailableForDirect(agentId: string): Promise<void>;
  hasActiveOrchestration(agentId: string): Promise<boolean>;
  cancelForAgent(agentId: string): Promise<number>;
}

export interface CreateOrchestrationInput {
  agentId: string;
  prompt: string;
  requestedMode: RequestedExecutionMode;   // "auto" | "direct" | "orchestrated"
  budget?: BudgetOverrides | undefined;
}

export interface ConfirmIntentInput {
  confirm: true;                    // literal true; confirmation is never inferred
  answers?: string[] | undefined;   // one per unresolved material question, in order
  criteria?: ContractCriterion[] | undefined;   // optional override of derived criteria
}

export const ORCHESTRATION_EVENT_TYPES: { /* stable event type names, see below */ };
```

#### `ControlPlaneSink` - additive extension of the frozen `OrchestrationSink`

The object handed to `driver.elaborateIntent/plan/execute` implements the frozen
`OrchestrationSink` **plus** the following. A Task 2 driver typed against the frozen
interface keeps working unchanged; it may feature-detect or cast to use these.

```ts
export interface ControlPlaneSink extends OrchestrationSink {
  /** Bounded-retry enforcement point. Returns { allowed:false, reason } at the cap. */
  reserveWorkerAttempt(input: { taskId: string; executionId: string | null }): Promise<BudgetDecision>;

  /** Narrow context-expansion gate; counted and bounded per task. */
  requestContextExpansion(request: {
    taskId: string;
    executionId: string | null;
    reason: string;
    requestedPath: string;
  }): Promise<{ allowed: true; expansionId: string } | { allowed: false; reason: string }>;

  /** Optional lifecycle stage announcements: running -> integrating -> verifying. */
  markIntegrating(summary: string): Promise<void>;
  markVerifying(summary: string): Promise<void>;

  /** Records what happened to a temporary worker workspace. Task 2 does the filesystem work. */
  recordWorkspaceDisposition(disposition: {
    taskId: string | null;
    policy: "cleaned" | "archived" | "retained-for-debugging" | "unknown";
    location: string | null;
    reason: string;
  }): Promise<void>;
}
```

**Why this exists:** the frozen contract has no enforcement point for retries, context
expansions or stage announcements, all of which sections 6.6 and 6.7 require. Adding
them to `contracts.ts` would have been a cross-task contract change, which section 4.3
forbids in a task branch. This is the documented proposal for Final Assembly to fold in
if all three modules are updated together.

### `control/routes.ts`

```ts
export function registerOrchestrationRoutes(
  app: FastifyInstance,
  service: OrchestrationControlService,
): void;
```

Registers, all under `/api/*` so the existing bearer hook covers them:

| Method | Path | Success |
| --- | --- | ---: |
| POST | `/api/agents/:agentId/orchestrations` | 202 |
| GET | `/api/agents/:agentId/orchestrations` | 200 |
| GET | `/api/orchestrations/:orchestrationId` | 200 |
| PATCH | `/api/orchestrations/:orchestrationId/intent` | 202 |
| POST | `/api/orchestrations/:orchestrationId/confirm` | 202 |
| POST | `/api/orchestrations/:orchestrationId/start` | 202 |
| POST | `/api/orchestrations/:orchestrationId/cancel` | 200 |
| GET | `/api/orchestrations/:orchestrationId/events` | 200 |
| GET | `/api/orchestrations/:orchestrationId/tasks` | 200 |
| GET | `/api/orchestrations/:orchestrationId/artifacts` | 200 |
| GET | `/api/orchestrations/:orchestrationId/verifications` | 200 |
| POST | `/api/orchestrations/:orchestrationId/amendments/:amendmentId/confirm` | 202 |
| POST | `/api/orchestrations/:orchestrationId/amendments/:amendmentId/reject` | 200 |

Error mapping (via the existing `HttpError` + `ZodError` handler in `app.ts`):
`400` malformed input, `404` unknown Agent/orchestration/amendment, `409` illegal
transition or concurrency conflict, `422` semantically invalid confirmation/amendment.
Budget exhaustion is a persisted domain state (`status: "budget-exhausted"`), never a 5xx.

**Response shapes for Task 3:**
`GET /api/orchestrations/:id` returns the read model at the top level
(`{ orchestration, intentDraft, intentDraftHistory, activeContract, contractHistory,
pendingAmendment, amendments, plan, applicationMaps, tasks, contextPackets, attempts,
artifacts, verifications, events, workspaceDispositions, usage, budget }`), **not**
wrapped in `{ orchestration: <everything> }`. Collection routes wrap:
`{ events }`, `{ tasks }`, `{ artifacts }`, `{ verifications }`, `{ orchestrations }`.
Confirm/amendment-confirm return `{ orchestration, contract }`.
`GET .../events` accepts `?limit=1..1000` and `?afterEventId=<uuid>`.

### `control/store.ts`

```ts
export const ORCHESTRATION_SCHEMA_VERSION = 1;
export function emptyOrchestrationDatabase(): OrchestrationDatabase;
export class OrchestrationStoreError extends Error {}
export class OrchestrationStore {
  constructor(filePath: string);
  get databasePath(): string;
  initialize(): Promise<void>;
  snapshot(): OrchestrationDatabase;             // structuredClone
  mutate<T>(fn: (db: OrchestrationDatabase) => T | Promise<T>): Promise<T>;
}
export interface OrchestrationDatabase { /* see below */ }
export interface OrchestrationPlanRecord { ... }
export interface BudgetReservationRecord { ... }
export interface BudgetState { ... }
export interface WorkspaceDisposition { ... }
export interface BenchmarkReference { ... }      // placeholder for Task 3 correlation
```

Collections: `orchestrations`, `intentDrafts`, `contracts`, `amendments`, `plans`,
`tasks`, `applicationMaps`, `contextPackets`, `attempts`, `artifacts`, `verifications`,
`events`, `budgetStates`, `workspaceDispositions`, `benchmarks`.

### `control/budget-ledger.ts`

```ts
export interface ModelPricing {
  inputUsdPerMillionTokens: number;
  cachedInputUsdPerMillionTokens: number;
  outputUsdPerMillionTokens: number;
}
export type PricingTable = Readonly<Record<string /* modelId */, ModelPricing>>;
export type BudgetOverrides = { [K in keyof BudgetPolicy]?: BudgetPolicy[K] | undefined };

export const DEFAULT_BUDGET_POLICY: BudgetPolicy;   // see "Configuration added"
export const BUDGET_LIMITS: { /* absolute ceilings for browser input */ };

export class PricingBook {
  constructor(table?: PricingTable);
  get isConfigured(): boolean;
  has(modelId: string): boolean;
  estimateUsd(modelId: string, usage: TokenUsage): number | null;   // null when unpriced
}

export function normalizeTokenUsage(usage): TokenUsage;
export function emptyUsageLedger(pricingConfigured: boolean): UsageLedger;
export function createBudgetState(orchestrationId: string, startedAt: string | null): BudgetState;
export function openReservationTotals(state, pricing): { inputTokens; outputTokens; estimatedUsd };
export function evaluateModelCall(context: BudgetContext, reservation: ModelCallReservation): BudgetEvaluation;
export function evaluateWorkerAttempt(context: BudgetContext, taskId: string): BudgetEvaluation;
export function evaluateContextExpansion(context: BudgetContext, taskId: string): BudgetEvaluation;
export function applyUsage(ledger, role, modelId, actual, pricing): UsageLedger;
export function normalizeBudgetPolicy(overrides: BudgetOverrides | undefined, defaults?): BudgetPolicy;
```

### `control/state-machine.ts`

```ts
export const ORCHESTRATION_STATUSES: readonly OrchestrationStatus[];
export const TERMINAL_STATUSES: ReadonlySet<OrchestrationStatus>;        // completed|failed|cancelled|budget-exhausted
export const WORKSPACE_ACTIVE_STATUSES: ReadonlySet<OrchestrationStatus>; // running|integrating|verifying
export const INTERRUPTIBLE_STATUSES: ReadonlySet<OrchestrationStatus>;   // restart reconciliation targets
export const LEGAL_TRANSITIONS: Readonly<Record<OrchestrationStatus, readonly OrchestrationStatus[]>>;
export class IllegalTransitionError extends HttpError {}   // statusCode 409
export function isTerminalStatus(s): boolean;
export function canTransition(from, to): boolean;
export function assertTransition(from, to): void;          // throws IllegalTransitionError
export function completionPath(from): readonly OrchestrationStatus[];
```

### `control/read-model.ts`

```ts
export interface OrchestrationReadModel { ... }
export interface BudgetStatusView { policy; modelCalls; steps; workerAttempts;
  contextExpansions; openReservations; wallClockStartedAt; elapsedMs; exhaustedReason }
export interface PlanView { selectedMode; routeReason; applicationMapVersion; taskIds; createdAt }
export function buildReadModel(db, orchestrationId, options?): OrchestrationReadModel | null;
export function listOrchestrationsForAgent(db, agentId): Orchestration[];
export function findOrchestration(db, orchestrationId): Orchestration | null;
export function buildBudgetStatus(db, orchestration, nowMs): BudgetStatusView;
```

### `control/redaction.ts`

```ts
export const REDACTED = "[redacted]";
export function redactString(value: string, limit?: number): string;
export function redactRecord<T>(value: T): T;        // applied before every persist
export function redactForResponse<T>(value: T): T;   // redactRecord + absolute-path masking
export function maskFilesystemPaths(value: string): string;
export function truncate(value: string, limit: number): string;
```

### Stable event type names (`ORCHESTRATION_EVENT_TYPES`)

`orchestration.created`, `orchestration.status-changed`, `orchestration.restart-reconciled`,
`intent.drafted`, `intent.revision-requested`, `estimate.recorded`, `contract.confirmed`,
`plan.recorded`, `execution.started`, `budget.reserved`, `budget.denied`, `usage.committed`,
`usage.orphaned`, `task.upserted`, `application-map.recorded`, `context-packet.recorded`,
`context.expansion-granted`, `context.expansion-denied`, `worker.attempt-reserved`,
`worker.attempt-denied`, `worker.attempt-recorded`, `artifact.published`,
`artifact.dependency-stale`, `verification.recorded`, `integration.started`,
`verification.started`, `amendment.pending`, `amendment.confirmed`, `amendment.rejected`,
`workspace.disposition`, `orchestration.cancelled`, `orchestration.cancellation-reconciled`,
`orchestration.completed`, `orchestration.failed`, `orchestration.budget-exhausted`,
`orchestration.outcome-ignored`.

Task 3 should filter timelines on these strings; drivers may emit additional custom types
through `sink.recordEvent`, which are stored and returned as-is (after redaction).

---

## Exact checks run and results

```bash
# from /root/work/codejam
npx tsc -p apps/server/tsconfig.json --noEmit
# -> exit 0, no diagnostics

# from /root/work/codejam/apps/server
npx vitest run src/orchestration/control
# -> Test Files 6 passed (6);  Tests 82 passed (82)

npx vitest run                     # whole server workspace, incl. baseline regressions
# -> Test Files 18 passed (18);  Tests 150 passed (150)
```

`npm run check` at the repository root was **not** run by this task, per the brief: it
also builds `apps/web` and depends on Task 2 and Task 3 files that were still being
written in the shared checkout. Final Assembly owns that gate.

### Test coverage against section 6.10

| Required test | File | Status |
| --- | --- | --- |
| Empty-store creation and reload | `store.test.ts`, `service.test.ts` | covered |
| Corrupted / unknown-version rejection | `store.test.ts` | covered (newer version, bad JSON, bad shape, older version) |
| Concurrent mutation serialization | `store.test.ts` | covered (25 parallel read-modify-writes) |
| Failed-persist recovery | `store.test.ts` | covered (EISDIR on the temp path, then recovery + reload) |
| Redaction before disk and before API response | `store.test.ts`, `service.test.ts`, `redaction.test.ts` | covered |
| create -> draft -> revise -> await -> confirm -> plan -> ready | `service.test.ts` | covered |
| Every legal transition / representative illegal | `state-machine.test.ts` | covered (23 legal, 14 illegal) |
| No planning before explicit confirmation | `service.test.ts`, `routes.test.ts` | covered |
| Immutable contract history | `service.test.ts` | covered (v1 byte-identical after v2) |
| Pending material amendment requiring renewed confirmation | `service.test.ts`, `routes.test.ts` | covered (confirm and reject paths) |
| Atomic one-active-orchestration rule | `service.test.ts` | covered (5 concurrent creates, 1 wins) |
| Token/cost/attempt/context/wall-clock budget decisions | `budget-ledger.test.ts`, `service.test.ts` | covered |
| Unknown pricing semantics | `budget-ledger.test.ts`, `service.test.ts` | covered |
| Role and total usage aggregation | `budget-ledger.test.ts`, `service.test.ts` | covered |
| Cancellation idempotency and driver cancellation | `service.test.ts` | covered |
| Restart reconciliation | `service.test.ts` | covered (running cancelled, awaiting-confirmation preserved) |
| All route status codes and Zod failures | `routes.test.ts` | covered (202/200/400/404/409/422) |
| Protected fields and secrets absent from read models | `service.test.ts` | covered (disk + serialized response) |
| Bearer-token protection with the plugin registered | `routes.test.ts` | covered (13 routes -> 401, then 200 with token) |

### Task 1 acceptance (section 6.11)

`service.test.ts > "Task 1 acceptance journey" > "drives create, draft, revise, confirm,
plan, ready, start, verify, completed"` asserts the exact status-change sequence:

```text
awaiting-confirmation -> drafting-intent -> awaiting-confirmation -> planning
-> ready -> running -> integrating -> verifying -> completed
```

with real asynchronous fake-driver results at each step, and
`"survives a reload of the store"` proves durability. Budget denial
(`"stops at budget-exhausted instead of reporting success"`,
`"ignores a late success reported after the budget stop"`) and cancellation
(`"cancels driver work, is idempotent, and never becomes a success"`) both prove no
invalid success state is reachable.

---

## Configuration added

No `config.ts` edits (Task 2 owns that file). The control plane takes configuration as
constructor arguments; Final Assembly wires environment variables to them.

| Option | Default | Notes |
| --- | --- | --- |
| store file | caller-supplied | recommend `path.join(config.dataDirectory, "orchestrations.json")`; `launchpad.json` is left intact |
| `pricing` | `{}` | `Record<modelId, {inputUsdPerMillionTokens, cachedInputUsdPerMillionTokens, outputUsdPerMillionTokens}>`. Empty => `pricingStatus: "unknown"` and every dollar figure `null` |
| `defaultBudget.maxInputTokens` | `2_000_000` | `null` = no limit |
| `defaultBudget.maxOutputTokens` | `400_000` | |
| `defaultBudget.maxEstimatedUsd` | `null` | only enforceable when pricing is configured |
| `defaultBudget.maxModelCalls` | `60` | |
| `defaultBudget.maxSteps` | `400` | a "step" = a reserved model call, worker attempt, context expansion, recorded attempt, published artifact or recorded verification |
| `defaultBudget.maxWorkerAttempts` | `3` | per task |
| `defaultBudget.maxContextExpansionsPerTask` | `3` | |
| `defaultBudget.maxWallClockMs` | `900_000` | measured from orchestration creation |
| `clock`, `newId`, `logger` | `Date`, `randomUUID`, none | injected for deterministic tests |

Browser-supplied budget overrides are bounded twice: by Zod in `routes.ts` and again by
`normalizeBudgetPolicy` (`BUDGET_LIMITS`: 50M input tokens, 10M output tokens, 10 000 USD,
10 000 calls, 100 000 steps, 50 attempts, 100 expansions, 6 hours). Negative, `NaN`,
`Infinity` and unknown fields are rejected or clamped.

Suggested environment variable names for Final Assembly (not implemented here, since
`config.ts` is Task 2-owned): `ORCHESTRATION_DB_FILE`, `ORCHESTRATION_MAX_MODEL_CALLS`,
`ORCHESTRATION_MAX_WALL_CLOCK_MS`, `ORCHESTRATION_MAX_WORKER_ATTEMPTS`,
`ORCHESTRATION_MAX_CONTEXT_EXPANSIONS`, `ORCHESTRATION_MAX_ESTIMATED_USD`,
`MODEL_PRICE_<ROLE>_INPUT|CACHED|OUTPUT`.

## Fake/test adapters used

All fakes live only inside `*.test.ts`. No production mock exists anywhere in `src`.

- `FakeDriver implements OrchestrationExecutionDriver` (`service.test.ts`, `routes.test.ts`):
  deterministic intent draft, estimate, plan (multi-worker, two tasks, application map v1)
  and execution. Overridable per test via `onElaborate` / `onPlan` / `onExecute` /
  `onCancel`, plus counters (`elaborateCount`, `planCount`, `executeCount`, `cancelCount`)
  and `materialQuestions`. Its default `execute` emits a realistic correlated evidence
  trail through the sink: reservations, usage commits, context packets, attempts, task
  upserts, an artifact version bump, integration/verification stage marks, a global
  verification record and a workspace disposition.
- `FakeAgents implements AgentAccessPort`: in-memory map of `AgentAccessSummary`.
- `agentServiceStub` (`routes.test.ts`): minimal `AgentService` cast so the real
  `createApp` can boot for the bearer-token assertions.
- Deterministic `newId` counter producing valid UUID-shaped ids so route param
  validation is exercised with realistic values.
- Temporary store files under `os.tmpdir()`, removed in `afterEach`.

---

## Integration steps for Final Assembly

1. **`apps/server/src/index.ts`** - create and initialize the store and service before
   `app.listen`, so restart reconciliation runs first:

   ```ts
   import path from "node:path";
   import { OrchestrationStore } from "./orchestration/control/store.js";
   import {
     OrchestrationControlService,
     createAgentExecutionCoordinator,
     type AgentAccessPort,
   } from "./orchestration/control/service.js";

   const orchestrationStore = new OrchestrationStore(
     path.join(config.dataDirectory, "orchestrations.json"),
   );

   const agentAccess: AgentAccessPort = {
     async getAgent(agentId) {
       try {
         const agent = service.getAgent(agentId);        // existing AgentService
         return { id: agent.id, status: agent.status, workspacePath: agent.workspacePath };
       } catch {
         return null;                                     // 404 becomes "not found"
       }
     },
   };

   const control = new OrchestrationControlService({
     store: orchestrationStore,
     driver: executionDriver,          // Task 2's real driver
     agents: agentAccess,
     pricing: config.modelPricing,     // {} if unconfigured -> dollars stay null
     defaultBudget: config.orchestrationBudget,
     logger: app.log,
   });
   await control.initialize();          // MUST run before listen()
   ```

2. **`apps/server/src/app.ts`** - register the plugin **after** the existing bearer-token
   `onRequest` hook (anywhere after that hook is fine; the routes are plain
   `/api/*` registrations):

   ```ts
   import { registerOrchestrationRoutes } from "./orchestration/control/routes.js";
   // ... after the auth hook and the existing routes:
   registerOrchestrationRoutes(app, orchestrationControlService);
   ```

   `createApp`'s signature must grow an optional parameter for the control service (or a
   composition object); this task deliberately did not make that edit.

3. **`AgentService` coordinator wiring** (Task 2 adds the optional port, Final Assembly
   injects the adapter):

   ```ts
   const coordinator = createAgentExecutionCoordinator(control);
   // AgentService.sendMessage -> await coordinator.assertAgentAvailableForDirect(agentId)
   //   before accepting a direct Run (throws HttpError 409 when an orchestration owns
   //   the workspace: status running | integrating | verifying)
   // AgentService.stopAgent  -> await coordinator.cancelForAgent(agentId)
   // AgentService.deleteAgent-> await coordinator.cancelForAgent(agentId) BEFORE archiving
   //   the workspace (section 6.9 defers Agent deletion integration to Final Assembly)
   ```

   `AgentExecutionCoordinator`'s three methods are all `async`; a default no-op port must
   keep existing `AgentService` construction and tests working when omitted.

4. **Driver contract** - Task 2's driver receives a `ControlPlaneSink` (a superset of the
   frozen `OrchestrationSink`). To get bounded retries, context expansions and stage marks,
   cast or feature-detect:

   ```ts
   const control = sink as Partial<ControlPlaneSink> & OrchestrationSink;
   await control.reserveWorkerAttempt?.({ taskId, executionId });
   await control.requestContextExpansion?.({ taskId, executionId, reason, requestedPath });
   await control.markIntegrating?.("deterministic merge");
   ```

   A denied reservation or attempt means **stop new work**; the control plane has already
   recorded the event and moved the orchestration to `budget-exhausted`, and it aborts the
   signal and calls `driver.cancel`. Whatever the driver returns afterwards is recorded as
   `orchestration.outcome-ignored` and cannot resurrect a success.

5. **Task 3 UI** - use the response shapes documented above and the
   `ORCHESTRATION_EVENT_TYPES` names for timeline filters. `usage.pricingStatus === "unknown"`
   must render as "Pricing not configured", never a fabricated dollar value; use the phrase
   "estimated cost".

6. **Integrated tests** (section 9.5) can reuse the patterns in
   `control/routes.test.ts`, which already registers the plugin on the real `createApp`.

---

## Known limitations and deliberate narrowing

Documented rather than faked, per section 5.

1. **Single process only.** `orchestrations.json` uses the same one-writer model as the
   baseline `launchpad.json`. PostgreSQL with row-level leases is the production evolution
   for multi-process execution; not implemented, by instruction.
2. **Redaction is defence in depth, not a proof of secrecy.** A credential that is
   syntactically indistinguishable from an ordinary identifier - a bare UUID Ark key with
   no surrounding `KEY=` / `"api_key":` / `Bearer` context - cannot be detected and will be
   stored. Detected patterns: `Bearer <token>`, `sk-…`, `NAME_KEY|TOKEN|SECRET|PASSWORD|
   CREDENTIAL|ACCESS_KEY|PRIVATE_KEY=…`, JSON/kv secret assignments, secret-named string
   fields, and whole-key drops for `reasoning`, `chainOfThought`, `protectedTestSource`,
   `evaluatorSource`, `sourceCode`, `fileContents`, `env`/`environment` and relatives.
3. **Absolute-path masking is prefix-based.** `redactForResponse` masks paths under
   `/home`, `/root`, `/Users`, `/var`, `/tmp`, `/private`, `/opt`, `/srv`, `/mnt`, `/data`,
   `/workspaces`, `/codex-home`, `/Applications`, `/Library`, keeping the last two segments
   (`<path>/src/reset.ts`). A path under an unusual root would not be masked. Stored data
   keeps the original path so an operator can debug on the trusted host; only responses are
   masked.
4. **Amendments are always user-gated.** The spec requires renewed confirmation for
   *material* amendments. This implementation gates **all** amendments (including
   `material: false`) behind explicit confirm/reject. Conservative, but it means a driver
   cannot auto-apply a "minor" contract change.
5. **Amendment rejection returns to `awaiting-confirmation`,** not straight back to
   `planning`. The previously confirmed contract remains active and unmodified; the user
   must confirm again (producing the next contract version) to resume. This is one of two
   legal readings of `needs-user -> awaiting-confirmation | planning`.
6. **Acceptance criteria are derived by the control plane** from the confirmed intent
   (requirements -> functional/`protected-test`, architecture decisions ->
   architectural/`static-check`, non-goals -> scope/`static-check`, manual expectations ->
   manual/`manual`, plus one always-present runtime criterion for existing regressions).
   The frozen `IntentDraft` carries no criteria, so either the control plane derives them
   or the confirm request supplies them explicitly (both supported). A future planner-
   supplied criteria channel would need a `contracts.ts` change.
7. **Integration/verification stages are control-plane markers.** If the driver calls
   `markIntegrating`/`markVerifying` the transitions happen when the work happens;
   otherwise the control plane walks `running -> integrating -> verifying -> completed` on
   a `completed` outcome so the state machine is never skipped. The *evidence* of what was
   actually verified comes from the driver's `VerificationRecord`s, not from these markers.
8. **Dependency drift is detected, not acted on.** `publishArtifact` emits
   `artifact.dependency-stale` naming the affected task ids, but does not change task
   status - Task 2's engine owns marking work stale and refreshing it (capability matrix
   row: "Artifacts and dependency drift" -> primary Task 2).
9. **Direct-run blocking is limited to workspace-owning states**
   (`running`, `integrating`, `verifying`). An orchestration sitting in
   `awaiting-confirmation`, `ready` or `needs-user` does not block a direct Playground run,
   because nothing is writing the workspace. `planning` is also not blocked (it only reads).
10. **Wall-clock budget starts at creation,** so time spent waiting for the user to confirm
    counts against it. Deliberate (it bounds an abandoned orchestration) but worth knowing
    when choosing `maxWallClockMs` for a demo.
11. **The estimated-dollar budget cannot be enforced without pricing.** With
    `pricingStatus: "unknown"` the token, call, step, attempt and wall-clock limits are the
    effective bound; `maxEstimatedUsd` is skipped rather than guessed.
12. **Event storage is bounded** at 1 000 events per orchestration and 10 000 total
    (oldest dropped). Long runs lose the earliest timeline entries.
13. **Cancel on a `budget-exhausted` orchestration is accepted (200) but does not change
    the status.** It aborts the signal, calls `driver.cancel` and records
    `orchestration.cancellation-reconciled`, keeping the budget stop as the truthful
    terminal state. Cancel on `completed`/`failed` returns 409.
14. **`confirm: false` is a 400, not a 422.** Shape violations are Zod/400; only semantic
    failures (unanswered material questions, already-decided amendment, no draft to
    confirm) are 422.
15. **No filesystem cleanup is performed here.** `recordWorkspaceDisposition` stores the
    policy metadata only; Task 2 performs the actual temp-workspace cleanup or archive
    (section 6.9).
16. **`npm run check` not run by this task** - see "Exact checks run".

## Deviations from Appendix A

`apps/server/src/orchestration/contracts.ts` is **byte-unchanged**. No Appendix A type was
renamed, reordered, extended or reformatted.

Two additive, non-breaking extensions live entirely inside `control/`:

1. `ControlPlaneSink extends OrchestrationSink` with `reserveWorkerAttempt`,
   `requestContextExpansion`, `markIntegrating`, `markVerifying` and
   `recordWorkspaceDisposition` (rationale above). **Proposed** for Appendix A if Final
   Assembly wants a single interface; would require updating Tasks 1, 2 and 3 together.
2. Control-plane-private persisted records not present in Appendix A, kept in the Task 1
   database only: `OrchestrationPlanRecord` (carries `routeReason`, which `Orchestration`
   has no field for), `BudgetState` / `BudgetReservationRecord` (the counters
   `BudgetPolicy` measures against), `WorkspaceDisposition`, and a `benchmarks`
   placeholder collection for Task 3 correlation.

Two documented supersets of the section 6.4 minimum transition table:

- `failed` is reachable from every active state (any driver call may reject);
- `budget-exhausted` is reachable from `planning`, `integrating` and `verifying` as well
  as `running`, because a budget denial can occur in any of those phases.

Both are supersets: every transition the specification lists is legal, and no listed
illegal transition was made legal. `running -> completed` remains illegal - completion is
only reachable through `verifying`.
