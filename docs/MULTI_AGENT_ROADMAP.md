# Multi-agent roadmap

AutoPrompter 3.0 already implements the browser-backed Project Mode foundation: dedicated planner, reviewer, and integrator chats; bounded worker assignments; strict envelopes; local task leases; automatic planner repair; guarded integration; and explicit approval boundaries.

The remaining work is to make that foundation reliable enough for sustained multi-agent projects using ChatGPT Web conversations while keeping paid API execution optional.

See [`PROJECT_MODE_ARCHITECTURE_REVIEW.md`](PROJECT_MODE_ARCHITECTURE_REVIEW.md) for the detailed risk assessment and acceptance criteria.

## Product objective

Coordinate multiple bounded ChatGPT Web conversations as specialized agents, preserve durable project state outside any single transcript, recover safely after interruption, and verify consequential work through supported repository tools.

ChatGPT Web remains the reasoning surface. Browser automation must not become an unofficial model-selection API, bypass platform restrictions, or claim repository side effects that were not independently verified.

## Design principles

- **Version every boundary.** Popup, background worker, content script, schemas, storage migrations, and command contracts ship as one compatible release.
- **Repository evidence outranks transcripts.** Browser storage is an execution cache; verified repository state is the durable recovery source when enabled.
- **Bound every unit of work.** Tasks have immutable IDs, dependencies, budgets, acceptance criteria, verification commands, and rollback guidance.
- **Separate reasoning from side effects.** ChatGPT chats can plan and review; supported adapters perform and verify repository actions.
- **Preserve explicit user control.** Model selection and consequential external actions remain user-confirmed unless a supported, permissioned adapter provides a safer contract.
- **Fail closed.** Unknown runtime commands, stale selectors, missing evidence, duplicate dispatch risk, platform restrictions, and exhausted budgets stop execution.

## Current foundation

- Goal, project, plan, task, result, review, integration, approval, and reconciliation protocols.
- Schema-migrated Project Mode storage.
- Planner, reviewer, integrator, and worker chat roles.
- Automatic role bootstrap and bounded planner repair.
- Dependency-aware task records and deterministic leases.
- Concurrent managed tabs with interruption recovery and circuit breakers.
- Manual model verification before worker dispatch.
- Explicit approval records for merges, releases, workflow changes, permission changes, deletions, and other side effects.

## Phase 1 — runtime and release integrity

- Add a side-effect-free runtime capability handshake.
- Publish command constants and protocol version from one shared module.
- Include build fingerprint, store schema, extension version, and supported capabilities in diagnostics.
- Block project mutations when popup, background, or content-script capabilities differ.
- Add end-to-end smoke coverage for project creation through bootstrap start.

## Phase 2 — orchestration core and adapters

- Extract project state transitions and scheduling policy from `background.js` into a pure controller.
- Isolate Chrome storage, tab lifecycle, notifications, ChatGPT DOM interaction, and repository access behind adapters.
- Version the ChatGPT DOM adapter and test it against recorded fixtures.
- Add idempotency keys to project creation, bootstrap, dispatch, result submission, review, and integration operations.

## Phase 3 — repository-backed durability

- Define `.autoprompter/project.json`, task/result evidence records, and an append-only event log.
- Add an action-capable repository adapter with explicit permission checks and repository allowlists.
- Record verified commit refs for accepted tasks, reviews, and integrations.
- Rehydrate browser state from repository evidence after reinstall, browser loss, or storage corruption.
- Display evidence trust levels: local claim, assistant claim, repository verified, and provider verified.

## Phase 4 — project admission, budgets, and routing

- Add visible `one_off`, `project`, and `large_project` classification with manual override.
- Run preflight checks for runtime compatibility, selector health, repository validity, role uniqueness, worker availability, permissions, and existing state.
- Add project budgets for prompts, retries, elapsed time, concurrent tabs, revision count, and estimated allowance use.
- Map capability profiles such as `fast`, `balanced`, `deep`, and `highest` to user-confirmed models or supported provider metadata.
- Never silently downgrade a task whose acceptance criteria require a stronger capability.

## Phase 5 — bounded parallel execution

- Schedule only dependency-ready tasks.
- Limit active workers by project policy, observed allowance pressure, and browser health.
- Use dedicated branches or worktrees when a supported repository adapter is available.
- Detect overlapping file ownership and probable integration conflicts before dispatch.
- Require independent review and verified evidence before task acceptance.

## Phase 6 — evaluation and hardening

- Simulate service-worker replacement, popup/background mismatch, browser restart, storage loss, duplicate messages, stale leases, and interrupted generation.
- Maintain selector canaries and recorded ChatGPT DOM fixtures.
- Benchmark planner decomposition, worker completion, reviewer precision, integration conflict handling, recovery, and message efficiency.
- Run secret scanning, permission tests, path/ref validation, and malicious envelope fixtures.
- Keep autonomous execution opt-in until restart safety and duplicate prevention are demonstrated under failure.

## Acceptance gates

A production-grade multi-agent release must demonstrate:

1. No duplicate project, bootstrap, lease, dispatch, or integration action after restart.
2. No project mutation before runtime and selector preflight succeeds.
3. Every accepted task has a traceable ID, independent review, verification evidence, and durable repository reference when repository verification is enabled.
4. Interrupted sessions recover from durable state without copying private transcripts.
5. Platform restrictions stop execution; accounts, chats, models, or endpoints are never rotated to evade limits.
6. Concurrency, retries, elapsed time, and allowance budgets remain enforced during failure.
7. Users can stop all managed tabs immediately and inspect every pending side effect.
8. The interface clearly distinguishes automatic reasoning, user confirmation, assistant claims, and independently verified actions.
