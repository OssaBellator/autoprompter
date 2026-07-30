(() => {
  "use strict";

  const MESSAGE_SCOPE = "AUTOPROMPTER_RUNTIME";
  const FALLBACK_STABLE_MS = 2500;
  const POLL_MS = 250;
  const READY_HEARTBEAT_MS = 15000;
  const JOB_TIMEOUT_MS = 30 * 60 * 1000;
  const COMPOSER_WAIT_MS = 10 * 60 * 1000;
  const OWNERSHIP_ATTR = "data-autoprompter-owner";

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
    ]
  });

  let activeJob = null;

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

  function isVisible(element) {
    if (!element?.isConnected) return false;
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
      textLength: text.length,
      signature: `${nodes.length}:${identity}:${text.length}:${hashText(text)}`
    };
  }

  function userCount() {
    return uniqueRoleNodes(SELECTORS.user, "user").length;
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

  function conversationInfo(value = location.href) {
    try {
      const url = new URL(value, location.href);
      const match = url.pathname.match(/(?:^|\/)c\/([^/?#]+)/);
      return match ? { id: decodeURIComponent(match[1]), url: `https://chatgpt.com/c/${encodeURIComponent(decodeURIComponent(match[1]))}` } : null;
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
    const chats = new Map();
    for (const anchor of document.querySelectorAll('a[href*="/c/"]')) {
      const info = conversationInfo(anchor.href);
      if (!info) continue;
      const title = titleForAnchor(anchor);
      const current = chats.get(info.id);
      if (!current || current.title === "Untitled chat") chats.set(info.id, { ...info, title });
    }

    const current = conversationInfo();
    if (current && !chats.has(current.id)) {
      const pageTitle = normalizeText(document.title).replace(/\s*[|–-]\s*ChatGPT.*$/i, "");
      chats.set(current.id, { ...current, title: pageTitle || "Current chat" });
    }
    return [...chats.values()].sort((left, right) => left.title.localeCompare(right.title));
  }

  function snapshotChanged(before, after) {
    return before.count !== after.count || before.identity !== after.identity || before.signature !== after.signature;
  }

  async function waitUntil(predicate, { timeoutMs, signal, onWait, intervalMs = POLL_MS }) {
    const started = Date.now();
    let lastNotice = 0;
    while (Date.now() - started < timeoutMs) {
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
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

  async function waitForCompletedAssistant({ signal, baseline = null, requireChange = false, timeoutMs = JOB_TIMEOUT_MS, status }) {
    let last = assistantSnapshot();
    let lastChangedAt = Date.now();
    return waitUntil(() => {
      const snapshot = assistantSnapshot();
      const generating = isGenerating();
      if (snapshot.signature !== last.signature) {
        last = snapshot;
        lastChangedAt = Date.now();
      }

      const changed = !baseline || snapshotChanged(baseline, snapshot);
      const stable = Date.now() - lastChangedAt >= FALLBACK_STABLE_MS;
      if (snapshot.count === 0 || generating || !stable) return null;
      if (requireChange && !changed) return null;
      return snapshot;
    }, {
      timeoutMs,
      signal,
      onWait: () => status(requireChange ? "Waiting for the new response" : "Waiting for a completed response")
    });
  }

  async function waitForEmptyComposer(signal, status) {
    return waitUntil(() => {
      const target = composer();
      return target && composerText(target) === "" ? target : null;
    }, {
      timeoutMs: COMPOSER_WAIT_MS,
      signal,
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

  async function executeJob(message, controller) {
    const signal = controller.signal;
    const status = value => runtimeMessage({
      type: "JOB_STATUS",
      token: message.token,
      jobId: message.jobId,
      status: value
    });
    const current = conversationInfo();
    if (!current || current.id !== message.chat.id) throw new Error("The managed tab opened a different conversation.");

    await status("Waiting for completion");
    const baseline = await waitForCompletedAssistant({ signal, status });
    let target = await waitForEmptyComposer(signal, status);

    await status(`Delaying ${message.settings.delaySeconds}s`);
    await sleep(message.settings.delaySeconds * 1000, signal);

    const currentAfterDelay = conversationInfo();
    if (!currentAfterDelay || currentAfterDelay.id !== message.chat.id) throw new Error("The conversation changed before submission.");
    if (isGenerating()) throw new Error("ChatGPT started generating before the prompt was submitted.");
    target = await waitForEmptyComposer(signal, status);

    const owner = `${message.jobId}:${Math.random().toString(36).slice(2)}`;
    target.setAttribute(OWNERSHIP_ATTR, owner);
    dispatchInput(target, message.settings.prompt);

    try {
      await status("Preparing prompt");
      const button = await waitUntil(() => {
        if (!target.isConnected) throw new Error("The composer was replaced before submission.");
        if (target.getAttribute(OWNERSHIP_ATTR) !== owner || composerText(target) !== normalizeText(message.settings.prompt)) {
          throw new Error("The prompt was edited before submission; it was not sent.");
        }
        return enabledSendButton();
      }, { timeoutMs: 8000, signal });

      const beforeUsers = userCount();
      button.click();
      await status("Submitting prompt");
      await waitUntil(() => {
        const sent = userCount() > beforeUsers || isGenerating() || composerText(target) === "";
        return sent ? true : null;
      }, { timeoutMs: 10000, signal });
      target.removeAttribute(OWNERSHIP_ATTR);
    } catch (error) {
      clearOwnedComposer(target, owner);
      throw error;
    }

    await status("Waiting for the new response");
    const completed = await waitForCompletedAssistant({
      signal,
      baseline,
      requireChange: true,
      timeoutMs: JOB_TIMEOUT_MS,
      status
    });
    await runtimeMessage({
      type: "JOB_DONE",
      token: message.token,
      jobId: message.jobId,
      assistantSignature: completed.signature
    });
  }

  function startJob(message) {
    if (activeJob?.jobId === message.jobId) return;
    activeJob?.controller.abort();
    const controller = new AbortController();
    activeJob = { jobId: message.jobId, controller };

    executeJob(message, controller)
      .catch(async error => {
        if (error?.name === "AbortError") return;
        await runtimeMessage({
          type: "JOB_ERROR",
          token: message.token,
          jobId: message.jobId,
          error: error?.message || String(error)
        });
      })
      .finally(() => {
        if (activeJob?.jobId === message.jobId) activeJob = null;
      });
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "GET_CHAT_CATALOG") {
      sendResponse({ ok: true, chats: getChatCatalog() });
      return false;
    }
    if (message?.type === "RUN_CHAT_JOB") {
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
      snapshotChanged
    };
  }
})();
