# Final Assembly handoff

Composition-root work connecting the three independently-built modules
(Task 1 control plane, Task 2 execution engine, Task 3 web UI/benchmark)
into the running application. Done in the same session as all three tasks,
branch `task1-julian`.

## What changed

```
apps/server/src/orchestration/composition.ts    (new) — composition glue, owned by no task
apps/server/src/orchestration/composition.test.ts (new) — live integration tests
apps/server/src/index.ts                          — constructs the composed app
apps/server/src/app.ts                            — registers orchestration/benchmark routes
apps/server/src/config.ts                         — optional orchestration env vars
apps/server/src/agent-service.ts                  — optional AgentExecutionCoordinator port

apps/web/src/api.ts                               — orchestrationApi adapter
apps/web/src/App.tsx                              — mounts OrchestrationPanel
```

## Composition (`composition.ts`)

`composeOrchestration(config, agentStore, runner)`:

1. Builds `EngineConfig` from `AppConfig` (per-role model IDs, a single
   uniform pricing table if all three `ARK_*_PRICE_PER_TOKEN` vars are set,
   the scratch root, and an optional single `globalChecks` entry from
   `GLOBAL_CHECK_COMMAND`).
2. `createEngineDriver(engineConfig)` — the real Task 2 driver.
3. `new OrchestrationStore(...)` + `new OrchestrationControlService(...)`,
   `.initialize()`d immediately (runs restart reconciliation before the
   server starts accepting traffic).
4. `new BenchmarkService(...)` with two `BenchmarkExecutor` adapters — both
   wrap the *same* engine driver, one forcing `selectedMode: "direct"`, the
   other calling `driver.plan()` for real routing — against synthetic,
   unpersisted `Orchestration`/`ExecutionContract` objects built from the
   benchmark's own prompt/criteria, with a real (not test-only) in-memory
   `OrchestrationSink` whose budget math reuses Task 1's pure
   `reserveModelCall`/`commitModelUsage` functions.

`createAgentAccessPort`/`createAgentWorkspaceLookup` adapt the baseline
`JsonStore` to the two small ports Task 1 and Task 3 expect, without either
of those modules importing anything Agent-specific.

## `config.ts` additions

All optional, all with safe defaults (a single configured Ark endpoint
fills every logical role when unset):

```
PLANNER_MODEL_ID / WORKER_MODEL_ID / VERIFIER_MODEL_ID / INTEGRATOR_MODEL_ID
ARK_INPUT_PRICE_PER_TOKEN / ARK_CACHED_INPUT_PRICE_PER_TOKEN / ARK_OUTPUT_PRICE_PER_TOKEN
ORCHESTRATION_SCRATCH_ROOT   (default: <APP_DATA_DIR>/orchestration-tmp)
PROTECTED_EVALUATOR_ROOT     (default: <APP_DATA_DIR>/protected-evaluators — resolved but unused; no protected checks are wired yet)
GLOBAL_CHECK_COMMAND         (space-separated command + args, no shell; e.g. "npm run typecheck")
```

**Deliberate simplification:** pricing is one uniform rate applied to all
four roles rather than per-role granularity (which would need 12 env
vars for marginal value at this stage). Missing any of the three price
vars keeps `pricingStatus: "unknown"` — never a fabricated cost.

## `AgentExecutionCoordinator` wiring

`AgentService` gained an optional 5th constructor parameter,
`coordinator?: AgentExecutionCoordinator` (interface defined in
`agent-service.ts`, shape matching Task 1's `OrchestrationCoordinator`
exactly so `createOrchestrationCoordinator(controlService)` passes straight
through). Called:

- `assertAgentAvailableForDirect(agentId)` at the top of `sendMessage`
  (before the Ark-configured check), so a direct chat message is rejected
  with 409 while an orchestration is active for that Agent.
- `cancelForAgent(agentId)` in both `stopAgent` and `deleteAgent`, before
  the existing `cancelExecution`/archive logic.

Every existing baseline test still passes unmodified — the port is
optional and every existing `new AgentService(...)` call site that omits
it behaves exactly as before.

## Verification performed

```
npm run check   -> pass (typecheck ×2, 209 tests across 29 files, build ×2)
```

Additional manual verification (not part of `npm run check`):

1. **Live boot smoke test** — built the server, ran `node dist/index.js`
   against temp data/workspace/codex-home directories with
   `RUNTIME_PROVIDER=local-process`, and hit `/api/health`, `/api/system`,
   `POST /api/agents` (baseline behavior, all working), `POST
   /api/agents/:id/orchestrations` (202, real background elaboration
   scheduled), `GET .../orchestrations` (showed the real failure from
   attempting to spawn this shell's broken local Codex CLI install — proof
   the pipeline genuinely tried to call it, not a code bug), and `POST
   /api/agents/:id/benchmarks` (400 on empty criteria, proving the route is
   registered and validated).
2. **Vite dev server** — confirmed `main.tsx` (which now transitively
   imports the entire orchestration UI module) serves without a transform
   error.
3. **Production build module count** — 41 modules bundled (was 30 before
   `App.tsx` referenced `OrchestrationPanel`), confirming the UI code is
   genuinely reachable, not dead code excluded by tree-shaking.
4. **Live browser pass** (after the user connected the Claude in Chrome
   extension mid-session) — ran the production build against a real
   server, created an Agent, and drove the `OrchestrationPanel` UI by hand:
   mode selector, submitting an Auto-mode task, watching the status pill
   move through `Drafting intent`, the honest error surfaced when the
   local Codex CLI install failed to spawn (an environment issue, not a
   code bug — proves the real prompt/pipeline executes), the Usage &
   budget panel, the event Timeline (correct chronological ordering, real
   timestamps), Cancel (correctly moves to a terminal `Cancelled` status
   and clears the one-active-orchestration block), and Direct mode
   (correctly bypasses orchestration entirely and routes through the
   existing baseline chat, surfacing the baseline `503 Service
   Unavailable` banner unchanged). This found and fixed two real bugs
   (below) — everything else rendered and behaved as designed.

### Bugs found via live testing and fixed in this session

1. **Error text overflowed the viewport horizontally.** A long unbroken
   token (a filesystem path in a spawn-failure stack trace) had no wrap
   opportunity, forcing the whole error box past the page edge. Fixed in
   `orchestration.css`: `.orch-panel` now sets `overflow-wrap: anywhere`
   (inherited by every descendant), and `.orch-error-summary` gained
   `white-space: pre-wrap` (so real newlines in an error render as line
   breaks instead of being collapsed) plus a scrollable `max-height`.
2. **A stuck non-terminal orchestration was invisible after a page
   reload, while still blocking new ones server-side.** When elaboration
   fails, the orchestration stays at `drafting-intent` (never reaches a
   terminal status per the frozen table — see the Task 1 handoff), which
   correctly keeps the one-active-orchestration-per-Agent rule enforced —
   but `OrchestrationPanel` only tracked an orchestration it had itself
   just created, so reloading the page lost track of it, leaving no way
   to see or cancel it from the UI even though it still blocked new
   orchestrations for that Agent. Fixed in `OrchestrationPanel.tsx`: on
   mount (when no `initialOrchestrationId` is given), it now calls
   `api.list(agentId)` and resumes tracking the Agent's own most recent
   non-terminal orchestration, if any — verified live: after the fix, a
   reload correctly showed the stuck orchestration with its Cancel button,
   clicking Cancel correctly cleared the block, and a new orchestration
   could then be created immediately.

Both fixes are covered by the existing `npm run check` (183 server + 26
web tests, unchanged pass count — these are UI/CSS-shaped fixes, not new
branching logic, so no new unit test was added; the live browser pass
above is the verification for both).

## Not done

- **No protected-evaluator checks wired** — `protectedEvaluatorRoot` is
  resolved but nothing populates it or points `EngineConfig.protectedChecks`
  at it. Only one optional example global check exists
  (`GLOBAL_CHECK_COMMAND`).
- `terraform fmt -check -recursive deploy/volcengine` and `docker compose
  config` (original spec §9.6) were not run this session.
- The original spec's full manual checklist (§9.7) — Agent create/edit/
  start/stop/delete, direct multi-turn Playground, orchestrated intent/
  revision/confirmation, a real model call, protected/global verification
  evidence, cancellation, a deterministic failure/recovery scenario — was
  exercised through automated integration tests and the boot smoke test
  above, but never with a **live Ark key** end to end (none was available
  in this environment). Everything up to the actual ModelArk call is
  proven working; the model call itself is the one link nobody in this
  session could verify.
