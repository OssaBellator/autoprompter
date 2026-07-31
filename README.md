# AutoPrompter for ChatGPT

Current release: **2.4.0**

AutoPrompter is a Microsoft Edge / Chromium Manifest V3 extension that runs selected ChatGPT conversations concurrently using one inactive managed tab per chat. Each chat independently queues its next follow-up as soon as its current response completes. It can notify you when work prompts complete and, when explicitly configured, create successor chats from verified Git repository checkpoints.

## Features

- Discover chats currently loaded in the ChatGPT sidebar.
- Launch up to 12 selected conversations concurrently, using one isolated inactive managed tab per chat.
- Queue each chat's next follow-up immediately when that chat completes, without waiting for slower chats.
- Configurable work prompt, delay, and per-goal work-prompt limit.
- Browser notifications for prompt completion, scheduler completion, errors, and handoffs.
- Conservative response-completion and composer-ownership checks.
- Approximate visible-context monitoring with a configurable capacity and rollover threshold.
- Optional repository checkpoints before and after work.
- Automatic successor chats for context exhaustion, verified prolonged stalls, or content-loss signals—but only when a repository checkpoint marker is available.
- Incremental durability instructions that ask the selected repository tool to commit completed logical units before lengthy or risky work continues.
- Default-on automatic circuit breaker for rate limits, account restrictions, and safety blocks, with an explicit disable option for false-positive troubleshooting.

## Install in Edge

1. Clone or download this repository.
2. Open `edge://extensions`.
3. Enable **Developer mode**.
4. Choose **Load unpacked**.
5. Select the repository folder.
6. Reload any open ChatGPT page.

## Select chats

1. Open ChatGPT in a normal tab.
2. Scroll the sidebar so the conversations you need are loaded.
3. Open AutoPrompter and press **Refresh**.
4. Select the conversations.
5. Configure the work prompt and limits.
6. Press **Start all selected**.

The sidebar is virtualized, so the extension can discover only links present in the current page DOM. Repeatedly scroll and refresh to expand the saved local catalog.

## Per-chat settings and continuity initialization

Each selected conversation can override the global follow-up prompt, GitHub repository, continuity file, plugin/tool instruction, and whether continuity is enabled. Open **Per-chat prompt and repository overrides** and choose a selected chat. Draft changes autosave while typing and are flushed before switching chats or starting a run. Blank fields inherit the global settings.

Use **Initialize continuity** to send one purpose-built initialization prompt to every selected chat. Each chat uses its effective repository settings, creates or reconciles the continuity file, commits and pushes it through the configured action-capable tool, and must return an `AUTOPROMPTER_CHECKPOINT` marker. Initialization does not run the normal repeated work prompt.

## Circuit-breaker matching

Restriction detection is intentionally exact and UI-scoped. Normal assistant prose that merely discusses rate limits, account restrictions, or safety controls does not activate the circuit breaker. Actual trusted notice containers and short assistant/system messages matching documented restriction wording still stop the scheduler. The popup includes **Disable automatic circuit breaker**, which is off by default and can be enabled when troubleshooting detector false positives. Disabling it affects only AutoPrompter's heuristic detector; it does not bypass ChatGPT controls.

## Concurrent scheduling

AutoPrompter opens one inactive managed tab for every selected chat, up to 12 chats per run. Initial prompts are launched together. Afterward, each chat advances independently: whichever response finishes first receives its next follow-up first, while slower chats continue working without blocking the queue.

Concurrent prompting can consume account allowances faster and can make rate-limit notices more likely. Use a conservative delay, keep the selected batch small, and leave the automatic circuit breaker enabled unless false positives require disabling it. Inactive tabs may also be throttled by the browser.

## Notifications

The extension requests the browser `notifications` permission. Notifications can be enabled globally and separately for each completed work prompt. A final notification is also sent when a run finishes or is stopped by an intervention.

## Repository continuity

Repository continuity is optional and disabled by default.

1. Enable **Verified repository handoffs**.
2. Enter a GitHub repository as `owner/repository`.
3. Choose a continuity file, normally `AUTOPROMPTER_HANDOFF.md`.
4. Provide an instruction for an action-capable repository tool.
5. Configure the estimated context capacity, rollover threshold, and stall timeout.
6. Keep pre-work and post-work checkpoints enabled for the strongest recovery behavior.

Each checkpoint prompt asks ChatGPT to commit completed work, update the continuity file, verify the remote commit, and return a marker:

```text
AUTOPROMPTER_CHECKPOINT: <commit-sha-or-immutable-ref>
```

A context handoff uses:

```text
AUTOPROMPTER_HANDOFF_READY: <commit-sha-or-immutable-ref>
```

The extension checks for the marker but cannot independently prove that a model or plugin performed the Git operation. Use an action-capable tool with least-privilege repository access. The standard read-only GitHub app cannot push changes; Codex or a purpose-built action-capable plugin/app is required for writes.

## Context estimation

ChatGPT does not expose a stable browser API for exact per-conversation context consumption. AutoPrompter estimates tokens from visible user and assistant text and compares the estimate with the capacity you configure. Attachments, hidden instructions, tool results, model-specific accounting, summarization, and unloaded messages can make the estimate inaccurate. Treat the threshold as an early-warning heuristic, not a precise meter.

## Guardrails and interruptions

AutoPrompter classifies visible interruption messages conservatively:

- **Context limit, prolonged stall, or content removal:** create a successor chat only when continuity is enabled and a verified checkpoint marker exists. Stuck-generation labels documented by OpenAI—`Thinking…`, `Generating…`, and `Working…`—must persist for the configured stall timeout before rollover.
- **Suspicious activity, rate limit, temporary account restriction, or safety block:** stop the whole scheduler and notify the user. Documented restriction variants include `We detect suspicious activity.`, `Unusual Activity Detected`, `Unusual activity has been detected from your device. Try again later`, and `Sorry, you have been blocked`.
- **Missing checkpoint:** stop and request manual review rather than opening a successor with guessed state.

The extension intentionally does not rotate chats, models, accounts, or endpoints to evade a platform restriction.

## Message usage

With repository continuity enabled, one work cycle can use up to three messages:

1. pre-work checkpoint
2. work prompt
3. post-work checkpoint

This improves recovery but consumes allowances faster. Use a reasonable delay, low work-prompt limit, and the circuit breaker. Do not use the extension for unattended high-volume extraction or as a third-party service.

## Development

Requires Node.js 20 or newer.

```bash
npm test
npm run check
```

The tests cover URL and repository validation, scheduler eligibility, successor prompt construction, context rollover, marker parsing, and guardrail classification.

## Future architecture

See [`docs/MULTI_AGENT_ROADMAP.md`](docs/MULTI_AGENT_ROADMAP.md) for a planned, supported-interface multi-agent design. It deliberately avoids implementing model-picker automation or temporary worker-chat orchestration in this release.

## Known limitations

- ChatGPT DOM changes can break selectors.
- Hidden/inactive managed tabs may be throttled by the browser, especially when many chats run concurrently.
- Context and guardrail detection are heuristic.
- Notification delivery depends on browser and operating-system settings.
- Plugin availability and capabilities vary by plan, workspace, region, and product surface.
- A marker is an assistant/tool claim, not cryptographic verification by this extension.

## License

Apache-2.0. See [`LICENSE`](LICENSE).
