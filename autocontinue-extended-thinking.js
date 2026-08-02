"use strict";

(function attachExtendedThinkingRecovery(root, factory) {
  const api = factory(root);
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.AutoPrompterExtendedThinkingRecovery = api;
})(typeof globalThis !== "undefined" ? globalThis : self, root => {
  const MAX_SAME_CHAT_REPEATS = 3;
  const NOTICE = /^our systems are thinking a bit more about this request before responding\.?\s*you can retry with a faster model for a quicker response,?\s*though it may be less capable of handling complex requests\.?(?:\s*learn more)?$/i;
  let installed = false;

  function normalize(value) {
    return String(value || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
  }

  function isExtendedThinkingNotice(value) {
    return NOTICE.test(normalize(value).replace(/^(?:error|warning|notice)\s*[:–—-]\s*/i, ""));
  }

  function nextAction(currentCount) {
    const count = Math.max(0, Number(currentCount) || 0) + 1;
    return {
      count,
      action: count > MAX_SAME_CHAT_REPEATS ? "new_chat" : "retry_same_chat"
    };
  }

  async function resetCount(message, sender) {
    if (typeof root.loadState !== "function" || typeof root.findChatIndexForMessage !== "function") return;
    const state = await root.loadState();
    const index = root.findChatIndexForMessage(state, message, sender);
    if (index < 0) return;
    const chat = state.chats[index];
    if (!chat?.extendedThinkingRepeatCount) return;
    chat.extendedThinkingRepeatCount = 0;
    await root.saveState(state);
  }

  function install() {
    if (installed) return true;
    if (
      typeof root.interruptJob !== "function"
      || typeof root.finishJob !== "function"
      || typeof root.loadState !== "function"
      || typeof root.findChatIndexForMessage !== "function"
    ) return false;

    const originalInterruptJob = root.interruptJob;
    const originalFinishJob = root.finishJob;

    root.interruptJob = async function interruptWithExtendedThinkingRecovery(message, sender) {
      const kind = String(message?.kind || "");
      const extended = kind === "connection_interrupted" && isExtendedThinkingNotice(message?.message);
      const state = await root.loadState();
      const index = root.findChatIndexForMessage(state, message, sender);
      if (index < 0) return originalInterruptJob(message, sender);
      const chat = state.chats[index];

      if (!extended) {
        if (chat.extendedThinkingRepeatCount) {
          chat.extendedThinkingRepeatCount = 0;
          await root.saveState(state);
        }
        return originalInterruptJob(message, sender);
      }

      const decision = nextAction(chat.extendedThinkingRepeatCount);
      chat.extendedThinkingRepeatCount = decision.action === "new_chat" ? 0 : decision.count;
      if (decision.action === "new_chat") {
        chat.connectionRetryCount = 0;
        const currentRollovers = Number(chat.rolloverCount || 0);
        if (chat.settings) {
          chat.settings.maxRollovers = Math.max(Number(chat.settings.maxRollovers || 0), currentRollovers + 1);
        }
      }
      await root.saveState(state);

      if (decision.action === "retry_same_chat") {
        return originalInterruptJob(message, sender);
      }

      const reason = `ChatGPT repeated the extended-thinking notice more than ${MAX_SAME_CHAT_REPEATS} times. Starting a fresh chat.`;
      return originalInterruptJob({
        ...message,
        kind: "context_limit",
        reason,
        message: reason,
        extendedThinkingRecovery: true
      }, sender);
    };

    root.finishJob = async function finishAndResetExtendedThinking(message, sender) {
      await resetCount(message, sender);
      return originalFinishJob(message, sender);
    };

    installed = true;
    return true;
  }

  if (typeof importScripts === "function") install();

  return {
    MAX_SAME_CHAT_REPEATS,
    isExtendedThinkingNotice,
    nextAction,
    install
  };
});