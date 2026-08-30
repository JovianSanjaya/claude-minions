# Volc Agent Launchpad — Agent Context and Model Allocation Control Layer

A coding-Agent middleware built on top of the Volc Agent Launchpad starter kit
(React/Fastify/Codex CLI/ModelArk). It treats model intelligence and
repository context as **schedulable resources**: a planner first establishes
enough common ground with the user before any work is multiplied across
agents, the control layer routes work to direct execution or one/many
isolated workers depending on size and modularity, and every model call is
budgeted, verified, and — when it fails — bounded and diagnosable instead of
looping forever.

## The problem, in one sentence

A single powerful coding agent re-reasons over growing repository context on
every turn; naive multi-agent delegation is often worse (duplicated context,
coordination overhead, an integrator that reconstructs the same monolithic
context at the end). This project is the middleware that decides *whether*
to delegate, *what* minimum-sufficient context each worker gets, and *how*
isolated results get verified and merged back — not just another agent.

## What the Starter Kit already provides (unmodified)

- Agent create/inspect/edit/start/stop/delete, a Playground chat, and
  asynchronous Run polling.
- A Fastify/Zod/TypeScript control plane with atomic single-process JSON
  persistence, restart reconciliation, and per-Agent workspaces.
- Codex CLI execution against BytePlus/Volcengine ModelArk, either in a
  disposable local container (`RUNTIME_PROVIDER=container`) or as a local
  process (`RUNTIME_PROVIDER=local-process`, e.g. ECS).

None of this baseline behavior changed. `npm run test` still runs every
original baseline test alongside the new orchestration suite.

## What this project adds

| Layer | What it does |
| --- | --- |
| **Control plane** (`apps/server/src/orchestration/control`) | Owns intent grounding, confirmation, immutable contract versioning, amendments, budget enforcement, cancellation, restart reconciliation, and the correlated evidence timeline. |
| **Execution engine** (`apps/server/src/orchestration/engine`) | The real driver: deterministic application map, adaptive router, minimum-sufficient context packets with bounded expansion, isolated worker workspaces, read-only preflight, a bounded retry loop, an artifact registry with drift detection, worker-visible/protected/global verification, and deterministic-first integration. |
| **Benchmark** (`apps/server/src/orchestration/benchmark`) | Runs a direct arm and an orchestrated arm from the *same* isolated snapshot with the *same* prompt/criteria, and reports quality before cost — including when direct wins. |
| **Web UI** (`apps/web/src/orchestration`) | Direct / Auto / Orchestrated Playground modes, intent review with provenance-tagged claims and contrastive clarification questions, contract/plan review, a correlated evidence timeline, and usage/budget display. |

## Common-ground grounding, not a rubber-stamp confirm

Before any code is written, the planner elaborates the request into typed
claims tagged with **provenance** — `user-explicit`, `planner-inferred`,
`repository-derived`, or `user-delegated` — and **materiality** —
`trivial` or `material`. Only material ambiguity is ever surfaced to the
user as a clarification question (with a "let the AI decide" option); a
trivial one resolves itself silently. The confirmed contract keeps this
provenance on every acceptance criterion, so the system can always answer
"why do we believe this is part of the contract."

## Direct / Auto / Orchestrated

- **Direct** — the existing Playground chat, unchanged.
- **Auto** — the router picks direct, one worker, or multiple workers based
  on how many functional requirements the confirmed contract has and how
  many distinct repository areas they touch.
- **Orchestrated** — always delegates (at least one worker), still fully
  budgeted, preflighted, and verified.

## Quick start

```bash
npm install
ARK_API_KEY=your-ark-api-key ARK_MODEL=ep-your-endpoint-id npm run poc
```

See `docs/LOCAL_POC.md` for the full local-container setup (Docker, Colima,
or rootless Podman) and `.env.example` for every configuration variable,
including the orchestration-specific ones (budget defaults, scratch root,
per-role model overrides).

`npm run dev` runs the control plane and Vite dev server without Docker, for
UI iteration against a `local-process` runner.

## Demo steps

See `docs/DEMO.md` for a reliable, sub-three-minute normal-path walkthrough
and a deterministic failure/recovery scenario. In short: create an Agent,
submit a modular task in **Auto** mode, review and confirm the grounded
intent (answering or delegating any material question), review the route
and task breakdown, start execution, and watch the timeline through
verification and publish.

## Automated checks

```bash
npm run check   # typecheck (server + web) + test (server + web) + build (server + web)
```

Every orchestration module — control plane, execution engine, and benchmark
— is tested with deterministic fakes (`OrchestrationSink`, `AgentRunner`,
`BenchmarkExecutor`); no test in the repository requires live Ark
credentials, network access, Docker, or a globally installed Codex CLI.

## Benchmark interpretation

The benchmark always reports **quality before cost**: if the two arms didn't
produce comparably valid results (one passed verification and the other
didn't), no cost comparison is offered at all — see
`apps/server/src/orchestration/benchmark/service.ts`'s `interpretBenchmark`.
When pricing isn't configured for a model, only token totals are compared,
never a fabricated dollar figure. Direct winning is valid, reportable
evidence, not a bug.

## Cleanup and recovery

- Cancelling an orchestration is immediate and authoritative — it never
  hangs waiting for a driver that ignores its abort signal.
- A server restart marks any orchestration that was mid-flight `cancelled`
  with an explicit "server restarted" reason; it never reports interrupted
  work as having succeeded.
- Failed verification always leaves the Agent's real workspace untouched —
  publication only happens after protected/global checks pass on a staged
  candidate.
- Isolated worker/staging workspaces are cleaned up after each execution;
  cleanup refuses (rather than silently no-ops) if a computed path resolves
  outside the trusted scratch root.

## Known limitations

- **No live-model demo evidence in this repository's own test suite** — all
  orchestration tests use deterministic fakes by design (spec requirement).
  A judge with an Ark key can run the real thing via `npm run poc`.
- **Deterministic, not model-based, routing/classification** in the engine
  (no live credentials existed in the build environment) — see
  `docs/handoffs/task-2-engine.md` for the specific tradeoffs.
- **No dedicated protected-evaluator storage path** is wired yet; only one
  optional example check exists (`GLOBAL_CHECK_COMMAND`) — point
  `EngineConfig.protectedChecks`/`globalChecks` at real trusted commands
  for a fuller demo.
- **Wall-clock budget** is declared per orchestration but not yet enforced
  by an active timer at the orchestration level (the underlying Codex
  process still has its own per-call timeout).
- **Rendered and driven live in a real browser** (Agent creation, Auto-mode
  submission, status/timeline/usage rendering, Cancel, Direct-mode routing
  all interactively verified — see `docs/handoffs/final-assembly.md`), but
  **never run against a live Ark key** — no real ModelArk call has
  completed end to end in this build environment. Do that before a live
  demo.
- Full detail and every other deliberate scope decision: see
  `docs/handoffs/task-1-control-plane.md`, `docs/handoffs/task-2-engine.md`,
  `docs/handoffs/task-3-experience-evidence.md`, and
  `docs/handoffs/final-assembly.md`.

## No secrets

`ARK_API_KEY` never reaches the browser. The control plane redacts likely
secrets (API keys, bearer tokens, passwords, `KEY=value` assignments) from
every string before it is persisted or returned, defensively, even from
free-text prompts and clarification answers — see
`apps/server/src/orchestration/control/redaction.ts`.
