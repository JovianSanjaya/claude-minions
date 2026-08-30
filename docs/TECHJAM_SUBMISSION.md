# TechJam submission notes

## Summary

Volc Agent Launchpad turns opaque coding runs into a user-confirmed, budget-bounded, inspectable orchestration. It preserves the starter kit’s direct Agent experience while adding adaptive routing, isolated workers, minimum-context packets, versioned artifacts, protected verification, deterministic integration, and safe correlated evidence.

## Rubric evidence

- **Useful Agent experience:** Direct, Auto, and Orchestrated modes live in one Playground; the user reviews/revises intent and explicitly starts a confirmed plan.
- **Technical depth:** persistent state machine, immutable contract versions, hard reservation ledger, application mapping, preflight, bounded workers, artifact drift, staged verified publish, cancel/restart reconciliation.
- **Transparency:** task/route/model/context/artifact/verification/usage evidence and filterable redacted timeline without chain-of-thought or evaluator source.
- **ModelArk integration:** all logical roles use the configured Ark endpoint by default, with optional server-side model overrides and truthful fallback evidence.
- **Validation:** deterministic unit/integration tests plus a same-snapshot Direct-versus-Orchestrated benchmark service.

## Benchmark caveats

Quality and verification are presented before tokens or estimated cost. Different models, unknown pricing, or unequal verification produce warnings and prevent a cost-winner claim. One benchmark is evidence about one prompt/snapshot; Direct may correctly win small or tightly coupled work.

## Known limitations

Single-node JSON stores assume one writer; ordinary containers are not hardened multi-tenant sandboxes; protected checks are not proof of correctness; dollar estimates need operator pricing; the live benchmark uses a compact common verification adapter; and manual criteria remain human decisions. Video and other final hackathon media are intentionally deferred.
