# Threat model

## Assets and actors

Assets are the Ark key, Agent source/workspaces, protected evaluator integrity, budget limits, persisted events, contracts, and publish state. Actors are the user, React client, Fastify/control plane, planner, workers, verifier, integrator, Runtime/container, and ModelArk endpoint.

Trust boundaries exist at browser-to-API authentication, control-plane-to-model calls, main workspace-to-isolated worker copies, worker-to-protected verifier, and staging-to-publish. Browser values never choose model IDs, prices, protected paths, or executable commands.

## Threats and implemented controls

| Threat | Implemented control |
| --- | --- |
| Secret capture or display | Fastify header redaction, bounded/redacted events and artifacts, no environment/protected source in browser DTOs, no-secret guidance. |
| Traversal, symlink, or mount escape | Resolved task-specific roots, allowed-path validation, symlink/scope checks, no broad cleanup targets. |
| Test tampering/evaluator exposure | Protected definitions remain in a mode-0700 server directory excluded from worker copies; workers cannot report protected success. |
| Runaway cost or execution | Atomic call reservations, token/call/step/attempt/expansion/wall-clock limits, abort propagation, exact budget-stop reason. |
| Stale shared artifacts | Versioned artifacts, observed versions, targeted stale-task refresh and new preflight/context. |
| Malicious package scripts | Trusted verification allowlist; arbitrary browser/model shell strings are not verification commands. Workspace-write execution still carries residual risk. |
| Partial or conflicting publish | Isolated task copies, base manifest comparison, staging, deterministic-first merge, required global/protected checks, no publish on failure. |
| Restart inconsistency | Interrupted states reconcile to cancellation; reservations are released and evidence retained. |

## Non-goals and residual risk

This POC is not multi-tenant authorization, hardened VM isolation, a complete software-correctness proof, or guaranteed cost accounting. A compromised host/operator can access data; dependencies and allowed workspace commands remain risky; model output may be wrong; JSON persistence is single-process; and manual criteria require human judgment. Protected tests reduce obvious gaming but do not make evaluation infallible. Budget accounting is conservative but not exact: a failed model call is recorded as zero usage, so real spend on an aborted call can be undercounted. Parallel worker and verification batches have no host-level concurrency cap, so a large plan can launch an entire batch's containers at once.
