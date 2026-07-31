# AutoPrompter for ChatGPT

Current release: **2.8.0**

- Detects ChatGPT’s current maximum-length notice and opens a best-effort successor even when no repository checkpoint exists.

AutoPrompter is a Microsoft Edge / Chromium Manifest V3 extension that runs selected ChatGPT conversations concurrently using one inactive managed tab per chat. Initial workers synchronize at a readiness barrier and receive zero-delay jobs together, avoiding independent background-tab delay timers that can drift under browser throttling. Each chat independently queues its next follow-up as soon as its current response completes. It can notify you when work prompts complete and, when explicitly configured, create successor chats from verified Git repository checkpoints.

- Chats are displayed in the same most-recent-first order as the ChatGPT sidebar.
- The ↗ control can start a selected legacy goal in a new chat immediately.
- Real context-limit interruptions fall back to a best-effort fresh chat when a verified continuity checkpoint cannot be created.
- While a run is active, the selection UI is replaced by a collapsible progress view containing only the selected chats.

## Features

- Discover chats currently loaded in the ChatGPT sidebar.
- Launch up to 12 selected conversations concurrently, using one isolated inactive managed tab per chat.
- Submit the initial selected-chat batch together after all worker pages report ready; later follow-ups still advance independently as each chat completes.
- Apply the configured delay between follow-ups, not before the first concurrent batch.
- Configurable work prompt, delay, and per-goal work-prompt limit.
- Browser notifications for prompt completion, scheduler completion, errors, and handoffs.
- Conservative response-completion and composer-ownership checks.
- Approximate visible-context monitoring with a configurable capacity and rollover threshold.
- Optional repository checkpoints before and after work.
- Verified successor chats when a repository checkpoint is available, plus best-effort fresh-chat recovery for actual context-limit failures that occur before a checkpoint can be created.
- Incremental durability instructions that ask the selected repository tool to commit completed logical units before lengthy or risky work continues.
- Default-on automatic circuit breaker for rate limits, account restrictions, and safety blocks, with an explicit disable option for false-positive troubleshooting.
- Draft Project Mode foundation on the development branch: versioned local project storage, fixed planner/reviewer/integrator roles, selected-chat worker pools, lifecycle controls, and an audit trail. The preview does not dispatch agents yet.

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
5. For a legacy or already-full conversation, press its **↗** control to start the goal in a new chat immediately.
6. Configure the work prompt and limits.
7. Press **Start all selected**. The picker is replaced by a collapsible progress panel containing only the selected chats while the run is active.

The sidebar is virtualized, so the extension can discover only links present in the current page DOM. Repeatedly scroll and refresh to expand the saved local catalog.

## Per-chat settings and continuity initialization

Each selected conversation can override the global follow-up prompt, GitHub repository, continuity file, plugin/tool instruction, and whether continuity is enabled. Open **Per-chat prompt and repository overrides** and choose a selected chat. Draft changes autosave while typing and are flushed before switching chats or starting a run. Blank fields inherit the global settings.

Use **Initialize continuity** to send one purpose-built initialization prompt to every selected chat. Each chat uses its effective repository settings, creates or reconciles the continuity file, commits and pushes it through the configured action-capable tool, and must return an `AUTOPROMPTER_CHECKPOINT` marker. Initialization does not run the normal repeated work prompt.

## Circuit-breaker matching

Restriction detection is intentionally exact and UI-scoped. Normal assistant prose that merely discusses rate limits, account restrictions, or safety controls does not activate the circuit breaker. Actual trusted notice containers and short assistant/system messages matching documented restriction wording still stop the scheduler. The popup includes **Disable automatic circuit breaker**, which is off by default and can be enabled when troubleshooting detector false positives. Disabling it affects only AutoPrompter's heuristic detector; it does not bypass ChatGPT controls.

## Concurrent scheduling

AutoPrompter opens one inactive managed tab for every selected chat, up to 12 chats per run. Initial prompts are launched together. Afterward, each chat advances independently: whichever response finishes first receives its next follow-up first, while slower chats continue working without blocking the queue.

Initial prompts are dispatched together after a readiness barrier. A slow worker is released after a five-second grace period so it cannot block the whole batch. Concurrent prompting can consume account allowances faster and can make rate-limit notices more likely. Use a conservative delay, keep the selected batch small, and leave the automatic circuit breaker enabled unless false positives require disabling it. Inactive tabs may also be throttled by the browser.

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

- **Context limit:** use a verified repository handoff when possible. The detector includes `You’ve reached the maximum length for this conversation, but you can keep talking by starting a new chat.` If the context-limit message arrives before a checkpoint can be created, open a best-effort fresh chat using the selected chat title, configured work prompt, and any repository details. The extension explicitly tells the new chat that it cannot see the old transcript.
- **Connection interrupted:** stop the interrupted generation when a stop control is available, then queue a same-chat continuation prompt without incrementing completed-work progress. Retries are capped at three consecutive attempts.
- **Prolonged stall or content removal:** require a verified checkpoint before rollover. Stuck-generation labels—`Thinking…`, `Generating…`, and `Working…`—must persist for the configured stall timeout before rollover.
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

The tests cover URL and repository validation, scheduler eligibility, successor prompt construction, context rollover, marker parsing, guardrail classification, verified fresh-chat creation, and connection-interruption retry behavior.

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

## Connection interruption recovery

When ChatGPT shows `Connection interrupted. Waiting for the complete answer`, AutoPrompter stops the interrupted generation when a stop control is available and queues `Continue from where the response was interrupted. Do not repeat completed material.` for that chat. The retry does not increment the completed-work counter and is limited to three consecutive attempts.

Fresh-start workers click ChatGPT's New chat control when the site restores an older `/c/<id>` route, wait for an empty conversation surface, and reject any successor whose conversation ID matches its parent.
