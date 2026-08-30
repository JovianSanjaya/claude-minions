# Threat model — orchestration middleware

This covers the orchestration layer added on top of the baseline Starter
Kit. `SECURITY.md` covers the baseline platform; this document does not
repeat it.

## Assets

| Asset | Where it lives | Why it matters |
| --- | --- | --- |
| `ARK_API_KEY` | Server env, `codex-home/config.toml` | Full ModelArk spend/access if leaked. |
| Agent workspace (source code) | `workspaces/<agentId>` | The thing being edited; must not be corrupted or leaked. |
| Protected evaluator definitions | Not yet materialized on disk (see limitations) | Gaming resistance depends on workers never seeing these. |
| Orchestration budget | `orchestrations.json` usage ledger | Runaway spend if enforcement is bypassable. |
| Event/evidence timeline | `orchestrations.json` events/attempts/verifications | Must be honest (no fabricated success) and free of secrets. |
| Bearer token | `APP_AUTH_TOKEN` | Demo access control, not user identity. |

## Actors

| Actor | Trust level | Notes |
| --- | --- | --- |
| User (browser) | Untrusted input, trusted intent | Confirms contracts; cannot force execution to start without confirming. |
| Control plane (`OrchestrationControlService`) | Trusted | Sole authority on confirmation, budget, and legal state transitions. |
| Planner role | Semi-trusted | Analyzes intent, proposes routing; cannot itself decide confirmation is unnecessary. |
| Worker role | Untrusted for grading purposes | Can edit files inside its own isolated workspace only; cannot grade its own result. |
| Verifier / protected checks | Trusted | Runs outside worker authority, via a server-side command allowlist. |
| Integrator role | Semi-trusted | Only sees conflicting files, never full worker transcripts; publish still gated by verification. |
| `AgentRunner` / Codex CLI / ModelArk | Trusted execution, semi-trusted output | Executes real file changes; its *output* is not trusted for pass/fail. |

## Trust boundaries

1. **Browser ↔ Control plane.** The browser can request anything via the
   API, but every mutating action is re-validated server-side against the
   state machine and budget ledger — the UI's own gating (e.g. a disabled
   Confirm button) is a convenience, never the enforcement.
2. **Control plane ↔ Execution engine.** `plan()`/`execute()` require a
   confirmed `ExecutionContract` at the type level. The engine cannot
   silently reinterpret or weaken that contract; a worker that discovers a
   conflict must return structured evidence that becomes a `needs-user`
   amendment, never a smoothed-over pass.
3. **Isolated worker workspace ↔ real Agent workspace.** Workers write only
   to a per-task temp copy (`worker-workspaces.ts`). Publication happens
   only through the integrator, only after protected/global verification
   passes, and only if the main workspace hasn't drifted since the base
   snapshot was captured.
4. **Worker ↔ protected verification.** A worker can see criterion
   *descriptions* but never protected check *implementations*, and cannot
   mark its own attempt passed — only `runChecks`'s return value
   (independent of the model's own claim) decides status.

## Specific risks and controls

| Risk | Control | Residual risk |
| --- | --- | --- |
| Secret captured in a prompt/answer/reason field | `redaction.ts` applied before persistence and before every API response, recursively | A secret shape not matched by the keyword/pattern list could still leak; redaction is defense-in-depth, not a guarantee. |
| Path traversal / symlink escape in a context-expansion request | `resolveExpansion` resolves against the workspace root and rejects `..`/protected patterns before ever touching disk | Real symlinks created *inside* an isolated workspace by a worker's own writes are not separately re-validated after the fact. |
| Worker games its own visible test | Only protected/global verification (trusted config, never a worker- or browser-supplied command string) gates publish | A judge relying solely on worker-visible checks would be fooled — the docs are explicit that only protected/global checks matter for publish. |
| Runaway token/dollar/attempt/expansion spend | `budget-ledger.ts` denies a reservation *before* the call happens; `worker-loop.ts` stops retrying immediately on denial rather than burning further attempts | Wall-clock budget is declared but not yet actively timer-enforced at the orchestration level (see Non-goals). |
| Stale artifact silently trusted by a dependent task | `artifact-registry.ts`'s `detectStaleTasks` + just-in-time `observedArtifactVersions` resolution | Full automatic cross-task dependency inference during planning is not implemented (see Task 2 handoff). |
| Malicious package script during a worker's writable call | Out of scope for this build — the worker runs with whatever sandbox mode Codex CLI enforces (`workspace-write` by default); no additional package-script interception exists | Real risk if a task installs untrusted dependencies; mitigated only by the existing Codex sandbox, not by anything orchestration-specific. |
| Partial publish after a mid-integration failure | `integrator.ts` only copies files from a *staged* candidate to the real workspace, and only after all changed files have been merged/reconciled and verification has passed on the whole staged set — never a partial file-by-file publish | If the process crashes mid-copy-loop (not mid-verification), a partial publish is theoretically possible; not covered by an automated test in this build. |
| Main workspace edited by a human while workers run | `integrator.ts` compares the current main-workspace manifest against the base snapshot before merging anything; any difference halts with `needs-user` drift, never overwrites | None known for the covered case. |
| Unsafe cleanup target (bad path resolution, symlink) | `cleanupTaskWorkspace` refuses (throws) rather than deleting anything outside the resolved trusted scratch root | None known for the covered case; verified with a dedicated test. |
| Cancellation hangs on a misbehaving driver | `cancelOrchestration` marks the orchestration terminal immediately, independent of whether the driver's `execute()` promise ever resolves | The underlying process (e.g. a real Codex child process) may keep running until its own OS-level termination completes; the *orchestration record* is correct immediately, the *process* cleanup is best-effort. |

## Implemented controls vs. non-goals

**Implemented:**

- Server-side confirmation gate, immutable contract versioning, and
  provenance-tagged claims (never silently upgrading a planner inference to
  a user requirement).
- Budget reservation before spend, at every model call, for every role.
- Filesystem isolation per worker, with manifest-diff-based change
  detection and scope-violation rejection.
- Trusted, allowlist-only verification command execution.
- Deterministic-first integration with drift detection.
- Recursive secret redaction before persistence.
- Authoritative, non-blocking cancellation and restart reconciliation.

**Non-goals (explicitly out of scope for this build):**

- Real user identity, RBAC, or multi-tenant isolation — the shared bearer
  token remains demo access control only, per the baseline `SECURITY.md`.
- A hardened multi-tenant sandbox beyond what the baseline Docker/Podman
  container or Codex's own sandbox mode provides.
- Protection against a fundamentally malicious or compromised ModelArk
  endpoint — the trust boundary assumes the configured model endpoint
  itself is not adversarial.
- Prompt-injection prevention. Context minimization (minimum-sufficient
  packets) reduces blast radius; it does not prevent prompt injection, and
  no claim to the contrary appears anywhere in this codebase or its docs.
- Wall-clock timeout enforcement at the orchestration level (only the
  underlying Codex process has its own per-call timeout today).
