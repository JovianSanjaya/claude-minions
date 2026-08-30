# Demo script

Two scenarios: a normal orchestration that finishes under three minutes, and a
deterministic failure/recovery scenario that never depends on an unpredictable
external outage.

Read [ARCHITECTURE.md](ARCHITECTURE.md#orchestration-middleware) first if you
want the trust boundaries in mind while watching.

---

## Before you start

```bash
ARK_API_KEY=your-ark-api-key \
ARK_MODEL=ep-your-endpoint-id \
npm run poc
```

Open <http://localhost:3000>.

Checklist, so nothing is decided live:

- [ ] One Agent already exists and is `ready`, with a small seeded project in
      its workspace (two or three modules with narrow interfaces demos best).
- [ ] The Runtime card in the sidebar shows a container Runtime and a model.
- [ ] Optional: set `ORCHESTRATION_MODEL_PRICING` so estimated dollars appear.
      Without it the UI honestly shows `Pricing not configured`, which is also
      a fine thing to show a judge.
- [ ] Never paste a real key into a terminal that is on screen, and never into
      source, docs, logs, or a recording.

Rough timing for the three-minute run: 20s framing, 40s intent and
confirmation, 60s execution evidence, 40s verification and publish, 20s usage
and benchmark.

---

## Scenario A — normal path (about 2 minutes 40 seconds)

### 1. Frame the problem (20s)

> "A single strong coding Agent re-reads the whole repository every turn. Naive
> delegation is often worse. This middleware decides *whether* to delegate,
> gives each worker only the context it needs, and then proves whether that
> helped."

Point at the existing Playground: **the baseline still works**. Send nothing
yet.

### 2. Show the three modes (15s)

Point at **Direct · Auto · Orchestrated**.

> "Direct is the Starter Kit path, unchanged. Auto confirms intent and then
> still decides between direct, one worker, or several. Orchestrated forces
> delegation when the contract can actually be decomposed within budget."

### 3. Submit a modular task (15s)

Choose **Auto**. Submit something genuinely decomposable, for example:

```text
Add password reset: a reset-token model with expiry, an API endpoint that
validates the token, and a frontend screen. Keep existing login tests passing.
```

Nothing is written yet. The status becomes `drafting-intent`.

### 4. Review, revise, and confirm intent (40s)

The panel reaches **Awaiting your confirmation** and shows goal, requirements,
assumptions, non-goals, architecture decisions, manual expectations, open
material questions, the token and estimated-dollar range with its assumptions,
and the hard budget.

Do two things deliberately:

1. **Answer a material question.** Show that **Confirm contract is disabled**
   until it is answered. Say: *"Confirmation is explicit. It is never inferred
   from a model message or from opening this screen."*
2. **Revise once.** Type a correction and press **Revise**. The revision number
   increments; the previous draft is kept, not overwritten.

Then press **Confirm contract**. Point at contract **v1** and its criteria,
including a `protected-test` criterion:

> "Workers can read what this criterion requires. They can never read or edit
> how it is checked."

### 5. Route decision and context (30s)

Status moves through `planning` to `ready`. Show:

- the **selected route and its reason**;
- two or three tasks with dependencies and allowed paths;
- each task's **context packet**: file count, hashes, bytes, token estimate.

> "This is the whole point: file paths, hashes, and sizes — not the file
> contents, and not every other worker's transcript."

Press **Start execution**. Nothing starts merely because the screen is open.

### 6. Isolated execution and coordination (30s)

While it runs, show:

- worker preflight approved before any writable call;
- isolated worker workspaces and per-attempt changed-file manifests;
- a **shared artifact** published at v1 and, if the run produces one, a
  dependant task marked stale and refreshed;
- the timeline filters: Tasks, Roles, Failures, Budget, Verification,
  Integration.

### 7. Verification and publish (40s)

Show the four verification groups kept apart: worker-visible, protected,
global, manual.

> "A worker's claim is not proof. Worker-visible checks help it iterate.
> Protected and global checks run outside its authority, and it cannot mark
> itself passed."

Then show deterministic integration, the global pass, and the published result
in the main Agent workspace.

### 8. Usage and cost (20s)

Scroll to the usage table: per-role tokens, model IDs, model calls, estimate
versus actual, hard-limit gauges, and the evidence counters.

> "Estimated cost, from configured prices. Never billed cost. If a model has no
> configured price we show token totals and say pricing is not configured."

---

## Scenario B — deterministic budget stop and recovery (about 60 seconds)

This is reproducible on demand and needs no external failure.

### Setup

Restart with a deliberately tiny budget:

```bash
ORCHESTRATION_MAX_MODEL_CALLS=2 \
ARK_API_KEY=your-ark-api-key \
ARK_MODEL=ep-your-endpoint-id \
npm run poc
```

`ORCHESTRATION_MAX_WALL_CLOCK_MS=20000` produces the same shape of result if
you prefer a time-based stop.

### Run it

1. Submit the same modular task in **Orchestrated** mode and confirm the
   contract as before.
2. Press **Start execution**.
3. The budget gate denies the next reservation. Show, in this order:
   - the **Budget** filter on the timeline, with the denial event;
   - the orchestration status **Budget stop** and the exact stop reason;
   - the hard-limit gauge at its limit;
   - **no published result**, and the main Agent workspace unchanged;
   - the Agent back in a truthful `ready` state, still fully controllable.

> "The budget is enforced in the control plane, not suggested to the model. A
> denial is a persisted domain state, not an HTTP 500, and it stops new work
> rather than silently weakening the contract to make something pass."

### Two ten-second variants worth showing if time allows

- **Cancellation.** Start a run and press **Cancel orchestration**. Child
  executions are aborted, state becomes `cancelled` with a reason, and
  contracts, events, verifications, and usage are retained.
- **Restart.** Stop the server mid-run with `Ctrl+C` and start it again.
  Interrupted work is reconciled to `cancelled` with a restart reason. It is
  never reported as success.

---

## Optional — the benchmark (30 seconds)

Use the **Direct versus orchestrated** panel, or:

```bash
curl -X POST http://localhost:3000/api/agents/$AGENT_ID/benchmarks \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $APP_AUTH_TOKEN" \
  -d '{"prompt":"Rename one constant and update its tests."}'

curl http://localhost:3000/api/benchmarks/$BENCHMARK_ID \
  -H "authorization: Bearer $APP_AUTH_TOKEN"
```

Read the result in the order the panel presents it:

1. **Quality and verification first.** If the arms did not reach the same
   verified quality, the cost verdict is withheld — a cheaper arm that failed
   its checks is not a winner.
2. **Then tokens, then estimated dollars**, reported separately.
3. **Then the comparability warnings**: model differences, pricing assumptions,
   snapshot match, single-sample caveat, sequential wall-clock caveat.

Run both a small coupled task and a modular one.

> "Direct winning on a small coupled task is the expected, honest result, and we
> show it rather than hiding it."

Live Ark benchmarking is a manual step. The automated suite uses a deterministic
two-arm fixture and is skipped from nothing: it never needs credentials.

---

## Automated checks a judge can run

```bash
npm run check                                            # typecheck, tests, build
npx vitest run src/orchestration/benchmark -w @launchpad/server
npx vitest run --root apps/web                           # UI state and polling helpers
```

No Ark key, network access, Docker, or global Codex install is required for any
of these.

---

## If something goes wrong live

- **Ark is unreachable or slow.** Switch to Scenario B; the budget stop is local
  and deterministic. Or show the automated suites above.
- **A run hangs.** Press **Cancel orchestration**; that itself demonstrates a
  required capability.
- **The Agent shows `error`.** Press **Stop** then **Start**; the baseline
  lifecycle is unchanged and recovers.
- **Nothing renders.** The panel keeps the last valid view on a recoverable
  network error and backs off; check the error banner text before reloading.
