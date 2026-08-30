# TechJam 2026 — Track 1 submission

**Track.** Agent Launchpad: Design and Build Lightweight Agent Middleware.

**One-sentence pitch.** Middleware that treats model intelligence and context as
schedulable Agent resources: a powerful planner confirms global intent with the
user, then the control layer routes local work to appropriately priced models
with only the context each one needs, under versioned contracts, hard budgets,
trusted verification, and measured direct-versus-orchestrated evidence.

---

## 1. The Agent-specific problem

A single strong coding Agent re-reasons over broad and growing repository
context on every turn, so cost tracks repository size rather than task size.

The obvious fix — spawn more Agents — is frequently worse. Workers duplicate
context, coordination itself costs tokens, interfaces drift mid-flight, retries
accumulate, and an integrator quietly reassembles the monolithic context at the
end. Meanwhile a worker's own claim of success is trusted, budgets are advisory,
and nobody can say afterwards whether delegation helped.

The missing component is not another Agent. It is a **control layer** that
decides whether to delegate at all, allocates context and model capability as
budgeted resources, keeps a confirmed contract stable under pressure, verifies
outside worker authority, and then measures the outcome honestly.

## 2. Why middleware is the right boundary

The decisions above are not model decisions and not application decisions.

- They need **trusted state** the model cannot rewrite: confirmed contracts,
  the budget ledger, verification results.
- They need **filesystem and process authority** the model must not hold:
  isolated snapshots, protected evaluator storage, publication.
- They must be **enforced**, not requested. A budget that a prompt can talk its
  way past is not a budget.

So they belong between the browser and the Runtime, alongside the existing
control plane — exactly where the Starter Kit leaves a seam.

## 3. What was added

The Starter Kit already provided Agent CRUD and lifecycle, the direct Playground
with resumable Codex sessions, async Run polling, persistent workspaces, atomic
JSON persistence, disposable container execution, cancellation, timeouts,
resource limits, and restart reconciliation. **All of it still works unchanged**,
and the direct path is deliberately retained as the benchmark baseline.

Added on top:

| Layer | What it owns |
| --- | --- |
| **Control plane** | Orchestration state machine, intent drafts and revisions, immutable versioned contracts and amendments, redaction before persistence, budget ledger, cancellation, restart reconciliation, event and read model, Fastify routes |
| **Execution engine** | Planner / worker / verifier / integrator roles, adaptive routing, versioned application map, context broker with budgeted expansion, isolated worker workspaces, read-only preflight, bounded worker loop, artifact registry with drift detection, protected and global verification, deterministic-first integration, verified publication |
| **Experience and evidence** | Direct/Auto/Orchestrated control, intent review and explicit confirmation, amendment confirm/reject, route and task evidence, context-packet evidence, correlated filterable timeline, per-role usage and estimated cost, budget gauges, benchmark service and UI |

## 4. Architecture

The one-page diagram, trust boundaries, and the enforcement /
instrumentation / recovery table are in
[ARCHITECTURE.md](ARCHITECTURE.md#orchestration-middleware).

The short version:

```text
Browser ─▶ Fastify (bearer + Zod) ─▶ Control plane ─▶ Execution driver ─▶ AgentRunner ─▶ ModelArk
                                          │                    │
                                    budget ledger        isolated worker
                                    contract store        workspaces
                                    redacted events            │
                                          │              staging + protected
                                          └── publication gate ── verification
```

## 5. Live journey

Both scenarios, with timings and fallbacks, are in [DEMO.md](DEMO.md).

**Normal.** Select a ready Agent → choose Auto → submit a modular coding task →
read the planner's interpretation, answer a material question, revise once →
confirm contract v1 → see the route decision and per-task context packets →
start → watch preflight, isolated edits, a shared artifact version and a focused
refresh → deterministic integration → protected and global verification →
verified publish → per-role usage and estimated cost.

**Failure and recovery.** Restart with `ORCHESTRATION_MAX_MODEL_CALLS=2`. The
budget gate denies the next reservation, the orchestration ends in
`budget-exhausted` with the exact stop reason, **nothing is published**, the main
workspace is untouched, and the Agent returns to a truthful `ready` state. It is
fully deterministic and needs no external outage.

## 6. Rubric mapping

### End-to-end middleware behaviour (40%)

Real browser → control plane → Runtime → workspace path. Model calls, file
edits, command execution, and verification all happen for real; the middleware
changes routing, context, budget, verification, and publication behaviour in the
backend, not just the display. The failure case (budget stop) and the recovery
cases (cancellation, restart reconciliation) are demonstrable and deterministic.

### Technical design and integration (25%)

A single clearly-stated Agent problem, a coherent boundary (trusted control
plane versus untrusted model output versus sandboxed worker action), and focused
changes: the baseline database and direct path are untouched, orchestration
state lives in its own store, and the three modules communicate through one
frozen TypeScript contract (`apps/server/src/orchestration/contracts.ts`) plus
injected ports — `OrchestrationExecutionDriver`, `OrchestrationSink`,
`AgentAccessPort`, `BenchmarkExecutor`, `OrchestrationApi`. Each module compiles
and tests independently of the others.

### Verification and robustness (20%)

Automated tests across the control plane, engine, benchmark, and UI helpers, all
runnable without Ark, network, Docker, or a global Codex install. Trusted
verification lives outside worker authority; workers cannot read or edit
protected checks or mark themselves passed. Redaction happens before
persistence. Budgets are enforced at reservation time. Cancellation and restart
reconciliation never report interrupted work as success. Traversal and symlink
escapes are rejected; cleanup refuses unsafe targets.

### Demo and reproducibility (15%)

One-command startup (`npm run poc`), a scripted sub-three-minute demo with a
deterministic failure scenario and stated fallbacks, `npm run check` as the
single validation entry point, no hidden manual setup, no secrets in the
repository, and an explicit limitations section in both the README and the
threat model.

## 7. Evidence a reviewer can inspect

| Question | Where to look |
| --- | --- |
| What did the user actually agree to? | Contract v1 and its criteria in the panel; immutable version history in the store |
| Why this route? | Route decision and reason on the plan board |
| What context did each worker get? | Context packets: file count, hashes, bytes, token estimate — never contents |
| What stopped runaway work? | Budget gauges, the Budget timeline filter, the `budget-exhausted` state and its reason |
| How were workers stopped from grading themselves? | The four verification groups; protected checks at `PROTECTED_EVALUATOR_ROOT`, mode 0700, never mounted |
| How was interface drift handled? | Artifact versions, stale marking, focused refresh in the coordination panel |
| Why trust the final workspace? | Deterministic integration, staging workspace, global verification before publish |
| What happened on failure or restart? | Failure packets, cancellation events, restart reconciliation reason |
| Did orchestration help? | The benchmark panel — quality first, then tokens, then estimated dollars, then warnings |

## 8. Benchmark caveats

Read the benchmark exactly as it is presented, in order.

1. **Quality and verification first.** If the arms did not reach the same
   verified quality or did not run the same trusted checks, the cost verdict is
   **withheld**. A cheaper arm that failed its checks is not a winner.
2. **Tokens and dollars are separate.** More tokens on a cheaper model can still
   cost less; unknown pricing yields token totals plus
   `pricingStatus: "unknown"` and no dollar figure.
3. **Fairness is enforced, not assumed.** Two isolated copies of one workspace
   snapshot, identical prompt and criteria, no cross-arm leakage; the arm inputs
   are constructed only from the immutable benchmark record.
4. **Known non-comparabilities are printed, not hidden.** Model differences,
   pricing assumptions, snapshot mismatch, cancellation, one sample per arm, and
   sequential execution on a shared host.
5. **Direct winning is a real result.** For small or tightly coupled tasks it is
   the expected one, and it is displayed rather than suppressed.

Run at least one small coupled task and one modular task before concluding
anything.

## 9. Known limitations

- Single-user POC: no real identity, RBAC, tenant isolation, or CSRF defence.
  The shared bearer token is demo access control, not authorization.
- Ordinary containers are not hardened multi-tenant sandboxes; Runtime network
  access is broad, and the Runtime holds the Ark key for its turn.
- JSON persistence supports exactly one server process. PostgreSQL with leases
  is documented as the production evolution, not implemented.
- **Context minimization is a cost and focus mechanism, not a security boundary.
  It does not prevent prompt injection.**
- Protected checks reduce obvious gaming; they are not proof of correctness.
- If the installed Codex CLI cannot override the model per role, all roles fall
  back to the configured Ark model and the evidence records that truthfully. No
  multi-model saving is fabricated.
- Budget reservations are estimates; a single in-flight call can overshoot
  before commit. Wall-clock limits are checked at call boundaries.
- Benchmarks are single samples run sequentially; sampling variance is not
  measured.
- Estimated dollars are estimates from configured prices, never billed amounts.
- Publication is atomic on a best-effort basis, not transactional across a
  filesystem; a crash mid-publish is reported as cancelled, never as success.
- Artifact staleness is tracked per artifact, not per symbol, so refreshes can
  be broader than strictly necessary.

## 10. Explicitly not claimed

- That subagents or delegation are novel.
- That delegation always saves tokens or money — the benchmark exists because it
  must be measured, and it is allowed to say no.
- That hidden tests prove correctness.
- That reduced context prevents prompt injection.
- That any dollar figure shown is a billed amount.

## 11. Repository map

```text
apps/server/src/orchestration/contracts.ts    frozen cross-module contract
apps/server/src/orchestration/control/        state, store, redaction, budget, routes
apps/server/src/orchestration/engine/         router, map, broker, roles, verify, integrate
apps/server/src/orchestration/benchmark/      direct-vs-orchestrated service and routes
apps/web/src/orchestration/                   panel, ports, view model, polling, components

docs/ARCHITECTURE.md    diagram, boundaries, enforcement points
docs/DEMO.md            three-minute script plus deterministic failure case
docs/THREAT_MODEL.md    assets, actors, boundaries, threats, residual risk
docs/handoffs/          per-module integration notes
```

## 12. Validation

```bash
npm run check                                   # typecheck, server tests, build
terraform fmt -check -recursive deploy/volcengine
docker compose config
```

Focused suites:

```bash
npx vitest run src/orchestration/benchmark -w @launchpad/server
npx vitest run --root apps/web
```

No Ark credentials, network access, Docker, or global Codex install is required
for any automated test.
