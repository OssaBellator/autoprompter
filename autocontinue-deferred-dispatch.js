"use strict";

(function attachDeferredAutoContinueDispatch(root, factory) {
  const api = factory(root);
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.AutoPrompterDeferredDispatch = api;
})(typeof globalThis !== "undefined" ? globalThis : self, root => {
  const TERMINAL_METHODS = Object.freeze(["finishJob", "interruptJob", "successorCreated"]);
  const scheduled = new Map();
  let installed = false;
  let terminalDepth = 0;

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

  function install() {
    if (installed) return installed;
    if (
      typeof root.queueNextChatJob !== "function"
      || typeof root.loadState !== "function"
      || typeof root.publicState !== "function"
      || typeof root.isChatEligible !== "function"
      || typeof root.enqueue !== "function"
      || TERMINAL_METHODS.some(name => typeof root[name] !== "function")
    ) return false;

    const originalQueueNextChatJob = root.queueNextChatJob;
    const originalTerminalMethods = Object.fromEntries(
      TERMINAL_METHODS.map(name => [name, root[name]])
    );

    root.queueNextChatJob = async function queueOnNextBackgroundTurn(state, index) {
      if (terminalDepth <= 0) return originalQueueNextChatJob(state, index);

      const chat = state?.chats?.[index];
      const key = chatKey(state, index);
      if (!chat || !key) return root.publicState(state);

      if (!scheduled.has(key)) {
        const token = state.token;
        const chainId = chat.chainId;
        const chatId = chat.id;
        const schedule = typeof root.setTimeout === "function" ? root.setTimeout.bind(root) : setTimeout;
        const timer = schedule(() => {
          const operation = root.enqueue(async () => {
            const latest = await root.loadState();
            if (!latest?.running || latest.token !== token) return root.publicState(latest);
            const latestIndex = findCurrentIndex(latest, chainId, chatId);
            if (latestIndex < 0) return root.publicState(latest);
            const latestChat = latest.chats[latestIndex];
            if (latestChat.currentJobId || !root.isChatEligible(latest, latestChat)) {
              return root.publicState(latest);
            }
            return originalQueueNextChatJob(latest, latestIndex);
          });
          Promise.resolve(operation).catch(() => {}).finally(() => scheduled.delete(key));
        }, 0);
        scheduled.set(key, timer);
      }

      return root.publicState(state);
    };

    for (const name of TERMINAL_METHODS) {
      const original = originalTerminalMethods[name];
      root[name] = async function acknowledgeBeforeRedispatch(...args) {
        terminalDepth += 1;
        try {
          return await original(...args);
        } finally {
          terminalDepth -= 1;
        }
      };
    }

    installed = {
      originalQueueNextChatJob,
      originalTerminalMethods
    };
    return installed;
  }

  if (typeof importScripts === "function") install();

  return {
    TERMINAL_METHODS,
    chatKey,
    findCurrentIndex,
    install
  };
});