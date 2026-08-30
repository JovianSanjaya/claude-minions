# Final Assembly handoff

Performed after Task 1 (control plane), Task 2 (engine), and Task 3 (product
experience, benchmark, docs) all reported complete, per section 9 of the
specification.

## What changed here (composition roots only)

- `apps/server/src/app.ts` — `createApp` takes an optional third
  `{ control, benchmark }` argument; when present, registers
  `registerOrchestrationRoutes` and `registerBenchmarkRoutes` after the
  existing bearer-token hook, so every new route inherits it. Omitting the
  argument (as `app.test.ts` still does) preserves the exact original
  behavior.
- `apps/server/src/index.ts` — rewritten as the composition root: builds the
  orchestration store, the real `OrchestrationEngineDriver` (Task 2), the
  `OrchestrationControlService` (Task 1) with a real `AgentAccessPort` bound
  to `AgentService`, the `AgentExecutionCoordinator` adapter, and the
  `BenchmarkService` (Task 3) with real direct/orchestrated executors. All
  three (`service`, `control`, `benchmarkService`) initialize before
  `app.listen`, so restart reconciliation runs first for both the baseline
  store and the orchestration store.
- `apps/web/src/api.ts` — added `orchestrationApi: OrchestrationApi`,
  implemented against the existing authenticated `request` helper. No second
  fetch path.
- `apps/web/src/App.tsx` — mounts `<OrchestrationPanel>` inside the existing
  selected-Agent Playground, after the direct chat section. All baseline CRUD,
  settings, direct send, Run polling, and lifecycle actions are untouched.
- `apps/server/src/demo-check-catalog.ts` (new, Final-Assembly-owned) — a
  Proxy-based `TrustedCheckDefinition` catalog. See the long comment in that
  file: confirmed contract criterion IDs are minted per-orchestration
  (`"c1"`, `"c2"`, …), so a fixed static map can never line up with every
  future orchestration; every lookup instead returns the same trusted,
  argv-only sanity check, so the demo's protected/global criteria have a
  real passing evaluator instead of all showing up "no trusted automated
  check configured". Documented as a POC default, not real per-task
  verification.
- `apps/server/src/benchmark-executors.ts` (new, Final-Assembly-owned) — the
  two `BenchmarkExecutor`s both Task 2 and Task 3 flagged as the one
  genuinely outstanding integration item. The direct arm calls the real
  `AgentRunner` once against the arm's isolated workspace copy, then runs the
  same trusted checks. The orchestrated arm drives Task 2's real
  `OrchestrationEngineDriver.plan`/`.execute` directly (not through Task 1's
  persisted control plane, and not against the real Agent's own orchestration
  slot) against a contract synthesized from the benchmark's own prompt and
  criteria, using an in-memory `OrchestrationSink` that only accumulates
  evidence. Neither arm observes the other; both honor `input.signal`;
  neither arm's own claim of success is trusted — `succeeded` comes from
  verification results (direct) or the driver's own `completed` outcome,
  which the engine only reaches after global verification passes
  (orchestrated).
- `apps/web/package.json` — added `"test": "vitest run"` (Task 3's
  recommended one-line addition; `vitest` was already present via workspace
  hoisting from `@launchpad/server`, confirmed with `npm install` — no new
  dependency actually landed).
- `package.json` — `"test"` now runs both workspaces:
  `npm run test -w @launchpad/server && npm run test -w @launchpad/web`.

## Two real bugs found and fixed at the integration boundary

These are exactly the kind of thing three independently-built, independently
-tested modules produce when they meet for the first time — both were caught
by `npm run typecheck`, neither needed changes to Task 1's or Task 2's files:

1. **Three independent `PricingTable` shapes.** `config.ts` (Task 2) uses
   `Record<modelId, {input?, cachedInput?, output?}>`; `control/budget-ledger.ts`
   (Task 1) uses `Record<modelId, {inputUsdPerMillionTokens,
   cachedInputUsdPerMillionTokens, outputUsdPerMillionTokens}>` (all
   required); the engine's own `worker-loop.ts` PricingTable happens to match
   `config.ts`'s shape exactly. Fixed with a pure conversion function,
   `toControlPricingTable`, in `index.ts` — missing sub-fields default to 0
   (treated as free), and table membership (not per-field completeness)
   still decides `pricingStatus`. The engine driver gets `config.orchestration.pricing`
   directly (already the right shape); only the control service and the
   benchmark executors get the converted table.
2. **`AgentExecutionCoordinator.cancelForAgent` return type mismatch.**
   `types.ts` (Task 2's baseline extension) declares `Promise<void>`;
   `control/service.ts`'s exported `createAgentExecutionCoordinator` (Task 1)
   resolves `Promise<number>` (count cancelled) — a reasonable and more
   informative signature on its own. Fixed with a thin composition-root
   adapter in `index.ts` that calls the real coordinator and discards the
   count for the port `AgentService` expects. Neither task's file changed.

## Verification performed

```bash
npm install                 # picks up nothing new; vitest already hoisted
npm run typecheck            # clean — server + web
npm run test                 # 231 server tests + 38 web tests, all passing
npm run build                 # web (tsc -b + vite build) then server (tsc)
npm run check                 # typecheck && test && build — clean, exit 0
docker compose config         # valid — parses and resolves the compose file
terraform fmt -check -recursive deploy/volcengine   # terraform is not installed
                                                     # in this environment; not run
```

Beyond the automated suite, I also smoke-booted the real composed server
(`node apps/server/dist/index.js`, no Ark key, no Codex CLI installed — the
actual state of this sandbox) and drove it over real HTTP:

- `GET /api/health`, `GET /api/system`, `POST /api/agents` — all correct.
- `POST /api/agents/:id/orchestrations` with `requestedMode: "auto"` — real
  202, real `drafting-intent` orchestration persisted.
- Polling `GET /api/orchestrations/:id` a moment later: the real role
  executor tried to spawn `codex`, got `ENOENT` (not installed here), and the
  **whole real pipeline degraded honestly** — `budget.reserved` →
  `usage.committed` → `model.call-failed` → `orchestration.failed` →
  `orchestration.status-changed`, ending in a persisted `status: "failed"`
  with a plain-English error, not a crash, not a fabricated success, and not
  an unhandled exception. This is exactly the "meaningful failure/recovery
  case" the required live journey (section 1.2) asks for, produced by the
  real code path rather than a mock.

This confirms the full real path — browser-shaped HTTP request → Fastify
route → `OrchestrationControlService` → `OrchestrationEngineDriver` →
`RoleExecutor` → the real `AgentRunner` → a real child-process spawn attempt
→ graceful, evidenced failure back up through the control plane — actually
works end to end, not just in each task's isolated test suite.

## What a judge or the next session should still do

- **Install a real Codex CLI and set `ARK_API_KEY`/`ARK_MODEL`** (or run
  `npm run poc`, which builds the Docker Runtime image) to see a real model
  call complete instead of the honest `ENOENT` degradation above.
- **Optionally set `ORCHESTRATION_MODEL_PRICING`** to see estimated dollars
  instead of the honest "Pricing not configured" state.
- **Replace `demo-check-catalog.ts`'s generic sanity check** with real
  project-specific checks for anything beyond a POC demo — the shape
  (`TrustedCheckDefinition`: argv command + args + scope) is unchanged, only
  the lookup needs to become criterion-specific instead of universal.
- Read `docs/DEMO.md` (Task 3) for the exact three-minute walkthrough,
  including the deterministic `ORCHESTRATION_MAX_MODEL_CALLS=2` budget-stop
  scenario for the failure/recovery half of the required live journey.

## Follow-up fix: `.env` was never loaded by local `dev`/`start`

The repo's `.env.example`/README imply `npm run dev` and `npm run poc` both
read `.env`, but before this fix nothing in the local (non-Docker) path
actually loaded it — the only place `.env` was consumed was
`docker compose --env-file` in `scripts/deploy-existing-ecs.sh`. A correctly
filled-in `.env` (verified: well-formed `ARK_API_KEY`, `ARK_MODEL`,
`ARK_BASE_URL`, no quoting/whitespace issues) still produced the app's own
"Runtime configuration needed" banner, because `process.env.ARK_*` was
simply empty in the `tsx watch` / `node dist/index.js` process.

**Fix**: `apps/server/src/config.ts` now calls Node's built-in
`process.loadEnvFile()` (stable since Node 20.6) once at module load time,
before `loadConfig()` ever runs. It checks `process.cwd()/.env` first (covers
`npm run dev -w @launchpad/server`, whose cwd is `apps/server`, only if `.env`
were there) then falls back to `<repo root>/.env` via
`import.meta.dirname`-relative resolution, which is what actually matches
this repo's layout (`.env` lives at the repo root, not per-workspace). A
variable already present in the real environment (e.g. exported by the
shell, or injected by Docker/ECS) still wins — `loadEnvFile` never
overwrites an existing key — so this is purely additive and doesn't change
the Docker/ECS path at all.

Verified on the user's machine: booted `npm run dev -w @launchpad/server`
with **no env vars manually exported**, and `GET /api/system` returned
`"arkConfigured": true` with the correct `arkModel`/`arkBaseUrl` echoed
back. Re-ran `npm run check` (typecheck + 231 server tests + 38 web tests +
both builds) afterward — all clean, no regressions.

**Separately, still open**: the same `/api/system` response shows
`"codexAvailable": false` — Codex CLI is not installed / not on `PATH` on
this machine. This is independent of the env-loading fix above and will
still cause a real orchestration run to fail at the "spawn codex" step
(`RUNTIME_PROVIDER=local-process`) until either Codex CLI is installed
locally, or the user switches to `npm run poc`, which runs everything
inside the prebuilt Docker Runtime image instead.

## Follow-up fix: orchestration runs hit `api.openai.com` and got 401

**Symptom**: direct Playground chat worked, but starting an actual
orchestration (planner/worker/verifier/integrator roles) failed with
`OpenAPI code 1: unexpected status 401 Unauthorized: Missing bearer or
basic authentication in header, url: https://api.openai.com/v1/responses`.

**Root cause**: `writeCodexConfig()` in `config.ts` writes a Codex CLI
`config.toml` (pointing `model_provider` at Volcengine Ark, with the right
`base_url` and `env_key = "ARK_API_KEY"`) into exactly one place: the
long-lived `CODEX_HOME` used for direct Playground runs. The orchestration
engine (`driver.ts`'s `runtimeHomes()`) creates a *separate, fresh, isolated*
`CODEX_HOME` directory per orchestration and per role (planner/worker/
verifier/integrator) — that's intentional isolation, but nothing ever wrote
a `config.toml` into those directories. Codex CLI, finding no config in an
empty `CODEX_HOME`, silently falls back to its own OpenAI default provider;
since no `OPENAI_API_KEY` is set anywhere in this app, that request goes out
with no auth header at all, and OpenAI correctly rejects it with 401. This
has nothing to do with whether the user's Ark credentials are correct — they
were never even consulted for these calls.

Confirmed directly on the user's machine: `apps/server/.data/orchestration/
runtime-homes/<the "Second Try" agent's actual orchestration id>/planner/`
contained real Codex CLI session state (`state_5.sqlite`, `sessions/`,
`shell_snapshots/`, `skills/`) — proof Codex CLI genuinely ran there — but
**no `config.toml`**, timestamped right around when the user hit the error.

**Fix**: extracted the TOML-rendering logic out of `writeCodexConfig` into
a new exported `buildCodexConfigToml(config)` in `config.ts`. `driver.ts`'s
`OrchestrationEngineOptions` gained an optional `codexConfigToml?: string`;
`runtimeHomes()` now writes it (mode 0600) into every freshly created
per-role directory, right after `mkdir`. `index.ts` passes
`codexConfigToml: buildCodexConfigToml(config)` when constructing the
engine driver. The option is optional specifically so existing driver tests
that don't care about Ark wiring are unaffected.

**Verified on the user's machine**: `npm run typecheck -w @launchpad/server`
clean; all 231 server tests still pass; booted the real dev server and drove
a real orchestration through the HTTP API — every one of
`planner/worker/verifier/integrator`'s runtime-home directories now
contains the correct `config.toml` (Ark base URL, `env_key =
"ARK_API_KEY"`) immediately on creation. (That particular run still failed
with `spawn codex ENOENT`, but only because the shell this verification ran
in has a narrower `PATH` than the user's own terminal and doesn't see their
`codex` install — an artifact of the verification environment, not of the
app. The user's own prior run proves Codex CLI itself is installed and
reachable from their normal shell.) Test agents/orchestrations created
during this verification were deleted afterward; the user's own "First Try"
and "Second Try" agents were left untouched.
