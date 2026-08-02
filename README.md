# AutoPrompter for ChatGPT

Current release: **4.0.3**

- Fixes the flashing **Resume stage** button by giving the recoverable GitHub-stage control stable ownership instead of fighting the popup renderer.
- Recoverable-stage clicks now use a dedicated background command, while normal paused-project Resume behavior remains unchanged.
- Captures only complete planner issue manifests and uses the newest complete envelope when ChatGPT repeats one.
- Reuses already initialized planner and reviewer/merger chats instead of assigning their roles again.
- Fresh issue work runs in temporary managed worker tabs. The same worker conversation is reopened only when its pull request needs revisions.

AutoPrompter is a Microsoft Edge / Chromium Manifest V3 extension that coordinates work through ChatGPT Web. It does not call an inference API and it does not store a GitHub token.

## GitHub Issue and Pull Request Mode

Project Mode is GitHub-native:

1. A dedicated planner chat inspects the repository with a connected, write-capable GitHub plugin or tool.
2. The planner creates real GitHub issues for the independently executable units of work.
3. AutoPrompter opens one fresh temporary managed worker tab for each ready issue.
4. Each worker reads its issue, creates or updates one branch, and opens one pull request.
5. A single combined reviewer/merger chat evaluates the issue, pull request, diff, commits, comments, and checks.
6. When the pull request is ready, the reviewer/merger merges that exact pull request and verifies the resulting default-branch commit and closed issue.
7. When changes are needed, the reviewer/merger posts actionable feedback on GitHub, leaves the pull request open, and returns the issue to the same worker conversation.
8. Issues that depend on other issues remain blocked until the prerequisite pull requests are verified as merged.

GitHub issues and pull requests are the durable task state. The extension keeps local orchestration records for tab identity, status, and recovery, but it no longer treats a separate local task DAG or final integrator stage as the source of truth.

### Planner recovery and Resume stage

Planner recovery accepts only a complete `AUTOPROMPTER_ISSUES_BEGIN` / `AUTOPROMPTER_ISSUES_END` envelope. Role acknowledgements, tool summaries, setup prose, and incomplete responses are ignored. When a response contains more than one complete manifest, AutoPrompter validates only the newest complete envelope.

A failed bootstrap is not restarted by the delayed creation watchdog. Use **Resume stage** on the saved project:

- When an issue manifest was already validated, task records are created immediately.
- When GitHub issues exist but no valid local manifest was stored, AutoPrompter reopens the existing planner conversation and asks it to inventory the exact existing issues without duplicating them.
- The initialized reviewer/merger conversation is reused and does not receive another role-assignment prompt.
- When task records already exist, the task board resumes preparation and dispatch of ready issues.

The Resume stage control uses a dedicated background command and remains enabled while a failed or cancelled bootstrap is recoverable. It no longer alternates between enabled and disabled as the popup refreshes.

### Required GitHub capability

The planner, issue workers, and reviewer/merger require a connected GitHub plugin, MCP server, Codex environment, or other repository tool that can perform the requested writes.

The extension itself:

- has no GitHub host permission;
- does not authenticate directly to GitHub;
- does not store a personal access token;
- cannot bypass platform confirmation or a repository tool's safety checks;
- validates the issue and pull-request identities returned by the ChatGPT agent before advancing local state.

A read-only GitHub connector is insufficient for issue creation, branches, commits, pull requests, review comments, or merges.

## Normal AutoContinue

AutoPrompter can still run selected ChatGPT conversations concurrently and submit a configured follow-up prompt as each conversation completes.

A recoverable `Connection interrupted. Waiting for the complete answer` event now queues the same-chat continuation without a fixed consecutive retry ceiling. The retry counter remains visible for diagnostics, but it no longer stops the chat after three interruptions.

This does not weaken the other controls:

- explicit user stop still stops the run;
- rate-limit, account-restriction, and safety notices still activate the circuit breaker when enabled;
- context-limit and prolonged-stall handling still use the configured successor-chat and repository-continuity rules;
- the completed-work prompt limit remains configurable.

## Install in Edge

1. Clone or download this repository.
2. Open `edge://extensions`.
3. Enable **Developer mode**.
4. Choose **Load unpacked**.
5. Select the repository folder.
6. Reload open ChatGPT tabs after every extension update.

## Start a GitHub issue project

1. Open ChatGPT and make sure the required GitHub write-capable tool is connected and authorized for the repository.
2. Open AutoPrompter and expand **GitHub Issue and Pull Request Mode**.
3. Enter the project title, goal, and `owner/repository` value.
4. Leave the planner and pull-request reviewer/merger selectors on **Create automatically**, or bind separate existing chats.
5. Create the project.

The planner creates the issues. Ready issues then receive temporary managed worker tabs automatically. The combined reviewer/merger processes pull requests one at a time and either merges or posts feedback.

## Safety boundaries

- Planner, worker, and reviewer/merger chats must be distinct roles.
- Workers do not merge their own pull requests.
- The reviewer/merger is scoped to the exact pull request assigned by AutoPrompter.
- A merge result must include a verified merge commit and closed issue.
- A changes-requested result must leave the pull request and issue open and include feedback already posted on GitHub.
- Claims returned by a model or repository tool are validated structurally, but the extension is not an independent cryptographic verifier of GitHub state.
- Browser DOM changes, inactive-tab throttling, plugin availability, and platform safety controls can still interrupt automation.

## Repository continuity

Repository continuity remains optional for normal AutoContinue. When enabled, checkpoint and successor prompts ask the configured repository tool to commit completed work and return a verified repository marker. Context usage is estimated from visible page text and is not an exact tokenizer measurement.

## Development

Requires Node.js 20 or newer.

```bash
npm test
npm run check
```

The tests cover planner-created and recovered issue manifests, role reuse, stable stage-aware resume, temporary worker dispatch, pull-request revisions, review-and-merge decisions, dependency unlocking, popup startup safety, normal AutoContinue interruption recovery, and syntax validation for every runtime module.

## Known limitations

- ChatGPT DOM changes can break selectors.
- Hidden or inactive managed tabs may be throttled by the browser.
- GitHub plugin availability and write capability vary by plan, workspace, authorization, and product surface.
- Platform safety controls may block individual repository actions.
- Returned repository evidence is structurally validated but is still supplied by the model or connected tool.

## License

Apache-2.0. See [`LICENSE`](LICENSE).
