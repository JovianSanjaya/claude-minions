# Architecture

Volc Agent Launchpad is a single-node control plane for hackathon use.

```mermaid
flowchart LR
    UI["React: Direct / Auto / Orchestrated"] --> API["Fastify + auth"]
    API --> Control["Contract, state, budget, cancel/recovery"]
    Control <--> Store["Atomic contract/event store"]
    Control --> Router["Adaptive router"]
    Router --> Broker["Application map + context broker"]
    Broker --> Roles["Planner / worker / verifier / integrator"]
    Roles --> Runner["AgentRunner"] --> Ark["Volcengine ModelArk"]
    Roles --> Workers["Isolated worker workspaces"]
    Workers --> Integrate["Deterministic-first integration"]
    Integrate --> Verify["Protected/global verification"]
    Verify --> Publish["Verified Agent workspace publish"]
    Trust["Protected evaluator trust boundary"] -. server-only .-> Verify
    Control -. enforces .-> Router
    Control -. enforces .-> Roles
    Control -. enforces .-> Integrate
```

```mermaid
flowchart TB
    UI["React UI<br/>Direct / Auto / Orchestrated"]

    subgraph B1["Trust boundary 1 — browser to API"]
        AUTH["Bearer-token check<br/>(not user identity)"]
    end

    subgraph CP["Control plane — Fastify + AgentService"]
        API["API routes<br/>validation"]
        CTRL["Orchestration control service<br/>contract + state machine"]
        STORE[("Atomic JSON store<br/>contracts / events / redacted evidence")]
        BUDGET{{"ENFORCEMENT<br/>Budget ledger<br/>calls / tokens / attempts / wall-clock"}}
        RECON(("RECOVERY<br/>Restart reconciliation<br/>interrupted -> cancelled, reservations released"))
        ROUTER["Adaptive router<br/>direct / one worker / multi-worker"]
        BROKER["Context broker<br/>minimum-context packets"]
    end

    subgraph B2["Trust boundary 2 — control plane to model calls"]
        ROLES["Planner / Worker / Verifier / Integrator roles"]
        RUNNER["AgentRunner"]
    end

    ARK["Volcengine ModelArk<br/>(Ark key stays server-side)"]

    subgraph B3["Trust boundary 3 — main workspace vs. isolated worker copies"]
        WORKERS["Isolated worker workspaces<br/>scoped file access, symlink/traversal checks"]
    end

    INTEGRATE["Deterministic-first integrator<br/>focused conflict resolution"]

    subgraph B4["Trust boundary 4 — worker to protected verifier"]
        VERIFY{{"ENFORCEMENT<br/>Verification service<br/>argv-only, allowlisted commands<br/>mode-0700, excluded from worker copies"}}
    end

    subgraph B5["Trust boundary 5 — staging to publish"]
        MAIN["Main Agent workspace<br/>updated only after required verification passes"]
    end

    UI -->|HTTPS| AUTH --> API --> CTRL
    CTRL <--> STORE
    CTRL --> BUDGET
    CTRL --> RECON
    CTRL --> ROUTER --> BROKER --> ROLES
    ROLES --> RUNNER --> ARK
    ROLES --> WORKERS --> INTEGRATE --> VERIFY
    VERIFY -->|pass| MAIN
    VERIFY -.->|fail: no publish, evidence retained in STORE| STORE
    BUDGET -.->|deny: exact stop reason, no model call| ROLES
    RECON -.->|on restart| STORE

    classDef enforce fill:#fdecea,stroke:#c0392b,stroke-width:1px
    classDef recover fill:#eaf2fd,stroke:#2e5fa3,stroke-width:1px
    classDef boundary fill:#fff,stroke:#999,stroke-dasharray: 4 3
    class BUDGET,VERIFY enforce
    class RECON recover
```

## Components

### Web UI

Lists Agents, manages lifecycle actions, submits prompts, and polls asynchronous
Runs and orchestrations. It renders only persisted, redacted read models and never
receives the Ark key, protected evaluator source, unrestricted environment data,
or worker reasoning transcripts.

### Orchestration control plane

Persists immutable intent/contract versions, explicit confirmation, task state,
events, usage reservations, hard budgets, cancellation, and restart reconciliation.
The execution engine maps the repository, selects a route, gives each worker the
minimum relevant context, performs a read-only preflight, and uses task-specific
workspace copies. Shared coordination happens through versioned artifacts.

Protected and global checks run outside worker authority. Integration is
deterministic for non-overlapping edits; a focused integrator handles remaining
conflicts. The main Agent workspace is updated only after required verification.

### Fastify API

Validates requests, protects remote demos with a shared bearer token, and
serves the compiled Web UI. The token is not user identity or authorization.

### AgentService

Coordinates lifecycle state, persistence, workspaces, and Runs. One Agent can
have only one active Run.

```text
ready -> busy -> ready
  |       |
  v       v
stopped  error
```

Interrupted Runs become `cancelled` after a restart.

### Storage

```text
data/launchpad.json       Agent, message, and Run metadata
workspaces/AgentID/       Agent-created files
workspaces/.deleted/      Archived deleted workspaces
codex-home/               Codex configuration and sessions
```

`JsonStore` serializes writes and atomically replaces one JSON file. It supports
one process only.

### Runtime providers

- `CodexRunner` runs Codex inside the application container for ECS.
- `ContainerCodexRunner` starts one disposable Docker, Colima, or Podman
  container for every local turn.

Both providers use argv-only process execution, bound output and time, resume
the stored Codex thread, and escalate termination after a grace period.

## Deployment profiles

| Profile | Control plane | Agent execution |
| --- | --- | --- |
| Local POC | Host Node.js | Disposable local container |
| ECS | Application container | Codex process in the same container |
| Local development | Host Node.js | Host Codex process |

## Extension seams

| Track | Primary seam | Expected change |
| --- | --- | --- |
| Glass Box | `AgentRunner`, `AgentRun` | Emit and display correlated execution events. |
| Bouncer | API routes, Agent ownership | Add identity and server-side authorization. |
| Kill Switch | `AgentRunner` | Add threat-specific policy or a stronger sandbox. |

The current container or ECS instance is the POC trust boundary. Ordinary
containers are not hardened multi-tenant isolation.
