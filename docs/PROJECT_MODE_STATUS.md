# Project Mode development status

Project Mode is being developed on `agent/web-first-multi-agent-project-mode`. It remains separate from the released extension and does not dispatch autonomous agents yet.

## Completed milestones

1. **Durable protocol** — versioned project, plan, task, and result contracts; security boundaries; sample repository state; protocol invariants.
2. **Extension-local store** — migration-aware local persistence; project creation and inspection; pause, resume, and cancel operations; popup lifecycle controls and audit history.
3. **Approval-gated planner protocol** — bounded planner prompts; strict `AUTOPROMPTER_PLAN_BEGIN` / `AUTOPROMPTER_PLAN_END` parsing; dependency, phase, path, and command validation; pending-plan storage; explicit approval before task materialization.
4. **Deterministic worker lease preparation** — explicit local project start; dependency-aware ready-task selection; bounded worker assignment; idempotent dispatch IDs; deterministic task branches; lease expiry and retry attempts; restart and orphan recovery; cancellation cleanup; local worker prompts and visible worker/task state.

## Current safety boundary

Planner and worker prompts are generated for manual use. Starting a project changes only extension-local state. Preparing assignments does not open tabs, send ChatGPT messages, write repositories, run task commands, or claim that a worker executed anything. Active leases are local coordination records and expire automatically.

## Next milestone

Add strict `AUTOPROMPTER_TASK_RESULT_BEGIN` / `AUTOPROMPTER_TASK_RESULT_END` parsing, dispatch/result identity checks, verification-evidence validation, and explicit reviewer acceptance or bounded revision decisions. Live worker submission remains disabled until result handling and recovery are complete.
