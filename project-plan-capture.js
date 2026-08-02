(() => {
  "use strict";

  if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) return;

  const RUNTIME_SCOPE = "AUTOPROMPTER_RUNTIME";
  const RECOVERY_SCOPE = "AUTOPROMPTER_PROJECT_PLAN_RECOVERY";
  const GET_RECOVERY = "GET_PROJECT_PLANNER_RECOVERY";
  const POLL_MS = 2000;
  const STABLE_MS = 1500;
  const RETRY_MS = 5000;
  const PROPOSAL_BEGIN = "AUTOPROMPTER_PROPOSAL_BEGIN";
  const PROPOSAL_END = "AUTOPROMPTER_PROPOSAL_END";
  const PLAN_BEGIN = "AUTOPROMPTER_PLAN_BEGIN";
  const PLAN_END = "AUTOPROMPTER_PLAN_END";
  let timer = null;
  let checking = false;
  let observed = null;
  const submittedAt = new Map();

  function hashText(value) {
    let hash = 2166136261;
    const text = String(value || "");
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  }

  function conversation() {
    const match = location.pathname.match(/(?:^|\/)c\/([^/?#]+)/);
    if (!match) return null;
    const id = decodeURIComponent(match[1]);
    return { id, url: `https://chatgpt.com/c/${encodeURIComponent(id)}` };
  }

  function assistantNodes() {
    const selectors = [
      '[data-message-author-role="assistant"]',
      'article[data-turn="assistant"]',
      '[data-testid^="conversation-turn-"][data-turn="assistant"]'
    ];
    const nodes = [];
    for (const selector of selectors) {
      for (const match of document.querySelectorAll(selector)) {
        const node = match.closest?.('article[data-turn="assistant"], [data-testid^="conversation-turn-"][data-turn="assistant"]') || match;
        if (!nodes.includes(node)) nodes.push(node);
      }
    }
    return nodes;
  }

  function hasCompleteEnvelope(text) {
    const value = String(text || "");
    return (
      value.includes(PROPOSAL_BEGIN) && value.includes(PROPOSAL_END)
    ) || (
      value.includes(PLAN_BEGIN) && value.includes(PLAN_END)
    );
  }

  function latestPlannerEnvelope() {
    const nodes = assistantNodes();
    for (let index = nodes.length - 1; index >= 0; index -= 1) {
      const node = nodes[index];
      const content = node.querySelector?.('[data-message-content], .markdown, .prose') || node;
      const text = String(content?.innerText || content?.textContent || "").trim();
      if (!hasCompleteEnvelope(text)) continue;
      const identity = node.getAttribute?.("data-turn-id")
        || node.getAttribute?.("data-message-id")
        || node.getAttribute?.("data-testid")
        || `assistant-${index}`;
      return {
        text,
        signature: `${identity}:${text.length}:${hashText(text)}`
      };
    }
    return null;
  }

  async function send(scope, type, extra = {}) {
    try {
      return await chrome.runtime.sendMessage({ scope, type, ...extra });
    } catch {
      return null;
    }
  }

  async function check() {
    if (checking) return;
    checking = true;
    try {
      const state = await send(RECOVERY_SCOPE, GET_RECOVERY);
      const recovery = state?.ok === true ? state.recovery : null;
      if (!recovery) {
        observed = null;
        return;
      }
      const candidate = latestPlannerEnvelope();
      const currentConversation = conversation();
      if (!candidate || !currentConversation) return;

      const key = `${recovery.projectId}:${recovery.jobId}:${recovery.stage}:${candidate.signature}`;
      const now = Date.now();
      if (!observed || observed.key !== key) {
        observed = { key, firstSeenAt: now };
        return;
      }
      if (now - observed.firstSeenAt < STABLE_MS) return;
      if (now - Number(submittedAt.get(key) || 0) < RETRY_MS) return;
      submittedAt.set(key, now);

      await send(RUNTIME_SCOPE, "PROJECT_BOOTSTRAP_RESULT", {
        projectId: recovery.projectId,
        role: "planner",
        stage: recovery.stage,
        jobId: recovery.jobId,
        conversation: currentConversation,
        output: candidate.text,
        assistantSignature: candidate.signature,
        recoveredFromStableDom: true
      });
    } finally {
      checking = false;
    }
  }

  function schedule(delay = 100) {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      check().finally(() => schedule(POLL_MS));
    }, delay);
  }

  const observer = new MutationObserver(() => {
    if (!timer) schedule(250);
  });
  observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  schedule(0);
})();
