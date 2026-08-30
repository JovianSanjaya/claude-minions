# Demo script

Two scenarios: a normal path (under three minutes) and a deterministic
failure/recovery path. Final Assembly has wired the orchestration routes
and `OrchestrationPanel` into the running app (see
`docs/handoffs/final-assembly.md`) — verified by boot smoke tests and a
full HTTP integration test suite, but **never visually rendered in a
browser** (no browser tooling was available in the build environment). Do
a manual run-through before relying on this for a live demo.

## Prerequisites

```bash
ARK_API_KEY=your-ark-api-key ARK_MODEL=ep-your-endpoint-id npm run poc
```

An Agent already created and selected in the Playground.

## Normal path (~2.5 minutes)

1. **Select Auto mode.** Show the three mode options (Direct / Auto /
   Orchestrated) and explain: Auto lets the router decide; Orchestrated
   always delegates; Direct is the unmodified baseline chat.
2. **Submit a modular task**, e.g.:
   > "Add a password reset flow: a reset-token model, an API endpoint that
   > emails a reset link, and a frontend form to request one."
3. **Review the grounded intent.** Point out claims grouped by provenance
   ("You said" / "Planner inferred" / "From the repository" /
   "You delegated"), and the token/cost estimate range. If a material
   clarification question appears (e.g. token expiry), either pick a
   concrete option or the "🤝 Let the AI decide" delegate option — note
   that delegating never requires typing an implementation choice.
4. **Confirm.** Show the confirmed contract: criteria grouped by kind
   (functional/architectural/scope/manual/runtime), each tagged with its
   provenance.
5. **Review the route.** Once planning finishes (status `ready`), show the
   selected mode (likely `multi-worker` for this task) and the task
   breakdown with allowed paths per task — before clicking anything.
6. **Start execution.** Click "Start execution." Watch the timeline: worker
   preflight, isolated file changes, worker-visible checks, an artifact
   published, integration, protected/global verification, and the
   "Execution completed and published" event.
7. **Show usage.** Per-role token counts and — if a `PricingTable` is
   configured — estimated cost; otherwise the honest "Pricing not
   configured" label.

## Failure / recovery path (deterministic, ~1 minute)

Pick **one** of these, whichever is easier to trigger reliably in the demo
environment:

### Option A — budget stop

1. Before submitting, set a deliberately tiny budget override (e.g.
   `maxInputTokens: 50`) via the create-orchestration request (or a demo
   toggle if Task 3's UI exposes one).
2. Submit any real task. The estimate-vs-budget check denies confirmation
   with a 422 and an explicit reason — or, if confirmed anyway with budget
   tight enough to bite during elaboration/planning, the first model call's
   reservation is denied and the orchestration stays at `drafting-intent`
   with the denial reason visible.
3. Point out: no orchestration silently proceeded past its budget, and the
   platform is still fully usable afterward (create a new orchestration
   with a normal budget).

### Option B — cancellation

1. Start a normal orchestrated run.
2. While it's `running`, click **Cancel**.
3. Show the orchestration is immediately `cancelled` (not stuck "cancelling
   forever" even though the underlying model call may still be
   unwinding) — `cancelOrchestration` is authoritative and non-blocking by
   design.
4. Show the main Agent workspace is untouched (nothing had been published
   yet), and that a new orchestration can be started immediately.

### Option C — verification failure (most illustrative, needs a fixture)

1. Point a `globalChecks` entry (in `EngineConfig`, wired by Final Assembly)
   at a command guaranteed to fail for the demo task (e.g. a trivial
   lint rule the task doesn't satisfy).
2. Run a normal orchestrated task through to integration.
3. Show the outcome is `failed` with the verification failure reason, and
   that the Agent's real workspace file content is unchanged — open the
   file, or point to the `verification-failed`/`failed` event, to prove
   nothing was published.
4. Show the platform remains controllable: create another orchestration
   normally right after.

## What NOT to rely on for the demo

- Do not claim reduced context prevents prompt injection — it doesn't, and
  no doc in this repo says it does.
- Do not claim a cost "winner" from the benchmark unless both arms actually
  passed verification with configured pricing — `interpretBenchmarkResult`
  enforces this; showing a benchmark where direct wins honestly is stronger
  evidence than avoiding that case.
- Do not rely on an external network outage or flaky third-party service
  for the failure scenario — all three options above are fully
  deterministic and reproducible offline (modulo the real ModelArk call
  itself, which only affects planner/worker/verifier reasoning quality, not
  the enforcement points being demonstrated).
