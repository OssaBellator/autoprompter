"use strict";

const MESSAGE_SCOPE = "AUTOPROMPTER_RUNTIME";
const SESSION_KEY = "autoprompterScheduler";
const SETTINGS_KEY = "autoprompterSettings";
const CATALOG_KEY = "autoprompterChatCatalog";
const SELECTION_KEY = "autoprompterSelectedChatIds";
const NEW_CHAT_URL = "https://chatgpt.com/";
const NOTIFICATION_ICON_DATA_URL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAABPUlEQVR4nO2ZMQ7CQAwEF0QPL4UO3kDJT/kBVCehFChxfDeWbqfPaT34HKMczvfrRxNzpAPQWAAdgMYC6AA0FkAHoLEAOgCNBdABaCyADkBzyjjk/XxlHBPi8rjtev6w5+8wWfiSqIjwFahUvBTPExJQrfhGJNf0Q3CzgKq/fmNrPncAHYDGAugANCmb4JK929k/sodwegf0LL7H+dNfAQvIPrD3opR9fpchWH1b/MVXgA5AM72AsovQqDlSdhHqvVA1pr8CFpB9YNbdHTUDvAjRAWgsYOsDo15PUbbmcwdEHqraBZFc4Q6oJiGaZ9fX4ca0n8fXsFYO1VElhiB5nXAB9CxBBdDFS6CACsVLkIAqxUuAgErFS4MFVCteGiigYvHSIAFVi5cGbILVwRchGgugA9BYAB2AxgLoADRfdOpG+jsXCCIAAAAASUVORK5CYII=";

const DEFAULTS = Object.freeze({
  prompt: "Continue from where you left off. Do not repeat completed material.",
  delaySeconds: 2,
  maxContinuations: 5,
  notificationsEnabled: true,
  notifyOnPromptDone: true,
  continuityEnabled: false,
  repository: "",
  handoffFile: "AUTOPROMPTER_HANDOFF.md",
  pluginInstruction: "Use an action-capable repository plugin or Codex. The read-only GitHub app is not sufficient for commits.",
  contextCapacityTokens: 128000,
  contextThresholdPercent: 90,
  stallMinutes: 15,
  checkpointBeforePrompt: true,
  checkpointAfterPrompt: true,
  maxRollovers: 3
});

let operationQueue = Promise.resolve();

function enqueue(operation) {
  operationQueue = operationQueue.catch(() => {}).then(operation);
  return operationQueue;
}

function clampNumber(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function normalizeRepository(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  let candidate = raw;
  try {
    if (/^https?:\/\//i.test(raw)) {
      const url = new URL(raw);
      if (url.hostname !== "github.com" && url.hostname !== "www.github.com") return "";
      candidate = url.pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
    }
  } catch {
    return "";
  }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(candidate)) return "";
  return candidate;
}

function normalizeHandoffFile(value) {
  const file = String(value || DEFAULTS.handoffFile).trim().replace(/^\/+/, "");
  if (!file || file.includes("..") || !/^[A-Za-z0-9_./-]+$/.test(file)) return DEFAULTS.handoffFile;
  return file.slice(0, 200);
}

function normalizeSettings(settings = {}) {
  const repository = normalizeRepository(settings.repository);
  return {
    prompt: typeof settings.prompt === "string" && settings.prompt.trim()
      ? settings.prompt.trim().slice(0, 12000)
      : DEFAULTS.prompt,
    delaySeconds: clampNumber(settings.delaySeconds, DEFAULTS.delaySeconds, 2, 120),
    maxContinuations: Math.round(
      clampNumber(settings.maxContinuations, DEFAULTS.maxContinuations, 1, 50)
    ),
    notificationsEnabled: settings.notificationsEnabled !== false,
    notifyOnPromptDone: settings.notifyOnPromptDone !== false,
    continuityEnabled: Boolean(settings.continuityEnabled && repository),
    repository,
    handoffFile: normalizeHandoffFile(settings.handoffFile),
    pluginInstruction: String(settings.pluginInstruction || DEFAULTS.pluginInstruction).trim().slice(0, 1000),
    contextCapacityTokens: Math.round(clampNumber(
      settings.contextCapacityTokens,
      DEFAULTS.contextCapacityTokens,
      16000,
      1000000
    )),
    contextThresholdPercent: clampNumber(
      settings.contextThresholdPercent,
      DEFAULTS.contextThresholdPercent,
      50,
      98
    ),
    stallMinutes: clampNumber(settings.stallMinutes, DEFAULTS.stallMinutes, 5, 180),
    checkpointBeforePrompt: settings.checkpointBeforePrompt !== false,
    checkpointAfterPrompt: settings.checkpointAfterPrompt !== false,
    maxRollovers: Math.round(clampNumber(settings.maxRollovers, DEFAULTS.maxRollovers, 1, 10))
  };
}

function normalizeConversationUrl(value) {
  try {
    const url = new URL(value);
    if (url.hostname !== "chatgpt.com" && url.hostname !== "chat.openai.com") return null;
    const match = url.pathname.match(/(?:^|\/)c\/([^/?#]+)/);
    if (!match) return null;
    return {
      id: decodeURIComponent(match[1]),
      url: `https://chatgpt.com/c/${encodeURIComponent(decodeURIComponent(match[1]))}`
    };
  } catch {
    return null;
  }
}

function isNewChatUrl(value) {
  try {
    const url = new URL(value);
    if (url.hostname !== "chatgpt.com" && url.hostname !== "chat.openai.com") return false;
    return !/(?:^|\/)c\/[^/?#]+/.test(url.pathname);
  } catch {
    return false;
  }
}

function normalizeChat(chat) {
  const normalized = normalizeConversationUrl(chat?.url || "");
  if (!normalized) return null;
  const suppliedId = String(chat?.id || normalized.id);
  if (suppliedId !== normalized.id) return null;
  return {
    id: normalized.id,
    title: String(chat?.title || "Untitled chat").trim().slice(0, 160) || "Untitled chat",
    url: normalized.url,
    sentCount: 0,
    status: "Queued",
    lastError: "",
    failed: false,
    retired: false,
    chainId: normalized.id,
    generation: 0,
    rolloverCount: 0,
    lastCheckpoint: "",
    contextEstimateTokens: 0,
    contextPercent: 0
  };
}

function nextEligibleIndex(chats, currentIndex, maxContinuations) {
  if (!Array.isArray(chats) || chats.length === 0) return -1;
  for (let offset = 1; offset <= chats.length; offset += 1) {
    const index = (currentIndex + offset + chats.length) % chats.length;
    const chat = chats[index];
    if (!chat.failed && !chat.retired && Number(chat.sentCount || 0) < maxContinuations) return index;
  }
  return -1;
}

function buildSuccessorPrompt(settings, chat, checkpoint, reason) {
  const reasonText = String(reason || "the previous chat reached a continuity boundary").slice(0, 500);
  return [
    "Continue the same project goal from the previous chat.",
    `Repository: ${settings.repository}`,
    `Continuity file: ${settings.handoffFile}`,
    checkpoint ? `Last verified checkpoint: ${checkpoint}` : "Last verified checkpoint: not supplied",
    `Reason for rollover: ${reasonText}`,
    "",
    settings.pluginInstruction,
    "Read the repository and continuity file before taking action. Treat committed repository state as the source of truth.",
    "Verify the active branch, latest commit, completed work, remaining work, blockers, and next safe task.",
    "Do not reconstruct missing work from guesses and do not repeat completed tasks.",
    "Continue with the next unfinished task, then update the continuity file and commit completed work before finishing."
  ].filter(Boolean).join("\n");
}

function publicState(state) {
  const version = chrome.runtime.getManifest().version;
  if (!state) return {
    running: false,
    status: "Stopped",
    chats: [],
    settings: { ...DEFAULTS },
    handoffHistory: [],
    version
  };

  return {
    running: Boolean(state.running),
    status: state.status || "Stopped",
    lastError: state.lastError || "",
    pausedReason: state.pausedReason || "",
    workerTabId: state.workerTabId ?? null,
    currentIndex: Number.isInteger(state.currentIndex) ? state.currentIndex : -1,
    chats: Array.isArray(state.chats) ? state.chats : [],
    settings: normalizeSettings(state.settings),
    startedAt: state.startedAt || null,
    pendingSuccessor: state.pendingSuccessor || null,
    handoffHistory: Array.isArray(state.handoffHistory) ? state.handoffHistory : [],
    version
  };
}

async function loadState() {
  const stored = await chrome.storage.session.get(SESSION_KEY);
  return stored?.[SESSION_KEY] || null;
}

async function saveState(state) {
  await chrome.storage.session.set({
    [SESSION_KEY]: { ...state, savedAt: Date.now() }
  });
}

async function notify(state, title, message, idSuffix = "event") {
  if (!state?.settings?.notificationsEnabled) return;
  const notificationId = `autoprompter-${idSuffix}-${Date.now()}`;
  try {
    await chrome.notifications.create(notificationId, {
      type: "basic",
      iconUrl: NOTIFICATION_ICON_DATA_URL,
      title: String(title).slice(0, 120),
      message: String(message).slice(0, 500),
      priority: 0
    });
  } catch {
    try {
      await chrome.action.setBadgeBackgroundColor({ color: "#b42318" });
      await chrome.action.setBadgeText({ text: "!" });
    } catch {
      // Notifications and badges are best-effort.
    }
  }
}

async function clearBadge() {
  try { await chrome.action.setBadgeText({ text: "" }); } catch { /* best-effort */ }
}

async function removeManagedTab(tabId) {
  if (!Number.isInteger(tabId)) return;
  try {
    await chrome.tabs.remove(tabId);
  } catch {
    // The user may already have closed the tab.
  }
}

async function stopScheduler(reason = "Stopped", error = "", closeWorker = true, notifyUser = false) {
  const state = await loadState();
  if (!state) return publicState(null);

  const stopped = {
    ...state,
    running: false,
    token: Number(state.token || 0) + 1,
    workerTabId: null,
    currentJobId: null,
    pendingSuccessor: null,
    status: reason,
    lastError: error,
    pausedReason: error || reason
  };
  stopped.chats = (stopped.chats || []).map(chat => ({
    ...chat,
    status: chat.status === "Finished" || chat.retired || chat.failed ? chat.status : "Stopped"
  }));
  await saveState(stopped);

  if (Number.isInteger(state.workerTabId)) {
    try {
      await chrome.tabs.sendMessage(state.workerTabId, {
        type: "CANCEL_CHAT_JOB",
        token: stopped.token
      });
    } catch {
      // The page may be navigating.
    }
    if (closeWorker) await removeManagedTab(state.workerTabId);
  }

  if (notifyUser) await notify(stopped, "AutoPrompter stopped", error || reason, "stopped");
  return publicState(stopped);
}

async function saveSuccessorToCatalog(chat) {
  const stored = await chrome.storage.local.get([CATALOG_KEY, SELECTION_KEY]);
  const catalog = Array.isArray(stored[CATALOG_KEY]) ? stored[CATALOG_KEY] : [];
  const byId = new Map(catalog.map(item => [item.id, item]));
  byId.set(chat.id, { id: chat.id, title: chat.title, url: chat.url });
  const selected = new Set(Array.isArray(stored[SELECTION_KEY]) ? stored[SELECTION_KEY] : []);
  selected.add(chat.id);
  await chrome.storage.local.set({
    [CATALOG_KEY]: [...byId.values()].sort((left, right) => left.title.localeCompare(right.title)),
    [SELECTION_KEY]: [...selected]
  });
}

async function sendCurrentJob(state) {
  if (!state?.running || !Number.isInteger(state.workerTabId) || !state.currentJobId) return;

  let tab;
  try {
    tab = await chrome.tabs.get(state.workerTabId);
  } catch {
    await stopScheduler("Stopped", "The managed ChatGPT tab was closed.", false, true);
    return;
  }

  if (state.pendingSuccessor) {
    if (!isNewChatUrl(tab.url || "")) return;
    try {
      await chrome.tabs.sendMessage(state.workerTabId, {
        type: "RUN_SUCCESSOR_JOB",
        token: state.token,
        jobId: state.currentJobId,
        parentChat: state.pendingSuccessor.parentChat,
        settings: state.settings,
        prompt: state.pendingSuccessor.prompt,
        checkpoint: state.pendingSuccessor.checkpoint,
        reason: state.pendingSuccessor.reason
      });
    } catch {
      // The content script will announce readiness after navigation settles.
    }
    return;
  }

  const chat = state.chats?.[state.currentIndex];
  if (!chat) return;
  const current = normalizeConversationUrl(tab.url || "");
  if (!current || current.id !== chat.id) return;

  try {
    await chrome.tabs.sendMessage(state.workerTabId, {
      type: "RUN_CHAT_JOB",
      token: state.token,
      jobId: state.currentJobId,
      chat: { ...chat },
      settings: state.settings
    });
  } catch {
    // The content script will announce readiness after navigation settles.
  }
}

async function advanceScheduler(state) {
  if (!state?.running) return publicState(state);

  const nextIndex = nextEligibleIndex(
    state.chats,
    Number.isInteger(state.currentIndex) ? state.currentIndex : -1,
    state.settings.maxContinuations
  );

  if (nextIndex < 0) {
    const workerTabId = state.workerTabId;
    state.running = false;
    state.status = state.chats.some(chat => chat.failed)
      ? "Finished with errors"
      : "Finished";
    state.workerTabId = null;
    state.currentJobId = null;
    state.pendingSuccessor = null;
    state.chats = state.chats.map(chat => ({
      ...chat,
      status: chat.failed ? "Error" : (chat.retired ? chat.status : "Finished")
    }));
    await saveState(state);
    await removeManagedTab(workerTabId);
    await notify(state, "AutoPrompter finished", state.status, "finished");
    return publicState(state);
  }

  const chat = state.chats[nextIndex];
  const jobNumber = Number(chat.sentCount || 0) + 1;
  state.currentIndex = nextIndex;
  state.currentJobId = `${state.token}:${chat.id}:${jobNumber}:${Date.now()}`;
  state.pendingSuccessor = null;
  state.status = `Loading ${chat.title}`;
  state.lastError = "";
  state.pausedReason = "";
  state.chats = state.chats.map((entry, index) => index === nextIndex
    ? { ...entry, status: "Loading", lastError: "" }
    : entry);
  await saveState(state);

  let tab;
  try {
    tab = await chrome.tabs.get(state.workerTabId);
  } catch {
    tab = null;
  }

  if (!tab) {
    try {
      tab = await chrome.tabs.create({ url: "about:blank", active: false });
      state.workerTabId = tab.id;
      await saveState(state);
      await chrome.tabs.update(tab.id, { url: chat.url, active: false });
    } catch (error) {
      state.running = false;
      state.workerTabId = null;
      state.currentJobId = null;
      state.status = "Stopped";
      state.lastError = `Could not open the managed ChatGPT tab: ${error.message}`;
      await saveState(state);
      if (tab?.id) await removeManagedTab(tab.id);
      await notify(state, "AutoPrompter stopped", state.lastError, "tab-error");
    }
    return publicState(state);
  }

  const current = normalizeConversationUrl(tab.url || "");
  if (current?.id === chat.id && tab.status === "complete") {
    await sendCurrentJob(state);
  } else {
    try {
      await chrome.tabs.update(state.workerTabId, { url: chat.url, active: false });
    } catch (error) {
      return stopScheduler("Stopped", `Could not open ${chat.title}: ${error.message}`, true, true);
    }
  }
  return publicState(state);
}

async function startScheduler(chats, settings) {
  const normalizedSettings = normalizeSettings(settings);
  if (settings?.continuityEnabled && !normalizedSettings.repository) {
    throw new Error("Repository continuity requires a valid GitHub owner/repository value.");
  }

  const normalizedChats = [];
  const seen = new Set();
  for (const chat of Array.isArray(chats) ? chats : []) {
    const normalized = normalizeChat(chat);
    if (!normalized || seen.has(normalized.id)) continue;
    seen.add(normalized.id);
    normalizedChats.push(normalized);
  }
  if (normalizedChats.length === 0) throw new Error("Select at least one ChatGPT conversation.");

  const previous = await loadState();
  if (previous?.running) await stopScheduler("Restarted", "", true);

  const state = {
    running: true,
    token: Math.max(Date.now(), Number(previous?.token || 0) + 2),
    workerTabId: null,
    currentIndex: -1,
    currentJobId: null,
    pendingSuccessor: null,
    status: "Starting",
    lastError: "",
    pausedReason: "",
    settings: normalizedSettings,
    chats: normalizedChats,
    handoffHistory: [],
    startedAt: Date.now()
  };
  await clearBadge();
  await saveState(state);
  return advanceScheduler(state);
}

async function updateJobStatus(message, sender) {
  const state = await loadState();
  if (!state?.running || sender.tab?.id !== state.workerTabId) return publicState(state);
  if (message.token !== state.token || message.jobId !== state.currentJobId) return publicState(state);

  const chat = state.chats[state.currentIndex];
  if (!chat) return publicState(state);
  chat.status = String(message.status || "Working").slice(0, 160);
  if (Number.isFinite(message.contextEstimateTokens)) chat.contextEstimateTokens = Math.round(message.contextEstimateTokens);
  if (Number.isFinite(message.contextPercent)) chat.contextPercent = Math.round(message.contextPercent * 10) / 10;
  state.status = `${chat.title}: ${chat.status}`;
  await saveState(state);
  return publicState(state);
}

async function finishJob(message, sender) {
  const state = await loadState();
  if (!state?.running || sender.tab?.id !== state.workerTabId) return publicState(state);
  if (message.token !== state.token || message.jobId !== state.currentJobId) return publicState(state);

  const chat = state.chats[state.currentIndex];
  if (!chat) return publicState(state);
  chat.sentCount = Number(chat.sentCount || 0) + 1;
  chat.status = chat.sentCount >= state.settings.maxContinuations ? "Finished" : "Queued";
  chat.lastError = "";
  if (message.checkpoint) chat.lastCheckpoint = String(message.checkpoint).slice(0, 200);
  if (Number.isFinite(message.contextEstimateTokens)) chat.contextEstimateTokens = Math.round(message.contextEstimateTokens);
  if (Number.isFinite(message.contextPercent)) chat.contextPercent = Math.round(message.contextPercent * 10) / 10;
  state.currentJobId = null;
  await saveState(state);

  if (state.settings.notifyOnPromptDone) {
    await notify(
      state,
      `Prompt completed: ${chat.title}`,
      `${chat.sentCount}/${state.settings.maxContinuations}${chat.lastCheckpoint ? ` · checkpoint ${chat.lastCheckpoint}` : ""}`,
      `prompt-${chat.id}`
    );
  }
  return advanceScheduler(state);
}

async function failJob(message, sender) {
  const state = await loadState();
  if (!state?.running || sender.tab?.id !== state.workerTabId) return publicState(state);
  if (message.token !== state.token || message.jobId !== state.currentJobId) return publicState(state);

  const chat = state.chats[state.currentIndex];
  if (!chat) return publicState(state);
  chat.failed = true;
  chat.status = "Error";
  chat.lastError = String(message.error || "The chat job failed.").slice(0, 500);
  state.lastError = `${chat.title}: ${chat.lastError}`;
  state.currentJobId = null;
  await saveState(state);
  await notify(state, `AutoPrompter error: ${chat.title}`, chat.lastError, `error-${chat.id}`);
  return advanceScheduler(state);
}

async function beginSuccessor(state, chat, message) {
  const checkpoint = String(message.checkpoint || chat.lastCheckpoint || "").slice(0, 200);
  const reason = String(message.reason || message.message || "Continuity rollover requested.").slice(0, 500);
  const rolloverCount = Number(chat.rolloverCount || 0) + 1;
  if (!state.settings.continuityEnabled || !state.settings.repository) {
    return stopScheduler("Continuity handoff required", reason, true, true);
  }
  if (!checkpoint) {
    return stopScheduler(
      "Continuity handoff blocked",
      `${reason} No verified repository checkpoint was available, so no successor chat was opened.`,
      true,
      true
    );
  }
  if (rolloverCount > state.settings.maxRollovers) {
    return stopScheduler(
      "Rollover limit reached",
      `The chat reached the configured limit of ${state.settings.maxRollovers} successor chats.`,
      true,
      true
    );
  }

  chat.status = "Creating successor";
  chat.lastCheckpoint = checkpoint;
  chat.rolloverCount = rolloverCount;
  state.currentJobId = `${state.token}:successor:${chat.chainId}:${rolloverCount}:${Date.now()}`;
  state.pendingSuccessor = {
    parentChat: { ...chat },
    checkpoint,
    reason,
    prompt: buildSuccessorPrompt(state.settings, chat, checkpoint, reason)
  };
  state.status = `Creating successor for ${chat.title}`;
  await saveState(state);
  await notify(state, `Creating successor: ${chat.title}`, `${reason} · checkpoint ${checkpoint}`, `rollover-${chat.id}`);

  let tab;
  try { tab = await chrome.tabs.get(state.workerTabId); } catch { tab = null; }
  if (!tab) {
    try {
      tab = await chrome.tabs.create({ url: "about:blank", active: false });
      state.workerTabId = tab.id;
      await saveState(state);
    } catch (error) {
      return stopScheduler("Stopped", `Could not create a successor tab: ${error.message}`, true, true);
    }
  }
  try {
    await chrome.tabs.update(state.workerTabId, { url: NEW_CHAT_URL, active: false });
  } catch (error) {
    return stopScheduler("Stopped", `Could not open a new ChatGPT conversation: ${error.message}`, true, true);
  }
  return publicState(state);
}

async function interruptJob(message, sender) {
  const state = await loadState();
  if (!state?.running || sender.tab?.id !== state.workerTabId) return publicState(state);
  if (message.token !== state.token || message.jobId !== state.currentJobId) return publicState(state);
  const chat = state.chats[state.currentIndex];
  if (!chat) return publicState(state);

  if (message.checkpoint) chat.lastCheckpoint = String(message.checkpoint).slice(0, 200);
  if (Number.isFinite(message.contextEstimateTokens)) chat.contextEstimateTokens = Math.round(message.contextEstimateTokens);
  if (Number.isFinite(message.contextPercent)) chat.contextPercent = Math.round(message.contextPercent * 10) / 10;
  const kind = String(message.kind || "unknown");
  const reason = String(message.message || "ChatGPT interrupted the job.").slice(0, 500);

  if (["context_limit", "stalled", "content_removed"].includes(kind)) {
    return beginSuccessor(state, chat, { ...message, reason });
  }

  // Do not use a new chat to evade account restrictions, rate limits, or safety decisions.
  if (["rate_limit", "account_restriction", "safety_restriction"].includes(kind)) {
    return stopScheduler("Circuit breaker activated", reason, true, true);
  }

  return stopScheduler("Manual review required", reason, true, true);
}

async function successorCreated(message, sender) {
  const state = await loadState();
  if (!state?.running || sender.tab?.id !== state.workerTabId || !state.pendingSuccessor) return publicState(state);
  if (message.token !== state.token || message.jobId !== state.currentJobId) return publicState(state);

  const info = normalizeConversationUrl(message.conversation?.url || "");
  if (!info || info.id !== message.conversation?.id) {
    return stopScheduler("Successor creation failed", "The new ChatGPT conversation URL could not be verified.", true, true);
  }

  const parent = state.pendingSuccessor.parentChat;
  const successor = {
    ...parent,
    id: info.id,
    url: info.url,
    title: `${parent.title} · continued ${Number(parent.generation || 0) + 1}`.slice(0, 160),
    sentCount: Number(parent.sentCount || 0) + 1,
    status: "Queued",
    lastError: "",
    failed: false,
    retired: false,
    generation: Number(parent.generation || 0) + 1,
    rolloverCount: Number(parent.rolloverCount || 0),
    lastCheckpoint: String(message.checkpoint || state.pendingSuccessor.checkpoint || "").slice(0, 200),
    contextEstimateTokens: Number(message.contextEstimateTokens || 0),
    contextPercent: Number(message.contextPercent || 0)
  };

  state.handoffHistory = [...(state.handoffHistory || []), {
    id: parent.id,
    title: parent.title,
    url: parent.url,
    successorId: successor.id,
    checkpoint: state.pendingSuccessor.checkpoint,
    reason: state.pendingSuccessor.reason,
    at: Date.now()
  }].slice(-50);
  state.chats[state.currentIndex] = successor;
  state.pendingSuccessor = null;
  state.currentJobId = null;
  state.status = `Successor created for ${parent.title}`;
  await saveState(state);
  await saveSuccessorToCatalog(successor);
  await notify(state, "Successor chat ready", `${successor.title} · checkpoint ${successor.lastCheckpoint}`, `successor-${successor.id}`);
  return advanceScheduler(state);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.scope !== MESSAGE_SCOPE) return false;

  const operation = async () => {
    switch (message.type) {
      case "GET_SCHEDULER_STATE":
        return publicState(await loadState());
      case "START_SCHEDULER":
        return startScheduler(message.chats, message.settings);
      case "STOP_SCHEDULER":
        return stopScheduler("Stopped by user", "", true);
      case "CONTENT_READY": {
        const state = await loadState();
        if (state?.running && sender.tab?.id === state.workerTabId) await sendCurrentJob(state);
        return publicState(state);
      }
      case "JOB_STATUS":
        return updateJobStatus(message, sender);
      case "JOB_DONE":
        return finishJob(message, sender);
      case "JOB_ERROR":
        return failJob(message, sender);
      case "JOB_INTERRUPTED":
      case "JOB_ROLLOVER":
        return interruptJob(message, sender);
      case "SUCCESSOR_CREATED":
        return successorCreated(message, sender);
      default:
        return { running: false, status: "Unknown command" };
    }
  };

  enqueue(operation)
    .then(result => sendResponse({ ok: true, ...result }))
    .catch(error => sendResponse({ ok: false, error: error.message }));
  return true;
});

chrome.tabs.onRemoved.addListener(tabId => {
  enqueue(async () => {
    const state = await loadState();
    if (state?.running && state.workerTabId === tabId) {
      await stopScheduler("Stopped", "The managed ChatGPT tab was closed.", false, true);
    }
  }).catch(() => {});
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status !== "complete") return;
  enqueue(async () => {
    const state = await loadState();
    if (state?.running && state.workerTabId === tabId) await sendCurrentJob(state);
  }).catch(() => {});
});

if (typeof module !== "undefined") {
  module.exports = {
    DEFAULTS,
    normalizeSettings,
    normalizeRepository,
    normalizeHandoffFile,
    normalizeConversationUrl,
    isNewChatUrl,
    normalizeChat,
    nextEligibleIndex,
    buildSuccessorPrompt
  };
}
