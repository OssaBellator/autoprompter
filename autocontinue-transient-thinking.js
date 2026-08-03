"use strict";

(function attachTransientThinkingRecovery(root, factory) {
  const api = factory(root);
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.AutoPrompterTransientThinkingRecovery = api;
})(typeof globalThis !== "undefined" ? globalThis : self, root => {
  const MAX_SAME_CHAT_RELOADS = 3;
  const TRANSIENT_STATUS = /^(?:thinking|generating|working)(?:\s*[.…]{1,3})?$/i;
  let installed = false;

  function normalize(value) {
    return String(value || "")
      .replace(/\u00a0/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/^(?:error|warning|notice)\s*[:–—-]\s*/i, "");
  }

  function isTransientThinkingStatus(value) {
    return TRANSIENT_STATUS.test(normalize(value));
  }

  function nextAction(currentCount) {
    const count = Math.max(0, Number(currentCount) || 0) + 1;
    return {
      count,
      action: count > MAX_SAME_CHAT_RELOADS ? "new_chat" : "reload_same_chat"
    };
  }

  async function resetCount(message, sender) {
    if (typeof root.loadState !== "function" || typeof root.findChatIndexForMessage !== "function") return;
    const state = await root.loadState();
    const index = root.findChatIndexForMessage(state, message, sender);
    if (index < 0) return;
    const chat = state.chats[index];
    if (!chat?.transientThinkingRepeatCount) return;
    chat.transientThinkingRepeatCount = 0;
    await root.saveState(state);
  }

  function install() {
    if (installed) return true;
    if (
      typeof root.interruptJob !== "function"
      || typeof root.finishJob !== "function"
      || typeof root.loadState !== "function"
      || typeof root.saveState !== "function"
      || typeof root.findChatIndexForMessage !== "function"
      || typeof root.queueNextChatJob !== "function"
      || typeof root.beginSuccessor !== "function"
    ) return false;

    const originalInterruptJob = root.interruptJob;
    const originalFinishJob = root.finishJob;

    root.interruptJob = async function interruptWithTransientThinkingRecovery(message, sender) {
      const transient = String(message?.kind || "") === "stalled"
        && isTransientThinkingStatus(message?.message);
      if (!transient) return originalInterruptJob(message, sender);

      const state = await root.loadState();
      const index = root.findChatIndexForMessage(state, message, sender);
      if (index < 0) return originalInterruptJob(message, sender);
      const chat = state.chats[index];
      const decision = nextAction(chat.transientThinkingRepeatCount);

      if (decision.action === "new_chat") {
        chat.transientThinkingRepeatCount = 0;
        chat.connectionRetryCount = 0;
        const currentRollovers = Number(chat.rolloverCount || 0);
        if (chat.settings) {
          chat.settings.maxRollovers = Math.max(Number(chat.settings.maxRollovers || 0), currentRollovers + 1);
        }
        await root.saveState(state);
        const reason = `ChatGPT repeated the stale ${normalize(message.message)} status more than ${MAX_SAME_CHAT_RELOADS} times. Starting a fresh chat.`;
        return root.beginSuccessor(state, index, {
          ...message,
          kind: "stalled",
          message: reason,
          reason,
          forceFreshStart: true,
          transientThinkingRecovery: true
        });
      }

      chat.transientThinkingRepeatCount = decision.count;
      chat.currentJobId = null;
      chat.jobDispatched = false;
      chat.contentReady = false;
      chat.initialJobPending = false;
      chat.lastError = normalize(message.message);
      chat.status = `Refreshing stale thinking state (${decision.count}/${MAX_SAME_CHAT_RELOADS})`;
      root.updateOverallStatus(state, `${chat.title}: ${chat.status}`);
      await root.saveState(state);

      const tabId = chat.workerTabId;
      try {
        if (Number.isInteger(tabId)) {
          await root.chrome.tabs.update(tabId, { url: "about:blank", active: false });
        }
      } catch (error) {
        return root.failChatWorker(
          state,
          index,
          `Could not refresh the managed chat after a stale Thinking status: ${error?.message || error}`
        );
      }
      return root.queueNextChatJob(state, index);
    };

    root.finishJob = async function finishAndResetTransientThinking(message, sender) {
      await resetCount(message, sender);
      return originalFinishJob(message, sender);
    };

    installed = true;
    return true;
  }

  if (typeof importScripts === "function") install();

  return {
    MAX_SAME_CHAT_RELOADS,
    isTransientThinkingStatus,
    nextAction,
    install
  };
});
