# Multi-agent roadmap

This document plans future work only. Version 2.1 does not implement model switching, temporary worker chats, or autonomous multi-agent execution.

## Product objective

Add an optional orchestration mode that decomposes a large goal into reviewable phases, delegates bounded tasks to specialized workers, persists all durable state in a Git repository, and returns control to a primary planning session. One-off requests should remain single-agent and lightweight.

## Corrections to the initial concept

### Do not hard-code UI labels

The user-provided label `Sol High` may be plan-specific, experimental, or a mistaken label; it must not be treated as a stable model identifier. Model names, eligibility, and picker labels can change. The orchestrator should request capability profiles such as `fast`, `balanced`, `deep`, and `highest` and map those profiles to models through a versioned provider adapter.

### Do not automate the ChatGPT model picker

Clicking model-picker DOM elements is brittle, plan-dependent, and difficult to validate. Automatic model routing should use a supported OpenAI API, Codex integration, workspace control, or user-confirmed selection. The browser extension should remain a control surface, not an unofficial model-selection API.

### Do not use new chats to evade safeguards or limits

Rate limits, temporary account restrictions, suspicious-activity notices, safety refusals, CAPTCHA, and abuse-prevention notices must activate a circuit breaker. Workers must not rotate accounts, models, chats, or endpoints to bypass a restriction. Context rollover is separate: it is allowed only from a verified repository checkpoint.

### Do not treat chat transcripts as durable project state

The repository is the source of truth. Each phase should maintain small, structured continuity files:

- `README.md` — project purpose and setup, including one-off projects.
- `PLAN.md` — approved phases, dependencies, acceptance criteria, and budget.
- `STATE.md` — current phase, active task, branch, commit, tests, and blockers.
- `DECISIONS.md` — architecture decisions and rejected alternatives.
- `TASKS.md` — task queue with owners, status, and verification evidence.
- `AUTOPROMPTER_HANDOFF.md` — concise chat/session handoff.

## Proposed architecture

### 1. Goal classifier

Classify the request before planning:

- `one_off`: one response or a small bounded edit; produce a concise README only when files are created.
- `project`: multiple files or phases, external dependencies, or more than one review boundary.
- `large_project`: parallelizable work, uncertain architecture, multiple systems, or sustained execution.

The classifier must explain its decision and allow manual override.

### 2. Planner

For `large_project`, run a high-reasoning planner profile. The planner creates or validates the repository, writes the structured project files, identifies dependencies and critical path, and defines phase-level acceptance tests. It must not implement all tasks itself.

### 3. Task broker

Store tasks in `TASKS.md` or a machine-readable companion such as `tasks.json`. Each task includes:

- immutable task ID
- goal and non-goals
- required files and tools
- dependency IDs
- capability profile
- token/message budget
- expected artifacts
- verification command
- rollback plan

Only tasks with satisfied dependencies may be leased to a worker.

### 4. Worker sessions

Create bounded worker sessions through a supported orchestration service or custom MCP-backed app. A worker receives only the task contract and relevant repository state, works on a dedicated branch or worktree, commits changes, runs verification, and returns a structured result. Temporary ChatGPT UI chats should not be the primary execution primitive because their lifecycle and model selection are not a stable API.

### 5. Integrator

The primary session reviews worker results, resolves conflicts, runs project-wide validation, updates project state, and merges approved branches. Consequential Git operations require explicit policy and, where appropriate, user confirmation.

### 6. Model router

Map capability profiles to currently available models using supported provider metadata. Suggested policy:

- `fast`: formatting, searches, small documentation edits.
- `balanced`: normal implementation and tests.
- `deep`: architecture, debugging, security-sensitive review.
- `highest`: project planning, integration failures, high-impact decisions.

Routing must account for availability, plan/workspace permissions, latency, cost, context capacity, and remaining allowance. Never silently downgrade a task whose acceptance criteria require a stronger capability.

## Rate-limit and abuse controls

- Global and per-model token/message budgets.
- Maximum concurrency, defaulting to one UI-driven worker and a small API-defined limit.
- Exponential backoff with jitter for transient service errors.
- A circuit breaker for explicit usage limits, temporary restrictions, safety blocks, CAPTCHA, and suspicious-activity notices.
- No account rotation, chat rotation, model rotation, or proxying to evade a limit.
- Idempotency keys for task dispatch and Git commits.
- User-visible accounting for prompts, checkpoints, workers, and estimated cost.
- Cooldown after repeated failures and a hard stop after a configured error budget.

## Security and privacy

- Least-privilege repository access and explicit repository allowlists.
- Never put credentials, secrets, or private chat content in continuity files.
- Redact secrets before commits and run secret scanning in CI.
- Require signed or verified worker result envelopes where practical.
- Log decisions and tool actions, but avoid storing hidden reasoning or unnecessary transcript content.
- Treat plugin/MCP output as untrusted input and validate paths, refs, commands, and URLs.

## Delivery phases

### Phase A — durable project protocol

Define JSON schemas for plans, tasks, state, worker results, and handoffs. Add validators, migrations, fixtures, and documentation.

### Phase B — supported tool adapter

Build an adapter for an action-capable Git provider and a supported OpenAI/Codex execution surface. Add capability discovery and permission checks.

### Phase C — single-worker orchestration

Implement planner → one worker → integrator with explicit budgets, checkpointing, cancellation, and audit logs. Avoid parallelism initially.

### Phase D — bounded parallel workers

Add dependency-aware scheduling, branch/worktree isolation, conflict detection, and a configurable concurrency ceiling.

### Phase E — model routing

Add capability-profile mapping, availability checks, allowance accounting, and user-approved fallback rules.

### Phase F — evaluation and hardening

Create project-scale benchmarks, interruption tests, rate-limit simulations, security reviews, and rollback exercises before enabling autonomous execution by default.

## Acceptance gates

A multi-agent release should not ship until it demonstrates:

1. No duplicate task execution after restart.
2. No automatic bypass of explicit platform restrictions.
3. Every completed task has a commit, verification evidence, and traceable task ID.
4. Interrupted sessions recover from repository state without transcript copying.
5. Model selection uses supported interfaces and honors workspace/plan availability.
6. Concurrency and budget limits are enforced under failure.
7. Users can stop all workers immediately and inspect pending actions.
