# AutoPrompter for ChatGPT

AutoPrompter is a Manifest V3 extension for Microsoft Edge that sends a configurable follow-up prompt after ChatGPT completes a response.

Version 2 adds multi-chat scheduling: select conversations from the popup and the extension cycles through them with one inactive managed tab. You no longer need to keep one tab open for every automated conversation.

## Features

- Discovers conversation links currently loaded in ChatGPT's sidebar.
- Lets you select any combination of discovered chats.
- Uses one managed background tab and processes selected chats in round-robin order.
- Applies a configurable prompt, delay, and maximum prompt count to every selected chat.
- Treats an already-completed response as immediately eligible.
- Waits for the newly generated assistant response before moving to the next chat.
- Pauses for a non-empty composer rather than overwriting a draft.
- Refuses to submit an injected prompt if it was edited or its composer was replaced.
- Stops the whole run when the managed tab is closed.
- Stores settings and chat selections locally; runtime state is session-only.
- Contains no analytics, remote code, or third-party network requests.

## Install in Microsoft Edge

1. Clone or download this repository.
2. Open `edge://extensions`.
3. Enable **Developer mode**.
4. Select **Load unpacked**.
5. Choose the repository directory.
6. Open ChatGPT and reload it once.
7. Open the extension popup and press **Refresh**.
8. Select the chats to process, configure the prompt, and press **Start selected**.

## Chat discovery

The ChatGPT sidebar may virtualize or lazily load conversation history. AutoPrompter collects links that are currently present in the page DOM. Scroll through the sidebar and press **Refresh** again to add more chats to the saved catalog.

The catalog is retained locally, so a conversation does not need to remain visible in the sidebar after it has been discovered.

## Scheduler behavior

AutoPrompter creates one inactive managed ChatGPT tab. For each selected chat it:

1. Opens the conversation.
2. Waits for the latest assistant response to be complete.
3. Waits for an empty composer and the configured delay.
4. Submits the continuation prompt.
5. Waits for the resulting assistant response to finish.
6. Moves to the next selected conversation.

The scheduler repeats this round-robin process until every selected chat reaches the configured **Prompts per chat** limit. A failure in one conversation is recorded and the remaining selected chats continue.

## Development

```bash
npm test
npm run check
```

Main files:

- `manifest.json` — Manifest V3 permissions and entry points.
- `background.js` — global multi-chat scheduler and managed-tab lifecycle.
- `content.js` — chat discovery, completion detection, guarded composer injection, and one-shot job execution.
- `popup.html`, `popup.css`, `popup.js` — settings, chat selection, and per-chat progress.
- `tests/` — scheduler and response-change regression tests.

## Limitations

This extension automates the ChatGPT website UI rather than a stable browser automation API. ChatGPT interface changes can require selector updates. Keep prompt limits conservative and supervise important work. Each automatic continuation consumes a normal ChatGPT message and remains subject to account limits and applicable terms.

The managed tab is inactive, not invisible. Edge and ChatGPT must remain running while a schedule is active, and closing the managed tab stops the run.

## License

Apache License 2.0. See `LICENSE`.
