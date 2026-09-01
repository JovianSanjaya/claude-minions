# MinionWare

MinionWare is a user-centric agentic AI middleware that turns an ambiguous coding request into a user-confirmed execution contract, routes the work across an appropriate hierarchy of models, gives bounded tasks to isolated workers, verifies the integrated result, and publishes only a verified candidate. It preserves the Starter Kit's Agent CRUD, lifecycle, Playground, persistent workspace, resumable Codex session, local container Runtime, and BytePlus ModelArk path.

## Project description

> MinionWare is a user-centric agentic AI middleware that combines orchestration, human-agent interaction, and test driven development, providing users with better results and efficient resource use.

### MinionWare

> A user centric agentic AI middleware that combines orchestration, human agent interaction, and test driven development.

### Inspiration

Coding agents are powerful, but their output is hard to trust and harder to predict. Most of the time the problem isn't the model. It's the specification. To get a desirable outcome from an agent, a user has to explain exactly what they want, and humans are notoriously bad at articulating everything they have in mind in a single prompt.

Today's baseline coding agents paper over that gap by guessing. They produce output based on their own interpretation of an ambiguous request, and the result looks confident even when it's wrong. The user only finds out several hundred lines later.

We wanted something that treats the specification as a primary artifact rather than an afterthought, a system that pins down intent before it starts burning tokens on implementation. That's MinionWare.

### What it does

MinionWare sits between the user and the coding agents as a middleware layer. It:

- Orchestrates a hierarchy of models rather than throwing one large model at the whole problem.
- Keeps the human in the loop at the points where ambiguity actually matters, so intent is captured up front instead of being reverse engineered from broken code.
- Drives development with tests, so "done" is a condition the system can check rather than a judgement call the model makes about its own work.

The result is better alignment with what the user actually asked for, and meaningfully more efficient use of expensive model calls.

### How we built it

MinionWare runs on two tiers of models.

**The driver.** A larger, more sophisticated thinking model owns the project. It holds the user's intent, decomposes the work, and writes the test cases that define what each unit of work has to satisfy.

**The minions.** Smaller, cheaper models take those goals and do the actual build and test cycle. Small models are generally quite capable of writing correct code when the end goal is unambiguous, and an AI generated test suite is about as unambiguous as a goal gets. Each minion iterates until its tests pass.

The key property here is context economy. The expensive model never has to read every failed attempt, every stack trace, and every intermediate diff. If a task takes $n$ build and test iterations, the naive single agent approach accumulates all $n$ iterations in one context window:

```text
C_naive = c_1 + c_2 + ... + c_n
```

Under MinionWare, that noise is absorbed by the minions, and the driver's context grows only by the goal and its result:

```text
C_driver = c_spec + c_result
```

Keeping the driver's context clean is what keeps it focused on the user's original intent, instead of drifting as its window fills with debugging noise.

### Challenges we ran into

Most of our pain was in implementation, and it was pain of exactly the kind MinionWare exists to solve.

We repeatedly shipped things that didn't match our vision. Our own development was driven partly by agents, and those agents kept writing code that behaved very differently from what we had in our heads. It was plausible, well structured, and not what we meant. Debugging a misunderstanding is much harder than debugging a bug, because nothing looks broken.

We also hit the coordination version of the same problem. We split the work, went off to build, and came back to find that our pieces overlapped severely. Two separate layers of unclear communication had compounded: first in how we divided the work between ourselves, and then again in how each of us described our segment to our own agent. Ambiguity at the top of the chain doesn't stay small. It multiplies.

### What we learned

The core lesson is that getting an agent, or any capable engineer, to produce code that matches your vision requires two things: clear communication of intent, and a willingness to go through multiple rounds of building and testing. Neither is optional, and no amount of model capability substitutes for either.

Living through our own overlapping implementations problem was the strongest possible argument for the thing we were building. A single, authoritative holder of project intent isn't optional. It's the difference between parallel work and duplicated work.

### What's next

MinionWare's real advantage is the centralization of project intent in a large driver model, which makes AI workflows look a lot like corporate ones: managers who hold context and engineers who execute against clear specs. That analogy suggests the next steps.

- Manager to manager communication, so multiple drivers can negotiate interfaces and split large projects the way teams of teams do.
- Multiple users to a single manager, so a whole team can collaborate against one shared, coherent specification rather than each person maintaining their own private version of the plan.
- Security and sandboxing around minion execution, so untrusted generated code stays contained.

---

## 1. Agent Launchpad: Design and Build Lightweight Agent Middleware

MinionWare builds the missing middleware, not a replacement platform. The implementation extends the Starter Kit's React/Fastify/Codex platform at its existing API, service, Runtime, workspace, and data seams.

### 1.1 Mission

AI coding Agents can reason, call tools, execute code, modify files, and continue across turns, but their execution is difficult to predict or audit when intent, scope, cost, and success criteria remain implicit. MinionWare addresses that Agent-specific infrastructure problem with one coherent story:

1. A planner elaborates the request into an explicit intent draft.
2. Material ambiguity is returned to the human instead of guessed.
3. The human reviews, revises, and explicitly confirms an immutable contract.
4. The control plane maps the application and adaptively selects Direct, one-worker, or multi-worker execution.
5. Each worker receives a bounded objective, allowed write paths, relevant context, artifacts, and acceptance criteria.
6. Candidate changes are integrated away from the main Agent workspace.
7. Protected and global verification gate publication.
8. Correlated, redacted evidence explains the route, actors, model usage, task attempts, checks, integration, publication, cancellation, and recovery.

This is functional middleware in the backend and Runtime path. The UI is only the control and evidence surface.

### 1.2 Starter Kit baseline and MinionWare responsibility

| Area | Baseline retained | MinionWare addition |
| --- | --- | --- |
| Product experience | React Agent list, create/edit, lifecycle controls, Playground, Run status | Direct, Auto, and Orchestrated controls; intent clarification and confirmation; plan, usage, evidence, and integration result views |
| Control plane | Fastify API, validation, asynchronous Runs, `AgentService`, JSON persistence | Orchestration and benchmark routes; immutable contracts; explicit state transitions; budgets; cancellation; restart reconciliation; redacted read models |
| Agent Runtime | Codex CLI, persistent sessions, per-Agent workspaces, disposable local containers | Role-aware planner/worker/verifier/integrator execution through the existing `AgentRunner` boundary |
| Infrastructure | Docker, Colima, Podman, Docker Compose, optional ECS scripts | Reuses the smallest local Runtime path; no cloud deployment is required for judging |
| Middleware | Intentionally absent in the Starter Kit | Evidence-driven orchestration, adaptive routing, compact context, isolated worker copies, protected acceptance plans, deterministic-first integration, verified publication, and benchmark evidence |

The original Agent lifecycle remains available: create, inspect, edit, start, stop, delete, send multi-turn Playground tasks, poll Runs, resume a Codex session, and retain the Agent workspace across restarts.

### 1.3 Run the baseline and MinionWare locally

#### Requirements

- macOS or Linux.
- Node.js 22 or newer and npm 10 or newer.
- One running container engine: Docker, Colima, or Podman.
- A BytePlus ModelArk API key and a Responses-compatible endpoint ID.

`ARK_API_KEY` must be an Ark model API key, not a BytePlus account AK/SK. `ARK_MODEL` is normally an endpoint ID beginning with `ep-`. The API key stays in the server/Runtime environment; never put it in the browser, a prompt, an Agent workspace, a screenshot, a trace, or a commit.

#### One-command local POC

From the repository root, run exactly one command:

```bash
ARK_API_KEY=your-ark-api-key ARK_MODEL=ep-your-endpoint-id npm run poc
```

The startup script installs dependencies on the first run, detects Docker, Colima, or Podman, builds the Runtime image, validates the configured mounts, builds the React and Fastify applications, starts the server, and cleans up this instance's remaining Runtime containers on exit. Open <http://localhost:3000>. Press `Ctrl+C` to stop it; metadata, workspaces, and Codex sessions persist.

To use distinct model tiers while retaining the same one-command startup:

```bash
ARK_API_KEY=your-ark-api-key ARK_MODEL=ep-default ORCHESTRATION_BIG_MODEL=ep-driver ORCHESTRATION_SMALL_MODEL=ep-minion npm run poc
```

The planner, verifier, and integrator use the big endpoint; workers use the small endpoint. Per-role overrides are also available through `ORCHESTRATION_PLANNER_MODEL`, `ORCHESTRATION_WORKER_MODEL`, `ORCHESTRATION_VERIFIER_MODEL`, and `ORCHESTRATION_INTEGRATOR_MODEL`. All roles fall back to `ARK_MODEL` when an override is absent.

To force rootless Podman, prepend `CONTAINER_ENGINE=podman`. Colima exposes the Docker CLI, so start Colima and use the normal command.

#### Baseline acceptance test

1. Open the browser and select **Create Agent**.
2. Enter a name, description, and workspace instructions.
3. Create the Agent and send: `Create a TypeScript hello-world CLI, add a test, run it, and summarize the files`.
4. Wait for the Run to complete and confirm that an assistant response appears.
5. Send a follow-up and confirm that the same Codex session continues.
6. Stop and restart the Agent and confirm that its workspace still exists.

If startup fails, check `docker info` or `podman info`, inspect <http://localhost:3000/api/system>, and verify the Ark key and endpoint. A `401 Unauthorized` from Ark normally means an account AK/SK was used instead of an Ark API key, or the endpoint ID is wrong.

#### Repository verification

```bash
npm run check
```

This runs TypeScript checks, the server test suite, and production builds. Validation result: 18 test files and 84 tests passed, and both the web and server production builds completed.

### 1.4 Platform and middleware design requirements

#### Middleware problem and rationale

The failure MinionWare targets is specification drift: an Agent can produce plausible code while solving the wrong interpretation of the request. Parallel workers amplify the risk when their scopes overlap or their understanding of shared interfaces diverges. A single expensive model also accumulates every failed attempt and stack trace in one context.

MinionWare makes intent, scope, dependencies, budgets, checks, and publication rules first-class control-plane data. It keeps the driver focused on the confirmed contract while bounded workers absorb implementation and test iterations.

#### Architecture

![MinionWare architecture](docs/architecture.jpeg)

The dashed teal box is the team-designed middleware: an evidence-driven orchestration control plane integrated into the Starter Kit rather than a replacement for it. Solid arrows show the baseline request, persistence, workspace, Runtime, and model paths. Dotted arrows marked **integrate** show the extension seams. The **verified publish only** path is the critical release gate: worker or integrator output cannot write the main Agent workspace until the isolated candidate passes required verification.

The flow is:

1. The human uses the React UI to create/select an Agent and submit a request.
2. The Fastify API validates the request and delegates Agent lifecycle work to `AgentService` or orchestration work to the orchestration routes.
3. `OrchestrationControlService` owns immutable intent/contract versions, legal state transitions, the budget ledger, correlated redacted events, cancellation, and restart reconciliation. Orchestration records persist in `orchestrations.json`.
4. `AgentExecutionCoordinator` prevents a Direct Run and an orchestration from owning the same Agent workspace concurrently and propagates stop/delete cancellation.
5. `ContextAwareExecutionDriver` maps the repository, selects a route, builds minimum-context packets, runs preflight, coordinates bounded worker loops, integrates changes, and invokes verification.
6. Planner, worker, verifier, and integrator roles all execute through the existing `AgentRunner` interface. The local POC creates a disposable Docker, Colima, or Podman container per turn; the ECS profile uses a Codex CLI process in the application container.
7. Codex calls the Volcengine Ark Responses API using credentials held outside the browser and Agent workspace.
8. Successful verification permits a drift-checked, rollback-capable publication into the per-Agent workspace. Failure retains redacted evidence and archives or cleans temporary state according to policy without publishing the candidate.

#### Ownership, data, enforcement, and failure boundaries

| Boundary | Owner and data crossing | Enforcement / instrumentation point | Failure behavior |
| --- | --- | --- | --- |
| Human / React → Fastify | Agent fields, prompt, requested mode, clarification answers, confirmation, and optional budget overrides | Zod request schemas, body limits, optional constant-time bearer-token check | Invalid or unauthorized input returns `400`, `401`, `409`, or `422`; no Runtime action occurs |
| Fastify → orchestration control plane | Agent ID, redacted prompt, requested mode, confirmed contract, state commands | `OrchestrationControlService`, immutable contract versions, explicit state machine, one active orchestration per Agent | Illegal transitions and workspace ownership conflicts are denied and recorded |
| Control plane → model roles | Role, model ID, compact prompt, workspace mode, execution/task IDs, estimated usage | Atomic model-call reservation, hard budgets, role-specific Runtime home, timeout, abort propagation | The call is denied before launch when a limit is exhausted; the exact stop reason is persisted |
| Main workspace → worker copy | Filtered snapshot, allowed write paths, application-map hashes, compact source context, required artifact versions | `.env`, secret-like paths, dependencies, build outputs, and control files are excluded; symlinks and traversal are rejected; preflight and post-run scope checks enforce `allowedPaths` | Scope or context violations fail the attempt; the main workspace remains unchanged |
| Worker → integration candidate | Changed/deleted file manifest and hashes from isolated task workspaces | Deterministic merge for identical/non-overlapping results; a focused integrator resolves true conflicts; base manifests detect drift | Conflicts, stale dependencies, or unexpected main-workspace drift stop publication and retain evidence |
| Candidate → protected/global verifier | Candidate workspace plus server-owned acceptance-plan identifiers; protected definitions do not enter worker context | Mode-`0700` protected evaluator directory, trusted executable allowlist, bounded output and timeout, correlated verification records | Any required failed check blocks publication; manual checks are marked explicitly instead of fabricated |
| Verified candidate → main workspace | Only the verified changed/deleted files | Staged publication, base-hash comparison, file backup, rollback on copy failure | Failed publication attempts rollback; rollback failures are separately captured as high-severity evidence |
| Control plane → JSON stores/UI | Contracts, tasks, attempts, usage, artifacts, checks, events, cleanup state | Serialized atomic writes, recursive secret redaction, bounded strings, safe read models | Interrupted work is reconciled to `cancelled`; reservations are released and evidence is retained |
| Runtime → ModelArk | Model request and Ark credential | Credential remains in the server/container environment; browser cannot select arbitrary secrets, prices, protected paths, or commands | Provider/network errors are bounded and recorded; a wrong Ark credential produces `401` |

#### Trust boundary and protected assets

- **Untrusted or partially trusted:** browser input, prompts, model output, generated code, worker workspaces, package scripts, and external model responses.
- **Trusted control boundary:** Fastify validation, orchestration state machine, budget ledger, server-selected models and prices, workspace manager, integrator, and verifier.
- **Server-only protected boundary:** acceptance plans and protected evaluator material under the configured protected root. Workers receive the checks they may act on, never the protected source.
- **Execution containment boundary:** the local disposable container has restricted mounts, a non-root user, dropped Linux capabilities, `no-new-privileges`, CPU/memory/PID limits, bounded output, and a timeout. It is useful containment, not hardened multi-tenant isolation.
- **External boundary:** Volcengine Ark is remote. The Ark key and endpoint configuration are trusted operator inputs.

Protected assets are the Ark key, Agent source and workspace, confirmed contract, protected evaluator integrity, budget limits, correlated evidence, and verified publish state.

#### Real behavior, evidence, and automated verification

MinionWare is not a static UI. The backend persists contracts and orchestration state, reserves model calls, builds repository manifests, creates task-specific workspace copies, enforces path scopes, invokes real Codex/ModelArk roles, integrates candidate files, runs verification, and conditionally publishes.

The evidence timeline correlates `orchestrationId`, `taskId`, and `executionId` across route decisions, role/model calls, context packets, task attempts, artifacts, budget events, verification, integration, cancellation, and publication. Inputs and outputs are summarized and redacted; chain-of-thought and protected evaluator source are not exposed.

Automated tests cover the middleware core, including contracts and API validation, legal and illegal state transitions, atomic budget reservation, redaction, persistence, cancellation, restart reconciliation, application mapping, context expansion, preflight, write-scope enforcement, worker retries, protected verification, deterministic integration, publish rollback, benchmarks, and the original Agent lifecycle.

#### Comparative benchmark evidence

The benchmark routes take one prompt, one confirmed criterion set, and one source-workspace hash, then execute Direct and Orchestrated arms on separate copies. The result reports verification status before token, model-call, attempt, wall-clock, and estimated-cost comparisons. This ordering prevents a cheaper but unverified arm from being presented as the winner. The UI warns when model assignments differ, pricing is unknown, or verification is unequal; in those cases no cost-winner claim is valid. A benchmark is evidence about that prompt and snapshot only—Direct may correctly outperform orchestration for small or tightly coupled work.

### 1.5 Agent lifecycle and post-creation experience

After creation, an Agent remains discoverable and controllable rather than ending at a success screen.

| Stage | User experience | Middleware behavior |
| --- | --- | --- |
| Create / select | Create an Agent or select an existing ready Agent | Creates or reuses its persistent workspace and metadata |
| Choose mode | Select **Direct**, **Auto**, or **Orchestrated** | Direct preserves the existing conversation; Auto chooses a route; Orchestrated requires a worker path when appropriate |
| Clarify intent | Review goal, requirements, assumptions, non-goals, architecture decisions, questions, estimates, and hard limits | A read-only planner drafts intent; material answers trigger a complete reconciliation rather than an appended note |
| Confirm | Explicitly confirm the resolved contract | Stores an immutable user-confirmed contract; planning cannot begin before confirmation |
| Plan | Inspect route reason, tasks, dependencies, write scopes, and acceptance criteria | Maps the application, produces protected acceptance plans, and selects Direct, one worker, or multiple workers |
| Execute | Watch tasks, attempts, model roles, usage, and evidence | Performs preflight, bounded execution, context expansion, artifact refresh, verification, integration, and conditional publication |
| Control | Stop or cancel active work | Propagates abort to active Runtime calls, releases reservations, and records cancellation evidence |
| Recover | Restart the server after interruption | Reconciles interrupted orchestration and Runs to `cancelled`, restores Agent availability, and retains evidence |
| Delete | Delete the Agent | Cancels Direct and orchestrated work first, then archives the Agent workspace according to explicit policy |

Orchestration states are `drafting-intent → awaiting-confirmation → planning → ready → running → integrating → verifying → completed`, with explicit branches to `needs-user`, `budget-exhausted`, `failed`, or `cancelled`. Material amendments require renewed user confirmation.

### 1.6 Selected middleware directions

MinionWare focuses on three closely related middleware directions:

- **Evidence and observability:** stable orchestration, task, and execution identifiers connect route decisions, model roles, context packets, artifacts, attempts, verification, integration, cancellation, and usage. Evidence is redacted before persistence and display.
- **Multi-Agent orchestration and control:** a driver turns the confirmed contract into bounded tasks, selects Direct, one-worker, or multi-worker execution, gives each minion a narrow context and write scope, tracks versioned shared artifacts, and integrates independent results. Atomic budgets, bounded attempts, context-expansion limits, timeouts, and cancellation keep execution controllable.
- **Safety and verified publication:** workers operate on isolated workspace copies; traversal, symlinks, secret-like paths, and out-of-scope edits are rejected. Protected and global checks run outside worker authority, and only a verified, drift-checked candidate can be published to the main Agent workspace. Failed publication is rolled back, while interrupted work is reconciled and retained as redacted evidence.

Identity and multi-tenant authorization are not claimed. `APP_AUTH_TOKEN` is an optional shared bearer token for protecting a remote demo, not user identity, RBAC, ownership isolation, or delegated authority.

## Demo

The demo shows one complete Agent journey and one controlled failure. Start the platform before the three-minute presentation using the documented one-command local POC.

### Normal journey

1. Open <http://localhost:3000>, create or select a ready Agent, and point out its current lifecycle state.
2. In **Execution control**, choose **Orchestrated** and submit:

   ```text
   Build a small TypeScript notes API and a separate client, with tests and a shared typed interface.
   ```

3. When the orchestration reaches **awaiting confirmation**, inspect the goal, requirements, assumptions, non-goals, architecture decisions, material questions, estimates, and hard limits. If a material question appears, answer it and select **Revise** to show that MinionWare reconciles the decision across the entire intent.
4. Select **Confirm contract**. Inspect the selected route, route reason, bounded tasks, dependencies, allowed write paths, and acceptance criteria. Execution begins when the plan becomes ready.
5. Follow the correlated evidence as the Run proceeds. Show a real ModelArk call, workspace file or tool action, disposable Runtime execution, worker attempt, usage event, verification result, and integration event.
6. Open **Integration (Result)** and show that the candidate was published only after required verification passed. Confirm that the Agent is understandable and controllable after completion.
7. Switch to **Direct** and send a small follow-up to demonstrate that the original resumable Playground path still works.

### Controlled failure: deterministic budget denial

Use the UUID of the Agent selected in the frontend to create a second orchestration with a one-call budget:

```bash
curl -sS -X POST http://localhost:3000/api/agents/<agent-uuid>/orchestrations -H 'Content-Type: application/json' -d '{"prompt":"Add one small, tested feature","requestedMode":"orchestrated","budget":{"maxModelCalls":1}}'
```

If `APP_AUTH_TOKEN` is configured, also provide `-H 'Authorization: Bearer <token>'`.

1. Return to the Agent in the UI and open the new orchestration.
2. Inspect the intent created by the first permitted model call, then confirm the contract.
3. The next model-call reservation is denied when planning begins because the confirmed one-call budget is exhausted.
4. Show the terminal **budget exhausted** state, exact stop reason, retained contract, usage ledger, and correlated budget event.
5. Confirm that no worker candidate was published and that the Agent remains available and controllable.

This failure is deterministic and does not depend on a provider outage. It demonstrates backend enforcement rather than a simulated UI error. A verification-failure variation can additionally show that a failed required check archives the isolated candidate while leaving the main Agent workspace unchanged.

### Rehearsal checklist

- Use a valid Ark model API key and Responses-compatible endpoint; do not use a BytePlus account AK/SK.
- Prebuild and start the local POC before the presentation timer begins.
- Run `npm run check` and confirm that all TypeScript checks, tests, and production builds pass.
- Keep the Ark key, bearer token, prompts containing secrets, protected evaluator source, and unredacted payloads out of the browser, workspace, logs, screenshots, and recording.
- Rehearse both journeys so the normal Run and failure evidence fit within three minutes.

## Known limitations

- The platform and orchestration stores are JSON-based, single-node, and assume one writer process.
- `APP_AUTH_TOKEN` is shared demo authentication, not user identity or authorization. The POC does not provide ownership isolation, RBAC, CSRF protection, or multi-tenant isolation.
- Ordinary Docker, Colima, and Podman containers are not hardened multi-tenant sandboxes. In the ECS profile, Codex runs inside the application container.
- The Ark key is available to the server and active Runtime. Outbound network access is broad, and generated code, dependencies, and allowed workspace commands remain risky.
- Protected checks reduce obvious evaluator gaming but do not prove arbitrary program correctness. Model-judged verification and bounded automatic repair remain best-effort, while manual criteria still require human review.
- A model call that fails before returning usage is recorded with zero usage, so expenditure from an aborted call may be undercounted.
- Concurrent planning, verification, and worker batches have no host-level concurrency cap. A large plan can launch an entire batch of containers at once.
- Estimated dollar cost remains unavailable until operator pricing is configured. Displayed cost is an estimate, not a billing record.
- The Direct-versus-Orchestrated benchmark describes one prompt and source snapshot. Different models, unknown pricing, or unequal verification prevent a valid cost-winner claim.
- A compromised host or operator can access POC data. Do not mount production data, use production credentials, or expose the service publicly without HTTPS, network restrictions, and a strong bearer token.

## Configuration reference

| Variable | Purpose | Default / behavior |
| --- | --- | --- |
| `ARK_API_KEY` | Ark model API key | Required for model-backed runs |
| `ARK_MODEL` | Default Responses-compatible endpoint/model | Required; fallback for every role |
| `ORCHESTRATION_BIG_MODEL` | Planner/verifier/integrator endpoint | Falls back to `ARK_MODEL` |
| `ORCHESTRATION_SMALL_MODEL` | Worker endpoint | Falls back to the big/default endpoint |
| `ORCHESTRATION_*_MODEL` | Advanced per-role overrides | Optional; server-controlled |
| `APP_AUTH_TOKEN` | Shared bearer token for a remote demo | Optional locally; required to be strong for non-loopback production |
| `ORCHESTRATION_MAX_MODEL_CALLS` | Cumulative model-call limit per orchestration | `100` |
| `ORCHESTRATION_MAX_WORKER_ATTEMPTS` | Worker attempt bound | `3` |
| `ORCHESTRATION_MAX_CONTEXT_EXPANSIONS` | Narrow context grants per task | `3` |
| `ORCHESTRATION_MAX_WALL_CLOCK_MS` | Orchestration wall-clock bound | `1800000` (30 minutes) |
| `CODEX_TIMEOUT_MS` | Timeout for one Codex CLI invocation | `1800000` (30 minutes) |
| `CONTAINER_CPU_LIMIT` / `CONTAINER_MEMORY_LIMIT` / `CONTAINER_PIDS_LIMIT` | Local Runtime resource bounds | `2` CPU / `2g` / `256` |
| `LOCAL_POC_DATA_ROOT` | Alternate persistent local data root | macOS: `~/.volc-agent-launchpad`; Linux: repository `.local` |

Input/output token ceilings are disabled unless configured. Cost ceilings require pricing configuration to be meaningful. The control plane also defaults to 250 steps.

## Technology

React, Vite, TypeScript, Fastify, Zod, Vitest, Node.js 22, Codex CLI, Docker/Colima/Podman, and BytePlus ModelArk's Responses-compatible API.

## License

See `LICENSE` in the repository.
