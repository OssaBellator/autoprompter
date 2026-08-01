# Project Mode development status

Project Mode is being developed on `agent/web-first-multi-agent-project-mode`. It remains separate from the released extension and does not dispatch autonomous agents yet.

## Completed milestones

1. **Durable protocol** — versioned project, plan, task, and result contracts; security boundaries; sample repository state; protocol invariants.
2. **Extension-local store** — migration-aware local persistence; project creation and inspection; pause, resume, and cancel operations; popup lifecycle controls and audit history.
3. **Approval-gated planner protocol** — bounded planner prompts; strict `AUTOPROMPTER_PLAN_BEGIN` / `AUTOPROMPTER_PLAN_END` parsing; dependency, phase, path, and command validation; pending-plan storage; explicit approval before task materialization.
4. **Deterministic worker lease preparation** — explicit local project start; dependency-aware ready-task selection; bounded worker assignment; idempotent dispatch IDs; deterministic task branches; lease expiry and retry attempts; restart and orphan recovery; cancellation cleanup; local worker prompts and visible worker/task state.
5. **Result, review, and integration protocol** — strict worker-result identity and evidence validation; independent reviewer envelopes; bounded revision loops; dependency unlocks after acceptance; integration evidence with explicit completion approval.
6. **Guarded ChatGPT Web dispatch** — an explicit model-verification checkbox opens assigned worker chats in inactive managed tabs, submits one bounded task prompt per lease, captures the result envelope, and stops rather than routing around platform restrictions.
7. **Recoverable extended-thinking overlays** — the non-selectable “Our systems are thinking a bit more…” notice is detected through scoped DOM and accessibility text, stopped when possible, and retried in the same chat without consuming completed-work progress.

## Current safety boundary

Planner, reviewer, and integrator prompts can still be copied manually. Live worker dispatch is opt-in and requires the user to verify each worker chat's model first. AutoPrompter never selects a model, merges to the default branch, publishes, changes permissions, rotates accounts, or bypasses platform restrictions. Worker results require independent review, and integration requires explicit completion approval.

## Frontier validation

The result, review, integration, web-dispatch, and recoverable-overlay frontiers are validated together before any source commit is created.

The non-selectable extended-thinking overlay is detected through scoped live-region text and the accessible label of its retry control. It is handled as a bounded same-chat interruption retry: stop generation when possible, send the existing continuation prompt, and do not increment completed-work progress.

The clean branch head passed 96 automated tests, JavaScript syntax checks, JSON validation, source cleanup checks, and ordinary GitHub Actions CI.

## Next milestone

Add integrator-side conflict/retry handling, explicit approval queues for merge/release actions, durable repository reconciliation after browser restart, and stronger live-dispatch recovery for context-limit successors without weakening identity checks.
