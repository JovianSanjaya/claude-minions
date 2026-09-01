# TechJam Track 1 — Personal Progress Notes

Local-only scratchpad (gitignored). Purpose: keep a running record of what's
actually been built vs. what the full spec (`read.md`) asks for, so I can
plan next steps and hand context to an external model for evaluation without
re-deriving it from scratch every time.

Last updated: 2026-08-30. **All four phases complete**: Task 1, Task 2,
Task 3, and Final Assembly. `npm run check` passes end-to-end.

---

## 0. TL;DR status

| Task | Status |
| --- | --- |
| Task 1 (control plane) | **Done** |
| Task 2 (execution engine) | **Done** |
| Task 3 (web UI, benchmark, docs) | **Done** |
| Final Assembly | **Done** |

209 tests (183 server across 27 files + 26 web across 2 files), both
typechecks, both builds, all clean. Zero tests need live Ark credentials,
network, Docker, or a global Codex install.

**The one thing genuinely unverified: no live Ark call has ever
completed.** The UI itself WAS driven live in a real browser later in this
session (Claude in Chrome connected mid-session) — Agent creation,
Auto-mode submission, status/timeline/usage rendering, Cancel, Direct-mode
fallback all interactively verified, and it found+fixed two real bugs
(CSS overflow, an orphaned-orchestration resume gap — see
`docs/handoffs/final-assembly.md`). No `ARK_API_KEY` was ever available,
so the actual ModelArk network call remains unverified end to end.

---

## 1. What exists (recap — see the four handoff docs for full detail)

- `docs/handoffs/task-1-control-plane.md` — grounding-aware control plane:
  provenance/materiality-typed intent claims, deterministic clarification
  policy, immutable contract versioning, amendments, budget ledger,
  cancellation, restart reconciliation, the two-step plan-then-execute
  lifecycle (a real bug found and fixed mid-Task-3: `/start` used to fuse
  `plan()`+`execute()`, making `ready` unreviewable — fixed).
- `docs/handoffs/task-2-engine.md` — the real `OrchestrationExecutionDriver`:
  deterministic application map/router, isolated worker workspaces,
  preflight, bounded retry loop with live-wired context expansion, artifact
  drift detection, trusted-allowlist verification, deterministic-first
  integration. `RunnerRequest` gained `executionId`/`sandboxMode` (additive,
  backward-compatible) so concurrent workers don't collide on the real
  Codex runner.
- `docs/handoffs/task-3-experience-evidence.md` — `OrchestrationPanel` +
  6 components, tested `view-model.ts`/`polling.ts`, the benchmark service
  (quality-before-cost, in-memory store, documented simplification).
- `docs/handoffs/final-assembly.md` (**new this session**) — the
  composition work below.

## 2. Final Assembly — what actually got wired

- `apps/server/src/orchestration/composition.ts` (new file, owned by no
  task): builds `EngineConfig`, `createEngineDriver`, `OrchestrationStore`
  + `OrchestrationControlService` (`.initialize()`d before listening), and
  `BenchmarkService` with real direct/orchestrated executor adapters (both
  wrap the same engine driver against synthetic unpersisted
  Orchestration/Contract objects, with a real in-memory sink reusing Task
  1's own budget-ledger pure functions).
- `config.ts` gained optional orchestration env vars (per-role model IDs,
  uniform pricing, scratch root, one example `GLOBAL_CHECK_COMMAND`) — all
  optional, safe defaults.
- `agent-service.ts` gained an optional `AgentExecutionCoordinator` port
  (5th constructor param), called in `sendMessage`/`stopAgent`/
  `deleteAgent` — direct execution and orchestrations can no longer race on
  the same Agent workspace. Every existing baseline test still passes
  unmodified (port is optional).
- `app.ts` registers the orchestration + benchmark route plugins after the
  bearer-token hook. `index.ts` composes everything.
- `api.ts` (web) exports `orchestrationApi: OrchestrationApi`. `App.tsx`
  mounts `<OrchestrationPanel>` after the existing Playground section, with
  `sendMessage` refactored to extract a reusable `sendDirectMessage`
  (behavior unchanged, now also used as `OrchestrationPanel`'s
  `onDirectSend`).
- New integration test file `apps/server/src/orchestration/composition.test.ts`
  (4 tests): full create→elaborate→confirm→plan→start→execute→completed
  cycle through real HTTP routes against the real composed app; bearer-
  token protection on every new route; Agent deletion cancels an active
  orchestration; direct execution blocked while an orchestration is active.

### Manual verification actually performed (not part of `npm run check`)

1. **Live boot smoke test** — built the server, ran `node dist/index.js`
   for real against temp dirs, `RUNTIME_PROVIDER=local-process`. Hit
   `/api/health`, `/api/system`, created an Agent, created an orchestration
   (202, real background elaboration kicked off), fetched it back and saw
   a **real** attempt to spawn the local Codex CLI with the exact planner
   prompt `driver.ts` constructs — it failed only because this shell's
   Codex CLI install is broken (`ENOENT` spawning the codex binary), not
   because of any bug in the orchestration code. Also hit the benchmark
   route (400 on empty criteria — route registered, validated).
2. **Vite dev server** — `main.tsx` (now transitively importing the whole
   orchestration UI) served without a transform error.
3. **Production build module count** — 41 modules bundled, up from 30
   before `App.tsx` referenced `OrchestrationPanel` — confirms the UI code
   is reachable, not dead/tree-shaken.
4. **Live browser pass** (Claude in Chrome connected mid-session) — drove
   `OrchestrationPanel` by hand: mode selector, Auto-mode task submission,
   status pill transitions, Usage/budget panel, event Timeline, Cancel
   (correctly clears the one-active-orchestration block), Direct mode
   (correctly bypasses orchestration and hits the unchanged baseline chat
   path). Found and fixed two real bugs: a CSS horizontal-overflow bug on
   long unbroken error text, and `OrchestrationPanel` not resuming a stuck
   non-terminal orchestration after a page reload (it now calls
   `api.list(agentId)` on mount and resumes the Agent's own active one).
   Full detail in `docs/handoffs/final-assembly.md`.

### Not done

- A real end-to-end model call (no Ark key available).
- `terraform fmt -check -recursive deploy/volcengine` / `docker compose
  config` (original spec §9.6).
- Default protected-evaluator checks (only one optional example global
  check via `GLOBAL_CHECK_COMMAND`).

---

## 3. Questions worth putting to an external model for evaluation

- Given a live Ark call has still never completed end to end, how much
  should "Final Assembly is done" actually count for, versus "wired,
  browser-verified, and automated-check-clean, but the one link never
  proven live is the actual model call"?
- Is the benchmark's synthetic-Orchestration-object approach (building a
  fake, unpersisted `Orchestration`/`ExecutionContract` to feed the same
  engine driver used for real orchestrations) a legitimate reuse pattern,
  or does it risk drifting out of sync with what a *real* orchestration's
  execution actually looks like, since it bypasses Task 1's control plane
  entirely?
- Was fixing the plan/execute lifecycle bug mid-session (rather than
  documenting it as a known limitation) the right call? (Asked before,
  still relevant — now resolved and shipped as part of Final Assembly too.)
- Is the uniform (not per-role) pricing simplification in `config.ts`
  reasonable, or does it undermine the "role as an allocated resource"
  economic thesis enough that per-role pricing should have been built
  despite the extra env-var surface?
