# TechJam submission notes

## Summary

Volc Agent Launchpad turns opaque coding runs into a user-confirmed, budget-bounded, inspectable orchestration. It preserves the starter kit’s direct Agent experience while adding adaptive routing, isolated workers, minimum-context packets, versioned artifacts, protected verification, deterministic integration, and safe correlated evidence.

## Rubric evidence

- **Useful Agent experience:** Direct, Auto, and Orchestrated modes live in one Playground; the user reviews/revises intent and explicitly starts a confirmed plan.
- **Technical depth:** persistent state machine, immutable contract versions, hard reservation ledger, application mapping, preflight, bounded workers, artifact drift, staged verified publish, cancel/restart reconciliation.
- **Transparency:** task/route/model/context/artifact/verification/usage evidence and filterable redacted timeline without chain-of-thought or evaluator source.
- **ModelArk integration:** all logical roles use the configured Ark endpoint by default, with optional server-side model overrides and truthful fallback evidence.
- **Validation:** deterministic unit/integration tests plus a same-snapshot Direct-versus-Orchestrated benchmark service.

## Optional evidence mapping

These map directly to the hackathon's optional-evidence checklist, with pointers to the actual enforcement point rather than a UI screen:

- **Scoped, backend-enforced permission:** each worker task is confined to an explicit `allowedPaths` list fixed at planning time and enforced in the workspace scope check (`worker-workspaces.ts`), not in the UI. Container mounts separately enforce read-only vs. writable access per role at the OS boundary (`container-codex-runner.ts`). A running orchestration's grant is revocable, not just initially scoped: cancelling it immediately halts further budget reservations and worker execution for that Run.
- **Correlated trace across the Run:** every model call, verification result, route decision, and budget event is recorded against the same `orchestrationId` / `taskId` / `executionId` keys in the orchestration event store, spanning planning, sandboxed worker execution, verification, and integration — inspectable end-to-end for a single Run, not scattered logs.
- **Threat contained, protected asset unchanged, recovery demonstrated:** if verification fails, the integrator's drift check (`integrator.ts`) refuses to touch the main Agent workspace, archives the failed candidate for inspection, and first attempts one bounded automatic repair against the isolated candidate before giving up. The main workspace is provably unmodified in the failure case; the archived candidate is the recovery evidence.
- **Reliability capability demonstrated under real load, not just described:** acceptance-verification and planning batch and parallelize model calls instead of issuing one unbounded call per Run, transient provider/network errors get one bounded retry, and every failure path — including process-level crashes — is captured to a persistent, redacted error log rather than only the happy path.

## Benchmark caveats

Quality and verification are presented before tokens or estimated cost. Different models, unknown pricing, or unequal verification produce warnings and prevent a cost-winner claim. One benchmark is evidence about one prompt/snapshot; Direct may correctly win small or tightly coupled work.

## Known limitations

Single-node JSON stores assume one writer; ordinary containers are not hardened multi-tenant sandboxes; protected checks are not proof of correctness; dollar estimates need operator pricing; the live benchmark uses a compact common verification adapter; and manual criteria remain human decisions. Video and other final hackathon media are intentionally deferred.

Concurrent worker and verification batches have no host-level concurrency cap, so a large plan launches an entire batch's containers at once; a model call that fails is recorded as zero token usage against the budget ledger, so real spend on an aborted call can be undercounted; and LLM-judged verification and its one-shot automatic repair are best-effort judgment, not deterministic proof — they reduce, but do not eliminate, the chance of an incorrect pass or an unnecessary fail.
