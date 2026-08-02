# AutoPrompter current-state inspection

Inspected against `main` commit `28cd2175f42a0fc47c341b96b47d24dd9c96e901` (extension/package version `3.4.1`).

## Executive finding

The repository already contains the core product shape described by the goal: a Chromium Manifest V3 extension coordinates separate ChatGPT Web conversations as planner, worker, reviewer, and integrator agents; turns a plan into dependency-aware tasks; assigns each worker a dedicated Git branch and fresh chat; and advances accepted work toward an integration result.

The shortest path to a framework that is safely comparable with mature multi-agent systems is therefore **not** another orchestration rewrite. The smallest safe path is to harden the existing branch task board around runtime compatibility, restart/idempotency behavior, and independently verified repository evidence. Today, the browser can validate response shape and coordinate chats, but it still trusts agent-reported commit and test evidence unless a human or chat-side repository tool checks it.

## Current execution workflow

1. **Extension runtime assembly**
   - `manifest.json` installs `background-entry.js` as the service worker and loads `project-role-runner.js` plus `content.js` on ChatGPT pages.
   - `background-entry.js` composes the active task-board runtime by importing the legacy scheduler, planner compiler/fallbacks, task-board store patch, fresh-chat dispatcher, auto-bootstrap watcher, reviewer/integrator orchestrator, lifecycle controller, and bootstrap upgrade module.
   - Dormant repository-action modules remain syntax-checked by `package.json`, but are not imported by the active task-board runtime.

2. **Project creation and role bootstrap**
   - Project data is normalized and stored under `chrome.storage.local` by `project-store.js` (`STORE_SCHEMA_VERSION = 1.6`).
   - `project-auto-bootstrap.js` watches for newly created draft projects and calls `AutoPrompterBackgroundProjectApi.startProjectBootstrap` after a short delay.
   - `background.js` refuses project bootstrap while the normal AutoPrompter scheduler is running, then creates or reuses the planner, reviewer, and integrator chats and manages bootstrap status in local storage.

3. **Planning**
   - `planner-compiler.js` asks the planner for a compact proposal, then deterministically generates internal task IDs, dependencies, phases, critical path, timestamps, path allowlists, and verification commands.
   - Unsafe verification commands are discarded. Missing allowed paths currently default to `**/*`, which is functional but weakens least-privilege task isolation.
   - `planner-no-repair.js` converts planner validation failures into a local fallback plan instead of consuming more ChatGPT messages in repair loops.

4. **Task leasing and branch assignment**
   - `project-task-board.js` patches `project-store.js` into `fresh_chat_per_task` mode.
   - A ready task receives a deterministic dispatch ID, attempt number, lease expiry, fresh worker identity, and branch name.
   - Independent tasks are instructed to create/reset their branch from the latest default branch. Dependent tasks are instructed to start from accepted dependency commits and conservatively incorporate additional reviewed dependencies.
   - Capacity is bounded by project settings; fresh task-board projects default to at most six concurrent workers, while the underlying scheduler schema permits up to twelve.

5. **Fresh ChatGPT worker dispatch**
   - `project-task-board-controller.js` automatically starts ready projects, prepares dependency-ready assignments, and asks `project-fresh-dispatch.js` to open one inactive fresh ChatGPT tab per prepared dispatch.
   - The normal repeated-prompt scheduler and Project Mode task board are mutually exclusive.
   - `content.js` owns ChatGPT DOM detection, composer submission, completion detection, interruption handling, circuit-breaker classification, and strict worker-result forwarding.

6. **Result, review, and integration**
   - `result-protocol.js` requires an exact `AUTOPROMPTER_TASK_RESULT` JSON envelope, validates task/dispatch identity, commit-SHA syntax, required test entries, and changed-path allowlists.
   - `project-store.js` moves a completed worker result into `review` state and records the reported commit.
   - `project-orchestrator.js` reuses the dedicated reviewer chat, then dispatches the integrator chat only after every task is accepted.
   - `reviewer-protocol.js` instructs the reviewer to inspect repository evidence where tools permit, but the extension itself only validates the review envelope and decision consistency.
   - `integration-protocol.js` requires all accepted tasks, an integration branch/commit, passing project-wide test claims, and no unresolved conflicts for a completed integration result.
   - `project-task-board-controller.js` currently marks the project completed automatically when a schema-valid integration result reports `completed`. It does not merge to the default branch.

## Repository areas relevant to the goal

| Area | Files | Responsibility and implementation constraint |
| --- | --- | --- |
| Extension assembly | `manifest.json`, `background-entry.js`, `package.json` | All popup, background, content-script, protocol, and storage changes must ship as one compatible unpacked-extension release. Import order matters because modules patch `AutoPrompterProjectStore` at runtime. |
| Planner pipeline | `planner-protocol.js`, `planner-compiler.js`, `planner-fallback.js`, `planner-no-repair.js` | Preserve strict envelopes and deterministic compiler output. Tighten `**/*` fallback before relying on path isolation as a security boundary. |
| Project state machine | `project-store.js`, `project-auto-store.js`, `project-task-board.js`, `project-task-board-controller.js`, `project-auto-bootstrap.js` | `chrome.storage.local` is the authoritative runtime store. Service-worker restarts, duplicate storage events, lease expiry, and replay must not duplicate mutations or tabs. |
| Browser/tab adapters | `background.js`, `background-project-api.js`, `project-fresh-dispatch.js`, `project-orchestrator.js`, `project-role-runner.js`, `content.js` | Chrome APIs and ChatGPT DOM automation are tightly coupled to orchestration. The normal scheduler must be stopped before project bootstrap or dispatch. |
| Protocol/evidence boundary | `worker-protocol.js`, `result-protocol.js`, `reviewer-protocol.js`, `integration-protocol.js`, `approval-protocol.js`, `reconciliation-protocol.js` | Schemas provide strong identity and shape validation, but a syntactically valid SHA, test claim, review, or integration result is still an agent claim until checked through a repository/provider adapter. |
| Runtime compatibility | `runtime-compat.js`, `popup.js`, `project-ui.js` | The current gate probes an existing command and may reload once. There is no shared command manifest, capability list, store-schema handshake, or per-mutation idempotency contract. |
| Repository adapters (inactive in 3.4 runtime) | `repository-bootstrap.js`, `repository-bootstrap-scope.js`, `project-action-protocol.js`, `project-full-auto.js` | These files are still checked but are not imported by `background-entry.js`; `project-task-board-controller.js` clears legacy repository-action jobs. Reusing them requires a deliberate adapter contract rather than re-enabling the old full-auto path wholesale. |
| UI | `popup.html`, `popup.css`, `popup.js`, `project-ui.js` | The popup is the control/diagnostic surface. It must distinguish agent claims, user-confirmed actions, repository-verified evidence, and provider-verified checks. |
| Tests | `tests/**/*.test.js` | Existing tests are mostly protocol, state-machine, and source-wiring tests. Browser restart, duplicate-message, storage-loss, selector-fixture, and end-to-end extension smoke coverage remain the important gaps. |
| Architecture documentation | `README.md`, `docs/MULTI_AGENT_ROADMAP.md`, `docs/PROJECT_MODE_ARCHITECTURE_REVIEW.md` | The roadmap captures the main risks, but parts describe the pre-3.4 role-worker model. `README.md` also says “Current release: 3.0.0” while package and manifest are 3.4.1. Documentation must be updated alongside the next implementation slice. |

## Material implementation constraints

- **No paid model API is required by the current design.** Reasoning happens in ChatGPT Web tabs, and model selection remains the user's responsibility.
- **Do not automate model selection or evade limits.** Existing circuit breakers stop on rate limits, suspicious activity, account restrictions, and safety blocks; this boundary should remain.
- **Manifest V3 workers are restartable.** In-memory timers, pending maps, and queues are not durable. Every mutation and external effect needs a replay-safe persisted identity.
- **Browser storage is not an externally durable source of truth.** Reinstall, profile loss, or storage corruption can lose the project ledger.
- **ChatGPT DOM selectors are unstable.** `content.js` contains the selector and completion heuristics; orchestration should not depend directly on those selectors.
- **Commit and test evidence is not independently verified.** `result-protocol.js` and `integration-protocol.js` validate formats and consistency, not that a ref exists, belongs to the expected branch, contains the reported files, or has passing provider checks.
- **Error handling is intentionally tolerant but opaque.** The task-board controller swallows transient start/prepare/dispatch errors and relies on future storage changes or retry commands. Diagnostics need durable error records before increasing autonomy.
- **Task isolation is advisory until repository verification exists.** Worker prompts and result validation enforce allowed paths, but a malicious or mistaken commit can contain additional files unless the diff is checked independently.
- **The active runtime intentionally removed repository action automation.** The next implementation should add a narrow evidence adapter first, not restore the older full-auto action path.

## Smallest safe implementation path

### Slice 1 — shared runtime contract and idempotent mutations

Add a small `runtime-protocol.js` module shared by popup, service worker, and content scripts. It should publish:

- protocol version, extension/build fingerprint, store schema, and supported commands/capabilities;
- one side-effect-free `GET_RUNTIME_CAPABILITIES` response;
- stable idempotency keys for project creation, bootstrap, dispatch, worker-result submission, review submission, and integration submission;
- a common success/error envelope.

Block Project Mode mutations when required capabilities differ. Persist completed operation keys in the project store so service-worker replacement or duplicate messages return the prior result instead of creating another project, lease, tab, review, or integration attempt.

Primary files: `runtime-protocol.js` (new), `background-entry.js`, `background.js`, `background-project-api.js`, `runtime-compat.js`, `popup.js`, `content.js`, `project-role-runner.js`, `project-store.js`, and focused tests.

### Slice 2 — pure task-board controller with restart tests

Extract `advanceLifecycle`, dispatch selection, and transition decisions from `project-task-board-controller.js` into a side-effect-free controller. Keep Chrome storage, tab creation, notifications, and ChatGPT submission behind adapters.

Add tests that replay the same storage event/message after simulated worker replacement and prove:

- no duplicate project bootstrap;
- no duplicate lease or fresh worker tab;
- no duplicate reviewer/integrator job;
- no automatic completion from a stale integration attempt;
- expired leases recover without accepting stale results.

Primary files: `project-controller.js` (new), `project-task-board-controller.js`, `project-auto-bootstrap.js`, `project-fresh-dispatch.js`, `project-orchestrator.js`, `project-store.js`, and tests.

### Slice 3 — read-only repository evidence verification

Introduce a narrow repository adapter that **reads and verifies only** before enabling any write automation. For each completed worker result, verify:

- the commit exists in the configured repository;
- the expected task branch contains the commit;
- dependency ancestry matches accepted commits;
- the commit diff stays inside `allowedPaths`;
- reported `filesChanged` matches the diff;
- available provider checks/statuses match the reported verification evidence.

Store explicit trust levels such as `assistant_claim`, `repository_verified`, and `provider_verified`. When repository verification is configured, block reviewer acceptance and project completion until the required trust level is reached. Surface failures in the popup instead of silently retrying.

Primary files: `repository-evidence-adapter.js` (new), `project-store.js`, `result-protocol.js`, `reviewer-protocol.js`, `integration-protocol.js`, `project-task-board-controller.js`, `project-ui.js`, and tests.

### Slice 4 — repository-backed recovery ledger

Only after the read-only adapter is reliable, persist a compact `.autoprompter/project.json` plus append-only events/evidence records through an explicitly permissioned write adapter. Rehydrate local browser state from verified repository evidence after reinstall or storage loss. Keep branch creation, merge, workflow, permission, release, and deletion actions separately approval-gated.

### Slice 5 — versioned ChatGPT DOM adapter and evaluation harness

Move selector/composer/completion logic out of `content.js` behind a versioned adapter. Add recorded DOM fixtures, selector canaries, and an end-to-end smoke harness covering project creation through first worker dispatch. Then benchmark planner decomposition, duplicate prevention, task completion, independent review quality, integration conflicts, recovery, and message efficiency.

## First implementation recommendation

Implement **Slices 1 and 2 before adding new agent roles or routing features**. They are the minimum foundation that makes every later repository or browser side effect replay-safe. Then implement the read-only half of Slice 3 as the first trust improvement. This preserves the existing working branch task board, keeps ChatGPT Web as the reasoning surface, and addresses the highest-risk gaps without reactivating broad repository write automation.

## Verification baseline

The repository declares Node.js 20 or newer and the following existing checks:

```bash
npm test
npm run check
```

`npm test` runs the Node test runner. `npm run check` syntax-checks the planner, task-board, orchestration, protocol, background, content, runtime, and popup scripts listed in `package.json`.
