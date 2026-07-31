# Project Mode development status

Project Mode is being developed on `agent/web-first-multi-agent-project-mode`. It remains separate from the released extension and does not dispatch autonomous agents yet.

## Completed milestones

1. **Durable protocol** — versioned project, plan, task, and result contracts; security boundaries; sample repository state; protocol invariants.
2. **Extension-local store** — migration-aware local persistence; project creation and inspection; pause, resume, and cancel operations; popup lifecycle controls and audit history.
3. **Approval-gated planner protocol** — bounded planner prompts; strict `AUTOPROMPTER_PLAN_BEGIN` / `AUTOPROMPTER_PLAN_END` parsing; dependency, phase, path, and command validation; pending-plan storage; explicit approval before task materialization.

## Current safety boundary

Planner prompts are generated for manual use, and planner responses are pasted back into the popup for validation. Creating or approving a plan does not open tabs, send ChatGPT messages, claim worker leases, modify repositories, or run task commands.

## Next milestone

Add deterministic worker leases and dependency-aware dispatch preparation with idempotent dispatch IDs, lease expiry, restart recovery, and user-visible assignment state. Live worker submission remains gated behind explicit project start and bounded concurrency controls.
