# Integrated orchestration experience

This branch starts from `dev` and deliberately combines implementations rather than
retaining one teammate branch wholesale.

## Source comparison

- `origin/jovian/task1task2task3` was selected as the server/engine foundation and
  Details evidence source. It descends from `dev`, preserves the frozen
  `apps/server/src/orchestration/contracts.ts`, and has the smallest coherent API/read-model
  surface.
- `origin/task1-julian` supplied the inline option-button plus `Other…` clarification
  interaction. Its richer server contract was not imported because it changes the frozen
  contract. The integrated driver serializes the same presentation information inside the
  existing `materialQuestions: string[]` field, and the web adapter still supports older
  plain-string questions.
- `origin/devan/task123` supplied the Planner task cards, Accounting table/gauges, and
  correlated task-filtered evidence timeline. These were adapted to Jovian's read model.
  Devan's confirmation behavior—answering questions into a new immutable intent revision—
  was also ported without changing the contract.

## Five-step experience

1. **Details** shows the user prompt, Agent instructions, grounded intent, confirmed
   criteria, application-map evidence, artifacts, and bounded per-task context packets.
2. **Planner** shows each task, scope/instructions, dependencies, context size, acceptance
   criteria, and recorded test outcomes.
3. **Accounting** shows live usage by logical role, hard budget gauges, estimate-versus-
   actual values, and evidence counters.
4. **Orchestration** derives a visible Planner/Worker/Verifier/Integrator roster from
   existing tasks, attempts, and events. Selecting an agent filters the live interaction
   and file-change timeline.
5. **Integration (Result)** is an evidence-backed proposal using only fields already
   persisted: final output/error, changed-file manifests, shared artifacts, integration and
   publication events, global verification records, and cleanup disposition.

Steps remain disabled until their underlying evidence exists. No synthetic completion or
cost data is fabricated.
