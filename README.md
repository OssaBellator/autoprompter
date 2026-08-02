# AutoPrompter for ChatGPT

Current release: **5.0.0**

AutoPrompter is a Microsoft Edge / Chromium Manifest V3 extension for running reliable AutoContinue workflows through ChatGPT Web. It does not call an inference API.

## AutoContinue

Select up to 12 ChatGPT conversations and run them concurrently in inactive managed tabs. Each chat can use:

- its own follow-up prompt;
- repository-continuity settings;
- repository and handoff-file overrides;
- plugin/tool instructions;
- notes and context that are appended to every work prompt.

A normal `Connection interrupted. Waiting for the complete answer` notice continues retrying in the same chat without a fixed retry ceiling.

When ChatGPT repeatedly displays the full “Our systems are thinking a bit more about this request…” platform notice, AutoPrompter retries the same conversation three times. The fourth consecutive occurrence starts a fresh successor chat and carries the configured prompt, repository details, project context, and per-chat notes forward.

Explicit user stop, rate-limit detection, account restrictions, safety notices, context rollover, and the configured completed-work prompt limit remain active.

## Projects

Projects are lightweight chat folders. They store:

- a project name;
- a GitHub `owner/repository` value;
- shared project notes;
- the ChatGPT conversations belonging to the project.

Loading a project selects its chats for AutoContinue. During a run, the project repository and notes are added only to chats in that project. Per-chat notes are added independently.

Projects do **not** create planners, workers, reviewers, issues, branches, pull requests, or merges. The previous Project Mode execution engine is retired. Legacy project titles, goals, repositories, and assigned role/worker chats are migrated into folder records; task and bootstrap state is not carried forward.

## Repository continuity

Repository continuity is optional. When enabled, AutoPrompter asks the configured repository tool to checkpoint work and return a verified handoff marker before creating a successor conversation.

The extension:

- has no GitHub host permission;
- does not authenticate directly to GitHub;
- does not store a personal access token;
- cannot bypass platform confirmations or repository-tool safety checks.

Without a verified handoff, context-limit and repeated extended-thinking recovery use a best-effort fresh chat with the configured prompt and available context.

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
6. Press **Start all selected**.

The ↗ control starts a selected goal in a fresh conversation before its first prompt.

## Development

Requires Node.js 20 or newer.

```bash
npm test
npm run check
```

The active test suite covers project-folder migration and CRUD, per-chat and project context injection, retired project-command blocking, runtime wiring, and repeated extended-thinking recovery.

## Known limitations

- ChatGPT DOM changes can break selectors.
- Hidden or inactive managed tabs may be throttled by the browser.
- Context usage is estimated from visible text and is not an exact tokenizer measurement.
- Plugin availability and write capability vary by plan, workspace, authorization, and product surface.

## License

Apache-2.0. See [`LICENSE`](LICENSE).
