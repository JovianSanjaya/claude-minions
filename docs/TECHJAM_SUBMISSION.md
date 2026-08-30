# TechJam 2026 Track 1 submission summary

**Track:** Agent Launchpad — Design and Build Lightweight Agent Middleware.

**One-sentence pitch:** middleware that treats model intelligence and
repository context as schedulable resources — a planner grounds intent with
the user before any work is multiplied across agents, a router decides
direct vs. delegated execution, and every model call is budgeted,
isolated, and independently verified before anything publishes.

## Status at handoff

| Piece | Status |
| --- | --- |
| Task 1 — control plane (grounding, contracts, budget, lifecycle) | Complete, tested, documented |
| Task 2 — execution engine (routing, isolation, verification, integration) | Complete, tested, documented |
| Task 3 — web UI, benchmark, docs | Complete, tested, documented |
| Final Assembly — wiring into `app.ts`/`index.ts`/`App.tsx` | Complete — see `docs/handoffs/final-assembly.md` |

The full stack is wired and reachable through real HTTP routes — verified
by `npm run check` (209 tests), a live server boot smoke test, a
production build that genuinely bundles the orchestration UI (41 modules,
up from 30), and a live interactive browser pass (Agent creation,
Auto-mode submission, status/timeline/usage rendering, Cancel, Direct-mode
fallback — see `docs/handoffs/final-assembly.md`, which also documents
two real bugs found and fixed during that pass). **The one thing not
verified:** no live Ark key was available, so no real ModelArk call has
completed end to end. Do a live-Ark pass before a live demo — see "What's
not demoable yet" below.

## Rubric mapping

### End-to-end middleware behavior (40%)

- **Normal case:** intent grounding → confirmation → plan review → bounded
  worker execution → deterministic integration → protected verification →
  publish, all evidenced by persisted events/tasks/artifacts/verifications
  (`apps/server/src/orchestration/control`, `.../engine`). Demonstrated
  end-to-end with fakes in `apps/server/src/orchestration/engine/driver.test.ts`
  (20 tests) and `apps/server/src/orchestration/control/service.test.ts`
  (37 tests spanning the full lifecycle).
- **Failure/recovery case:** budget denial (`budget-ledger.test.ts`,
  `service.test.ts`), a worker discovering a material contract conflict
  (`needs-user` + amendment, never a silent contract weakening), a
  deterministic verification failure that leaves the real workspace
  untouched (`integrator.test.ts`), and authoritative non-blocking
  cancellation (`driver.test.ts`, `service.test.ts`).
- **Platform stays controllable afterward:** every failure mode is a typed,
  persisted terminal or `needs-user` state, never an exception that leaves
  the record ambiguous; restart reconciliation guarantees no interrupted
  work is ever reported as succeeded.

### Technical design and integration (25%)

- The Agent-specific problem (context/model-allocation, common-ground
  grounding before multiplying work) is stated once and enforced
  structurally: `plan()`/`execute()` require an already-confirmed
  `ExecutionContract` at the *type* level, not just by convention.
- Coherent boundary: Task 1 owns confirmation/lifecycle authority, Task 2
  owns execution intelligence, Task 3 owns presentation/benchmark — each
  independently testable against fakes, verified by the file-ownership
  discipline documented in each handoff.
- Extensible contracts: the frozen `contracts.ts` interface
  (`OrchestrationExecutionDriver`) is unchanged from the original spec
  except three additive, documented deviations (provenance/materiality
  typing, `ContractCriterion.provenance`/`sourceClaimId`,
  `ElaborateIntentInput.priorDraft`) — see
  `docs/handoffs/task-1-control-plane.md`.

### Verification and robustness (20%)

- 178 server tests + 26 web tests, zero requiring live Ark credentials,
  network, Docker, or a global Codex install.
- Redaction before persistence (`redaction.ts`), not just at render time.
- Trusted-allowlist-only command execution for protected/global checks —
  never a worker- or browser-supplied string.
- Bypass resistance: a worker cannot mark its own result passed; only
  independently-run checks decide; the confirmation gate is re-validated
  server-side regardless of what the UI shows.
- Cleanup/recovery: unsafe cleanup targets are refused (not silently
  skipped); a genuinely completed orchestration survives a restart
  untouched; an interrupted one is explicitly marked, never silently lost.

### Demo and reproducibility (15%)

- `npm run check` is one command, passes end-to-end, no manual steps.
- `docs/DEMO.md` gives a concrete, deterministic sub-three-minute script
  with three interchangeable failure/recovery options.
- Known limitations are stated plainly (see each handoff and the README),
  not hidden.

## Architecture and evidence

See `docs/ARCHITECTURE.md` for the one-page diagram (data flow, trust
boundaries, enforcement/instrumentation/recovery points) and
`docs/THREAT_MODEL.md` for assets/actors/boundaries/residual risks.

## Benchmark caveats

The benchmark (`apps/server/src/orchestration/benchmark`) always reports
quality before cost: if the two arms didn't produce comparably valid
results, `interpretBenchmark` refuses to name a cost winner. Model
differences and unknown pricing are surfaced as explicit comparability
warnings, not hidden. A benchmark run where direct wins is treated as valid
evidence, not a failure to hide — see `README.md` §"Benchmark
interpretation" and `apps/server/src/orchestration/benchmark/service.test.ts`.

## Known limitations (see handoffs for full detail)

- Deterministic (not live-model) routing/classification/summarization in
  the engine, since no live Ark credentials existed in the build
  environment — the *budgeting, isolation, verification, and integration*
  machinery is real; the *routing heuristic* itself is a documented,
  tested substitute for what a live planner call could do.
- No dedicated protected-evaluator storage path yet — `EngineConfig`
  accepts `protectedChecks`/`globalChecks` as plain arrays; Final Assembly
  should point them at real trusted commands.
- Wall-clock budget is declared per orchestration but not yet actively
  enforced by a timer at the orchestration level.
- Shared `CODEX_HOME` across concurrent role executions (documented in
  `docs/handoffs/task-2-engine.md`).
- **No protected-evaluator checks are wired by default** — only one
  optional example global check exists (`GLOBAL_CHECK_COMMAND`).
- **No live Ark key used.** Final Assembly wired everything (see
  `docs/handoffs/final-assembly.md`) and it was verified with automated
  tests, a live server boot smoke test, a production build that genuinely
  bundles the UI, and a live interactive browser pass (which found and
  fixed two real bugs — see that doc) — but no live Ark key was available
  to complete a real model call end to end. Recommended before a live
  demo.
