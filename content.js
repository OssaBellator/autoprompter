(() => {
  "use strict";

  const MESSAGE_SCOPE = "AUTOPROMPTER_RUNTIME";
  const FALLBACK_STABLE_MS = 2500;
  const POLL_MS = 250;
  const READY_HEARTBEAT_MS = 15000;
  const JOB_TIMEOUT_MS = 12 * 60 * 60 * 1000;
  const ACTIVE_GENERATION_HEARTBEAT_MS = 30 * 1000;
  const STATUS_HEARTBEAT_MS = 15 * 1000;
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
      'button[data-testid="stop-button"]',
      'button[aria-label*="Stop generating"]',
      'button[aria-label*="Stop response"]',
      'button[aria-label*="Stop streaming"]',
      'button[title*="Stop generating"]',
      'button[title*="Stop response"]'
    ],
    voice: [
      'button[data-testid*="voice-mode"]',
      'button[aria-label*="Voice mode"]',
      'button[aria-label*="voice mode"]',
      'button[title*="Voice mode"]',
      'button[title*="voice mode"]'
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
      '[role="status"]',
      '[role="dialog"]',
      '[aria-live="assertive"]',
      '[aria-live="polite"]',
      '[data-testid*="error"]',
      '[data-testid*="warning"]',
      '[data-testid*="retry"]',
      '[class*="error-message"]',
      '[class*="toast"]',
      '[class*="popover"]',
      '[class*="modal"]'
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

    // ChatGPT may display a non-selectable overlay while a request is being
    // moved to a slower reasoning path. Treat the complete platform-shaped
    // notice as a recoverable interruption so the current generation is
    // stopped and the same-chat continuation retry path can take over.
    const extendedThinkingNotice = /^our systems are thinking a bit more about this request before responding\.?\s*you can retry with a faster model for a quicker response,?\s*though it may be less capable of handling complex requests\.?(?:\s*learn more)?$/i;
    if (source === "notice" && extendedThinkingNotice.test(candidate)) {
      return { kind: "connection_interrupted", message: text.slice(-500) };
    }

    // ChatGPT's current maximum-length notice differs from the older
    // "conversation too long" variants. Match the complete platform-shaped
    // sentence, including straight and curly apostrophes. Assistant matching
    // also permits the notice to be appended after a partial response.
    const maximumLengthNotice = /you(?:['’]ve| have) reached the maximum length for this conversation(?:,\s*but you can keep talking by starting a new chat)?\.?$/i;
    if ((source === "notice" && /^you(?:['’]ve| have) reached the maximum length for this conversation(?:,\s*but you can keep talking by starting a new chat)?(?:[.!]|\s|$)/i.test(candidate)) ||
        (source === "assistant" && maximumLengthNotice.test(candidate))) {
      return { kind: "context_limit", message: text.slice(-500) };
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

  function composerControlRoot() {
    const target = composer();
    return target?.closest?.("form") || document;
  }

  function visibleControlByLabel(root, pattern) {
    let controls = [];
    try { controls = root.querySelectorAll?.('button, [role="button"]') || []; } catch { controls = []; }
    for (const control of controls) {
      if (!isVisible(control)) continue;
      const label = normalizeText([
        control.getAttribute?.("aria-label"),
        control.getAttribute?.("title"),
        control.getAttribute?.("data-testid")
      ].filter(Boolean).join(" "));
      if (pattern.test(label)) return control;
    }
    return null;
  }

  function generationControlState() {
    const root = composerControlRoot();
    const voice = firstVisible(SELECTORS.voice, root)
      || visibleControlByLabel(root, /(?:start\s+)?voice\s+mode/i);
    const stop = firstVisible(SELECTORS.stop, root)
      || visibleControlByLabel(root, /stop\s+(?:generating|response|streaming)/i);
    if (voice) return { state: "idle", voice, stop };
    if (stop) return { state: "generating", voice: null, stop };
    return { state: "unknown", voice: null, stop: null };
  }

  function isGenerating() {
    return generationControlState().state === "generating";
  }

  function isComposerIdle() {
    return generationControlState().state === "idle";
  }

  function extractActivityElapsedValues(value) {
    const text = normalizeText(value);
    if (!text) return [];
    const matches = text.match(/(?:^|\s)(?:\d+\s*h\s*)?(?:\d+\s*m\s*)?\d+\s*s(?:$|\s)/gi) || [];
    return [...new Set(matches.map(item => normalizeText(item)).filter(Boolean))];
  }

  function activityProgressSnapshot() {
    const values = [];
    const selectors = [
      'time', '[data-testid*="elapsed"]', '[aria-label*="elapsed"]',
      '[aria-label*="Activity"] time', '[data-testid*="activity"] time',
      'aside time', '[role="dialog"] time',
      '[aria-label*="Activity"] span', '[data-testid*="activity"] span',
      'aside span', '[role="dialog"] span'
    ];
    for (const selector of selectors) {
      let nodes = [];
      try { nodes = document.querySelectorAll(selector); } catch { nodes = []; }
      for (const node of nodes) {
        if (!isVisible(node)) continue;
        const text = accessibleNodeText(node);
        for (const value of extractActivityElapsedValues(text)) if (!values.includes(value)) values.push(value);
      }
    }
    values.sort();
    return { values, signature: values.join("|") };
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

  function selectorHealth() {
    const controls = generationControlState();
    const checks = {
      composer: Boolean(composer()),
      send: Boolean(enabledSendButton() || firstVisible(SELECTORS.send)),
      stop: controls.state === "generating",
      voice: controls.state === "idle",
      newChat: Boolean(newChatControl()),
      conversation: Boolean(conversationInfo()),
      notices: Boolean(firstVisible(SELECTORS.notices))
    };
    const required = [checks.composer, checks.newChat];
    const status = required.every(Boolean) ? "healthy" : required.some(Boolean) ? "degraded" : "failed";
    return {
      ok: status !== "failed",
      status,
      checkedAt: new Date().toISOString(),
      conversation: conversationInfo(),
      checks,
      selectorCounts: Object.fromEntries(Object.entries(SELECTORS).map(([key, selectors]) => [key, selectors.length]))
    };
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

  function accessibleNodeText(node) {
    if (!node) return "";
    const attributes = ["aria-label", "title", "data-tooltip-content", "data-message"]
      .map(name => node.getAttribute?.(name) || "")
      .filter(Boolean);
    return normalizeText([node.innerText || "", node.textContent || "", ...attributes].join(" "));
  }

  function liveNoticeTexts() {
    const parts = [];
    const conversationSelector = [
      '[data-message-author-role]', '[data-turn="assistant"]', '[data-turn="user"]',
      'article', '[data-testid^="conversation-turn-"]'
    ].join(', ');
    const addNode = node => {
      if (!isVisible(node)) return;
      // Ignore live regions owned by chat turns, the composer, or containers
      // that wrap the conversation. These commonly contain user/assistant prose.
      if (node.closest?.(conversationSelector) || node.closest?.('form')) return;
      if (node.querySelector?.(conversationSelector) || node.querySelector?.('#prompt-textarea, form')) return;
      const text = accessibleNodeText(node);
      if (text && text.length <= 2000 && !parts.includes(text)) parts.push(text);
    };

    for (const selector of SELECTORS.notices) {
      let nodes = [];
      try { nodes = document.querySelectorAll(selector); } catch { nodes = []; }
      for (const node of nodes) addNode(node);
    }

    // The extended-thinking notice can be rendered in an ordinary popover with
    // user selection disabled and without role=alert. Its retry control remains
    // accessible, so use that control as an anchor and inspect a small ancestor
    // chain rather than scanning the whole page or conversation transcript.
    let controls = [];
    try { controls = document.querySelectorAll('a, button, [role="button"], [role="link"]'); } catch { controls = []; }
    for (const control of controls) {
      const label = accessibleNodeText(control);
      if (!/retry with a faster model/i.test(label)) continue;
      let node = control;
      for (let depth = 0; node && depth < 6; depth += 1, node = node.parentElement) addNode(node);
    }
    return parts;
  }

  function detectInterruption(settings, baseline = null, { allowStalled = true } = {}) {
    for (const text of liveNoticeTexts()) {
      const classified = classifyGuardrailText(text, "notice");
      if (!allowStalled && classified?.kind === "stalled") continue;
      const notice = matureGuardrail(classified, settings);
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

  function assistantCompletionReady({ snapshot, baseline, requireChange, lastChangedAt, now = Date.now(), controlState }) {
    const changed = !baseline || snapshotChanged(baseline, snapshot);
    const stable = now - lastChangedAt >= FALLBACK_STABLE_MS;
    return Boolean(snapshot.count > 0 && stable && changed && controlState !== "generating" && (!requireChange || changed));
  }

  async function waitForCompletedAssistant({
    signal,
    settings,
    baseline = null,
    requireChange = false,
    timeoutMs = JOB_TIMEOUT_MS,
    status
  }) {
    const startedAt = Date.now();
    const hardTimeoutMs = Math.max(timeoutMs, JOB_TIMEOUT_MS);
    const inactivityMs = Math.max(60_000, Number(settings?.stallMinutes || 15) * 60 * 1000);
    let last = assistantSnapshot();
    let lastChangedAt = Date.now();
    let lastProgressAt = Date.now();
    let lastActiveHeartbeatAt = 0;
    let lastStatusAt = 0;
    let lastControlState = generationControlState().state;
    let lastActivity = activityProgressSnapshot();

    while (Date.now() - startedAt < hardTimeoutMs) {
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      const now = Date.now();
      const snapshot = assistantSnapshot();
      const controls = generationControlState();
      const activity = activityProgressSnapshot();

      if (snapshot.signature !== last.signature) {
        last = snapshot;
        lastChangedAt = now;
        lastProgressAt = now;
      }
      if (activity.signature !== lastActivity.signature) {
        lastActivity = activity;
        lastProgressAt = now;
      }
      if (controls.state !== lastControlState) {
        lastControlState = controls.state;
        lastProgressAt = now;
      }
      if (controls.state === "generating" && now - lastActiveHeartbeatAt >= ACTIVE_GENERATION_HEARTBEAT_MS) {
        lastActiveHeartbeatAt = now;
        lastProgressAt = now;
      }

      const interruption = detectInterruption(settings, baseline, { allowStalled: false });
      if (interruption) {
        if (interruption.kind === "connection_interrupted") stopGeneratingBestEffort();
        throw new JobInterruption(interruption.kind, interruption.message);
      }

      const responseGuardrail = classifyGuardrailText(snapshot.text, "assistant");
      if (responseGuardrail?.kind === "connection_interrupted") {
        stopGeneratingBestEffort();
        throw new JobInterruption(responseGuardrail.kind, responseGuardrail.message);
      }
      if (responseGuardrail && responseGuardrail.kind !== "stalled") {
        const mature = matureGuardrail(responseGuardrail, settings);
        if (shouldHandleInterruption(mature, settings)) throw new JobInterruption(mature.kind, mature.message);
      }

      if (assistantCompletionReady({ snapshot, baseline, requireChange, lastChangedAt, now, controlState: controls.state })) {
        return snapshot;
      }

      if (controls.state !== "generating" && now - lastProgressAt >= inactivityMs) {
        throw new JobInterruption(
          "stalled",
          `No assistant, activity-timer, or composer-control progress was observed for ${Math.round(inactivityMs / 60000)} minutes.`
        );
      }

      if (status && now - lastStatusAt >= STATUS_HEARTBEAT_MS) {
        lastStatusAt = now;
        const elapsed = activity.values.at(-1);
        const label = requireChange ? "Waiting for the new response" : "Waiting for a completed response";
        await status(elapsed ? `${label} · activity ${elapsed}` : label);
      }
      await sleep(POLL_MS, signal);
    }
    throw new Error("Timed out waiting for ChatGPT after the maximum 12-hour job window.");
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

  function submissionObserved(target, beforeUsers) {
    return userCount() > beforeUsers || isGenerating() || composerText(target) === "";
  }

  function submitWithFallback(target) {
    const form = target.closest?.("form");
    if (form && typeof form.requestSubmit === "function") {
      form.requestSubmit();
      return "form";
    }
    for (const type of ["keydown", "keypress", "keyup"]) {
      target.dispatchEvent(new KeyboardEvent(type, {
        key: "Enter",
        code: "Enter",
        bubbles: true,
        cancelable: true
      }));
    }
    return "keyboard";
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
    const delayMs = Math.max(0, Number(delaySeconds || 0) * 1000);
    if (delayMs > 0) {
      await status(`Delaying ${Number(delaySeconds)}s`);
      await sleep(delayMs, signal);
    }

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
      const validateOwnership = () => {
        if (!target.isConnected) throw new Error("The composer was replaced before submission.");
        if (target.getAttribute(OWNERSHIP_ATTR) !== owner || composerText(target) !== normalizeText(prompt)) {
          throw new Error("The prompt was edited before submission; it was not sent.");
        }
      };

      const beforeUsers = userCount();
      try {
        const button = await waitUntil(() => {
          validateOwnership();
          return enabledSendButton();
        }, {
          timeoutMs: 3000,
          signal,
          checkInterruption: () => detectInterruption(settings, baseline)
        });
        button.click();
      } catch (error) {
        if (error?.name === "AbortError" || error instanceof JobInterruption || !/Timed out waiting for ChatGPT/.test(error?.message || "")) {
          throw error;
        }
        validateOwnership();
        const method = submitWithFallback(target);
        await status(`Submitting prompt with ${method} fallback`);
      }

      await status("Submitting prompt");
      await waitUntil(() => submissionObserved(target, beforeUsers) ? true : null, {
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


  async function executeProjectTask(message, controller) {
    const signal = controller.signal;
    const status = value => runtimeMessage({
      type: "PROJECT_TASK_STATUS",
      projectId: message.projectId,
      dispatchId: message.dispatchId,
      status: value
    });
    try {
      const current = conversationInfo();
      if (!current || current.id !== message.workerChatId) throw new Error("The managed tab opened a different worker conversation.");
      await status("Waiting for the assigned worker chat");
      let baseline = await waitForCompletedAssistant({ signal, settings: message.settings, status });
      let retries = 0;
      let taskPrompt = message.prompt;
      while (true) {
        try {
          const completed = await submitPrompt({
            prompt: taskPrompt,
            signal,
            status,
            settings: message.settings,
            baseline,
            expectedConversationId: message.workerChatId,
            delaySeconds: 0
          });
          const response = await runtimeMessage({
            type: "PROJECT_TASK_RESULT",
            projectId: message.projectId,
            dispatchId: message.dispatchId,
            output: completed.text,
            assistantSignature: completed.signature
          });
          if (!response || response.ok === false) throw new Error(response?.error || "Project task result could not be recorded.");
          return;
        } catch (error) {
          if (!(error instanceof JobInterruption) || error.kind !== "connection_interrupted" || retries >= 3) throw error;
          retries += 1;
          stopGeneratingBestEffort();
          taskPrompt = "Continue from where the response was interrupted. Do not repeat completed material. When finished, return the complete required task result envelope again with no prose outside it.";
          await status(`Connection interrupted; retrying task continuation (${retries}/3)`);
          baseline = await waitForCompletedAssistant({ signal, settings: message.settings, status });
        }
      }
    } catch (error) {
      if (error?.name === "AbortError") return;
      if (error instanceof JobInterruption) {
        await runtimeMessage({
          type: "PROJECT_TASK_INTERRUPTED",
          projectId: message.projectId,
          dispatchId: message.dispatchId,
          kind: error.kind,
          error: error.message
        });
        return;
      }
      await runtimeMessage({
        type: "PROJECT_TASK_ERROR",
        projectId: message.projectId,
        dispatchId: message.dispatchId,
        error: error?.message || String(error)
      });
    }
  }

  async function executeProjectSuccessorTask(message, controller) {
    const signal = controller.signal;
    const status = value => runtimeMessage({
      type: "PROJECT_TASK_STATUS",
      projectId: message.projectId,
      dispatchId: message.dispatchId,
      status: value
    });
    try {
      const ready = await ensureFreshConversation({ signal, status, requestId: message.freshRequestId || message.dispatchId });
      if (!ready) return;
      let baseline = assistantSnapshot();
      const completed = await submitPrompt({
        prompt: message.prompt,
        signal,
        status,
        settings: message.settings,
        baseline,
        expectedConversationId: null,
        allowConversationChange: true,
        delaySeconds: 0
      });
      const conversation = await waitUntil(() => {
        const info = conversationInfo();
        return info && info.id !== message.parentConversationId ? info : null;
      }, {
        timeoutMs: 30000,
        signal,
        checkInterruption: () => detectInterruption(message.settings, completed),
        onWait: () => status("Waiting for the Project Mode successor chat URL")
      });
      const response = await runtimeMessage({
        type: "PROJECT_SUCCESSOR_TASK_RESULT",
        projectId: message.projectId,
        dispatchId: message.dispatchId,
        conversation,
        output: completed.text,
        assistantSignature: completed.signature
      });
      if (!response || response.ok === false) throw new Error(response?.error || "Project successor result could not be recorded.");
    } catch (error) {
      if (error?.name === "AbortError") return;
      if (error instanceof JobInterruption) {
        await runtimeMessage({
          type: "PROJECT_TASK_INTERRUPTED",
          projectId: message.projectId,
          dispatchId: message.dispatchId,
          kind: error.kind,
          error: error.message
        });
        return;
      }
      await runtimeMessage({
        type: "PROJECT_TASK_ERROR",
        projectId: message.projectId,
        dispatchId: message.dispatchId,
        error: error?.message || String(error)
      });
    }
  }


  async function executeProjectBootstrapJob(message, controller) {
    const signal = controller.signal;
    const status = value => runtimeMessage({
      type: "PROJECT_BOOTSTRAP_STATUS",
      projectId: message.projectId,
      role: message.role,
      stage: message.stage,
      jobId: message.jobId,
      status: value
    });
    try {
      let baseline;
      if (message.expectedConversationId) {
        const current = conversationInfo();
        if (!current || current.id !== message.expectedConversationId) {
          throw new Error(`The managed ${message.role} tab opened a different conversation.`);
        }
        baseline = await waitForCompletedAssistant({ signal, settings: message.settings, status });
      } else {
        const ready = await ensureFreshConversation({ signal, status, requestId: message.freshRequestId || message.jobId });
        if (!ready) return;
        baseline = assistantSnapshot();
      }
      const completed = await submitPrompt({
        prompt: message.prompt,
        signal,
        status,
        settings: message.settings,
        baseline,
        expectedConversationId: message.expectedConversationId || null,
        allowConversationChange: !message.expectedConversationId,
        delaySeconds: 0
      });
      const conversation = message.expectedConversationId
        ? conversationInfo()
        : await waitUntil(() => conversationInfo(), {
            timeoutMs: 30000,
            signal,
            checkInterruption: () => detectInterruption(message.settings, completed),
            onWait: () => status(`Waiting for the ${message.role} conversation URL`)
          });
      const response = await runtimeMessage({
        type: "PROJECT_BOOTSTRAP_RESULT",
        projectId: message.projectId,
        role: message.role,
        stage: message.stage,
        jobId: message.jobId,
        conversation,
        output: completed.text,
        assistantSignature: completed.signature
      });
      if (!response || response.ok === false) throw new Error(response?.error || "Project bootstrap result could not be recorded.");
    } catch (error) {
      if (error?.name === "AbortError") return;
      await runtimeMessage({
        type: "PROJECT_BOOTSTRAP_ERROR",
        projectId: message.projectId,
        role: message.role,
        stage: message.stage,
        jobId: message.jobId,
        kind: error instanceof JobInterruption ? error.kind : "runtime_error",
        error: error?.message || String(error)
      });
    }
  }

  function startJob(message) {
    if (activeJob?.jobId === message.jobId) return;
    activeJob?.controller.abort();
    const controller = new AbortController();
    activeJob = { jobId: message.jobId, controller };
    const runner = message.type === "RUN_SUCCESSOR_JOB"
      ? executeSuccessorJob
      : message.type === "RUN_PROJECT_BOOTSTRAP_JOB"
        ? executeProjectBootstrapJob
        : message.type === "RUN_PROJECT_SUCCESSOR_TASK"
        ? executeProjectSuccessorTask
        : message.type === "RUN_PROJECT_TASK"
          ? executeProjectTask
          : executeJob;

    runner(message, controller).finally(() => {
      if (activeJob?.jobId === message.jobId) activeJob = null;
    });
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "GET_CHAT_CATALOG") {
      sendResponse({ ok: true, chats: getChatCatalog() });
      return false;
    }
    if (message?.type === "GET_SELECTOR_HEALTH") {
      sendResponse(selectorHealth());
      return false;
    }
    if (message?.type === "RUN_CHAT_JOB" || message?.type === "RUN_SUCCESSOR_JOB" || message?.type === "RUN_PROJECT_TASK" || message?.type === "RUN_PROJECT_SUCCESSOR_TASK" || message?.type === "RUN_PROJECT_BOOTSTRAP_JOB") {
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
      accessibleNodeText,
      liveNoticeTexts,
      generationControlState,
      isComposerIdle,
      extractActivityElapsedValues,
      activityProgressSnapshot,
      assistantCompletionReady,
      isBlankConversationSurface,
      buildDurableWorkPrompt,
      buildInitializationPrompt,
      extractCheckpointMarker,
      extractHandoffMarker,
      getChatCatalog,
      submissionObserved,
      submitWithFallback
    };
  }
})();
