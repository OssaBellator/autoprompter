"use strict";

(function attachAutoContinueStateGuard(root, factory) {
  const api = factory(root);
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.AutoPrompterStateGuard = api;
})(typeof globalThis !== "undefined" ? globalThis : self, root => {
  const installedRuntimes = new WeakSet();
  const FALLBACK_SETTINGS = Object.freeze({
    prompt: "Continue from where you left off. Do not repeat completed material.",
    delaySeconds: 10,
    maxContinuations: 5,
    notificationsEnabled: true,
    notifyOnPromptDone: true,
    circuitBreakerEnabled: true,
    continuityEnabled: false,
    repository: "",
    handoffFile: "AUTOPROMPTER_HANDOFF.md",
    pluginInstruction: "",
    contextCapacityTokens: 128000,
    contextThresholdPercent: 90,
    stallMinutes: 15,
    checkpointBeforePrompt: true,
    checkpointAfterPrompt: true,
    maxRollovers: 3
  });

  function text(value, fallback = "") {
    const result = String(value == null ? "" : value).trim();
    return result || fallback;
  }

  function normalizeSettings(value, fallback = FALLBACK_SETTINGS, runtime = root) {
    const merged = {
      ...FALLBACK_SETTINGS,
      ...(fallback && typeof fallback === "object" ? fallback : {}),
      ...(value && typeof value === "object" ? value : {})
    };
    return typeof runtime?.normalizeSettings === "function"
      ? runtime.normalizeSettings(merged)
      : merged;
  }

  function normalizePendingSuccessor(value, chat, settings, runtime = root) {
    if (value == null) return null;
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const parentSource = value.parentChat && typeof value.parentChat === "object"
      ? value.parentChat
      : chat;
    const parentSettings = normalizeSettings(parentSource?.settings, settings, runtime);
    return {
      ...value,
      parentChat: {
        ...parentSource,
        id: text(parentSource?.id, chat.id),
        title: text(parentSource?.title, chat.title),
        url: text(parentSource?.url, chat.url),
        settings: parentSettings,
        pendingSuccessor: null
      },
      settings: normalizeSettings(value.settings, settings, runtime),
      resumeSettings: normalizeSettings(value.resumeSettings, settings, runtime)
    };
  }

  function normalizeChat(value, stateSettings, runtime = root) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const id = text(value.id);
    const url = text(value.url);
    if (!id || !url) return null;
    const settings = normalizeSettings(value.settings, stateSettings, runtime);
    const chat = {
      ...value,
      id,
      url,
      title: text(value.title, "Untitled chat"),
      sentCount: Number.isFinite(Number(value.sentCount)) ? Math.max(0, Number(value.sentCount)) : 0,
      failed: value.failed === true,
      retired: value.retired === true,
      chainId: text(value.chainId, id),
      generation: Number.isFinite(Number(value.generation)) ? Math.max(0, Number(value.generation)) : 0,
      rolloverCount: Number.isFinite(Number(value.rolloverCount)) ? Math.max(0, Number(value.rolloverCount)) : 0,
      status: text(value.status, "Queued"),
      lastError: text(value.lastError),
      currentJobId: value.currentJobId == null ? null : text(value.currentJobId) || null,
      pendingSuccessor: null,
      contentReady: value.contentReady === true,
      jobDispatched: value.jobDispatched === true,
      initialJobPending: value.initialJobPending === true,
      retryPrompt: text(value.retryPrompt),
      connectionRetryCount: Number.isFinite(Number(value.connectionRetryCount))
        ? Math.max(0, Number(value.connectionRetryCount))
        : 0,
      extendedThinkingRepeatCount: Number.isFinite(Number(value.extendedThinkingRepeatCount))
        ? Math.max(0, Number(value.extendedThinkingRepeatCount))
        : 0,
      transientThinkingRepeatCount: Number.isFinite(Number(value.transientThinkingRepeatCount))
        ? Math.max(0, Number(value.transientThinkingRepeatCount))
        : 0,
      settings
    };
    chat.pendingSuccessor = normalizePendingSuccessor(value.pendingSuccessor, chat, settings, runtime);
    return chat;
  }

  function repairSchedulerState(value, runtime = root) {
    if (value == null) return { state: null, repaired: false, removedChats: 0 };
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return { state: null, repaired: true, removedChats: 0 };
    }

    const settings = normalizeSettings(value.settings, FALLBACK_SETTINGS, runtime);
    const sourceChats = Array.isArray(value.chats) ? value.chats : [];
    const chats = sourceChats
      .map(chat => normalizeChat(chat, settings, runtime))
      .filter(Boolean);
    const removedChats = sourceChats.length - chats.length;
    const state = {
      ...value,
      settings,
      chats,
      handoffHistory: Array.isArray(value.handoffHistory) ? value.handoffHistory.filter(Boolean) : []
    };

    if (state.running && chats.length === 0) {
      state.running = false;
      state.status = "Stopped after repairing invalid scheduler state";
      state.lastError = "The saved AutoContinue session did not contain a valid chat. Start the selected chats again.";
      state.pausedReason = state.lastError;
    }

    let repaired = removedChats > 0 || !Array.isArray(value.chats) || !value.settings;
    if (!repaired) {
      try { repaired = JSON.stringify(state) !== JSON.stringify(value); } catch { repaired = true; }
    }
    return { state, repaired, removedChats };
  }

  function missingChatState(runtime, state, operation) {
    const repaired = repairSchedulerState(state, runtime).state;
    if (!repaired) return runtime.publicState(null);
    repaired.lastError = `AutoPrompter ignored a stale ${operation} request because its chat no longer exists or no longer owns that job.`;
    repaired.pausedReason = repaired.lastError;
    repaired.status = "Recovered stale scheduler request";
    return Promise.resolve(runtime.saveState(repaired)).then(() => runtime.publicState(repaired));
  }

  function install(runtime = root) {
    if (!runtime || (typeof runtime !== "object" && typeof runtime !== "function")) return false;
    if (installedRuntimes.has(runtime)) return true;
    if (
      typeof runtime.loadState !== "function"
      || typeof runtime.saveState !== "function"
      || typeof runtime.publicState !== "function"
      || typeof runtime.queueNextChatJob !== "function"
      || typeof runtime.beginSuccessor !== "function"
    ) return false;

    const originalLoadState = runtime.loadState;
    const originalSaveState = runtime.saveState;
    const originalPublicState = runtime.publicState;
    const originalQueueNextChatJob = runtime.queueNextChatJob;
    const originalBeginSuccessor = runtime.beginSuccessor;

    runtime.saveState = async function saveGuardedState(state) {
      const repaired = repairSchedulerState(state, runtime).state;
      return originalSaveState(repaired);
    };

    runtime.loadState = async function loadGuardedState() {
      const stored = await originalLoadState();
      const result = repairSchedulerState(stored, runtime);
      if (result.repaired && result.state) await originalSaveState(result.state);
      return result.state;
    };

    runtime.publicState = function publicGuardedState(state) {
      return originalPublicState(repairSchedulerState(state, runtime).state);
    };

    runtime.queueNextChatJob = async function queueGuardedChatJob(state, index, ...rest) {
      const repaired = repairSchedulerState(state, runtime).state;
      if (!repaired?.chats?.[index]) return missingChatState(runtime, repaired, "continuation");
      return originalQueueNextChatJob(repaired, index, ...rest);
    };

    runtime.beginSuccessor = async function beginGuardedSuccessor(state, index, message, ...rest) {
      const repaired = repairSchedulerState(state, runtime).state;
      const chat = repaired?.chats?.[index];
      const expectedJobId = text(message?.jobId);
      if (!chat || (expectedJobId && chat.currentJobId !== expectedJobId)) {
        return missingChatState(runtime, repaired, "successor");
      }
      return originalBeginSuccessor(repaired, index, message || {}, ...rest);
    };

    installedRuntimes.add(runtime);
    return true;
  }

  if (typeof importScripts === "function") install();

  return {
    FALLBACK_SETTINGS,
    normalizeSettings,
    normalizePendingSuccessor,
    normalizeChat,
    repairSchedulerState,
    install
  };
});
