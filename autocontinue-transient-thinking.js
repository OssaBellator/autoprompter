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

  function transientStatusName(value) {
    const normalized = normalize(value);
    return normalized
      .split(/\s+\|\s+/)
      .map(part => part.trim())
      .find(part => TRANSIENT_STATUS.test(part)) || "";
  }

  function isTransientThinkingStatus(value) {
    return Boolean(transientStatusName(value));
  }

  function nextAction(currentCount) {
    const count = Math.max(0, Number(currentCount) || 0) + 1;
    return {
      count,
      action: count > MAX_SAME_CHAT_RELOADS ? "new_chat" : "reload_same_chat"
    };
  }

  function findCurrentIndex(state, chainId, chatId) {
    if (!Array.isArray(state?.chats)) return -1;
    return state.chats.findIndex(chat =>
      String(chat?.chainId || "") === String(chainId || "")
      || String(chat?.id || "") === String(chatId || "")
    );
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
      || typeof runtime.enqueue !== "function"
      || typeof runtime.publicState !== "function"
    ) return false;

    const originalInterruptJob = runtime.interruptJob;
    const originalFinishJob = runtime.finishJob;
    const originalQueueNextChatJob = runtime.queueNextChatJob;

    runtime.queueNextChatJob = async function queueAfterTransientRefresh(state, index) {
      const chat = state?.chats?.[index];
      if (chat?.forceReloadBeforeNext) {
        chat.forceReloadBeforeNext = false;
        chat.contentReady = false;
        await runtime.saveState(state);
        if (Number.isInteger(chat.workerTabId)) {
          try {
            await runtime.chrome.tabs.reload(chat.workerTabId);
          } catch (error) {
            return runtime.failChatWorker(
              state,
              index,
              `Could not refresh the managed chat after a stale Thinking status: ${error?.message || error}`
            );
          }
        }
      }
      return originalQueueNextChatJob(state, index);
    };

    runtime.interruptJob = async function interruptWithTransientThinkingRecovery(message, sender) {
      const statusName = transientStatusName(message?.message);
      const transient = String(message?.kind || "") === "stalled" && Boolean(statusName);
      if (!transient) {
        await resetCount(runtime, message, sender);
        return originalInterruptJob(message, sender);
      }

      const state = await runtime.loadState();
      const index = runtime.findChatIndexForMessage(state, message, sender);
      if (index < 0) return originalInterruptJob(message, sender);
      const chat = state.chats[index];
      const decision = nextAction(chat.transientThinkingRepeatCount);

      if (decision.action === "new_chat") {
        chat.transientThinkingRepeatCount = 0;
        chat.connectionRetryCount = 0;
        chat.status = "Scheduling a fresh chat after repeated stale thinking states";
        const currentRollovers = Number(chat.rolloverCount || 0);
        if (chat.settings) {
          chat.settings.maxRollovers = Math.max(Number(chat.settings.maxRollovers || 0), currentRollovers + 1);
        }
        runtime.updateOverallStatus(state, `${chat.title}: ${chat.status}`);
        await runtime.saveState(state);

        const token = state.token;
        const chainId = chat.chainId;
        const chatId = chat.id;
        const expectedJobId = message.jobId;
        const reason = `ChatGPT repeated the stale ${statusName} status more than ${MAX_SAME_CHAT_RELOADS} times. Starting a fresh chat.`;
        const operation = runtime.enqueue(async () => {
          const latest = await runtime.loadState();
          if (!latest?.running || latest.token !== token) return runtime.publicState(latest);
          const latestIndex = findCurrentIndex(latest, chainId, chatId);
          if (latestIndex < 0) return runtime.publicState(latest);
          const latestChat = latest.chats[latestIndex];
          if (latestChat.currentJobId !== expectedJobId) return runtime.publicState(latest);
          return runtime.beginSuccessor(latest, latestIndex, {
            ...message,
            kind: "stalled",
            message: reason,
            reason,
            forceFreshStart: true,
            transientThinkingRecovery: true
          });
        });
        Promise.resolve(operation).catch(() => {});
        return runtime.publicState(state);
      }

      chat.transientThinkingRepeatCount = decision.count;
      chat.currentJobId = null;
      chat.jobDispatched = false;
      chat.contentReady = false;
      chat.initialJobPending = false;
      chat.forceReloadBeforeNext = true;
      chat.lastError = statusName;
      chat.status = `Refreshing stale thinking state (${decision.count}/${MAX_SAME_CHAT_RELOADS})`;
      runtime.updateOverallStatus(state, `${chat.title}: ${chat.status}`);
      await runtime.saveState(state);
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
    transientStatusName,
    isTransientThinkingStatus,
    nextAction,
    findCurrentIndex,
    install
  };
});
