# Volc Agent Launchpad

Coding Agents often hide how a task was interpreted, routed, budgeted, verified, and published. Launchpad adds a persistent evidence-driven orchestration control plane: users can review a contract before execution and inspect safe, correlated evidence afterward.

The starter kit already provides Agent CRUD, persistent workspaces, direct resumable Codex conversations, local-container or ECS execution, bearer-token protection, and Volcengine ModelArk configuration. This branch adds three execution modes:

- **Direct** keeps the existing single-Agent conversation.
- **Auto** selects direct, one worker, or multiple isolated workers based on the confirmed work.
- **Orchestrated** plans bounded tasks, brokers compact context, verifies isolated changes, and publishes only a verified integrated candidate.

## Run the UI

Requirements: Node.js 22+, npm, Docker/Colima/Podman, and a ModelArk endpoint. The disposable Runtime container is the recommended local security boundary and includes Chromium for browser verification.

```bash
cp .env.example .env
npm install
set -a; source .env; set +a
npm run dev
```

Set `ARK_API_KEY` and `ARK_MODEL` in `.env`, then open [http://localhost:5173](http://localhost:5173). Create an Agent, choose **Auto** or **Orchestrated**, submit a task, review/revise the generated intent, explicitly confirm it, inspect the plan, then press **Start execution**. Direct mode remains available in both the new execution control and classic chat below it.

Build the browser-capable Runtime once before `npm run dev`:

```bash
docker build -f Dockerfile.runtime -t volc-agent-runtime:local .
```

Verifier turns receive a read-only candidate mount plus bounded writable `/tmp`, private shared memory, subprocess support, loopback sockets, and bundled Chromium. They do not launch the host browser or use its profile.

The UI itself is visible without Ark credentials, but model-backed intent/planning/execution needs valid credentials. Never place secrets in prompts, Agent workspaces, browser configuration, commits, screenshots, or event metadata.

## Configuration

All logical roles default to `ARK_MODEL`; optional `ORCHESTRATION_*_MODEL` variables can select different validated server-side model IDs. Orchestration data, temporary worker copies, archives, Runtime homes, and protected evaluators live under `.data` by default. Dollar values display as unknown until server-side pricing is configured; the UI always calls them **estimated cost**, never billed cost.

## Test and demo

```bash
npm run check
```

See [docs/DEMO.md](docs/DEMO.md) for normal and deterministic budget-stop journeys. The benchmark API runs Direct and Orchestrated arms on isolated copies from one source hash and presents verification before token/cost comparison. Treat it as a workload-specific observation: different models, missing pricing, or unequal verification prevent a cost-winner claim.

## Recovery and limitations

Restart reconciliation cancels interrupted work while retaining redacted evidence. Stop/delete cancels orchestration children; worker scratch state follows the configured archive policy. This is a single-node POC, JSON stores assume one writer process, protected checks reduce gaming but do not prove correctness, ordinary containers are not hardened multi-tenant isolation, and the live benchmark adapter uses a compact common verification check rather than a universal quality oracle.

## Audit logs

The server writes redacted, append-only JSONL audit logs by default. The complete cross-system timeline is at `.data/logs/audit.jsonl`; each orchestration also receives `.data/logs/orchestrations/<orchestration-id>.jsonl`. Logs include HTTP timing, model execution boundaries and budgets, token/tool usage, state transitions, worker attempts, changed-file lists, verification evidence, artifacts by hash, recovery, cleanup, and failures. Prompts, model outputs, artifact payloads, authorization headers, cookies, API keys, and environment secrets are not copied into audit logs; sensitive bodies are represented by character counts and SHA-256 fingerprints.

Use `GET /api/orchestrations/:orchestrationId/audit-log?limit=500` to retrieve the newest redacted entries. Configure the system with `AUDIT_LOG_ENABLED`, `AUDIT_LOG_DIR`, `AUDIT_LOG_MAX_BYTES`, and `AUDIT_LOG_MAX_FILES`. Rotation is enabled by default at 25 MiB with five retained files.

Transient ModelArk transport failures are retried with bounded exponential backoff. `ORCHESTRATION_MODEL_TRANSPORT_MAX_RETRIES` controls the orchestration-level retry count independently of the Codex provider's request and stream retry settings; zero-turn disconnects restart with a fresh Codex thread.

Architecture and security details: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and [docs/THREAT_MODEL.md](docs/THREAT_MODEL.md).
