# Handoff — Task 3: product experience, benchmark, and submission evidence

## Base commit and branch

Single shared checkout, no branch. Task 3 worked only inside its owned files
(section 8.2 of the specification) while Task 1 and Task 2 worked in parallel in
disjoint directories.

**Final Assembly was deliberately NOT performed by this task.** `app.ts`,
`index.ts`, `App.tsx`, `api.ts`, and `types.ts` are untouched, even though
completed Task 1 and Task 2 modules are present in the checkout. A separate
Final Assembly step owns them so nobody races on the composition roots.

---

## 1. Files created or changed

### Server — benchmark module (new)

```text
apps/server/src/orchestration/benchmark/service.ts        (new)
apps/server/src/orchestration/benchmark/routes.ts         (new)
apps/server/src/orchestration/benchmark/service.test.ts   (new)
apps/server/src/orchestration/benchmark/routes.test.ts    (new)
apps/server/src/orchestration/benchmark/fixtures.test.ts  (new, test-only fakes)
```

### Web — orchestration module (new)

```text
apps/web/src/orchestration/contracts.ts                   (new)
apps/web/src/orchestration/api-port.ts                    (new)
apps/web/src/orchestration/view-model.ts                  (new)
apps/web/src/orchestration/polling.ts                     (new)
apps/web/src/orchestration/OrchestrationPanel.tsx         (new)
apps/web/src/orchestration/orchestration.css              (new)
apps/web/src/orchestration/components/StatusBadge.tsx     (new)
apps/web/src/orchestration/components/ModeSelector.tsx    (new)
apps/web/src/orchestration/components/IntentReview.tsx    (new)
apps/web/src/orchestration/components/PlanBoard.tsx       (new)
apps/web/src/orchestration/components/EvidenceTimeline.tsx(new)
apps/web/src/orchestration/components/UsagePanel.tsx      (new)
apps/web/src/orchestration/components/BenchmarkPanel.tsx  (new)
apps/web/src/orchestration/view-model.test.ts             (new)
apps/web/src/orchestration/polling.test.ts                (new)
apps/web/src/orchestration/panel-contract.test.tsx        (new)
```

### Documentation

```text
README.md                (extended, baseline content preserved)
.env.example             (extended, baseline content preserved)
docs/ARCHITECTURE.md     (extended, baseline content preserved)
docs/DEMO.md             (new)
docs/THREAT_MODEL.md     (new)
docs/TECHJAM_SUBMISSION.md (new)
docs/handoffs/task-3-experience-evidence.md (this file)
```

`apps/server/src/orchestration/contracts.ts` was already present and matches
Appendix A. **It was not modified.**

---

## 2. Public exports and constructors

### 2.1 `OrchestrationApi` (web) — Final Assembly implements this

`apps/web/src/orchestration/api-port.ts`. Every method returns the raw parsed
JSON body as `unknown`; `view-model.ts` narrows it. Method names and JSDoc match
Task 1's 13 routes exactly, so an adapter is one line per method.

```ts
export interface OrchestrationApi {
  createOrchestration(agentId: string, input: CreateOrchestrationInput): Promise<unknown>;
  listOrchestrations(agentId: string): Promise<unknown>;
  getOrchestration(orchestrationId: string): Promise<unknown>;
  reviseIntent(orchestrationId: string, input: ReviseIntentInput): Promise<unknown>;
  confirmIntent(orchestrationId: string, input: ConfirmIntentInput): Promise<unknown>;
  startOrchestration(orchestrationId: string): Promise<unknown>;
  cancelOrchestration(orchestrationId: string, reason?: string): Promise<unknown>;
  confirmAmendment(orchestrationId: string, amendmentId: string): Promise<unknown>;
  rejectAmendment(orchestrationId: string, amendmentId: string, reason?: string): Promise<unknown>;
  createBenchmark(agentId: string, input: CreateBenchmarkInput): Promise<unknown>;
  getBenchmark(benchmarkId: string): Promise<unknown>;
  cancelBenchmark(benchmarkId: string): Promise<unknown>;

  // Optional; the read model already carries this data.
  listEvents?(orchestrationId: string): Promise<unknown>;
  listTasks?(orchestrationId: string): Promise<unknown>;
  listArtifacts?(orchestrationId: string): Promise<unknown>;
  listVerifications?(orchestrationId: string): Promise<unknown>;
}

interface CreateOrchestrationInput { prompt: string; requestedMode: RequestedExecutionMode; budget?: Partial<BudgetPolicy>; }
interface ReviseIntentInput  { feedback: string; }                       // matches Task 1's PATCH body
interface ConfirmIntentInput { confirm: true; answers?: string[]; criteria?: ContractCriterion[]; }
interface CreateBenchmarkInput { prompt: string; criteria?: ContractCriterion[]; budget?: Partial<BudgetPolicy>; }
```

Also exported: `OrchestrationApiError(message, status)`.

### 2.2 `OrchestrationPanel` props

`apps/web/src/orchestration/OrchestrationPanel.tsx` — named and default export.

```ts
export interface OrchestrationPanelProps {
  agentId: string;                       // required
  agentStatus: "ready" | "busy" | "stopped" | "error";   // required, authoritative
  api: OrchestrationApi;                 // required, injected
  agentName?: string;
  onDirectSend?: (prompt: string) => Promise<void> | void; // omit -> Direct disabled, not faked
  system?: OrchestrationSystemSummary | null;              // from /api/system
  initialOrchestrationId?: string | null;
  onTerminalState?: (view: OrchestrationReadModel) => void; // host refreshes real state
  pollingOptions?: Partial<BackoffOptions>;  // test seam
  scheduler?: Scheduler;                     // test seam
  now?: () => number;                        // test seam
}
```

The panel never calls `fetch`, imports nothing from `apps/server`, and holds no
mock server.

### 2.3 Useful `view-model.ts` exports

`normalizeReadModel`, `normalizeBenchmark`, `normalizeSummaryList`,
`mergeCollections`, `extractOrchestrationId`, `extractBenchmarkId`,
`modeToAction`, `confirmationGate`, `filterEvents`, `eventMatchesFilter`,
`summarizeUsage`, `budgetGauges`, `budgetStopReason`, `elapsedMsFor`,
`evidenceCounters`, `compareEstimateToActual`, `presentBenchmark`,
`isTerminalStatus`, `isTerminalBenchmark`, `safeText`, `safePath`,
`formatEstimatedUsd`, `PRICING_NOT_CONFIGURED`, `EXECUTION_MODE_DESCRIPTORS`.

### 2.4 `polling.ts` exports

`createPoller(config)`, `reducePollState`, `initialPollState`,
`DEFAULT_BACKOFF`, `browserScheduler`, types `Poller`, `PollState`,
`BackoffOptions`, `Scheduler`, `PollerConfig<T>`.

### 2.5 `BenchmarkService` (server) — constructor and ports

`apps/server/src/orchestration/benchmark/service.ts`.

```ts
new BenchmarkService({
  agents: BenchmarkAgentPort,                        // required
  workspaces: BenchmarkWorkspaceProvider,            // required
  executors: Record<"direct" | "orchestrated", BenchmarkExecutor>, // required
  store?: BenchmarkRecordStore,        // default: InMemoryBenchmarkStore
  defaultBudget?: BudgetPolicy,        // default: DEFAULT_BENCHMARK_BUDGET
  armOrder?: BenchmarkArm[],           // default: ["direct", "orchestrated"]
  now?: () => number,
  newId?: () => string,
})
```

Methods: `initialize()`, `create(agentId, input)` (throws `HttpError` 400/404/409),
`get(id)`, `list(agentId)`, `cancel(id)`, `whenSettled(id)` (terminal-state
promise, used by tests and demo scripts).

**Ports Final Assembly must implement:**

```ts
interface BenchmarkAgentPort {
  getAgent(agentId: string): Promise<{ id: string; status: string; workspacePath: string } | null>;
}

interface BenchmarkWorkspaceProvider {
  capture(input: { benchmarkId: string; agentId: string; workspacePath: string })
    : Promise<BenchmarkSourceSnapshot>;
}
interface BenchmarkSourceSnapshot {
  sourceSnapshotHash: string;
  clone(arm: BenchmarkArm): Promise<BenchmarkArmWorkspace>;
  dispose(): Promise<void>;
}
interface BenchmarkArmWorkspace {
  label: string;         // safe evidence label; NOT an absolute host path
  path: string;          // absolute, executor-only, never persisted or returned
  snapshotHash: string;  // must equal sourceSnapshotHash
  dispose(): Promise<void>;
}

interface BenchmarkExecutor {
  readonly arm: BenchmarkArm;
  execute(input: BenchmarkExecutorInput): Promise<BenchmarkExecutorResult>;
  cancel?(benchmarkId: string): Promise<void>;
}
interface BenchmarkExecutorInput {
  benchmarkId: string; agentId: string; arm: BenchmarkArm;
  prompt: string;                    // identical across arms
  criteria: ContractCriterion[];     // identical across arms (cloned per arm)
  budget: BudgetPolicy;
  workspace: BenchmarkArmWorkspace;
  signal: AbortSignal;
}
interface BenchmarkExecutorResult {
  executionId: string;
  selectedMode: SelectedExecutionMode | null;
  succeeded: boolean;
  verifications: BenchmarkVerificationSummary[];
  usage: UsageLedger;
  counters: Partial<BenchmarkCounters>;
  finalOutputSummary?: string | null;
  observedWorkspaceHash?: string | null;
}
```

**Production-ready implementations already provided in `service.ts`:**

- `FileSystemBenchmarkWorkspaceProvider(temporaryRoot, retainForDebugging = false)`
  — copies the Agent workspace once, hashes it, then clones per arm. Excludes
  `.git`, `node_modules`, build output, coverage, Runtime state, and `.env*`.
  Cleanup targets only the resolved `benchmark-<id>` directory.
- `InMemoryBenchmarkStore` and `FileBenchmarkStore(filePath)` — the file store
  uses schema version 1, serialized mutations, mode-0600 temp file plus atomic
  rename, and reconciles interrupted `running` benchmarks to `cancelled` on
  `initialize()`.
- Helpers: `compareArms`, `armPassedQuality`, `hashDirectory`,
  `redactAndBound`, `mergeBudget`, `emptyUsageLedger`,
  `DEFAULT_BENCHMARK_BUDGET`.

### 2.6 Benchmark routes

`registerBenchmarkRoutes(app: FastifyInstance, service: BenchmarkService): void`

```text
POST /api/agents/:agentId/benchmarks      202 { benchmark }   400 / 404 / 409
GET  /api/agents/:agentId/benchmarks      200 { benchmarks }
GET  /api/benchmarks/:benchmarkId         200 { benchmark }   400 / 404
POST /api/benchmarks/:benchmarkId/cancel  202 { benchmark }   400 / 404
```

Handlers resolve their own status codes via `reply.code(...)`, so the plugin
behaves identically with or without a host error handler. It assumes the
application's existing bearer-token `onRequest` hook protects `/api/*` and adds
no second authentication mechanism.

---

## 3. Exact checks run and results

All run from the repository root unless noted.

| Check | Command | Result |
| --- | --- | --- |
| Server typecheck | `npx tsc -p apps/server/tsconfig.json --noEmit` | **Pass**, no output |
| Benchmark tests | `cd apps/server && npx vitest run src/orchestration/benchmark` | **Pass** — 3 files, 22 tests |
| Full server suite | `cd apps/server && npx vitest run` | **Pass** — 26 files, 231 tests (includes Task 1 and Task 2 suites; no regressions) |
| Web typecheck | `cd apps/web && npx tsc -b --force --pretty false` | **Pass**, no output |
| Web helper tests | `npx vitest run --root apps/web` | **Pass** — 3 files, 38 tests |
| Web production build | `npm run build -w @launchpad/web` | **Pass** — `tsc -b` then `vite build` |

`npm run check` was **not** run by this task: the brief explicitly deferred it to
Final Assembly. All of its constituent parts pass individually as listed above.

Test coverage against specification 8.12:

- API/UI view-model validation and safe unknown-field handling ✓
- mode-to-action mapping ✓
- confirmation disabled for unresolved material questions ✓
- terminal-state and cleanup behaviour in polling ✓
- retry/backoff helper behaviour ✓
- event filters and status mapping ✓
- usage/cost totals and unknown-pricing display ✓
- no protected/source/secret fields rendered by view models ✓
- benchmark same-snapshot isolation ✓
- same criteria across benchmark arms ✓
- quality/verification presented before cost ✓
- model/pricing comparability warnings ✓
- benchmark cancellation/failure/reload ✓
- Fastify route validation with fake benchmark executors ✓
- server and web TypeScript builds ✓
- full `npm run check` — deferred to Final Assembly

---

## 4. Configuration added

`.env.example` documents the orchestration block. **Every variable listed there
is already parsed by `apps/server/src/config.ts` (Task 2's file); Task 3 added
documentation only, no config code.**

- `ORCHESTRATION_{PLANNER,WORKER,VERIFIER,INTEGRATOR}_MODEL`
- `ORCHESTRATION_MODEL_PRICING` (JSON; missing entries keep dollars `null`)
- `ORCHESTRATION_{TEMP,ARCHIVE,RUNTIME_HOME}_ROOT`, `PROTECTED_EVALUATOR_ROOT`
- `ORCHESTRATION_CLEANUP_POLICY`
- `ORCHESTRATION_MAX_{INPUT_TOKENS,OUTPUT_TOKENS,ESTIMATED_USD,MODEL_CALLS,STEPS,WORKER_ATTEMPTS,CONTEXT_EXPANSIONS,WALL_CLOCK_MS}`

The benchmark deliberately introduces **no new environment variable**. Final
Assembly should pass `config.orchestration.tempRoot` to
`FileSystemBenchmarkWorkspaceProvider`. `.env.example` says exactly that.

---

## 5. Fake and test adapters used

All fakes live in `*.test.ts` / `*.test.tsx` files and are unreachable from
application code (specification 4.4). No production mock server exists.

| Fake | File | Purpose |
| --- | --- | --- |
| `FakeAgentPort` | `benchmark/fixtures.test.ts` | Deterministic Agent lookup |
| `FakeWorkspaceProvider` | `benchmark/fixtures.test.ts` | In-memory snapshot/clone with controllable per-arm hashes |
| `RecordingExecutor` | `benchmark/fixtures.test.ts` | Records the exact input each arm received; supports result / throw / hang |
| `ManualScheduler` | `polling.test.ts` | Deterministic timer control, no real clock |
| `InTestOrchestrationApi` | `panel-contract.test.tsx` | Full `OrchestrationApi` implementation returning Task 1's real response shapes |

`fixtures.test.ts` carries one trivial test because Vitest requires at least one
test per collected file. The server `tsconfig.json` excludes `src/**/*.test.ts`,
so none of this reaches `dist`.

---

## 6. Known limitations and deliberate narrowings

Stated openly rather than represented as done:

1. **No web test runner is wired into `npm run check`.** `apps/web/package.json`
   has no `test` script and is not in Task 3's owned file list, so it was not
   edited. The web tests run via `npx vitest run --root apps/web` (Vitest
   resolves from the hoisted root `node_modules`, and `apps/web/vite.config.ts`
   supplies the React transform). See the integration steps for the one-line
   change that adds it to `npm run check`.
2. **No component render tests.** Meaningful logic was extracted into
   `view-model.ts` and `polling.ts` and tested directly, rather than adding
   jsdom and Testing Library purely for snapshots. `panel-contract.test.tsx`
   covers the props/port contract at compile time and constructs the element,
   but does not render a DOM tree.
3. **Accessibility is designed, not audited.** Semantic headings, labelled
   inputs, `role="group"` filter sets with `aria-pressed`, `role="meter"`
   gauges, visible focus rings, a polite `aria-live` status line, status
   communicated by icon plus text rather than colour alone, wrapping for long
   paths, and responsive breakpoints matching `styles.css`. No screen-reader or
   automated axe audit was performed.
4. **The benchmark runs arms sequentially**, direct first (configurable via
   `armOrder`). This guarantees no cross-arm leakage but means wall-clock
   comparison is affected by host load; that is emitted as a standing
   comparability limitation on every record.
5. **One sample per arm.** Model sampling variance is not measured, and this is
   recorded as a limitation on every benchmark record.
6. **`FileBenchmarkStore` is single-process**, matching the baseline `JsonStore`.
   Multi-process operation would need a real database.
7. **Failure packets are not in Task 1's read model.** The UI renders them from
   `failurePackets` when present and shows nothing when absent; the failure story
   is otherwise carried by events, attempts, and verification records.
8. **Amendment diff rendering is a structured summary**, not a character-level
   diff: goal, requirements, and proposed criteria are listed with the stated
   reason.
9. **The benchmark's direct arm needs a real adapter.** The service is complete
   and tested, but until Final Assembly supplies the two executors, the endpoint
   has nothing real to run.

### Deviations from Appendix A

**None.** `apps/server/src/orchestration/contracts.ts` was not modified. The
browser DTOs in `apps/web/src/orchestration/contracts.ts` are structurally
identical to the Appendix A types they mirror; they are re-declared rather than
imported so the browser bundle never reaches into the server workspace.

Task-3-owned additions that are *not* in Appendix A (all in Task 3 files, as
section 4.3 requires): the benchmark types (`BenchmarkRecord`,
`BenchmarkArmResult`, `BenchmarkComparison`, and their ports), and the browser
view types `BudgetStatus`, `WorkspaceDisposition`, and `PlanSummary` — the last
three mirror Task 1's read-model shapes rather than Appendix A.

### Deviations from the required capabilities

None omitted. Every capability in the Task 3 column of section 5 has
implementation and evidence. Items 1–9 above are narrowings of depth, not
missing capabilities.

---

## 7. Integration steps for Final Assembly

### 7.1 `apps/web/src/api.ts` — adapt the existing request helper

Reuse the existing `request` helper and its bearer token; do not add a second
fetch path.

```ts
import type { OrchestrationApi } from "./orchestration/api-port";

export const orchestrationApi: OrchestrationApi = {
  createOrchestration: (agentId, input) =>
    request(`/api/agents/${agentId}/orchestrations`, {
      method: "POST", body: JSON.stringify(input),
    }),
  listOrchestrations: (agentId) => request(`/api/agents/${agentId}/orchestrations`),
  getOrchestration: (id) => request(`/api/orchestrations/${id}`),
  reviseIntent: (id, input) =>
    request(`/api/orchestrations/${id}/intent`, {
      method: "PATCH", body: JSON.stringify(input),        // { feedback }
    }),
  confirmIntent: (id, input) =>
    request(`/api/orchestrations/${id}/confirm`, {
      method: "POST", body: JSON.stringify(input),         // { confirm: true, answers? }
    }),
  startOrchestration: (id) =>
    request(`/api/orchestrations/${id}/start`, { method: "POST" }),
  cancelOrchestration: (id, reason) =>
    request(`/api/orchestrations/${id}/cancel`, {
      method: "POST", body: JSON.stringify({ reason }),
    }),
  confirmAmendment: (id, amendmentId) =>
    request(`/api/orchestrations/${id}/amendments/${amendmentId}/confirm`, { method: "POST" }),
  rejectAmendment: (id, amendmentId, reason) =>
    request(`/api/orchestrations/${id}/amendments/${amendmentId}/reject`, {
      method: "POST", body: JSON.stringify({ reason }),
    }),
  createBenchmark: (agentId, input) =>
    request(`/api/agents/${agentId}/benchmarks`, {
      method: "POST", body: JSON.stringify(input),
    }),
  getBenchmark: (id) => request(`/api/benchmarks/${id}`),
  cancelBenchmark: (id) => request(`/api/benchmarks/${id}/cancel`, { method: "POST" }),
};
```

`request<T>` is generic; call it as `request<unknown>` or let inference supply
`unknown` — the port intentionally returns unvalidated bodies.

**Note on `cancelOrchestration` / `rejectAmendment`:** Task 1's Zod body is
`{ reason?: string }` with `min(1)`. When `reason` is `undefined`, send no body
at all rather than `{"reason":undefined}` → `{}` — both are accepted, but omit
the `body` key entirely for the cleanest match.

### 7.2 `apps/web/src/App.tsx` — mount the panel

Mount **inside** the existing selected-Agent Playground. Do **not** remove Agent
CRUD, settings, messages, direct send, Run polling, or lifecycle actions.

```tsx
import "./orchestration/orchestration.css";   // in addition to styles.css, never instead of it
import { OrchestrationPanel } from "./orchestration/OrchestrationPanel";
import { orchestrationApi } from "./api";

// inside the `selected ? (...)` branch, after the existing <section className="playground">:
<OrchestrationPanel
  agentId={selected.id}
  agentStatus={selected.status}
  agentName={selected.name}
  api={orchestrationApi}
  system={system}
  onDirectSend={async (content) => {
    const result = await api.sendMessage(selected.id, content);
    setMessages((current) => [...current, result.message]);
    setActiveRun(result.run);
    await pollRun(result.run.id, selected.id);
  }}
  onTerminalState={() => {
    void refreshAgents();
    void refreshMessages(selected.id);
  }}
/>
```

- `agentStatus` must be the authoritative status from `refreshAgents()`, never an
  optimistic local value.
- The panel keys all state off `agentId`; switching Agent clears its state and
  stops its pollers via effect cleanup. Only UI polling stops — server work is
  untouched.
- `orchestration.css` is fully scoped under `.orch` and overrides no baseline
  rule.

### 7.3 `apps/server/src/app.ts` — register the benchmark routes

Register **after** the existing bearer-token `onRequest` hook so the new routes
inherit it.

```ts
import { registerBenchmarkRoutes } from "./orchestration/benchmark/routes.js";
// ...
registerBenchmarkRoutes(app, benchmarkService);
```

`createApp`'s signature will need the benchmark service (and Task 1's control
service) passed in — that change is Final Assembly's to make.

### 7.4 `apps/server/src/index.ts` — construct the benchmark service

```ts
import {
  BenchmarkService,
  FileBenchmarkStore,
  FileSystemBenchmarkWorkspaceProvider,
} from "./orchestration/benchmark/service.js";

const benchmarkService = new BenchmarkService({
  agents: {
    async getAgent(agentId) {
      try {
        const agent = agentService.getAgent(agentId);   // throws HttpError 404
        return { id: agent.id, status: agent.status, workspacePath: agent.workspacePath };
      } catch {
        return null;
      }
    },
  },
  workspaces: new FileSystemBenchmarkWorkspaceProvider(
    config.orchestration.tempRoot,
    config.orchestration.cleanupPolicy === "retain",
  ),
  executors: { direct: directArmExecutor, orchestrated: orchestratedArmExecutor },
  store: new FileBenchmarkStore(path.join(config.dataDirectory, "benchmarks.json")),
  defaultBudget: config.orchestration.budget,
});
await benchmarkService.initialize();   // reconciles interrupted runs; call before listen()
```

**The two arm executors still need writing** (they are the one genuinely
outstanding integration item):

- **Direct arm.** Run the prompt through `AgentRunner` against
  `input.workspace.path` with a fresh `executionId`, then run the same global
  verification the orchestrated arm uses, and map the result into
  `BenchmarkExecutorResult`. Set `succeeded` from the verification outcome, not
  from the model's claim.
- **Orchestrated arm.** Drive Task 1's control service against a temporary
  orchestration whose workspace is `input.workspace.path`, auto-confirming the
  contract from `input.criteria`, then map the terminal read model into
  `BenchmarkExecutorResult` (usage ledger, verification records, counters).

Both must honour `input.signal` and must never read anything produced by the
other arm.

### 7.5 Ordering and lifecycle

1. Create both stores under `config.dataDirectory`.
2. Instantiate Task 2's driver, Task 1's control service, then the benchmark
   service.
3. `initialize()` everything **before** `listen()` so restart reconciliation runs.
4. Register Task 1's and Task 3's plugins after the bearer hook.
5. Stopping or deleting an Agent must cancel active orchestration work before
   the workspace is changed or archived.

### 7.6 Recommended (not done here, to respect file ownership)

Add a web test script so the UI helper tests join `npm run check`:

```jsonc
// apps/web/package.json
"scripts": { "test": "vitest run" }
```

```jsonc
// package.json — root
"test": "npm run test -w @launchpad/server && npm run test -w @launchpad/web"
```

Vitest is already installed at the root (hoisted from `@launchpad/server`), so
this needs no new dependency. Verified working: `npx vitest run --root apps/web`
passes 38 tests today.

---

## 8. Proposed cross-task contract changes

None. No change to `apps/server/src/orchestration/contracts.ts` is requested.

One observation for Final Assembly, requiring no code change: Task 1's read model
names the confirmed contract `activeContract` and exposes `budget` as a ledger
status view plus `applicationMaps` as a separate collection. The web view model
already accepts those names (and the alternatives `contract` / `budgetStatus` /
an inline `plan.applicationMap`), so either shape renders correctly.
