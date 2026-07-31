(() => {
  "use strict";

  const MESSAGE_SCOPE = "AUTOPROMPTER_RUNTIME";
  const FALLBACK_STABLE_MS = 2500;
  const POLL_MS = 250;
  const READY_HEARTBEAT_MS = 15000;
  const JOB_TIMEOUT_MS = 30 * 60 * 1000;
  const COMPOSER_WAIT_MS = 10 * 60 * 1000;
  const OWNERSHIP_ATTR = "data-autoprompter-owner";
  const CHECKPOINT_PREFIX = "AUTOPROMPTER_CHECKPOINT:";
  const HANDOFF_PREFIX = "AUTOPROMPTER_HANDOFF_READY:";

  const SELECTORS = Object.freeze({
    assistant: [
      '[data-message-author-role="assistant"]',
      '[data-turn="assistant"]',
      'article[data-turn="assistant"]',
      '[data-testid^="conversation-turn-"][data-turn="assistant"]'
    ],
    assistantFallbacks: [
      'article .agent-turn',
      '[data-testid^="conversation-turn-"] .agent-turn'
    ],
    user: [
      '[data-message-author-role="user"]',
      '[data-turn="user"]',
      'article[data-turn="user"]',
      '[data-testid^="conversation-turn-"][data-turn="user"]'
    ],
    composer: [
      '#prompt-textarea',
      'div#prompt-textarea[contenteditable="true"]',
      'textarea[name="prompt-textarea"]',
      'textarea[data-id="root"]',
      'form [contenteditable="true"][role="textbox"]',
      'form [contenteditable="true"][data-lexical-editor="true"]',
      '[data-testid*="composer"] [contenteditable="true"]',
      'form [contenteditable="true"]'
    ],
    send: [
      'button[data-testid="send-button"]',
      'button[aria-label="Send prompt"]',
      'button[aria-label="Send"]',
      'button[title="Send"]',
      'button[data-testid*="send"]',
      'button[data-testid*="submit"]',
      'button[type="submit"]'
    ],
    stop: [
      'form button[data-testid="stop-button"]',
      'form button[aria-label*="Stop generating"]',
      'form button[aria-label*="Stop response"]',
      'form button[aria-label*="Stop streaming"]',
      'button[data-testid*="stop"]'
    ],
    newChat: [
      'a[data-testid*="new-chat"]',
      'button[data-testid*="new-chat"]',
      'a[aria-label="New chat"]',
      'button[aria-label="New chat"]',
      'a[title="New chat"]',
      'button[title="New chat"]'
    ],
    notices: [
      '[role="alert"]',
      '[aria-live="assertive"]',
      '[data-testid*="error"]',
      '[data-testid*="warning"]',
      '[class*="error-message"]',
      '[class*="toast"]'
    ]
  });

  let activeJob = null;
  const guardrailFirstSeen = new Map();

  class JobInterruption extends Error {
    constructor(kind, message) {
      super(message);
      this.name = "JobInterruption";
      this.kind = kind;
    }
  }

  function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(new DOMException("Aborted", "AbortError"));
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(new DOMException("Aborted", "AbortError"));
      }, { once: true });
    });
  }

  function runtimeMessage(message) {
    return chrome.runtime.sendMessage({ scope: MESSAGE_SCOPE, ...message }).catch(() => null);
  }

  function normalizeText(value) {
    return String(value || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
  }

  function hashText(value) {
    let hash = 2166136261;
    const text = String(value || "");
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  }

  function estimateTokensFromText(value) {
    const text = normalizeText(value);
    if (!text) return 0;
    // A deliberately conservative browser-side heuristic. It is not a tokenizer.
    const words = text.split(/\s+/).length;
    return Math.ceil(Math.max(text.length / 4, words * 1.25));
  }

  function shouldRolloverContext(estimatedTokens, capacityTokens, thresholdPercent) {
    const capacity = Number(capacityTokens);
    const threshold = Number(thresholdPercent);
    if (!Number.isFinite(capacity) || capacity <= 0 || !Number.isFinite(threshold)) return false;
    return (Number(estimatedTokens || 0) / capacity) * 100 >= threshold;
  }

  function classifyGuardrailText(value, source = "notice") {
    const text = normalizeText(value);
    if (!text) return null;

    // Generation status labels are valid only as complete UI segments. Ordinary
    // prose such as "the planner is thinking about rate limits" must not match.
    const statusSegments = text.split(/\s+\|\s+/).map(part => part.trim()).filter(Boolean);
    if (statusSegments.some(part => /^(?:thinking|generating|working)(?:\s*[.…]{1,3})?$/i.test(part))) {
      return { kind: "stalled", message: text.slice(0, 500) };
    }

    const candidate = text.replace(/^(?:error|warning|notice)\s*[:–—-]\s*/i, "").trim();
    const connectionInterrupted = /connection interrupted\.?\s*waiting for the complete answer\.?$/i;
    if ((source === "notice" && /^connection interrupted\.?\s*waiting for the complete answer\.?$/i.test(candidate)) ||
        (source === "assistant" && connectionInterrupted.test(candidate))) {
      return { kind: "connection_interrupted", message: text.slice(-500) };
    }
    const rules = [
      {
        kind: "account_restriction",
        strict: /^(?:we detect suspicious activity(?: on your account)?\.?|unusual activity detected\.?|unusual activity has been detected from your device\.?\s*try again later\.?|sorry,? you have been blocked\.?|we(?:'ve| have) temporarily restricted your access(?: to [^.]+)? as we review for potential abuse\.?)$/i,
        notice: /^(?:we detect suspicious activity|unusual activity detected|unusual activity has been detected from your device|sorry,? you have been blocked|we(?:'ve| have) temporarily restricted your access(?: to .+)? as we review for potential abuse)(?:[.!]|\s|$)/i
      },
      {
        kind: "rate_limit",
        strict: /^(?:too many requests\.?|rate limit (?:reached|exceeded)\.?|you(?:'ve| have) reached (?:your|the) .{0,120}(?:usage|message|request|rate|gpt[^ ]*)?\s*limit\.?|you have reached your usage limit\.?|please try again (?:in|after) \d+[^.]*\.?|your .{0,100} limit resets .+)$/i,
        notice: /^(?:too many requests|rate limit (?:reached|exceeded)|you(?:'ve| have) reached (?:your|the) .{0,120}(?:usage|message|request|rate|gpt[^ ]*)?\s*limit|you have reached your usage limit|please try again (?:in|after) \d+|your .{0,100} limit resets)(?:[.!]|\s|$)/i
      },
      {
        kind: "context_limit",
        strict: /^(?:this )?conversation (?:is )?too long\.?|^(?:the )?maximum (?:conversation|context) length (?:has been )?reached\.?|^the context window is full\.?|^start a new chat to continue\.?/i,
        notice: /^(?:(?:this )?conversation (?:is )?too long|(?:the )?maximum (?:conversation|context) length (?:has been )?reached|the context window is full|start a new chat to continue)(?:[.!]|\s|$)/i
      },
      {
        kind: "content_removed",
        strict: /^(?:this )?(?:content|response) (?:was|has been) (?:removed|deleted)\.?$/i,
        notice: /^(?:this )?(?:content|response) (?:was|has been) (?:removed|deleted)(?:[.!]|\s|$)/i
      },
      {
        kind: "safety_restriction",
        strict: /^(?:your request was flagged as potentially violating our usage policy|this content may violate our terms of use or usage policies|your request was blocked|request blocked for safety|i cannot comply due to safety|i can't comply due to safety)\.?$/i,
        notice: /^(?:your request was flagged as potentially violating our usage policy|this content may violate our terms of use or usage policies|your request was blocked|request blocked for safety)(?:[.!]|\s|$)/i
      }
    ];

    for (const rule of rules) {
      const pattern = source === "assistant" ? rule.strict : rule.notice;
      if (pattern.test(candidate)) return { kind: rule.kind, message: text.slice(0, 500) };
    }
    return null;
  }


  const CIRCUIT_BREAKER_KINDS = new Set([
    "rate_limit",
    "account_restriction",
    "safety_restriction"
  ]);

  function shouldHandleInterruption(notice, settings) {
    if (!notice) return false;
    if (!CIRCUIT_BREAKER_KINDS.has(notice.kind)) return true;
    return settings?.circuitBreakerEnabled !== false;
  }

  function extractMarker(text, prefix) {
    const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = String(text || "").match(new RegExp(`${escaped}\\s*([A-Za-z0-9._/-]{7,160})`, "i"));
    return match ? match[1] : "";
  }

  function extractCheckpointMarker(text) {
    return extractMarker(text, CHECKPOINT_PREFIX);
  }

  function extractHandoffMarker(text) {
    return extractMarker(text, HANDOFF_PREFIX);
  }

  function isVisible(element) {
    if (!element?.isConnected) return false;
    if (typeof getComputedStyle !== "function") return true;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
  }

  function firstVisible(selectors, root = document) {
    for (const selector of selectors) {
      let matches = [];
      try { matches = root.querySelectorAll(selector); } catch { matches = []; }
      for (const match of matches) if (isVisible(match)) return match;
    }
    return null;
  }

  function uniqueRoleNodes(selectors, role) {
    const result = [];
    for (const selector of selectors) {
      let matches = [];
      try { matches = document.querySelectorAll(selector); } catch { matches = []; }
      for (const match of matches) {
        const node = match.closest?.(
          `article[data-turn="${role}"], [data-testid^="conversation-turn-"][data-turn="${role}"]`
        ) || match;
        if (!result.includes(node)) result.push(node);
      }
    }
    return result.sort((left, right) => {
      if (left === right) return 0;
      if (typeof left.compareDocumentPosition !== "function") return 0;
      const position = left.compareDocumentPosition(right);
      if (position & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
      if (position & Node.DOCUMENT_POSITION_PRECEDING) return 1;
      return 0;
    });
  }

  function assistantNodes() {
    const nodes = uniqueRoleNodes(SELECTORS.assistant, "assistant");
    if (nodes.length) return nodes;
    const fallback = [];
    for (const selector of SELECTORS.assistantFallbacks) {
      let matches = [];
      try { matches = document.querySelectorAll(selector); } catch { matches = []; }
      for (const match of matches) {
        const node = match.closest?.('article, [data-testid^="conversation-turn-"]') || match;
        if (!fallback.includes(node)) fallback.push(node);
      }
    }
    return fallback;
  }

  function assistantSnapshot() {
    const nodes = assistantNodes();
    const last = nodes[nodes.length - 1] || null;
    const content = last?.querySelector?.('[data-message-content], .markdown, .prose') || last;
    const text = normalizeText(content?.innerText || content?.textContent || "");
    const identity = last?.getAttribute?.("data-turn-id") ||
      last?.getAttribute?.("data-message-id") ||
      last?.getAttribute?.("data-testid") ||
      `assistant-${Math.max(0, nodes.length - 1)}`;
    return {
      count: nodes.length,
      identity,
      text,
      textLength: text.length,
      signature: `${nodes.length}:${identity}:${text.length}:${hashText(text)}`
    };
  }

  function userNodes() {
    return uniqueRoleNodes(SELECTORS.user, "user");
  }

  function userCount() {
    return userNodes().length;
  }

  function conversationText() {
    const nodes = [...userNodes(), ...assistantNodes()];
    const seen = new Set();
    const texts = [];
    for (const node of nodes) {
      if (seen.has(node)) continue;
      seen.add(node);
      const content = node?.querySelector?.('[data-message-content], .markdown, .prose') || node;
      const text = normalizeText(content?.innerText || content?.textContent || "");
      if (text) texts.push(text);
    }
    return texts.join("\n");
  }

  function contextMetrics(settings) {
    const estimatedTokens = estimateTokensFromText(conversationText());
    const capacity = Number(settings.contextCapacityTokens || 128000);
    return {
      estimatedTokens,
      percent: capacity > 0 ? (estimatedTokens / capacity) * 100 : 0
    };
  }

  function isGenerating() {
    return Boolean(firstVisible(SELECTORS.stop));
  }

  function composer() {
    return firstVisible(SELECTORS.composer);
  }

  function composerText(element = composer()) {
    if (!element) return "";
    if ("value" in element) return normalizeText(element.value);
    return normalizeText(element.innerText || element.textContent || "");
  }

  function enabledSendButton() {
    const button = firstVisible(SELECTORS.send);
    if (!button || button.disabled || button.getAttribute("aria-disabled") === "true") return null;
    return button;
  }

  function newChatControl() {
    const direct = firstVisible(SELECTORS.newChat);
    if (direct) return direct;
    for (const node of document.querySelectorAll?.('a, button') || []) {
      if (!isVisible(node)) continue;
      const label = normalizeText(node.getAttribute?.("aria-label") || node.getAttribute?.("title") || node.textContent || "");
      if (/^new chat$/i.test(label)) return node;
    }
    return null;
  }

  function stopGeneratingBestEffort() {
    const button = firstVisible(SELECTORS.stop);
    if (!button || button.disabled || button.getAttribute("aria-disabled") === "true") return false;
    try { button.click(); return true; } catch { return false; }
  }

  function isBlankConversationSurface() {
    return !conversationInfo() && userCount() === 0 && assistantSnapshot().count === 0 && Boolean(composer());
  }

  async function ensureFreshConversation({ signal, status, requestId = "" }) {
    if (isBlankConversationSurface()) return true;
    await status("Opening a blank new chat");
    const control = newChatControl();
    if (control) {
      try { control.click(); } catch { /* use hard navigation fallback below */ }
      try {
        await waitUntil(() => isBlankConversationSurface() ? true : null, {
          timeoutMs: 15000,
          signal,
          intervalMs: 250,
          onWait: () => status("Waiting for the blank new-chat screen")
        });
        return true;
      } catch (error) {
        if (error?.name === "AbortError") throw error;
      }
    }

    const url = new URL("/", location.origin || "https://chatgpt.com");
    url.searchParams.set("autoprompter_fresh", requestId || `${Date.now()}`);
    if (typeof location.replace === "function") location.replace(url.href);
    else location.href = url.href;
    return false;
  }

  function conversationInfo(value = location.href) {
    try {
      const url = new URL(value, location.href);
      const match = url.pathname.match(/(?:^|\/)c\/([^/?#]+)/);
      return match ? {
        id: decodeURIComponent(match[1]),
        url: `https://chatgpt.com/c/${encodeURIComponent(decodeURIComponent(match[1]))}`
      } : null;
    } catch {
      return null;
    }
  }

  function titleForAnchor(anchor) {
    const explicit = anchor.getAttribute("aria-label") || anchor.getAttribute("title") || "";
    const text = explicit || anchor.innerText || anchor.textContent || "";
    return normalizeText(text).replace(/^(Open conversation|Chat history item)\s*/i, "").slice(0, 160) || "Untitled chat";
  }

  function getChatCatalog() {
    const chats = [];
    const indexes = new Map();
    for (const anchor of document.querySelectorAll('a[href*="/c/"]')) {
      const info = conversationInfo(anchor.href);
      if (!info) continue;
      const title = titleForAnchor(anchor);
      const existingIndex = indexes.get(info.id);
      if (existingIndex == null) {
        indexes.set(info.id, chats.length);
        chats.push({ ...info, title });
      } else if (chats[existingIndex].title === "Untitled chat" && title !== "Untitled chat") {
        chats[existingIndex] = { ...chats[existingIndex], title };
      }
    }

    const current = conversationInfo();
    if (current && !indexes.has(current.id)) {
      const pageTitle = normalizeText(document.title).replace(/\s*[|–-]\s*ChatGPT.*$/i, "");
      chats.unshift({ ...current, title: pageTitle || "Current chat" });
    }
    return chats.map((chat, sidebarIndex) => ({ ...chat, sidebarIndex }));
  }

  function snapshotChanged(before, after) {
    return before.count !== after.count || before.identity !== after.identity || before.signature !== after.signature;
  }

  function matureGuardrail(notice, settings, now = Date.now(), seen = guardrailFirstSeen) {
    if (!notice) return null;
    if (notice.kind !== "stalled") return notice;
    const key = `${notice.kind}:${hashText(notice.message)}`;
    const firstSeen = seen.get(key) ?? now;
    seen.set(key, firstSeen);
    const stallMs = Number(settings?.stallMinutes || 15) * 60 * 1000;
    return now - firstSeen >= stallMs ? notice : null;
  }

  function buildDurableWorkPrompt(settings) {
    if (!settings?.continuityEnabled) return settings.prompt;
    return [
      "Execute the work request below with repository durability enabled.",
      `Repository: ${settings.repository}`,
      `Continuity file: ${settings.handoffFile}`,
      settings.pluginInstruction,
      "Work directly from the repository state. Commit each completed logical unit promptly and push it before starting another risky or lengthy unit.",
      "Update the continuity file whenever meaningful progress, a decision, a blocker, or the next task changes.",
      "Do not leave completed implementation only in chat text. Never commit secrets or private transcript content.",
      "",
      "Work request:",
      settings.prompt
    ].filter(Boolean).join("\n");
  }

  function liveNoticeTexts() {
    const parts = [];
    const conversationSelector = [
      '[data-message-author-role]', '[data-turn="assistant"]', '[data-turn="user"]',
      'article', '[data-testid^="conversation-turn-"]'
    ].join(', ');
    for (const selector of SELECTORS.notices) {
      let nodes = [];
      try { nodes = document.querySelectorAll(selector); } catch { nodes = []; }
      for (const node of nodes) {
        if (!isVisible(node)) continue;
        // Ignore live regions owned by chat turns, the composer, or containers
        // that wrap the conversation. These commonly contain user/assistant prose.
        if (node.closest?.(conversationSelector) || node.closest?.('form')) continue;
        if (node.querySelector?.(conversationSelector) || node.querySelector?.('#prompt-textarea, form')) continue;
        const text = normalizeText(node.innerText || node.textContent || "");
        if (text && text.length <= 2000 && !parts.includes(text)) parts.push(text);
      }
    }
    return parts;
  }

  function detectInterruption(settings, baseline = null) {
    for (const text of liveNoticeTexts()) {
      const notice = matureGuardrail(classifyGuardrailText(text, "notice"), settings);
      if (shouldHandleInterruption(notice, settings)) return notice;
    }

    if (baseline && !isGenerating()) {
      const current = assistantSnapshot();
      const removedTurn = baseline.count > 0 && current.count < baseline.count;
      const collapsedSameTurn = baseline.identity === current.identity &&
        baseline.textLength > 1000 && current.textLength < baseline.textLength * 0.2;
      if (removedTurn || collapsedSameTurn) {
        return {
          kind: "content_removed",
          message: "Previously visible assistant content disappeared before the job completed."
        };
      }
    }
    return null;
  }

  async function waitUntil(predicate, {
    timeoutMs,
    signal,
    onWait,
    intervalMs = POLL_MS,
    checkInterruption = null
  }) {
    const started = Date.now();
    let lastNotice = 0;
    while (Date.now() - started < timeoutMs) {
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      const interruption = checkInterruption?.();
      if (interruption) {
        if (interruption.kind === "connection_interrupted") stopGeneratingBestEffort();
        throw new JobInterruption(interruption.kind, interruption.message);
      }
      const value = await predicate();
      if (value) return value;
      if (onWait && Date.now() - lastNotice > 1500) {
        lastNotice = Date.now();
        await onWait();
      }
      await sleep(intervalMs, signal);
    }
    throw new Error("Timed out waiting for ChatGPT.");
  }

  async function waitForCompletedAssistant({
    signal,
    settings,
    baseline = null,
    requireChange = false,
    timeoutMs = JOB_TIMEOUT_MS,
    status
  }) {
    let last = assistantSnapshot();
    let lastChangedAt = Date.now();
    const stallAwareTimeoutMs = Math.max(
      timeoutMs,
      Math.ceil(Number(settings?.stallMinutes || 0) * 60 * 1000) + 60_000
    );
    return waitUntil(() => {
      const snapshot = assistantSnapshot();
      const generating = isGenerating();
      if (snapshot.signature !== last.signature) {
        last = snapshot;
        lastChangedAt = Date.now();
      }

      const changed = !baseline || snapshotChanged(baseline, snapshot);
      const stable = Date.now() - lastChangedAt >= FALLBACK_STABLE_MS;
      const responseGuardrail = classifyGuardrailText(snapshot.text, "assistant");
      if (responseGuardrail?.kind === "connection_interrupted") {
        stopGeneratingBestEffort();
        throw new JobInterruption(responseGuardrail.kind, responseGuardrail.message);
      }
      if (snapshot.count === 0 || generating || !stable) return null;
      if (requireChange && !changed) return null;

      if (responseGuardrail) {
        const mature = matureGuardrail(responseGuardrail, settings);
        if (shouldHandleInterruption(mature, settings)) {
          if (mature.kind === "connection_interrupted") stopGeneratingBestEffort();
          throw new JobInterruption(mature.kind, mature.message);
        }
        if (responseGuardrail.kind === "stalled") return null;
      }
      return snapshot;
    }, {
      timeoutMs: stallAwareTimeoutMs,
      signal,
      checkInterruption: () => detectInterruption(settings, baseline),
      onWait: () => status(requireChange ? "Waiting for the new response" : "Waiting for a completed response")
    });
  }

  async function waitForEmptyComposer(signal, status, settings, baseline) {
    return waitUntil(() => {
      const target = composer();
      return target && composerText(target) === "" ? target : null;
    }, {
      timeoutMs: COMPOSER_WAIT_MS,
      signal,
      checkInterruption: () => detectInterruption(settings, baseline),
      onWait: () => status("Waiting for an empty composer")
    });
  }

  function dispatchInput(element, text) {
    element.focus();
    if ("value" in element) {
      const prototype = element.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
      if (setter) setter.call(element, text); else element.value = text;
      element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
      element.dispatchEvent(new Event("change", { bubbles: true }));
      return;
    }

    const selection = getSelection();
    const range = document.createRange();
    range.selectNodeContents(element);
    selection.removeAllRanges();
    selection.addRange(range);
    let inserted = false;
    try { inserted = document.execCommand("insertText", false, text); } catch { inserted = false; }
    if (!inserted) {
      element.textContent = text;
      element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
    }
  }

  function clearOwnedComposer(element, owner) {
    if (!element?.isConnected || element.getAttribute(OWNERSHIP_ATTR) !== owner) return;
    if ("value" in element) element.value = ""; else element.textContent = "";
    element.removeAttribute(OWNERSHIP_ATTR);
    element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward" }));
  }

  function buildCheckpointPrompt(settings, phase) {
    return [
      `Repository continuity checkpoint (${phase}). Do not start new project work in this response.`,
      `Repository: ${settings.repository}`,
      `Continuity file: ${settings.handoffFile}`,
      settings.pluginInstruction,
      "Commit every completed, reviewable change that currently exists. Update the continuity file with the goal, completed work, current branch, decisions, blockers, uncommitted work, and exact next steps.",
      "Verify the commit exists remotely before claiming success.",
      `End with exactly one machine-readable line: ${CHECKPOINT_PREFIX} <commit-sha-or-immutable-ref>`,
      "If no action-capable repository tool is available or the commit cannot be verified, end with: AUTOPROMPTER_CHECKPOINT_FAILED: <reason>"
    ].filter(Boolean).join("\n");
  }

  function buildInitializationPrompt(settings) {
    return [
      "Initialize durable repository continuity for this chat. Do not continue unrelated implementation work in this response.",
      `Repository: ${settings.repository}`,
      `Continuity file: ${settings.handoffFile}`,
      settings.pluginInstruction,
      "Read the current conversation goal and inspect the repository before editing files.",
      "Create the continuity file if it does not exist. If it already exists, reconcile and improve it instead of discarding valid state.",
      "Record: original goal, current branch and commit, completed work, changed files, decisions, tests, blockers, unfinished work, and a prioritized next-task checklist.",
      "Commit and push the continuity file and any already-completed reviewable work. Never commit secrets or private transcript content.",
      "Verify the commit exists remotely before claiming success.",
      `End with exactly one machine-readable line: ${CHECKPOINT_PREFIX} <commit-sha-or-immutable-ref>`,
      "If no action-capable repository tool is available or the commit cannot be verified, end with: AUTOPROMPTER_CHECKPOINT_FAILED: <reason>"
    ].filter(Boolean).join("\n");
  }

  function buildHandoffPrompt(settings, reason, metrics) {
    return [
      "Prepare this project for continuation in a new chat. Do not begin new implementation work.",
      `Repository: ${settings.repository}`,
      `Continuity file: ${settings.handoffFile}`,
      `Rollover reason: ${reason}`,
      `Estimated visible context: ${Math.round(metrics.estimatedTokens)} tokens (${metrics.percent.toFixed(1)}% of the configured estimate).`,
      settings.pluginInstruction,
      "Commit all completed work and update the continuity file with: original goal, completed work, current branch and commit, changed files, decisions, tests, blockers, incomplete work, and a prioritized future-work checklist.",
      "Verify the commit exists remotely. The repository is the source of truth for the successor chat.",
      `End with exactly one machine-readable line: ${HANDOFF_PREFIX} <commit-sha-or-immutable-ref>`,
      "If the repository cannot be updated and verified, end with: AUTOPROMPTER_HANDOFF_FAILED: <reason>"
    ].filter(Boolean).join("\n");
  }

  async function submitPrompt({
    prompt,
    signal,
    status,
    settings,
    baseline,
    expectedConversationId,
    allowConversationChange = false,
    delaySeconds = settings.delaySeconds
  }) {
    let target = await waitForEmptyComposer(signal, status, settings, baseline);
    await status(`Delaying ${delaySeconds}s`);
    await sleep(delaySeconds * 1000, signal);

    const currentAfterDelay = conversationInfo();
    if (!allowConversationChange && expectedConversationId && currentAfterDelay?.id !== expectedConversationId) {
      throw new Error("The conversation changed before submission.");
    }
    const interruption = detectInterruption(settings, baseline);
    if (interruption) throw new JobInterruption(interruption.kind, interruption.message);
    if (isGenerating()) throw new Error("ChatGPT started generating before the prompt was submitted.");
    target = await waitForEmptyComposer(signal, status, settings, baseline);

    const owner = `${Date.now()}:${Math.random().toString(36).slice(2)}`;
    target.setAttribute(OWNERSHIP_ATTR, owner);
    dispatchInput(target, prompt);

    try {
      await status("Preparing prompt");
      const button = await waitUntil(() => {
        if (!target.isConnected) throw new Error("The composer was replaced before submission.");
        if (target.getAttribute(OWNERSHIP_ATTR) !== owner || composerText(target) !== normalizeText(prompt)) {
          throw new Error("The prompt was edited before submission; it was not sent.");
        }
        return enabledSendButton();
      }, {
        timeoutMs: 8000,
        signal,
        checkInterruption: () => detectInterruption(settings, baseline)
      });

      const beforeUsers = userCount();
      button.click();
      await status("Submitting prompt");
      await waitUntil(() => {
        const sent = userCount() > beforeUsers || isGenerating() || composerText(target) === "";
        return sent ? true : null;
      }, {
        timeoutMs: 10000,
        signal,
        checkInterruption: () => detectInterruption(settings, baseline)
      });
      target.removeAttribute(OWNERSHIP_ATTR);
    } catch (error) {
      clearOwnedComposer(target, owner);
      throw error;
    }

    await status("Waiting for the new response");
    return waitForCompletedAssistant({
      signal,
      settings,
      baseline,
      requireChange: true,
      timeoutMs: JOB_TIMEOUT_MS,
      status
    });
  }

  async function runCheckpoint({ settings, signal, status, phase, baseline, conversationId }) {
    await status(`Checkpointing ${phase}`);
    const completed = await submitPrompt({
      prompt: buildCheckpointPrompt(settings, phase),
      signal,
      status,
      settings,
      baseline,
      expectedConversationId: conversationId
    });
    if (/AUTOPROMPTER_CHECKPOINT_FAILED:/i.test(completed.text)) {
      throw new Error("The repository checkpoint failed; automation stopped before continuing.");
    }
    const marker = extractCheckpointMarker(completed.text);
    if (!marker) throw new Error("The checkpoint response did not include a verified checkpoint marker.");
    return { marker, completed };
  }

  async function executeJob(message, controller) {
    const signal = controller.signal;
    let checkpoint = String(message.chat.lastCheckpoint || "");
    const status = (value, metrics = null) => runtimeMessage({
      type: "JOB_STATUS",
      token: message.token,
      jobId: message.jobId,
      status: value,
      contextEstimateTokens: metrics?.estimatedTokens,
      contextPercent: metrics?.percent
    });

    try {
      const current = conversationInfo();
      if (!current || current.id !== message.chat.id) throw new Error("The managed tab opened a different conversation.");

      await status("Waiting for completion");
      let baseline = await waitForCompletedAssistant({ signal, settings: message.settings, status });
      let metrics = contextMetrics(message.settings);
      await status(`Context estimate ${metrics.percent.toFixed(1)}%`, metrics);

      if (message.mode === "initialize") {
        if (!message.settings.continuityEnabled || !message.settings.repository) {
          throw new Error("Continuity initialization requires a valid repository for this chat.");
        }
        await status("Initializing continuity file", metrics);
        const initialized = await submitPrompt({
          prompt: buildInitializationPrompt(message.settings),
          signal,
          status,
          settings: message.settings,
          baseline,
          expectedConversationId: message.chat.id
        });
        if (/AUTOPROMPTER_CHECKPOINT_FAILED:/i.test(initialized.text)) {
          throw new Error("Continuity initialization failed; the repository was not verified.");
        }
        checkpoint = extractCheckpointMarker(initialized.text);
        if (!checkpoint) throw new Error("Initialization response did not include a verified checkpoint marker.");
        metrics = contextMetrics(message.settings);
        await runtimeMessage({
          type: "JOB_DONE",
          token: message.token,
          jobId: message.jobId,
          assistantSignature: initialized.signature,
          checkpoint,
          initialized: true,
          contextEstimateTokens: metrics.estimatedTokens,
          contextPercent: metrics.percent
        });
        return;
      }

      if (shouldRolloverContext(
        metrics.estimatedTokens,
        message.settings.contextCapacityTokens,
        message.settings.contextThresholdPercent
      )) {
        if (!message.settings.continuityEnabled) {
          throw new JobInterruption(
            "context_limit",
            `Estimated context reached ${metrics.percent.toFixed(1)}%, but repository continuity is disabled.`
          );
        }
        try {
          if (message.settings.checkpointBeforePrompt) {
            const pre = await runCheckpoint({
              settings: message.settings,
              signal,
              status,
              phase: "before handoff",
              baseline,
              conversationId: message.chat.id
            });
            checkpoint = pre.marker;
            baseline = pre.completed;
          }

          await status("Preparing repository handoff", metrics);
          const handoff = await submitPrompt({
            prompt: buildHandoffPrompt(
              message.settings,
              `Configured context threshold ${message.settings.contextThresholdPercent}% reached`,
              metrics
            ),
            signal,
            status,
            settings: message.settings,
            baseline,
            expectedConversationId: message.chat.id
          });
          if (/AUTOPROMPTER_HANDOFF_FAILED:/i.test(handoff.text)) {
            throw new Error("The repository handoff failed.");
          }
          checkpoint = extractHandoffMarker(handoff.text) || extractCheckpointMarker(handoff.text);
          if (!checkpoint) throw new Error("The handoff response did not include a verified repository marker.");
        } catch (error) {
          if (error instanceof JobInterruption) throw error;
          throw new JobInterruption(
            "context_limit",
            `The context threshold was reached, but a verified repository handoff could not be created: ${error?.message || error}`
          );
        }
        metrics = contextMetrics(message.settings);
        await runtimeMessage({
          type: "JOB_ROLLOVER",
          token: message.token,
          jobId: message.jobId,
          kind: "context_limit",
          reason: `Estimated context reached ${metrics.percent.toFixed(1)}%.`,
          checkpoint,
          contextEstimateTokens: metrics.estimatedTokens,
          contextPercent: metrics.percent
        });
        return;
      }

      if (message.settings.continuityEnabled && message.settings.checkpointBeforePrompt) {
        const pre = await runCheckpoint({
          settings: message.settings,
          signal,
          status,
          phase: "before new work",
          baseline,
          conversationId: message.chat.id
        });
        checkpoint = pre.marker;
        baseline = pre.completed;
      }

      const completed = await submitPrompt({
        prompt: buildDurableWorkPrompt(message.settings),
        signal,
        status,
        settings: message.settings,
        baseline,
        expectedConversationId: message.chat.id
      });
      baseline = completed;

      if (message.settings.continuityEnabled && message.settings.checkpointAfterPrompt) {
        const post = await runCheckpoint({
          settings: message.settings,
          signal,
          status,
          phase: "after completed work",
          baseline,
          conversationId: message.chat.id
        });
        checkpoint = post.marker;
        baseline = post.completed;
      }

      metrics = contextMetrics(message.settings);
      await runtimeMessage({
        type: "JOB_DONE",
        token: message.token,
        jobId: message.jobId,
        assistantSignature: baseline.signature,
        checkpoint,
        contextEstimateTokens: metrics.estimatedTokens,
        contextPercent: metrics.percent
      });
    } catch (error) {
      if (error?.name === "AbortError") return;
      const metrics = contextMetrics(message.settings);
      if (error instanceof JobInterruption) {
        await runtimeMessage({
          type: "JOB_INTERRUPTED",
          token: message.token,
          jobId: message.jobId,
          kind: error.kind,
          message: error.message,
          checkpoint,
          contextEstimateTokens: metrics.estimatedTokens,
          contextPercent: metrics.percent
        });
        return;
      }
      await runtimeMessage({
        type: "JOB_ERROR",
        token: message.token,
        jobId: message.jobId,
        error: error?.message || String(error)
      });
    }
  }

  async function executeSuccessorJob(message, controller) {
    const signal = controller.signal;
    let checkpoint = String(message.checkpoint || "");
    const status = value => runtimeMessage({
      type: "JOB_STATUS",
      token: message.token,
      jobId: message.jobId,
      status: value
    });

    try {
      const ready = await ensureFreshConversation({
        signal,
        status,
        requestId: message.freshRequestId || message.jobId
      });
      if (!ready) return;
      let baseline = assistantSnapshot();
      const completed = await submitPrompt({
        prompt: message.prompt,
        signal,
        status,
        settings: message.settings,
        baseline,
        expectedConversationId: null,
        allowConversationChange: true
      });
      baseline = completed;

      const conversation = await waitUntil(() => {
        const info = conversationInfo();
        if (!info || info.id === message.parentConversationId) return null;
        return info;
      }, {
        timeoutMs: 30000,
        signal,
        checkInterruption: () => detectInterruption(message.settings, baseline),
        onWait: () => status("Waiting for the successor chat URL")
      });

      if (message.settings.continuityEnabled && message.settings.checkpointAfterPrompt) {
        const post = await runCheckpoint({
          settings: message.settings,
          signal,
          status,
          phase: "after successor startup",
          baseline,
          conversationId: conversation.id
        });
        checkpoint = post.marker;
        baseline = post.completed;
      }

      const metrics = contextMetrics(message.settings);
      await runtimeMessage({
        type: "SUCCESSOR_CREATED",
        token: message.token,
        jobId: message.jobId,
        conversation,
        checkpoint,
        assistantSignature: baseline.signature,
        contextEstimateTokens: metrics.estimatedTokens,
        contextPercent: metrics.percent
      });
    } catch (error) {
      if (error?.name === "AbortError") return;
      const metrics = contextMetrics(message.settings);
      if (error instanceof JobInterruption) {
        await runtimeMessage({
          type: "JOB_INTERRUPTED",
          token: message.token,
          jobId: message.jobId,
          kind: error.kind,
          message: error.message,
          checkpoint,
          contextEstimateTokens: metrics.estimatedTokens,
          contextPercent: metrics.percent
        });
        return;
      }
      await runtimeMessage({
        type: "JOB_ERROR",
        token: message.token,
        jobId: message.jobId,
        error: error?.message || String(error)
      });
    }
  }

  function startJob(message) {
    if (activeJob?.jobId === message.jobId) return;
    activeJob?.controller.abort();
    const controller = new AbortController();
    activeJob = { jobId: message.jobId, controller };
    const runner = message.type === "RUN_SUCCESSOR_JOB" ? executeSuccessorJob : executeJob;

    runner(message, controller).finally(() => {
      if (activeJob?.jobId === message.jobId) activeJob = null;
    });
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "GET_CHAT_CATALOG") {
      sendResponse({ ok: true, chats: getChatCatalog() });
      return false;
    }
    if (message?.type === "RUN_CHAT_JOB" || message?.type === "RUN_SUCCESSOR_JOB") {
      startJob(message);
      sendResponse({ ok: true, jobId: message.jobId });
      return false;
    }
    if (message?.type === "CANCEL_CHAT_JOB") {
      activeJob?.controller.abort();
      activeJob = null;
      sendResponse({ ok: true });
      return false;
    }
    return false;
  });

  function announceReady() {
    if (!activeJob) runtimeMessage({ type: "CONTENT_READY", conversation: conversationInfo() });
  }

  announceReady();
  addEventListener("pageshow", announceReady);
  addEventListener("focus", announceReady);
  setInterval(announceReady, READY_HEARTBEAT_MS);

  if (typeof module !== "undefined") {
    module.exports = {
      hashText,
      normalizeText,
      conversationInfo,
      snapshotChanged,
      estimateTokensFromText,
      shouldRolloverContext,
      classifyGuardrailText,
      matureGuardrail,
      shouldHandleInterruption,
      isBlankConversationSurface,
      buildDurableWorkPrompt,
      buildInitializationPrompt,
      extractCheckpointMarker,
      extractHandoffMarker,
      getChatCatalog
    };
  }
})();
