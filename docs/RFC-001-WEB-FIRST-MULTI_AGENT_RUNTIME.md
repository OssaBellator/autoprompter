# RFC-001: Web-first multi-agent project runtime

Status: Draft implementation foundation

## Summary

AutoPrompter will add a Project Mode that coordinates a planner chat, a bounded pool of worker chats, a reviewer chat, and an integrator chat. All model inference remains inside ordinary ChatGPT Web sessions covered by the user's subscription. The browser extension provides deterministic orchestration, durable state, scheduling, safety controls, and user-visible approvals.

This RFC starts Phase A of the multi-agent roadmap by defining the durable project protocol. It does not yet automate project execution, model selection, review loops, or branch integration.

## Goals

1. Keep inference in ChatGPT Web by default; require no OpenAI API key.
2. Represent projects, plans, tasks, worker leases, results, and approvals as durable machine-readable state.
3. Allow independent ready tasks to run concurrently without duplicate assignment.
4. Recover from browser, extension, tab, and chat-context interruptions using repository state.
5. Preserve account protections: no automatic attempt to bypass usage limits, suspicious-activity restrictions, safety blocks, or CAPTCHAs.
6. Require explicit approval for consequential actions such as merging to the default branch or publishing a release.

## Non-goals for the first implementation

- Peer-to-peer free-form agent communication.
- Paid API inference as the default execution path.
- Unverified automatic model-picker clicking.
- Account, model, endpoint, or chat rotation to evade restrictions.
- Autonomous merging to the default branch.
- Copying complete chat transcripts into project state.

## Runtime roles

### Planner

The planner classifies the goal, decides whether multi-agent execution is useful, and emits a versioned plan containing phases, dependencies, acceptance criteria, role assignments, and capability classes.

### Worker

A worker receives one leased task, reads the allowed repository state, works only within the task boundary, runs verification, and returns a structured result marker plus a committed artifact when repository tooling is available.

### Reviewer

The reviewer compares a worker result with the task acceptance criteria. It returns either `accepted` or a bounded revision request. A task is not complete merely because a worker says it is complete.

### Integrator

The integrator combines accepted results, detects conflicts, runs project-wide validation, updates continuity state, and prepares a pull request. Consequential operations remain approval-gated.

### Run controller

The run controller is deterministic extension code. It owns leases, concurrency, retries, cooldowns, circuit breakers, user approvals, and recovery. LLM chats do not control these safety invariants.

## Durable repository layout

```text
.autoprompter/
├── project.json
├── plan.json
├── events.jsonl
├── tasks/
│   └── task-<id>.json
├── results/
│   └── task-<id>.json
└── reviews/
    └── task-<id>.json

AUTOPROMPTER_HANDOFF.md
```

The repository is the shared source of truth for project artifacts. Extension-local storage may cache runtime state and leases but must reconcile with repository state after restart.

## Project lifecycle

```text
draft
  → planning
  → ready
  → running
  ↔ paused
  → completed
  → failed | cancelled
```

A project enters `ready` only when:

- the plan parses successfully;
- all task IDs are unique;
- every dependency references a known task;
- the dependency graph is acyclic;
- assigned chats are unique;
- scheduler and approval policies are valid.

## Task lifecycle

```text
blocked → ready → leased → running → review
                                  ↘ failed
review → accepted
review → revision_required → leased
```

Leases prevent duplicate work. A lease contains a worker chat ID, assignment time, expiry time, and attempt number. Reassignment is allowed only after completion, cancellation, explicit release, or expiry.

## Planner output protocol

The planner will eventually return a delimited JSON document:

```text
AUTOPROMPTER_PLAN_BEGIN
{ ...valid plan.json... }
AUTOPROMPTER_PLAN_END
```

The extension must parse and validate the payload before creating tasks. Prose outside the markers is informational and must not mutate project state.

## Worker result protocol

A worker result will use a similar machine-readable envelope:

```text
AUTOPROMPTER_RESULT_BEGIN
{ ...valid result.json... }
AUTOPROMPTER_RESULT_END
```

The extension treats repository content, tool output, and result markers as untrusted input. Paths, branches, commit IDs, commands, URLs, and task IDs must be validated before use.

## Scheduling policy

1. Compute tasks whose dependencies are accepted.
2. Exclude tasks with active leases.
3. Respect the project's global concurrency limit.
4. Prefer idle workers whose role matches the task.
5. Require manual model verification when the task's capability class differs from the worker's confirmed model class.
6. Issue one lease and one idempotent dispatch ID.
7. On worker completion, route the result to review before unlocking dependants.

The first implementation should use fixed roles and deterministic scheduling. Planner-created arbitrary agent types are deferred.

## Web model policy

Tasks request capability classes rather than hard-coded model IDs:

- `fast`: formatting, small documentation changes, low-risk searches.
- `standard`: ordinary implementation and tests.
- `deep`: planning, architecture, difficult debugging, security review, and integration.

Initially, model mapping is `manual_verified`: the user selects a ChatGPT Web model and confirms it for a worker. Automatic picker interaction is deferred until it can fail closed and verify the visible selected model.

## Subscription usage controls

The extension cannot read an authoritative remaining-message counter. It may maintain an estimate, but the following are mandatory:

- bounded project and per-role concurrency;
- user-configurable message budgets;
- cooldown after repeated transient failures;
- hard stop on explicit usage-limit or account-restriction notices;
- no automatic bypass through model, chat, account, or endpoint rotation;
- clear disclosure that concurrent workers can consume subscription allowances faster.

## Approval gates

The project schema lists actions requiring explicit user approval. The initial default set includes:

- merge to the default branch;
- delete a branch;
- publish a release;
- modify workflows;
- change permissions;
- perform an external side effect.

A chat may recommend an action, but only the run controller can present and record approval.

## Security boundaries

- Chat content is untrusted.
- Repository content is untrusted.
- Tool and plugin output is untrusted.
- The extension must never place credentials or hidden instructions in project files.
- Task `allowedPaths` are an allowlist, not documentation.
- Destructive operations remain disabled unless explicitly approved.
- Safety and account-restriction messages stop the whole project when the circuit breaker is enabled.

See `SECURITY_MODEL.md` for the initial threat model.

## Delivery sequence

### Milestone 1 — protocol foundation

- Add versioned schemas.
- Add a valid sample project.
- Add dependency-graph and path-safety tests.
- Document lifecycle and security invariants.

### Milestone 2 — extension-local project store

Implementation status: complete on the Project Mode development branch.

- Project Mode state is stored under a dedicated `chrome.storage.local` key.
- Store migrations are keyed by `schemaVersion`, including migration from the initial `0.1` array format.
- Create, pause, resume, cancel, list, and inspect operations are serialized through the service worker.
- The popup exposes a project draft form, fixed-role selectors, selected-chat worker pool, audit-aware inspector, and lifecycle controls.
- No planner or worker prompt is dispatched by this milestone.

### Milestone 3 — planner parsing

Implementation status: complete on the Project Mode development branch.

- Generate a bounded planning prompt for the selected planner chat without dispatching it automatically.
- Parse exactly one `AUTOPROMPTER_PLAN_BEGIN` / `AUTOPROMPTER_PLAN_END` JSON envelope.
- Reject unknown fields, duplicate IDs, unknown dependencies, cycles, unsafe paths, destructive verification commands, and tasks assigned to multiple phases.
- Store a validated plan as pending while the project remains in `planning`.
- Create no task records until the user explicitly approves the pending plan.
- Materialize approved tasks as `ready` or `blocked` records, then move the project to `ready`.
- Keep live planner and worker dispatch disabled in this milestone.

### Milestone 4 — worker leases and dispatch preparation

Implementation status: complete on the Project Mode development branch.

- Require an explicit local project start before assignments can be prepared.
- Select dependency-ready tasks in approved-plan order and respect the configured concurrency ceiling.
- Assign only currently available worker chats and persist one deterministic dispatch ID per task attempt.
- Generate deterministic task branches and bounded, repository-anchored worker prompts.
- Store leases, prepared dispatches, prompts, worker occupancy, and task status under schema version `1.2`.
- Recover expired, malformed, and orphaned leases after extension restart without duplicating valid active work.
- Return expired tasks to `ready` or `blocked`, preserve attempt history, and cancel active leases when the project is cancelled.
- Display worker capacity, task state, prepared assignments, and local prompts in the popup.
- Do not open tabs or send ChatGPT messages in this milestone.

### Milestone 5 — worker results and reviewer decisions

- Parse exactly one `AUTOPROMPTER_TASK_RESULT_BEGIN` / `AUTOPROMPTER_TASK_RESULT_END` envelope.
- Require matching project, task, dispatch, attempt, and worker identities.
- Validate commit claims, changed paths, test evidence, blockers, and timestamps.
- Route validated results to explicit reviewer acceptance or bounded revision decisions.
- Keep live worker submission disabled until result recovery and duplicate-result handling are tested.

### Milestone 6 — integration

- Add integrator prompts and approval-gated pull-request actions.
- Detect overlapping task branches and unresolved conflicts.
- Require full-project verification evidence before merge preparation.

## Open questions

1. Whether repository state should be written only by ChatGPT tools or optionally by an extension companion service.
2. How to verify model selection across changing ChatGPT Web interfaces without silently sending to the wrong model.
3. Whether worker chats should be reusable pools or project-specific fresh chats by default.
4. How long a lease should remain valid when a ChatGPT response can legitimately take hours.
5. Which project events require durable repository logging versus extension-local audit storage.
