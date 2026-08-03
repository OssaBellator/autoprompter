"use strict";

(function attachDeferredAutoContinueDispatch(root, factory) {
  const api = factory(root);
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.AutoPrompterDeferredDispatch = api;
})(typeof globalThis !== "undefined" ? globalThis : self, root => {
  const TERMINAL_METHODS = Object.freeze(["finishJob", "interruptJob", "successorCreated"]);
  const installations = new WeakMap();

  function chatKey(state, index) {
    const chat = state?.chats?.[index];
    if (!chat) return "";
    return [state.token, chat.chainId || chat.id, chat.generation || 0].join(":");
  }

  function findCurrentIndex(state, chainId, chatId) {
    if (!Array.isArray(state?.chats)) return -1;
    return state.chats.findIndex(chat =>
      String(chat?.chainId || "") === String(chainId || "")
      || String(chat?.id || "") === String(chatId || "")
    );
  }

  function install(target = root) {
    if (installations.has(target)) return installations.get(target);
    if (
      !target
      || typeof target.queueNextChatJob !== "function"
      || typeof target.loadState !== "function"
      || typeof target.publicState !== "function"
      || typeof target.isChatEligible !== "function"
      || typeof target.enqueue !== "function"
      || TERMINAL_METHODS.some(name => typeof target[name] !== "function")
    ) return false;

    const scheduled = new Map();
    let terminalDepth = 0;
    const originalQueueNextChatJob = target.queueNextChatJob;
    const originalTerminalMethods = Object.fromEntries(
      TERMINAL_METHODS.map(name => [name, target[name]])
    );

    target.queueNextChatJob = async function queueOnNextBackgroundTurn(state, index) {
      if (terminalDepth <= 0) return originalQueueNextChatJob(state, index);

      const chat = state?.chats?.[index];
      const key = chatKey(state, index);
      if (!chat || !key) return target.publicState(state);

      if (!scheduled.has(key)) {
        const token = state.token;
        const chainId = chat.chainId;
        const chatId = chat.id;
        const operation = target.enqueue(async () => {
          const latest = await target.loadState();
          if (!latest?.running || latest.token !== token) return target.publicState(latest);
          const latestIndex = findCurrentIndex(latest, chainId, chatId);
          if (latestIndex < 0) return target.publicState(latest);
          const latestChat = latest.chats[latestIndex];
          if (latestChat.currentJobId || !target.isChatEligible(latest, latestChat)) {
            return target.publicState(latest);
          }
          return originalQueueNextChatJob(latest, latestIndex);
        });
        scheduled.set(key, operation);
        Promise.resolve(operation).catch(() => {}).finally(() => scheduled.delete(key));
      }

      return target.publicState(state);
    };

    for (const name of TERMINAL_METHODS) {
      const original = originalTerminalMethods[name];
      target[name] = async function acknowledgeBeforeRedispatch(...args) {
        terminalDepth += 1;
        try {
          return await original(...args);
        } finally {
          terminalDepth -= 1;
        }
      };
    }

    const installed = {
      originalQueueNextChatJob,
      originalTerminalMethods,
      scheduled
    };
    installations.set(target, installed);
    return installed;
  }

  if (typeof importScripts === "function") install(root);

  return {
    TERMINAL_METHODS,
    chatKey,
    findCurrentIndex,
    install
  };
});