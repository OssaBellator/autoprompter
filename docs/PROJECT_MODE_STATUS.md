# Project Mode status

Project Mode is part of AutoPrompter 3.0 and uses subscription-backed ChatGPT Web. Project creation automatically bootstraps planner, reviewer, and integrator chats, validates and repairs planner output, and prepares the first eligible worker assignments. Worker dispatch remains explicit and model-verified; repository side effects remain approval-gated.

## Completed milestones

1. **Durable protocol** — versioned project, plan, task, and result contracts; security boundaries; sample repository state; protocol invariants.
2. **Extension-local store** — migration-aware local persistence; project creation and inspection; pause, resume, and cancel operations; popup lifecycle controls and audit history.
3. **Approval-gated planner protocol** — bounded planner prompts; strict `AUTOPROMPTER_PLAN_BEGIN` / `AUTOPROMPTER_PLAN_END` parsing; dependency, phase, path, and command validation; pending-plan storage; explicit approval before task materialization.
4. **Deterministic worker leases** — explicit local project start; dependency-aware bounded assignment; idempotent dispatch IDs; deterministic task branches; lease expiry and retry attempts; restart and orphan recovery; cancellation cleanup.
5. **Result and reviewer protocol** — strict result identity and evidence validation; independent reviewer envelopes; bounded revision loops; dependency unlocks after acceptance.
6. **Integration protocol** — accepted-task evidence, project-wide verification, explicit completion approval, immutable integration attempt IDs, conflict reporting, and bounded retries.
7. **Guarded ChatGPT Web dispatch** — manual model verification opens assigned worker chats in inactive managed tabs, submits one bounded prompt per lease, captures result envelopes, and stops rather than routing around platform restrictions.
8. **External-action approval queue** — merge, release, branch deletion, workflow, permission, and other side-effect requests become scoped, expiring approval records. Approval produces an instruction but executes nothing.
9. **Repository reconciliation** — browser or extension restart can require a strict read-only repository snapshot. Missing or conflicting task and integration artifacts remain visible and are never auto-accepted.
10. **Identity-preserving context successors** — live Project Mode workers can move to a fresh chat after a real context limit while preserving project, task, attempt, branch, original dispatch, parent dispatch, and successor-generation identity.
11. **Generation-state reconciliation and renewable heartbeats** — the composer Stop/Voice control, assistant-text growth, activity elapsed values, and control-state transitions are tracked independently. Decorative tool-card animation is ignored. Stable output with the composer back in Voice mode closes the job, while genuine progress renews both the page wait and Project Mode lease.
12. **Selector-health reporting and recoverable overlays** — open ChatGPT tabs can report composer, send, Stop, Voice, new-chat, notice, and conversation selector health. Connection interruptions and the non-selectable extended-thinking notice use bounded same-chat continuation without consuming completed-work progress.

13. **Autonomous role and planner bootstrap** — project creation can create or reuse planner, reviewer, and integrator chats, initialize their roles, submit the planner prompt, retry malformed planner JSON up to three times, approve only a schema-valid plan, and prepare the first worker wave without manual copy/paste.

## Generation completion and long-response behavior

A worker is no longer considered active merely because a tool card continues pulsing. AutoPrompter prefers the composer control state: a visible Voice mode control indicates idle even when a stale Stop node remains in the DOM. Assistant text changes, activity-panel elapsed-time changes, and generation-control transitions count as progress heartbeats. CSS animation and shadow changes do not.

The previous fixed first-response timeout has been replaced by a renewable inactivity model with a 12-hour hard ceiling. While the Stop control remains active, or assistant/activity output changes, the job continues. Project worker status heartbeats also extend the matching dispatch and task lease, preventing a legitimate long response from being requeued underneath an active chat.

## Current safety boundary

Model selection is never automated; the user must verify each worker chat's configured model. Planner, reviewer, integrator, reconciliation, and approved external-action instructions remain inspectable. AutoPrompter does not merge the default branch, publish, delete branches, change workflows or permissions, rotate accounts, bypass restrictions, or use paid API inference. Worker results require independent review, integration requires explicit completion approval, and repository reconciliation is evidence-only.

## Validation

The autonomous bootstrap and reliability frontier passed **115 automated tests**, JavaScript syntax checks, JSON validation, three-way patch validation, compressed-payload checksum verification, and exact Git blob verification before the source commit was created.

Regression coverage includes automatic role-chat creation, strict role acknowledgement, malformed planner JSON repair, schema-gated approval, automatic local project start and assignment preparation, Voice-over-Stale-Stop precedence, renewable long-response heartbeats, integration retries, approval records, repository reconciliation, selector health, and context-successor lineage.

A live authenticated multi-chat ChatGPT session has not been used for final end-to-end validation; selector-health reporting is available to diagnose future ChatGPT UI changes.

## Next frontiers

- Live authenticated multi-chat validation across long tool-using responses and context successors.
- Selector versioning and automatic degraded-selector diagnostics without guessing replacements.
- Approval instruction consumption with a separate evidence-return step, while keeping execution outside the extension.
- Repository reconciliation comparisons across plan revisions and integration retries.
- Project-level usage estimates, concurrency backpressure, and pause/resume recovery under genuine platform limits.
