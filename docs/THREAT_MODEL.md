# Threat model

Scope: the Volc Agent Launchpad proof of concept with the TechJam Track 1
orchestration middleware. This is a **single-user hackathon POC**, not a
production multi-tenant platform. The purpose of this document is to be precise
about what is actually enforced, what is merely reduced, and what is left open.

Related: [ARCHITECTURE.md](ARCHITECTURE.md#orchestration-middleware) for the
diagram, [SECURITY.md](../SECURITY.md) for the baseline policy.

---

## 1. Assets

| Asset | Why it matters | Where it lives |
| --- | --- | --- |
| `ARK_API_KEY` | Direct financial loss and model abuse if leaked | Server process env and the active Runtime container |
| `APP_AUTH_TOKEN` | Shared demo access control for `/api/*` | Server env and the operator's browser |
| Agent workspace and source | The user's actual work; can be corrupted or exfiltrated | `workspaces/<agentId>/` |
| Protected evaluator definitions | If a worker could read or edit them, verification would be theatre | `PROTECTED_EVALUATOR_ROOT`, mode 0700 |
| Confirmed contracts and amendments | The record of what the user actually agreed to | `orchestrations.json` |
| Budget and usage ledger | The only thing standing between a loop and an unbounded bill | `orchestrations.json` |
| Event and evidence data | Judged claims rest on it; must be safe to display | `orchestrations.json` |
| Benchmark records | Cost claims rest on comparability metadata | Benchmark store |

## 2. Actors

| Actor | Trust | Notes |
| --- | --- | --- |
| User (browser) | Semi-trusted | Authenticated only by a shared token. All input is validated server-side. |
| Control plane | Trusted | Owns state transitions, redaction, budget, cancellation, persistence. |
| Planner role | Untrusted output | A model. Its structured output is schema-validated; it never gains filesystem authority. |
| Worker roles | Untrusted output, sandboxed action | Write only inside their own snapshot and allowed paths. |
| Verifier role | Untrusted output, trusted harness | The *harness* is trusted; the model's opinion is not the pass signal. |
| Integrator role | Untrusted output | Only sees conflicting files; deterministic merge runs first. |
| Runtime (container / child process) | Semi-trusted | Holds the Ark key for the turn. Ordinary container, not a hardened sandbox. |
| ModelArk endpoint | External | Receives prompts and context. Assume anything sent there has left the boundary. |

## 3. Trust boundaries

```text
Browser  ──1──▶  Fastify API  ──▶  Control plane  ──2──▶  Engine
                                        │                    │
                                        │3                   │4
                                        ▼                    ▼
                            Protected evaluator root   Worker snapshots
                                                             │5
                                                             ▼
                                                    Runtime ──6──▶ ModelArk
```

1. **Browser → API.** Zod-validated params and bodies, bounded sizes, shared
   bearer token on `/api/*`. The browser can never choose a filesystem path, an
   executable, a model ID, a price, or a shell command.
2. **Control plane → engine.** The engine acts only through the frozen
   `OrchestrationSink`; every model call must first win a budget reservation.
3. **Control plane → protected evaluators.** Mode 0700, outside every workspace.
   Never mounted into a Runtime, never copied into a snapshot, never returned by
   an API response or rendered in the UI.
4. **Engine → worker snapshots.** One task-specific directory per worker, with
   resolved allowed paths. Symlink and traversal escapes are rejected.
5. **Worker → main workspace.** There is no direct path. Publication happens
   only from a staging workspace after global verification passes.
6. **Runtime → ModelArk.** The key crosses here. Context sent here has left our
   control.

## 4. Threats and controls

### 4.1 Secret capture

*Threat.* A prompt, a worker, a log line, an event summary, or a screenshot
exposes `ARK_API_KEY`, the bearer token, or an `Authorization` header.

*Controls.* The browser never receives the Ark key. Fastify redacts
`authorization` and `cookie` request headers. Recursive redaction of key-like
assignments, bearer tokens, and `sk-`-style keys runs **before persistence**,
and again in the browser view model before rendering. `.env*` files are excluded
from application maps, context packets, and benchmark snapshots. Stored
summaries and outputs are length-bounded.

*Residual.* A worker process legitimately holds the key for its turn and can
exfiltrate it over the network. Broad Runtime network access is a known,
accepted POC limitation.

### 4.2 Path traversal and symlink escape

*Threat.* A task, a context-expansion request, or a cleanup step reaches outside
the intended directory — reading `/etc/passwd`, or deleting a real workspace.

*Controls.* Paths are resolved and checked against a task-specific root.
Symlinks that escape the boundary are rejected rather than followed. Context
expansion validates the resolved path and is counted and budgeted. Cleanup runs
only against resolved, task-specific paths — never `/`, a home directory, a
workspace root, an unresolved environment variable, or a glob; an unsafe target
is refused and retained for manual review. The UI additionally shortens
absolute paths to their last segments before rendering.

*Residual.* A compromised Runtime with broad filesystem access inside its own
container is still able to act within that container.

### 4.3 Test tampering and self-grading

*Threat.* A worker weakens, deletes, or rewrites the checks that grade it, or
simply reports success.

*Controls.* Worker-visible checks are explicitly *not* the pass signal. Protected
and global checks run in a trusted harness outside worker authority, from
trusted configuration or confirmed typed contract mappings — never from an
arbitrary shell string. A worker cannot edit the evaluator or mark its own
result passed. The benchmark applies the same rule: an arm that claims success
while a protected or global check failed does not count as a quality pass.

*Residual.* Hidden checks reduce obvious gaming. **They are not proof of
correctness.**

### 4.4 Evaluator exposure

*Threat.* Protected check source leaks through a context packet, a mounted
directory, an API response, a failure packet, or the UI.

*Controls.* Protected evaluator storage lives outside every workspace at mode
0700 and is excluded from application maps and context packets. It is never
mounted into a worker Runtime. The read model exposes only a criterion
description, a check label, and a bounded output summary. The browser view model
drops fields named like protected or evaluator source even if a server ever sent
them, and a test asserts that.

*Residual.* A sufficiently detailed failure summary can leak information about
what a check expects. Summaries are bounded but are not formally analysed.

### 4.5 Runaway cost

*Threat.* A retry loop, a context explosion, or a stuck worker burns tokens
without bound.

*Controls.* Every model call must first win a `reserveModelCall` decision
checked against token, estimated-dollar, call, step, attempt, expansion, and
wall-clock limits, with a conservative reservation. Actual usage is committed
per role. A denial produces the persisted `budget-exhausted` state and stops new
work; it is not an HTTP 500 and it never silently weakens the contract.
Cancellation stays available after a budget stop. Limits are Zod-bounded and
never accept negative, `NaN`, infinite, or absurd values from the browser.

*Residual.* Reservations are estimates; a single in-flight call can overshoot
its reservation before it is committed. Wall-clock enforcement is checked at
call boundaries.

### 4.6 Stale artifact and interface drift

*Threat.* A worker builds against v1 of a shared interface after another worker
published v2, and the mismatch is only discovered at integration — or worse, is
not discovered.

*Controls.* Artifacts are versioned and published through the sink. Tasks record
the artifact versions they observed. Publishing a new version marks affected
dependants stale and triggers a focused refresh of their context packet and
preflight, rather than a full replan. Unaffected tasks are left alone.

*Residual.* Staleness is tracked at artifact granularity, not at symbol
granularity, so a refresh can be broader than strictly necessary.

### 4.7 Malicious package scripts and hostile repository content

*Threat.* A coding task installs a dependency whose install script runs
arbitrary code, or the model follows instructions embedded in repository files.

*Controls.* Execution is confined to the Runtime container with CPU, memory, and
PID limits and argv-only spawning. Output and time are bounded. Publication
requires global verification to pass first.

*Residual.* **Context minimization is not a security boundary and does not
prevent prompt injection.** A coding Agent that can run commands can be
influenced by content it reads. Do not point this POC at untrusted repositories
or place unrelated credentials in a workspace.

### 4.8 Partial publish

*Threat.* Verification fails halfway, leaving the main workspace in a broken,
half-written state.

*Controls.* Work happens in isolated snapshots; integration happens in a staging
workspace; publication to the main workspace happens only after all required
non-manual checks pass, with manual criteria explicitly accounted for. Before
publishing, the main workspace is compared against the captured base — if the
user or another process changed conflicting files, the orchestration goes to
`needs-user` instead of overwriting. Exactly what was published is recorded.

*Residual.* Publication is atomic on a best-effort basis, not transactional
across a filesystem. A crash during the final copy can still leave partial
state; restart reconciliation reports it as cancelled rather than successful.

### 4.9 Concurrent writers on one workspace

*Threat.* A direct Playground Run and an orchestration write the same Agent
workspace simultaneously.

*Controls.* One active orchestration per Agent, enforced atomically in the
control store; a stopped Agent cannot begin one. A coordinator port lets direct
execution assert availability and lets Agent stop/delete cancel orchestration
work first. The benchmark refuses to start when the Agent is `busy` or already
has a running benchmark, and its arms work on copies, never the live workspace.

*Residual.* Enforcement assumes a single server process, as does JSON
persistence.

### 4.10 Restart and interrupted state

*Threat.* A restart leaves work that looks successful but never finished.

*Controls.* Initialization marks interrupted non-terminal orchestrations,
benchmarks, and Runs as `cancelled` with a restart reason, and returns busy
Agents to `ready`. It never infers success. Contracts, events, verification
summaries, and usage are retained.

*Residual.* Child containers orphaned by an unclean host shutdown may need
manual cleanup.

### 4.11 Misleading efficiency claims

*Threat.* The project claims delegation saved money when it did not.

*Controls.* Quality is computed and displayed before cost. A cost verdict is
withheld whenever the arms differ in verified quality or ran different trusted
checks. Tokens and estimated dollars are reported separately. Unknown pricing
yields `pricingStatus: "unknown"` and no dollar value. Model and pricing
differences, snapshot mismatches, single-sample variance, and sequential
wall-clock timing are recorded as explicit comparability warnings. A direct win
is reported as a valid result.

*Residual.* One sample per arm. Model sampling variance is not measured.

## 5. Implemented controls versus non-goals

**Implemented.**

- Shared bearer token on `/api/*`, Zod validation, bounded bodies.
- Redaction before persistence and before rendering.
- Separate orchestration store; atomic mode-0600 writes; serialized mutations.
- State machine with explicit confirmation and immutable versioned contracts.
- Budget reservations, hard stops, and a persisted `budget-exhausted` state.
- Minimum-sufficient context packets with validated, budgeted expansion.
- Isolated per-task worker workspaces with scope manifests.
- Protected verification outside worker authority; publication gated on it.
- Deterministic-first integration and staging-workspace publication.
- Cancellation, restart reconciliation, and a recorded cleanup/archive policy.
- Fairness-constrained benchmark with quality-before-cost reporting.

**Explicit non-goals.**

- Production OAuth, RBAC, per-user identity, tenant isolation, CSRF defence.
- A hardened multi-tenant sandbox or container scheduler.
- Multi-process or multi-region operation; a real database with leases.
- Egress filtering or network policy for the Runtime.
- Supply-chain verification of packages a coding task installs.
- Formal proof that protected checks are correct or complete.

## 6. Residual risk statement

This POC is safe to demonstrate with a scoped demo key on a machine you control,
against a repository you are willing to lose. It is **not** safe for production
data, real credentials, untrusted repositories, or multi-user exposure. The
middleware makes runaway cost, self-graded success, context sprawl, and
unverified publication substantially harder. It does not make the Runtime a
trust boundary, and it does not defend against prompt injection.
