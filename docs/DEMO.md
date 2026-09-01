# UI demo and test guide

## Normal journey (under three minutes)

1. Copy `.env.example` to `.env`, add valid `ARK_API_KEY` and `ARK_MODEL`, then run `npm install`, `set -a; source .env; set +a`, and `npm run dev`.
2. Open `http://localhost:5173`, create or select a ready Agent, and find **Execution control** above the classic Playground.
3. Choose **Orchestrated** and ask: “Build a small TypeScript notes API and a separate client, with tests and a shared typed interface.”
4. Wait for **awaiting confirmation**. Inspect goal, requirements, assumptions, non-goals, architecture decisions, questions, estimates, and hard limits. If questions exist, answer in **Revision or answers** and click **Revise**.
5. Click **Confirm contract**. When the plan becomes **ready**, inspect its route/tasks and click **Start execution**.
6. Watch the correlated timeline, task attempts, role/model evidence, compact context, versioned artifacts, verification records, usage, and final publish/cleanup state.
7. Select **Direct** and send a small follow-up to demonstrate the existing resumable path remains intact.

## Deterministic budget-stop journey

Create an orchestration through the API with `budget.maxModelCalls: 0` (use the browser network token if authentication is enabled), then confirm its intent. The next model-call reservation is denied deterministically. The UI must show **budget exhausted**, the exact stop reason, retained evidence, and no verified publish. It does not depend on an external outage.

## Browser-only visual check without credentials

`npm run dev` still opens the UI without Ark credentials. Create an Agent and inspect Direct/Auto/Orchestrated controls, responsive layout, and keyboard focus. Model-backed intent creation will fail safely until credentials are configured.

Run `npm run check` before a demo. Do not place the Ark key in prompts, screen recordings, workspace files, or screenshots.
