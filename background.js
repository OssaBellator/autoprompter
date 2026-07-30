"use strict";

const MESSAGE_SCOPE = "AUTOPROMPTER_RUNTIME";
const SESSION_KEY = "autoprompterScheduler";
const DEFAULTS = Object.freeze({
  prompt: "Continue from where you left off. Do not repeat completed material.",
  delaySeconds: 2,
  maxContinuations: 5
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

function normalizeSettings(settings = {}) {
  return {
    prompt: typeof settings.prompt === "string" && settings.prompt.trim()
      ? settings.prompt.trim()
      : DEFAULTS.prompt,
    delaySeconds: clampNumber(settings.delaySeconds, DEFAULTS.delaySeconds, 0.5, 60),
    maxContinuations: Math.round(
      clampNumber(settings.maxContinuations, DEFAULTS.maxContinuations, 1, 50)
    )
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
    failed: false
  };
}

function nextEligibleIndex(chats, currentIndex, maxContinuations) {
  if (!Array.isArray(chats) || chats.length === 0) return -1;
  for (let offset = 1; offset <= chats.length; offset += 1) {
    const index = (currentIndex + offset + chats.length) % chats.length;
    const chat = chats[index];
    if (!chat.failed && Number(chat.sentCount || 0) < maxContinuations) return index;
  }
  return -1;
}

function publicState(state) {
  if (!state) return {
    running: false,
    status: "Stopped",
    chats: [],
    settings: { ...DEFAULTS },
    version: chrome.runtime.getManifest().version
  };

  return {
    running: Boolean(state.running),
    status: state.status || "Stopped",
    lastError: state.lastError || "",
    workerTabId: state.workerTabId ?? null,
    currentIndex: Number.isInteger(state.currentIndex) ? state.currentIndex : -1,
    chats: Array.isArray(state.chats) ? state.chats : [],
    settings: normalizeSettings(state.settings),
    startedAt: state.startedAt || null,
    version: chrome.runtime.getManifest().version
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

async function removeManagedTab(tabId) {
  if (!Number.isInteger(tabId)) return;
  try {
    await chrome.tabs.remove(tabId);
  } catch {
    // The user may already have closed the tab.
  }
}

async function stopScheduler(reason = "Stopped", error = "", closeWorker = true) {
  const state = await loadState();
  if (!state) return publicState(null);

  const stopped = {
    ...state,
    running: false,
    token: Number(state.token || 0) + 1,
    workerTabId: null,
    currentJobId: null,
    status: reason,
    lastError: error
  };
  stopped.chats = (stopped.chats || []).map(chat => ({
    ...chat,
    status: chat.status === "Finished" || chat.failed ? chat.status : "Stopped"
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

  return publicState(stopped);
}

async function sendCurrentJob(state) {
  if (!state?.running || !Number.isInteger(state.workerTabId)) return;
  const chat = state.chats?.[state.currentIndex];
  if (!chat || !state.currentJobId) return;

  let tab;
  try {
    tab = await chrome.tabs.get(state.workerTabId);
  } catch {
    await stopScheduler("Stopped", "The managed ChatGPT tab was closed.", false);
    return;
  }

  const current = normalizeConversationUrl(tab.url || "");
  if (!current || current.id !== chat.id) return;

  try {
    await chrome.tabs.sendMessage(state.workerTabId, {
      type: "RUN_CHAT_JOB",
      token: state.token,
      jobId: state.currentJobId,
      chat: { id: chat.id, title: chat.title, url: chat.url },
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
    state.chats = state.chats.map(chat => ({
      ...chat,
      status: chat.failed ? "Error" : "Finished"
    }));
    await saveState(state);
    await removeManagedTab(workerTabId);
    return publicState(state);
  }

  const chat = state.chats[nextIndex];
  const jobNumber = Number(chat.sentCount || 0) + 1;
  state.currentIndex = nextIndex;
  state.currentJobId = `${state.token}:${chat.id}:${jobNumber}:${Date.now()}`;
  state.status = `Loading ${chat.title}`;
  state.lastError = "";
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
      return stopScheduler("Stopped", `Could not open ${chat.title}: ${error.message}`, true);
    }
  }
  return publicState(state);
}

async function startScheduler(chats, settings) {
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
    status: "Starting",
    lastError: "",
    settings: normalizeSettings(settings),
    chats: normalizedChats,
    startedAt: Date.now()
  };
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
  state.currentJobId = null;
  await saveState(state);
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
      await stopScheduler("Stopped", "The managed ChatGPT tab was closed.", false);
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
    normalizeConversationUrl,
    normalizeChat,
    nextEligibleIndex
  };
}
