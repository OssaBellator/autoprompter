# AutoPrompter for ChatGPT

Current release: **5.1.2**

AutoPrompter is a Microsoft Edge / Chromium Manifest V3 extension for running reliable AutoContinue workflows through ChatGPT Web. It does not call an inference API.

## AutoContinue

Select up to 12 ChatGPT conversations and run them concurrently in inactive managed tabs. Each chat can use:

- its own follow-up prompt;
- repository-continuity settings;
- repository and handoff-file overrides;
- plugin/tool instructions;
- notes and context appended to every work prompt.

A completed response is acknowledged to the ChatGPT tab before AutoPrompter dispatches the next prompt. Normal connection interruptions retry in the same chat without a fixed retry ceiling.

AutoPrompter 5.1.2 routes real terminal browser messages through the final installed recovery handlers. Scheduler-state repair, repeated-thinking recovery, and acknowledgement-first dispatch now govern the actual service-worker listener instead of only wrapped function calls. Null or incomplete chat records are repaired, and popup self-repair controls validate service-worker responses before reading settings or active-job state.

The full “Our systems are thinking a bit more about this request…” platform notice retries the same conversation three times. The fourth consecutive occurrence starts a fresh successor chat.

A separate stale-status recovery handles bare UI labels such as `Thinking`, `Generating…`, or `Working`. These labels are not treated as repository-continuity failures. AutoPrompter refreshes the same managed chat for the first three consecutive stale occurrences; the fourth starts a best-effort fresh chat. This prevents the incorrect `Continuity handoff required: Thinking` stop between selected chats.

Explicit user stop, rate-limit detection, account restrictions, safety notices, context rollover, and the configured completed-work prompt limit remain active.

## Projects

Projects are lightweight chat folders. They store:

- a project name;
- a GitHub `owner/repository` value;
- shared project notes;
- the ChatGPT conversations belonging to the project.

Loading a project selects its chats for AutoContinue. During a run, project repository details and notes are added only to chats in that project. Per-chat notes are added independently.

Projects do **not** create planners, workers, reviewers, issues, branches, pull requests, or merges. The previous Project Mode execution engine has been removed from `main`. Its final source snapshot is preserved on the `legacy/project-mode-v5.0.1` branch. Legacy project titles, goals, repositories, and assigned role/worker chats can still be migrated into folder records; task and bootstrap state is not carried forward.

## Automatic extension self-repair

Automatic self-repair is opt-in from the popup. When enabled, AutoPrompter can:

1. capture a qualifying extension/runtime failure;
2. remove prompt text, conversation transcripts, project notes, and unapproved diagnostic fields;
3. deduplicate the error by a stable fingerprint;
4. open one inactive temporary ChatGPT repair chat;
5. instruct that chat to inspect only `OssaBellator/autoprompter`, add a regression test, create an `autofix/*` branch, run `npm test` and `npm run check`, and open one pull request;
6. optionally allow a squash merge only when tests and checks pass and the final change is narrowly scoped.

The repair runtime permits one active repair at a time, applies a duplicate-error cooldown, and enforces a configurable daily limit. User stops, platform rate limits, account restrictions, and safety restrictions are not sent into automatic repair.

A connected **write-capable** GitHub tool is required in the temporary ChatGPT chat. The extension itself has no GitHub host permission, stores no token, and cannot bypass tool confirmations or branch protections. When safe automated completion is not possible, the repair chat leaves the pull request open or reports a blocker.

## Repository continuity

Repository continuity is optional. When enabled, AutoPrompter asks the configured repository tool to checkpoint work and return a verified handoff marker before creating a successor conversation.

The extension:

- has no GitHub host permission;
- does not authenticate directly to GitHub;
- does not store a personal access token;
- cannot bypass platform confirmations or repository-tool safety checks.

Without a verified handoff, context-limit and repeated-thinking recovery use a best-effort fresh chat with the configured prompt and available folder/chat context.

## Install in Edge

1. Clone or download this repository.
2. Open `edge://extensions`.
3. Enable **Developer mode**.
4. Choose **Load unpacked**.
5. Select the repository folder.
6. Reload open ChatGPT tabs after every extension update.

## Usage

1. Open ChatGPT and press **Refresh** in AutoPrompter.
2. Select the conversations to run.
3. Open **Per-chat prompt and repository overrides** to add custom prompts, repository settings, and notes.
4. Optionally create or load a **Project** chat folder.
5. Configure the global follow-up prompt and continuation count.
6. Optionally enable **Automatic extension self-repair**.
7. Press **Start all selected**.

The ↗ control starts a selected goal in a fresh conversation before its first prompt.

## Updating a local unpacked checkout

A browser extension cannot safely execute `git pull` on the host machine. The default update boundary is therefore:

```bash
git checkout main
git pull --ff-only origin main
```

The pull can be automated outside the browser with Windows Task Scheduler, a systemd user timer, cron, or a small native-messaging host. The updater should refuse to run when the checkout is dirty and should use fast-forward-only updates. Reloading an unpacked extension can also be automated only by an external/native helper or by moving to a packaged, policy-managed extension update flow; the extension cannot reload its own source directory after files change.

## Development

Requires Node.js 20 or newer.

```bash
npm test
npm run check
```

The active suite covers chat-folder migration and context injection, scheduler-state repair, real service-worker terminal-handler routing, extended-thinking recovery, bare stale-`Thinking` recovery, acknowledgement-first dispatch, safe self-repair responses, bounded self-repair diagnostics and envelopes, runtime wiring, and the absence of retired Project Mode source from `main`.

## Known limitations

- ChatGPT DOM changes can break selectors.
- Hidden or inactive managed tabs may be throttled by the browser.
- Context usage is estimated from visible text and is not an exact tokenizer measurement.
- Plugin availability and write capability vary by plan, workspace, authorization, and product surface.
- Automatic repair cannot access the local checkout or private conversation history.

## License

Apache-2.0. See [`LICENSE`](LICENSE).
