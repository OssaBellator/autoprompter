(() => {
  "use strict";

  const SCOPE = "AUTOPROMPTER_SELF_REPAIR";
  const POLL_MS = 300;
  const STABLE_MS = 3000;
  const TIMEOUT_MS = 90 * 60 * 1000;
  const READY_INTERVAL_MS = 15000;
  const SELECTORS = Object.freeze({
    composer: [
      "#prompt-textarea",
      'div#prompt-textarea[contenteditable="true"]',
      'textarea[name="prompt-textarea"]',
      'textarea[data-id="root"]',
      'form [contenteditable="true"][role="textbox"]',
      'form [contenteditable="true"][data-lexical-editor="true"]',
      '[data-testid*="composer"] [contenteditable="true"]'
    ],
    send: [
      'button[data-testid="send-button"]',
      'button[aria-label="Send prompt"]',
      'button[aria-label="Send"]',
      'button[title="Send"]',
      'button[data-testid*="send"]',
      'button[type="submit"]'
    ],
    stop: [
      'button[data-testid="stop-button"]',
      'button[aria-label*="Stop generating"]',
      'button[aria-label*="Stop response"]',
      'button[title*="Stop generating"]'
    ],
    assistant: [
      '[data-message-author-role="assistant"]',
      '[data-turn="assistant"]',
      'article[data-turn="assistant"]',
      '[data-testid^="conversation-turn-"][data-turn="assistant"]'
    ]
  });
  let activeJob = null;

  function message(payload) {
    return chrome.runtime.sendMessage({ scope: SCOPE, ...payload }).catch(() => null);
  }

  function normalizeText(value) {
    return String(value || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
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

  function visible(element) {
    if (!element?.isConnected) return false;
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
  }

  function firstVisible(selectors) {
    for (const selector of selectors) {
      let nodes = [];
      try { nodes = document.querySelectorAll(selector); } catch { nodes = []; }
      for (const node of nodes) if (visible(node)) return node;
    }
    return null;
  }

  function composer() {
    return firstVisible(SELECTORS.composer);
  }

  function composerText(element = composer()) {
    if (!element) return "";
    return normalizeText("value" in element ? element.value : element.innerText || element.textContent || "");
  }

  function assistantNodes() {
    const result = [];
    for (const selector of SELECTORS.assistant) {
      let nodes = [];
      try { nodes = document.querySelectorAll(selector); } catch { nodes = []; }
      for (const node of nodes) {
        const turn = node.closest?.('article[data-turn="assistant"], [data-testid^="conversation-turn-"][data-turn="assistant"]') || node;
        if (!result.includes(turn)) result.push(turn);
      }
    }
    return result;
  }

  function assistantSnapshot() {
    const nodes = assistantNodes();
    const last = nodes[nodes.length - 1] || null;
    const content = last?.querySelector?.('[data-message-content], .markdown, .prose') || last;
    const text = normalizeText(content?.innerText || content?.textContent || "");
    const identity = last?.getAttribute?.("data-turn-id")
      || last?.getAttribute?.("data-message-id")
      || last?.getAttribute?.("data-testid")
      || `assistant-${Math.max(0, nodes.length - 1)}`;
    return { count: nodes.length, identity, text, signature: `${nodes.length}:${identity}:${text.length}:${hashText(text)}` };
  }

  function hashText(value) {
    let hash = 2166136261;
    const source = String(value || "");
    for (let index = 0; index < source.length; index += 1) {
      hash ^= source.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  }

  function conversationInfo() {
    try {
      const url = new URL(location.href);
      const match = url.pathname.match(/(?:^|\/)c\/([^/?#]+)/);
      if (!match) return null;
      const id = decodeURIComponent(match[1]);
      return { id, url: `https://chatgpt.com/c/${encodeURIComponent(id)}` };
    } catch {
      return null;
    }
  }

  function isGenerating() {
    return Boolean(firstVisible(SELECTORS.stop));
  }

  function fillComposer(target, prompt) {
    target.focus();
    if ("value" in target) {
      const prototype = target.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
      if (setter) setter.call(target, prompt); else target.value = prompt;
      target.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: prompt }));
      target.dispatchEvent(new Event("change", { bubbles: true }));
      return;
    }
    const selection = getSelection();
    const range = document.createRange();
    range.selectNodeContents(target);
    selection.removeAllRanges();
    selection.addRange(range);
    let inserted = false;
    try { inserted = document.execCommand("insertText", false, prompt); } catch { inserted = false; }
    if (!inserted) {
      target.textContent = prompt;
      target.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: prompt }));
    }
  }

  async function waitFor(predicate, timeoutMs, signal, status = null) {
    const started = Date.now();
    let lastStatus = 0;
    while (Date.now() - started < timeoutMs) {
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      const value = await predicate();
      if (value) return value;
      if (status && Date.now() - lastStatus > 5000) {
        lastStatus = Date.now();
        await status();
      }
      await sleep(POLL_MS, signal);
    }
    throw new Error("Timed out waiting for the temporary ChatGPT repair conversation.");
  }

  async function waitForCompletedResponse(baseline, signal, status) {
    const started = Date.now();
    let last = assistantSnapshot();
    let changedAt = Date.now();
    let lastStatus = 0;
    while (Date.now() - started < TIMEOUT_MS) {
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      const snapshot = assistantSnapshot();
      if (snapshot.signature !== last.signature) {
        last = snapshot;
        changedAt = Date.now();
      }
      const changed = snapshot.signature !== baseline.signature;
      if (changed && snapshot.text && !isGenerating() && Date.now() - changedAt >= STABLE_MS) return snapshot;
      if (Date.now() - lastStatus > 15000) {
        lastStatus = Date.now();
        await status(isGenerating() ? "Repair chat is working" : "Waiting for the repair result envelope");
      }
      await sleep(POLL_MS, signal);
    }
    throw new Error("The temporary repair chat exceeded the 90-minute safety timeout.");
  }

  async function submitPrompt(prompt, signal, status) {
    const baseline = assistantSnapshot();
    const target = await waitFor(
      () => {
        const current = composer();
        return current && !composerText(current) && !isGenerating() ? current : null;
      },
      10 * 60 * 1000,
      signal,
      () => status("Waiting for an empty repair-chat composer")
    );
    fillComposer(target, prompt);
    await sleep(200, signal);
    if (composerText(composer()) !== normalizeText(prompt)) throw new Error("The repair prompt was not preserved in the ChatGPT composer.");
    const button = firstVisible(SELECTORS.send);
    if (button && !button.disabled) {
      button.click();
    } else {
      const form = target.closest?.("form");
      if (form?.requestSubmit) form.requestSubmit();
      else target.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true }));
    }
    await status("Submitted the sanitized failure report");
    await waitFor(() => isGenerating() || composerText(composer()) === "" ? true : null, 15000, signal);
    return waitForCompletedResponse(baseline, signal, status);
  }

  async function executeRepair(messageValue, controller) {
    const signal = controller.signal;
    const status = value => message({ type: "SELF_REPAIR_STATUS", jobId: messageValue.jobId, status: value });
    try {
      await status("Opening temporary repair chat");
      await waitFor(() => composer(), 10 * 60 * 1000, signal, () => status("Waiting for ChatGPT page readiness"));
      const completed = await submitPrompt(messageValue.prompt, signal, status);
      const conversation = await waitFor(() => conversationInfo(), 30000, signal, () => status("Waiting for the repair chat URL"));
      await message({
        type: "SELF_REPAIR_RESULT",
        jobId: messageValue.jobId,
        conversation,
        output: completed.text,
        assistantSignature: completed.signature
      });
    } catch (error) {
      if (error?.name === "AbortError") return;
      await message({
        type: "SELF_REPAIR_ERROR",
        jobId: messageValue.jobId,
        error: error?.message || String(error)
      });
    }
  }

  function startRepair(messageValue) {
    if (activeJob?.jobId === messageValue.jobId) return;
    activeJob?.controller.abort();
    const controller = new AbortController();
    activeJob = { jobId: messageValue.jobId, controller };
    executeRepair(messageValue, controller).finally(() => {
      if (activeJob?.jobId === messageValue.jobId) activeJob = null;
    });
  }

  chrome.runtime.onMessage.addListener((messageValue, _sender, sendResponse) => {
    if (messageValue?.type !== "RUN_SELF_REPAIR_JOB") return false;
    startRepair(messageValue);
    sendResponse({ ok: true, jobId: messageValue.jobId });
    return false;
  });

  function announceReady() {
    if (!activeJob) message({ type: "SELF_REPAIR_CONTENT_READY", conversation: conversationInfo() });
  }

  addEventListener("error", event => {
    message({
      type: "SELF_REPAIR_DIAGNOSTIC",
      report: {
        source: "content_error",
        kind: "uncaught_error",
        message: event?.message || "Uncaught AutoPrompter content-script error",
        stack: event?.error?.stack || "",
        diagnostics: { status: "content script" }
      }
    });
  });

  addEventListener("unhandledrejection", event => {
    message({
      type: "SELF_REPAIR_DIAGNOSTIC",
      report: {
        source: "content_rejection",
        kind: "unhandled_rejection",
        message: event?.reason?.message || event?.reason || "Unhandled AutoPrompter content-script rejection",
        stack: event?.reason?.stack || "",
        diagnostics: { status: "content script" }
      }
    });
  });

  announceReady();
  addEventListener("pageshow", announceReady);
  addEventListener("focus", announceReady);
  setInterval(announceReady, READY_INTERVAL_MS);
})();
