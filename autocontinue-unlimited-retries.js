"use strict";

(function attachUnlimitedConnectionRetries(root, factory) {
  const api = factory(root);
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.AutoPrompterUnlimitedConnectionRetries = api;
})(typeof globalThis !== "undefined" ? globalThis : self, root => {
  const CONNECTION_RETRY_PROMPT = "Continue from where the response was interrupted. Do not repeat completed material.";
  let installed = false;

  function retryStatus(retries) {
    return `Retrying interrupted response (${Math.max(1, Number(retries) || 1)})`;
  }

  function install() {
    if (installed) return true;
    if (typeof root.interruptJob !== "function") return false;
    const originalInterruptJob = root.interruptJob;

    root.interruptJob = async function interruptWithoutFixedLimit(message, sender) {
      if (String(message?.kind || "") !== "connection_interrupted") {
        return originalInterruptJob(message, sender);
      }

      const state = await root.loadState();
      const index = root.findChatIndexForMessage(state, message, sender);
      if (index < 0) return root.publicState(state);
      const chat = state.chats[index];
      if (message.checkpoint) chat.lastCheckpoint = String(message.checkpoint).slice(0, 200);
      if (Number.isFinite(message.contextEstimateTokens)) chat.contextEstimateTokens = Math.round(message.contextEstimateTokens);
      if (Number.isFinite(message.contextPercent)) chat.contextPercent = Math.round(message.contextPercent * 10) / 10;

      const retries = Number(chat.connectionRetryCount || 0) + 1;
      const reason = String(message.message || "ChatGPT interrupted the job.").slice(0, 500);
      chat.connectionRetryCount = retries;
      chat.retryPrompt = CONNECTION_RETRY_PROMPT;
      chat.currentJobId = null;
      chat.status = retryStatus(retries);
      chat.lastError = reason;
      root.updateOverallStatus(state, `${chat.title}: ${chat.status}`);
      await root.saveState(state);
      await root.notify(state, `Retrying interrupted response: ${chat.title}`, reason, `connection-${chat.id}`);
      return root.queueNextChatJob(state, index);
    };

    installed = true;
    return true;
  }

  if (typeof importScripts === "function") install();

  return {
    CONNECTION_RETRY_PROMPT,
    retryStatus,
    install
  };
});