# Project Mode architecture review

## Target

AutoPrompter should coordinate multiple bounded ChatGPT Web conversations as planner, reviewer, integrator, and workers while keeping paid API execution optional. The extension should remain transparent about browser automation limits, never bypass platform restrictions, and make repository-backed evidence the durable source of truth.

## Current strengths

- Separate planner, reviewer, integrator, and worker roles.
- Strict planner, task, result, review, integration, approval, and reconciliation envelopes.
- Schema-migrated browser storage with deterministic task leases and bounded revisions.
- Explicit model-verification and consequential-action approval gates.
- Concurrent worker tabs, interruption handling, circuit breakers, context rollover, and regression tests.

These are a strong protocol foundation. The main gap is no longer task decomposition; it is operational reliability and separation of concerns.

## Highest-priority risks

### 1. Runtime commands are an implicit contract

The popup and Manifest V3 service worker currently communicate through string commands embedded in separate files. A partially updated unpacked extension can therefore load a new popup against an old background worker and fail with an unknown-command error.

Required direction:

- Introduce a shared, versioned runtime protocol manifest.
- Add a side-effect-free capability handshake before any project mutation.
- Include protocol version, build fingerprint, supported commands, store schema, and extension version in the handshake.
- Refuse project creation when required capabilities are missing.
- Treat popup, background, content script, schemas, and migrations as one atomic release unit.

### 2. Browser storage is durable locally, not externally verifiable

Project state is stored in `chrome.storage.local`, while repository continuity is described as the source of truth. After a browser loss or installation reset, reconciliation still depends on manually supplied evidence.

Required direction:

- Persist a compact project manifest and append-only event log under `.autoprompter/` in the target repository through an action-capable adapter.
- Record task IDs, leases, accepted results, review decisions, integration evidence, branch refs, and verified commits.
- Keep browser storage as a cache and execution journal, not the only durable copy.
- Assign trust levels to evidence: `local_claim`, `assistant_claim`, `repository_verified`, and `provider_verified`.

### 3. The extension core is tightly coupled to ChatGPT DOM automation

Scheduling, project orchestration, storage, message dispatch, and browser tab control are concentrated in large extension scripts. A ChatGPT DOM change can therefore affect unrelated project logic.

Required direction:

- Extract a pure orchestration core with no `chrome` or DOM dependency.
- Put storage, tab lifecycle, ChatGPT DOM interaction, notifications, and repository actions behind adapters.
- Version the ChatGPT selector adapter and maintain recorded DOM fixtures for regression tests.
- Expose selector-health and capability diagnostics before starting a project.

### 4. “Autonomous” currently means browser-driven, not independently verified

The planner bootstrap is automatic, but worker model selection remains manually verified and repository actions may be represented only by assistant-produced markers. This is an appropriate safety boundary, but the UI must distinguish orchestration from verification.

Required direction:

- Show which steps are automatic, user-confirmed, assistant-claimed, and repository-verified.
- Never label a task complete from a marker alone when repository verification is configured.
- Add an optional supported action adapter for GitHub/Codex/MCP-backed commits and reads.
- Keep ChatGPT Web as the reasoning surface while using supported tools for durable side effects.

### 5. Project admission and budgets are under-specified

A raw goal currently enters the large-project path without a visible classifier, preflight, resource estimate, or execution budget.

Required direction:

- Add a goal classifier with `one_off`, `project`, and `large_project`, plus manual override.
- Run a preflight covering repository normalization, role uniqueness, worker availability, runtime compatibility, selector health, permissions, and existing project state.
- Add project-level limits for prompts, retries, concurrent tabs, elapsed time, revision count, and estimated allowance consumption.
- Stop on a configurable error budget rather than retrying indefinitely.

## Recommended delivery sequence

### Release 3.0.x — startup and release integrity

1. Recover from unknown project commands whether discovered by the startup probe or by the real command.
2. Use a compatibility build fingerprint instead of relying only on the manifest version.
3. Add an explicit installation/update diagnostic in the popup.
4. Add a smoke test that loads popup and background artifacts from the same build and exercises project creation through bootstrap start.

### Release 3.1 — versioned controller core

1. Create `runtime-protocol.js` with command constants, protocol version, capability requirements, and response envelopes.
2. Add `GET_RUNTIME_CAPABILITIES` and require it before mutation commands.
3. Extract project orchestration transitions from `background.js` into a pure controller module.
4. Add idempotency keys for project creation, bootstrap, dispatch, result submission, and integration approval.

### Release 3.2 — repository-backed project state

1. Define `.autoprompter/project.json`, `events.jsonl`, and task/result evidence schemas.
2. Add a supported repository adapter with explicit read/write permissions.
3. Rehydrate local state from verified repository evidence after reinstall or browser loss.
4. Display evidence trust level and last verified commit in the UI.

### Release 3.3 — robust multi-agent execution

1. Add dependency-aware bounded worker waves and per-capability assignment policy.
2. Add allowance accounting, adaptive concurrency, cooldowns, and hard error budgets.
3. Add recorded ChatGPT DOM fixtures, selector canaries, restart simulations, and duplicate-dispatch tests.
4. Benchmark planner quality, task completion, independent review accuracy, recovery, and integration conflict handling.

## Acceptance criteria for the intended product

- No project mutation occurs before runtime and selector preflight succeeds.
- A restart never duplicates a project, bootstrap job, task lease, or worker dispatch.
- Every accepted task has a traceable task ID, independent review, verification evidence, and durable repository reference when repository verification is enabled.
- Browser or extension loss can recover from repository state without copying private transcripts.
- Platform restriction notices stop execution; chats, models, accounts, or endpoints are never rotated to evade limits.
- The user can immediately stop all managed tabs and inspect every pending external action.
- Project Mode clearly separates automated reasoning, user confirmation, assistant claims, and independently verified side effects.
