# Task 3 handoff — product experience, benchmark, and submission evidence

## Final Assembly status: DONE (this session)

- **Server:** `BenchmarkService` is now constructed in
  `apps/server/src/orchestration/composition.ts` with real direct/
  orchestrated executor adapters — thin wrappers over the same
  `createEngineDriver` used by the control plane, each building a
  synthetic (unpersisted) `Orchestration`/`ExecutionContract` from the
  benchmark's prompt/criteria and its own real in-memory `OrchestrationSink`
  (budget accounting reuses Task 1's own pure `reserveModelCall`/
  `commitModelUsage` functions). `registerBenchmarkRoutes` is registered in
  `app.ts` alongside the orchestration routes.
- **Web:** `apps/web/src/api.ts` now exports `orchestrationApi: OrchestrationApi`
  — one thin `request()` wrapper per method. `App.tsx` mounts
  `<OrchestrationPanel>` inside the selected-Agent view (after the existing
  Playground section, so CRUD/settings/direct-chat are untouched),
  imports `orchestration.css` alongside `styles.css`, and wires
  `onDirectSend` to a newly-extracted `sendDirectMessage` (the existing
  `sendMessage` form handler now just calls it — behavior unchanged).
- Verified: `npm run check` passes (typecheck/test/build, both
  workspaces), a production `vite build` bundles the orchestration module
  for real (41 modules vs. 30 before — confirms it's no longer dead code),
  a real `node dist/index.js` boot smoke test plus `curl` calls proved the
  new routes are reachable, and `npm run dev`'s Vite dev server served
  `main.tsx` (which now imports `App.tsx` → `OrchestrationPanel` → every
  component) without a transform error.
- **Live browser pass (later in this session, once Claude in Chrome
  connected):** Agent creation, mode selection, submitting an Auto-mode
  task, the status pill moving through real states, the Usage/budget
  panel, the event Timeline, Cancel, and Direct mode's fallback to the
  existing baseline chat were all interactively driven and visually
  verified — no runtime-only React error surfaced. Found and fixed two
  real bugs this way: a CSS horizontal-overflow bug on long unbroken error
  text, and `OrchestrationPanel` failing to resume tracking a stuck
  non-terminal orchestration after a page reload. Full detail in
  `docs/handoffs/final-assembly.md`. Still not verified: a live Ark key /
  real ModelArk call completing end to end.

## Base commit / branch

Built on top of the completed Task 1 (grounding upgrade + full lifecycle)
and Task 2 (execution engine) in this same session, branch `task1-julian`.

## What this covers

1. A standalone React orchestration module (`apps/web/src/orchestration/`)
   that compiles and is tested against an injected `OrchestrationApi` port
   — it does not import or depend on `../api.ts`.
2. A standalone benchmark service + routes
   (`apps/server/src/orchestration/benchmark/`) using injected
   `BenchmarkExecutor` ports — it does not depend on Task 1's control plane
   or Task 2's driver at build time, only on the frozen `ContractCriterion`
   type.
3. Judge-facing documentation: `README.md` (was empty), `.env.example`
   (didn't exist), `docs/ARCHITECTURE.md` (extended, not replaced),
   `docs/DEMO.md`, `docs/THREAT_MODEL.md`, `docs/TECHJAM_SUBMISSION.md`.

Per the file-ownership rules, this task did **not** touch
`apps/web/src/App.tsx`, `api.ts`, `types.ts`, `apps/server/src/app.ts`, or
`apps/server/src/index.ts` — those are Final Assembly's job.

## A real design gap this task surfaced and fixed in Task 1

Building the UI's "review the plan, then explicitly click Start" flow (spec
§8.5: "When planning reaches `ready`, show route reason, task/dependency
summary, and an explicit Start action... Do not start merely because the
screen was opened") exposed that Task 1's original `/start` implementation
called `driver.plan()` **and** `driver.execute()` back-to-back inside the
same call — meaning `status: "ready"` was set and immediately overwritten
by `"running"` within one atomic mutation, so it was never actually
reviewable before execution began. That contradicts the frozen state
table's `planning -> ready` step being a distinct, reviewable status.

Fixed in `apps/server/src/orchestration/control/service.ts` (this session,
before writing the UI):

- `confirmIntent`/`confirmAmendment` now schedule **planning** in the
  background immediately after confirmation (mirroring how intent
  elaboration is already auto-scheduled after create/revise).
- `runPlanning` calls `driver.plan()`, persists the route/tasks/application
  map, and transitions `planning -> ready` — genuinely reachable and
  pollable before any execution starts.
- `startOrchestration` now requires `status === "ready"` (previously
  `"planning"`) and only runs `driver.execute()`, using a plan cached
  in-memory from `runPlanning` (`Map<orchestrationId, PlanResult>` on the
  service instance — acceptable because a server restart between `ready`
  and `/start` is already covered by restart reconciliation, which marks
  the orchestration `cancelled` regardless).
- A shared `runBackgroundTransition` helper replaces the old
  `scheduleExecution`, used by both planning and execution scheduling.

This is a genuine correction to Task 1's behavior, not a Task 3-owned file
change — updated in `docs/handoffs/task-1-control-plane.md` and covered by
new/updated tests in `apps/server/src/orchestration/control/service.test.ts`
and `routes.test.ts` (both files needed several existing tests updated to
`await waitForPendingWork` between confirm and start, since starting
immediately after confirm is no longer valid — planning now genuinely
happens in between).

## Files added

```
apps/server/src/orchestration/benchmark/service.ts
apps/server/src/orchestration/benchmark/routes.ts
apps/server/src/orchestration/benchmark/service.test.ts
apps/server/src/orchestration/benchmark/routes.test.ts

apps/web/src/orchestration/contracts.ts
apps/web/src/orchestration/api-port.ts
apps/web/src/orchestration/view-model.ts
apps/web/src/orchestration/view-model.test.ts
apps/web/src/orchestration/polling.ts
apps/web/src/orchestration/polling.test.ts
apps/web/src/orchestration/OrchestrationPanel.tsx
apps/web/src/orchestration/components/ModeSelector.tsx
apps/web/src/orchestration/components/IntentReview.tsx
apps/web/src/orchestration/components/ClarificationQuestionCard.tsx
apps/web/src/orchestration/components/ContractView.tsx
apps/web/src/orchestration/components/ExecutionTimeline.tsx
apps/web/src/orchestration/components/UsageSummary.tsx
apps/web/src/orchestration/components/AmendmentBanner.tsx
apps/web/src/orchestration/orchestration.css

README.md                        (was empty)
.env.example                     (new)
docs/ARCHITECTURE.md             (extended)
docs/DEMO.md
docs/THREAT_MODEL.md
docs/TECHJAM_SUBMISSION.md
docs/handoffs/task-3-experience-evidence.md
```

Also (infrastructure, not product code):

```
apps/web/package.json    added vitest devDependency + "test" script
package.json (root)      "test" now runs both workspaces' tests
```

## Public exports / constructors

### Benchmark (server)

- `BenchmarkService` — constructor `(agents: AgentWorkspaceLookup, directExecutor: BenchmarkExecutor, orchestratedExecutor: BenchmarkExecutor, scratchRoot: string)`. Methods: `createBenchmark(input)`, `getBenchmark(id)`, `waitForPendingWork(id)` (test-only).
- `BenchmarkExecutor` / `AgentWorkspaceLookup` — injected ports; Final
  Assembly must supply real implementations (thin adapters over Task 1's
  service for the "direct" arm and Task 2's driver for the "orchestrated"
  arm).
- `interpretBenchmark(record)` — pure function, quality-before-cost
  interpretation; reused (duplicated intentionally, see below) client-side
  as `interpretBenchmarkResult` in `apps/web/src/orchestration/view-model.ts`.
- `registerBenchmarkRoutes(app, service)` — `POST
  /api/agents/:agentId/benchmarks` (202), `GET /api/benchmarks/:benchmarkId`.

### Web orchestration module

- `OrchestrationApi` (`api-port.ts`) — the typed boundary; Final Assembly
  adapts the existing authenticated `request()` helper in `../api.ts` to
  this interface (should be a thin, mechanical wrapper — one function per
  method, each just calling `request<T>(url, options)`).
- `OrchestrationPanel` (`OrchestrationPanel.tsx`) — props: `agentId`,
  `agentStatus`, `api: OrchestrationApi`, `onDirectSend?`,
  `systemSummary?`, `initialOrchestrationId?`. Final Assembly mounts this
  inside the existing selected-Agent Playground in `App.tsx`, wiring
  `onDirectSend` to the existing `sendMessage` flow.
- `view-model.ts` — `modeToRequestedMode`, `isTerminalStatus`,
  `describeStatus`, `evaluateConfirmationGate`, `groupClaimsByProvenance`,
  `formatUsage`, `formatEstimateRange`, `filterEvents`, `toSafeEventView`,
  `safeOrchestration`, `interpretBenchmarkResult`.
- `polling.ts` — `createPoller<T>(fetchOnce, onUpdate, onError, options)`,
  framework-agnostic (no React dependency), used by `OrchestrationPanel`
  via a small `useEffect`.

## Design decisions worth flagging

1. **No structured JSON DTO layer beyond hand-kept type mirrors.**
   `apps/web/src/orchestration/contracts.ts` is a manually-kept copy of the
   server's orchestration DTOs (apps/web has no build-time link to
   apps/server — confirmed by inspecting `tsconfig.json`/`vite.config.ts`,
   no project references). Final Assembly (or a future task) should keep
   the two in sync if the server-side shapes change; there is no automated
   check for drift in this build.
2. **`interpretBenchmarkResult` in `view-model.ts` intentionally duplicates
   the server's `interpretBenchmark` logic** rather than importing it,
   for the same cross-workspace-isolation reason. Both are independently
   tested against the same scenarios (quality-before-cost, unknown
   pricing, direct winning).
3. **No React component-rendering test stack was added** (no
   `@testing-library/react`, no `jsdom`) — per spec §8.12's own framing
   ("state/polling helpers are verified... without adding a large frontend
   test stack solely for snapshots") and the "keep dependencies minimal"
   instruction. `view-model.ts` and `polling.ts` — the two files with
   actual branching logic — are unit tested (26 tests); the components
   themselves are validated by `tsc -b` (strict TypeScript + `react-jsx`
   catches prop-shape and JSX-structure errors) and a production `vite
   build`. No test renders a component to the DOM. This is a real,
   deliberate scope boundary, not an oversight.
4. **`OrchestrationPanel` treats `"planning"` and `"ready"` as the plan-
   review phase**, showing `ContractView` (route/tasks, and a "Start
   execution" button only when `status === "ready"`) for both statuses
   once a contract exists and there's no pending amendment. This matches
   the corrected Task 1 lifecycle above.
5. **Polling backs off exponentially on repeated errors** (base interval →
   doubling, capped) and **never clears the last valid view on a
   recoverable error** — `onUpdate` is only invoked on a successful fetch;
   a transient network failure just skips that tick's UI update rather
   than showing a blank/broken state. Verified with fake timers in
   `polling.test.ts`.
6. **Redaction/safety at the view-model layer is defense-in-depth, not the
   primary control** — the server already redacts before persistence
   (Task 1). `toSafeEventView` additionally curates which fields ever
   reach the DOM (never spreads a raw event object) and stringifies
   `metadata` values rather than rendering them as live objects, so even a
   hypothetical future server bug that let a structured/unsafe value
   through `metadata` couldn't render as anything but inert text.

## Checks run

```
npm run typecheck   -> pass (server + web)
npm run test          -> pass (178 server tests across 26 files + 26 web tests across 2 files = 204 total)
npm run build           -> pass (web + server)
npm run check            -> pass end-to-end
```

Ran via `nvm use 22` (Node v22.23.2).

## Fake/test adapters used

- Server: `test-doubles.ts` reused from Task 2 (`createInMemorySink`,
  `createFakeAgentRunner`) is not reused directly by the benchmark tests —
  the benchmark's own fakes are simpler (`BenchmarkExecutor` stubs
  returning a canned `BenchmarkArmResult`), defined inline in
  `service.test.ts`/`routes.test.ts`.
- Web: no fakes needed for `view-model.test.ts` (pure functions over plain
  fixture objects); `polling.test.ts` uses `vi.useFakeTimers()`, no network
  or DOM.

No production mock exists anywhere in this delivery.

## Known limitations

- **Benchmark persistence is in-memory only** (`Map` on the `BenchmarkService`
  instance), not a durable JSON store like Task 1's `OrchestrationStore`.
  Acceptable for a comparison/demo tool given the time available; a restart
  loses in-flight or completed benchmark records. Documented as a
  deliberate simplification, not an oversight.
- **No live-model demo evidence** — consistent with Task 1/Task 2, every
  test in this delivery uses injected fakes.
- **`OrchestrationPanel` is not mounted anywhere yet** — see "What Final
  Assembly must wire" below.
- The web view-model's `safeOrchestration` defensive parser checks only
  the four fields actually used for routing decisions (`id`, `agentId`,
  `status`, `prompt`); it does not deep-validate every nested field (budget,
  usage, estimate) — a malformed nested field would still reach the
  renderer, which is expected to degrade gracefully via optional chaining
  in the components (e.g. `orchestration.estimate` is already nullable in
  the type) rather than a second validation pass.

## Integration steps Final Assembly must perform

1. **Server:** construct `BenchmarkService` with real
   `directExecutor`/`orchestratedExecutor` adapters (thin wrappers: direct
   = call Task 1's service with `requestedMode: "direct"` and read back
   usage/verification; orchestrated = same with `"orchestrated"`) and an
   `AgentWorkspaceLookup` backed by `AgentService`. Register
   `registerBenchmarkRoutes(app, benchmarkService)` alongside Task 1's
   `registerOrchestrationRoutes`, after the bearer-token hook.
2. **Web `api.ts`:** implement `OrchestrationApi` as a set of thin wrappers
   around the existing authenticated `request()` helper — one function per
   method in the interface, mapping 1:1 to the routes Task 1/this task
   registered.
3. **Web `App.tsx`:** import `orchestration.css` alongside `styles.css`;
   mount `<OrchestrationPanel agentId={selected.id} agentStatus={selected.status}
   api={orchestrationApi} onDirectSend={sendMessage} systemSummary={...}
   />` inside the existing selected-Agent Playground, without removing any
   existing CRUD/settings/direct-chat UI. Ensure Agent switching triggers
   the panel's own internal reset (already handled by its `agentId` effect
   dependency) so it never shows stale orchestration state for a different
   Agent.
4. Wire a real `EngineConfig` (Task 2) and `OrchestrationControlService`
   (Task 1) per their handoffs, so the API port has something real behind
   it.
5. Run the full manual verification checklist in the original spec §9.7
   once wired, using `docs/DEMO.md` as the script.
