# AutoPrompter Project Mode security model

Status: Initial draft

## Protected assets

- Git repositories and branches.
- Project plans, task state, results, and continuity files.
- ChatGPT subscription availability and account standing.
- User approvals and configured limits.
- Private chat and repository content.
- Browser extension storage and managed tabs.

## Trust boundaries

The following are always untrusted until validated:

1. ChatGPT assistant text and structured markers.
2. Repository files, including `.autoprompter/` state.
3. Tool, plugin, MCP, and Codex output.
4. URLs, branch names, commit identifiers, paths, and commands supplied by a model.
5. DOM text used to classify account or service notices.

The deterministic extension runtime owns state transitions, leases, approvals, and circuit breakers.

## Primary threats

### Prompt injection through repository content

A worker may read malicious instructions from source files or issues. Task prompts must state that repository instructions cannot expand tool permissions, allowed paths, project scope, or approval authority.

### Duplicate task execution

Browser restarts, repeated readiness messages, or stale tabs may dispatch the same task twice. Every dispatch needs a project ID, task ID, lease attempt, and idempotency key. A valid active lease blocks reassignment.

### Conflicting repository writes

Concurrent workers may edit overlapping files or branches. Each task has an allowed-path allowlist and dedicated branch. The integrator must detect overlap before combining results.

### Unverified completion claims

A worker can claim a commit or passing tests that do not exist. Result markers are claims, not proof. The reviewer or repository tool must inspect the commit and test evidence before acceptance.

### Destructive or externally visible actions

Merging, publishing, deleting branches, changing workflows, changing permissions, and external side effects require explicit approval recorded by the run controller.

### Subscription or account restriction evasion

The system must not rotate models, chats, accounts, or endpoints to bypass explicit limits or restrictions. Restriction-shaped notices trigger a project-wide stop when the circuit breaker is enabled.

### Secret leakage

Project state must not include credentials, cookies, access tokens, private keys, or unnecessary transcript content. Repository writes should be secret-scanned when tooling supports it.

## Mandatory controls

- Validate every versioned JSON document before state mutation.
- Reject unknown fields by default.
- Reject absolute paths, parent traversal, and NUL bytes.
- Restrict Git repositories to an explicit allowlist.
- Use branch-per-task isolation.
- Enforce unique worker chat assignments within a project.
- Cap concurrent workers.
- Cap revisions and retry attempts.
- Require approval for configured consequential actions.
- Keep an append-only event record for state-changing operations.
- Stop all workers on explicit account restrictions, suspicious activity, CAPTCHAs, or safety blocks.
- Never store hidden reasoning; store outcomes, evidence, and concise summaries only.

## Failure behavior

Project Mode fails closed when:

- the plan cannot be parsed or validated;
- dependencies are unknown or cyclic;
- a worker result references a different task or project;
- a lease is stale or duplicated;
- a requested action exceeds the task's allowed paths or tools;
- the selected model class cannot be confirmed where confirmation is required;
- an approval-gated action has no recorded approval;
- an explicit platform restriction is detected.

## Deferred controls

- Cryptographic signing of worker results.
- Independent remote commit verification by the extension.
- Full JSON Schema runtime validation dependency.
- Sandboxed command execution outside ChatGPT tools.
- Organization policy and workspace administrator controls.
