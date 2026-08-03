"use strict";

(function attachTransientThinkingRecovery(root, factory) {
  const api = factory(root);
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.AutoPrompterTransientThinkingRecovery = api;
})(typeof globalThis !== "undefined" ? globalThis : self, root => {
  const MAX_SAME_CHAT_RELOADS = 3;
  const TRANSIENT_STATUS = /^(?:thinking|generating|working)(?:\s*[.…]{1,3})?$/i;
  const installedRuntimes = new WeakSet();

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

  async function resetCount(runtime, message, sender) {
    if (typeof runtime.loadState !== "function" || typeof runtime.findChatIndexForMessage !== "function") return;
    const state = await runtime.loadState();
    const index = runtime.findChatIndexForMessage(state, message, sender);
    if (index < 0) return;
    const chat = state.chats[index];
    if (!chat?.transientThinkingRepeatCount) return;
    chat.transientThinkingRepeatCount = 0;
    await runtime.saveState(state);
  }

  function install(runtime = root) {
    if (!runtime || (typeof runtime !== "object" && typeof runtime !== "function")) return false;
    if (installedRuntimes.has(runtime)) return true;
    if (
      typeof runtime.interruptJob !== "function"
      || typeof runtime.finishJob !== "function"
      || typeof runtime.loadState !== "function"
      || typeof runtime.saveState !== "function"
      || typeof runtime.findChatIndexForMessage !== "function"
      || typeof runtime.queueNextChatJob !== "function"
      || typeof runtime.beginSuccessor !== "function"
    ) return false;

    const originalInterruptJob = runtime.interruptJob;
    const originalFinishJob = runtime.finishJob;

    runtime.interruptJob = async function interruptWithTransientThinkingRecovery(message, sender) {
      const transient = String(message?.kind || "") === "stalled"
        && isTransientThinkingStatus(message?.message);
      if (!transient) return originalInterruptJob(message, sender);

      const state = await runtime.loadState();
      const index = runtime.findChatIndexForMessage(state, message, sender);
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
        await runtime.saveState(state);
        const reason = `ChatGPT repeated the stale ${normalize(message.message)} status more than ${MAX_SAME_CHAT_RELOADS} times. Starting a fresh chat.`;
        return runtime.beginSuccessor(state, index, {
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
      runtime.updateOverallStatus(state, `${chat.title}: ${chat.status}`);
      await runtime.saveState(state);

      const tabId = chat.workerTabId;
      try {
        if (Number.isInteger(tabId)) {
          await runtime.chrome.tabs.update(tabId, { url: "about:blank", active: false });
        }
      } catch (error) {
        return runtime.failChatWorker(
          state,
          index,
          `Could not refresh the managed chat after a stale Thinking status: ${error?.message || error}`
        );
      }
      return runtime.queueNextChatJob(state, index);
    };

    runtime.finishJob = async function finishAndResetTransientThinking(message, sender) {
      await resetCount(runtime, message, sender);
      return originalFinishJob(message, sender);
    };

    installedRuntimes.add(runtime);
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
