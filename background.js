"use strict";

const MESSAGE_SCOPE = "AUTOPROMPTER_RUNTIME";
const SESSION_KEY = "autoprompterScheduler";
const SETTINGS_KEY = "autoprompterSettings";
const CATALOG_KEY = "autoprompterChatCatalog";
const SELECTION_KEY = "autoprompterSelectedChatIds";
const CHAT_CONFIGS_KEY = "autoprompterChatConfigs";
const NEW_CHAT_URL = "https://chatgpt.com/";
const MAX_CONCURRENT_CHATS = 12;
const NOTIFICATION_ICON_DATA_URL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAABPUlEQVR4nO2ZMQ7CQAwEF0QPL4UO3kDJT/kBVCehFChxfDeWbqfPaT34HKMczvfrRxNzpAPQWAAdgMYC6AA0FkAHoLEAOgCNBdABaCyADkBzyjjk/XxlHBPi8rjtev6w5+8wWfiSqIjwFahUvBTPExJQrfhGJNf0Q3CzgKq/fmNrPncAHYDGAugANCmb4JK929k/sodwegf0LL7H+dNfAQvIPrD3opR9fpchWH1b/MVXgA5AM72AsovQqDlSdhHqvVA1pr8CFpB9YNbdHTUDvAjRAWgsYOsDo15PUbbmcwdEHqraBZFc4Q6oJiGaZ9fX4ca0n8fXsFYO1VElhiB5nXAB9CxBBdDFS6CACsVLkIAqxUuAgErFS4MFVCteGiigYvHSIAFVi5cGbILVwRchGgugA9BYAB2AxgLoADRfdOpG+jsXCCIAAAAASUVORK5CYII=";

const DEFAULTS = Object.freeze({
  prompt: "Continue from where you left off. Do not repeat completed material.",
  delaySeconds: 10,
  maxContinuations: 5,
  notificationsEnabled: true,
  notifyOnPromptDone: true,
  circuitBreakerEnabled: true,
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
    delaySeconds: clampNumber(settings.delaySeconds, DEFAULTS.delaySeconds, 5, 120),
    maxContinuations: Math.round(
      clampNumber(settings.maxContinuations, DEFAULTS.maxContinuations, 1, 50)
    ),
    notificationsEnabled: settings.notificationsEnabled !== false,
    notifyOnPromptDone: settings.notifyOnPromptDone !== false,
    circuitBreakerEnabled: settings.circuitBreakerEnabled !== false,
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

function normalizeChat(chat, baseSettings = DEFAULTS) {
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
    contextPercent: 0,
    workerTabId: null,
    currentJobId: null,
    pendingSuccessor: null,
    startInNewChat: Boolean(chat?.startInNewChat),
    settings: normalizeSettings({ ...baseSettings, ...(chat?.settings || {}) })
  };
}

function nextEligibleIndex(chats, currentIndex, maxContinuations) {
  if (!Array.isArray(chats) || chats.length === 0) return -1;
  for (let offset = 1; offset <= chats.length; offset += 1) {
    const index = (currentIndex + offset + chats.length) % chats.length;
    const chat = chats[index];
    const limit = Number(chat.settings?.maxContinuations || maxContinuations);
    if (!chat.failed && !chat.retired && Number(chat.sentCount || 0) < limit) return index;
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

function buildFreshStartPrompt(settings, chat, reason) {
  const repository = String(settings?.repository || "").trim();
  const handoffFile = String(settings?.handoffFile || DEFAULTS.handoffFile).trim();
  const workPrompt = String(settings?.prompt || DEFAULTS.prompt).trim();
  const reasonText = String(reason || "the previous conversation cannot safely continue").slice(0, 500);
  return [
    "Start a new conversation for a goal that was previously worked on in another ChatGPT chat.",
    `Previous chat title: ${chat?.title || "Untitled chat"}`,
    `Reason for starting fresh: ${reasonText}`,
    "You cannot access the previous chat transcript. Do not claim that you can, and do not invent missing prior decisions.",
    repository ? `Repository: ${repository}` : "Repository: not configured",
    repository ? `Continuity file: ${handoffFile}` : "Continuity file: not available",
    repository ? String(settings?.pluginInstruction || DEFAULTS.pluginInstruction).trim() : "",
    repository
      ? "Inspect the repository first. If the continuity file exists, use it. If it is missing, reconstruct only what the repository proves, create the continuity file, and commit it before continuing."
      : "No verified repository handoff is available. Use only the explicit work instruction below and ask for any essential missing facts instead of guessing.",
    "",
    "Work instruction:",
    workPrompt
  ].filter(Boolean).join("\n");
}

function chatLimit(state, chat) {
  return Number(chat?.settings?.maxContinuations || state?.settings?.maxContinuations || DEFAULTS.maxContinuations);
}

function isChatEligible(state, chat) {
  return Boolean(chat && !chat.failed && !chat.retired && Number(chat.sentCount || 0) < chatLimit(state, chat));
}

function eligibleChatIndexes(chats, maxContinuations = DEFAULTS.maxContinuations) {
  const state = { settings: { maxContinuations } };
  return (Array.isArray(chats) ? chats : [])
    .map((chat, index) => isChatEligible(state, chat) ? index : -1)
    .filter(index => index >= 0);
}

function findChatIndexByTab(state, tabId) {
  if (!Number.isInteger(tabId)) return -1;
  return state?.chats?.findIndex(chat => chat.workerTabId === tabId) ?? -1;
}

function findChatIndexForMessage(state, message, sender) {
  if (!state?.running || message?.token !== state.token) return -1;
  const index = findChatIndexByTab(state, sender?.tab?.id);
  if (index < 0) return -1;
  return state.chats[index].currentJobId === message.jobId ? index : -1;
}

function updateOverallStatus(state, recent = "") {
  const active = state.chats.filter(chat => Number.isInteger(chat.workerTabId) && chat.currentJobId).length;
  const finished = state.chats.filter(chat => !isChatEligible(state, chat)).length;
  const total = state.chats.length;
  state.status = recent || `Running ${active} chat${active === 1 ? "" : "s"} concurrently · ${finished}/${total} complete`;
}

function publicState(state) {
  const version = chrome.runtime.getManifest().version;
  if (!state) return {
    running: false,
    status: "Stopped",
    chats: [],
    workerTabIds: [],
    settings: { ...DEFAULTS },
    handoffHistory: [],
    version
  };

  return {
    running: Boolean(state.running),
    status: state.status || "Stopped",
    lastError: state.lastError || "",
    pausedReason: state.pausedReason || "",
    workerTabIds: (state.chats || []).map(chat => chat.workerTabId).filter(Number.isInteger),
    chats: Array.isArray(state.chats) ? state.chats : [],
    settings: normalizeSettings(state.settings),
    mode: state.mode || "work",
    startedAt: state.startedAt || null,
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

async function removeManagedTabs(tabIds) {
  await Promise.all([...new Set((tabIds || []).filter(Number.isInteger))].map(removeManagedTab));
}

async function stopScheduler(reason = "Stopped", error = "", closeWorkers = true, notifyUser = false) {
  const state = await loadState();
  if (!state) return publicState(null);

  const tabIds = (state.chats || []).map(chat => chat.workerTabId).filter(Number.isInteger);
  const stopped = {
    ...state,
    running: false,
    token: Number(state.token || 0) + 1,
    status: reason,
    lastError: error,
    pausedReason: error || reason,
    chats: (state.chats || []).map(chat => ({
      ...chat,
      workerTabId: null,
      currentJobId: null,
      pendingSuccessor: null,
      status: chat.status === "Finished" || chat.status === "Initialized" || chat.retired || chat.failed
        ? chat.status
        : "Stopped"
    }))
  };
  await saveState(stopped);

  await Promise.all(tabIds.map(async tabId => {
    try {
      await chrome.tabs.sendMessage(tabId, { type: "CANCEL_CHAT_JOB", token: stopped.token });
    } catch {
      // A worker may be navigating or already closed.
    }
  }));
  if (closeWorkers) await removeManagedTabs(tabIds);

  if (notifyUser) await notify(stopped, "AutoPrompter stopped", error || reason, "stopped");
  return publicState(stopped);
}

async function saveSuccessorToCatalog(chat, parentId = "") {
  const stored = await chrome.storage.local.get([CATALOG_KEY, SELECTION_KEY, CHAT_CONFIGS_KEY]);
  const catalog = Array.isArray(stored[CATALOG_KEY]) ? stored[CATALOG_KEY] : [];
  const successorEntry = { id: chat.id, title: chat.title, url: chat.url, lastSeenAt: Date.now() };
  const nextCatalog = [successorEntry, ...catalog.filter(item => item.id !== chat.id)];
  const selected = new Set(Array.isArray(stored[SELECTION_KEY]) ? stored[SELECTION_KEY] : []);
  if (parentId) selected.delete(parentId);
  selected.add(chat.id);
  const configs = stored[CHAT_CONFIGS_KEY] && typeof stored[CHAT_CONFIGS_KEY] === "object"
    ? { ...stored[CHAT_CONFIGS_KEY] }
    : {};
  if (parentId && configs[parentId] && !configs[chat.id]) {
    const inherited = { ...configs[parentId] };
    delete inherited.startInNewChat;
    if (Object.keys(inherited).length) configs[chat.id] = inherited;
  }
  await chrome.storage.local.set({
    [CATALOG_KEY]: nextCatalog,
    [SELECTION_KEY]: [...selected],
    [CHAT_CONFIGS_KEY]: configs
  });
}

async function sendChatJob(state, index) {
  const chat = state?.chats?.[index];
  if (!state?.running || !chat || !Number.isInteger(chat.workerTabId) || !chat.currentJobId) return;

  let tab;
  try {
    tab = await chrome.tabs.get(chat.workerTabId);
  } catch {
    await failChatWorker(state, index, "The managed ChatGPT tab was closed.", false);
    return;
  }

  if (chat.pendingSuccessor) {
    if (!isNewChatUrl(tab.url || "")) return;
    try {
      await chrome.tabs.sendMessage(chat.workerTabId, {
        type: "RUN_SUCCESSOR_JOB",
        token: state.token,
        jobId: chat.currentJobId,
        parentChat: chat.pendingSuccessor.parentChat,
        settings: chat.pendingSuccessor.settings || chat.settings || state.settings,
        prompt: chat.pendingSuccessor.prompt,
        checkpoint: chat.pendingSuccessor.checkpoint,
        reason: chat.pendingSuccessor.reason
      });
    } catch {
      // The content script will announce readiness after navigation settles.
    }
    return;
  }

  const current = normalizeConversationUrl(tab.url || "");
  if (!current || current.id !== chat.id) return;

  try {
    await chrome.tabs.sendMessage(chat.workerTabId, {
      type: "RUN_CHAT_JOB",
      token: state.token,
      jobId: chat.currentJobId,
      chat: { ...chat },
      settings: chat.settings || state.settings,
      mode: state.mode || "work"
    });
  } catch {
    // The content script will announce readiness after navigation settles.
  }
}

async function maybeFinishScheduler(state) {
  if (!state?.running) return publicState(state);
  if (state.chats.some(chat => isChatEligible(state, chat))) {
    updateOverallStatus(state);
    await saveState(state);
    return publicState(state);
  }

  const tabIds = state.chats.map(chat => chat.workerTabId).filter(Number.isInteger);
  state.running = false;
  state.status = state.chats.some(chat => chat.failed) ? "Finished with errors" : "Finished";
  state.chats = state.chats.map(chat => ({
    ...chat,
    workerTabId: null,
    currentJobId: null,
    pendingSuccessor: null,
    status: chat.failed ? "Error" : (chat.retired ? chat.status : (state.mode === "initialize" ? "Initialized" : "Finished"))
  }));
  await saveState(state);
  await removeManagedTabs(tabIds);
  await notify(state, "AutoPrompter finished", state.status, "finished");
  return publicState(state);
}

async function failChatWorker(state, index, error, closeWorker = true) {
  const chat = state?.chats?.[index];
  if (!chat) return publicState(state);
  const tabId = chat.workerTabId;
  chat.failed = true;
  chat.status = "Error";
  chat.lastError = String(error || "The chat job failed.").slice(0, 500);
  chat.workerTabId = null;
  chat.currentJobId = null;
  chat.pendingSuccessor = null;
  state.lastError = `${chat.title}: ${chat.lastError}`;
  updateOverallStatus(state, `${chat.title}: Error`);
  await saveState(state);
  if (closeWorker) await removeManagedTab(tabId);
  await notify(state, `AutoPrompter error: ${chat.title}`, chat.lastError, `error-${chat.id}`);
  return maybeFinishScheduler(state);
}

async function queueNextChatJob(state, index) {
  const chat = state?.chats?.[index];
  if (!state?.running || !isChatEligible(state, chat)) return maybeFinishScheduler(state);

  const jobNumber = Number(chat.sentCount || 0) + 1;
  chat.currentJobId = `${state.token}:${chat.chainId}:${jobNumber}:${Date.now()}`;
  chat.pendingSuccessor = null;
  chat.status = "Loading";
  chat.lastError = "";
  state.lastError = "";
  state.pausedReason = "";
  updateOverallStatus(state, `${chat.title}: Loading next prompt`);
  await saveState(state);

  let tab = null;
  if (Number.isInteger(chat.workerTabId)) {
    try { tab = await chrome.tabs.get(chat.workerTabId); } catch { tab = null; }
  }
  if (!tab) {
    try {
      tab = await chrome.tabs.create({ url: "about:blank", active: false });
      chat.workerTabId = tab.id;
      await saveState(state);
    } catch (error) {
      return failChatWorker(state, index, `Could not create a managed ChatGPT tab: ${error.message}`, false);
    }
  }

  const current = normalizeConversationUrl(tab.url || "");
  if (current?.id === chat.id && tab.status === "complete") {
    await sendChatJob(state, index);
    return publicState(state);
  }

  try {
    await chrome.tabs.update(chat.workerTabId, { url: chat.url, active: false });
  } catch (error) {
    return failChatWorker(state, index, `Could not open ${chat.title}: ${error.message}`);
  }
  return publicState(state);
}

async function launchAllWorkers(state) {
  const indexes = eligibleChatIndexes(state.chats, state.settings.maxContinuations);
  for (const index of indexes) {
    const chat = state.chats[index];
    chat.lastError = "";
    if (state.mode === "work" && chat.startInNewChat) {
      const reason = "This chat was marked to start in a new conversation before work begins.";
      chat.currentJobId = `${state.token}:fresh:${chat.chainId}:1:${Date.now()}:${index}`;
      const resumeSettings = chat.settings || state.settings;
      chat.pendingSuccessor = {
        parentChat: { ...chat, startInNewChat: false, pendingSuccessor: null },
        checkpoint: "",
        reason,
        prompt: buildFreshStartPrompt(resumeSettings, chat, reason),
        settings: { ...resumeSettings, checkpointAfterPrompt: false },
        resumeSettings,
        kind: "forced_start",
        verified: false
      };
      chat.status = "Opening new chat";
    } else {
      chat.currentJobId = `${state.token}:${chat.chainId}:1:${Date.now()}:${index}`;
      chat.pendingSuccessor = null;
      chat.status = "Opening worker";
    }
  }
  updateOverallStatus(state, `Opening ${indexes.length} chats concurrently`);
  await saveState(state);

  const createResults = await Promise.allSettled(indexes.map(() => chrome.tabs.create({ url: "about:blank", active: false })));
  for (let offset = 0; offset < indexes.length; offset += 1) {
    const index = indexes[offset];
    const result = createResults[offset];
    if (result.status === "fulfilled" && Number.isInteger(result.value?.id)) {
      state.chats[index].workerTabId = result.value.id;
      state.chats[index].status = "Loading";
    } else {
      state.chats[index].failed = true;
      state.chats[index].status = "Error";
      state.chats[index].lastError = `Could not create a managed ChatGPT tab: ${result.reason?.message || result.reason || "unknown error"}`;
      state.chats[index].currentJobId = null;
    }
  }
  updateOverallStatus(state);
  await saveState(state);

  const navigations = indexes
    .filter(index => Number.isInteger(state.chats[index].workerTabId))
    .map(async index => {
      const chat = state.chats[index];
      try {
        const targetUrl = chat.pendingSuccessor ? NEW_CHAT_URL : chat.url;
        await chrome.tabs.update(chat.workerTabId, { url: targetUrl, active: false });
      } catch (error) {
        const tabId = chat.workerTabId;
        chat.workerTabId = null;
        chat.currentJobId = null;
        chat.failed = true;
        chat.status = "Error";
        chat.lastError = `Could not open ${chat.title}: ${error.message}`;
        await removeManagedTab(tabId);
      }
    });
  await Promise.all(navigations);
  updateOverallStatus(state);
  await saveState(state);

  for (const chat of state.chats.filter(item => item.failed && item.lastError)) {
    await notify(state, `AutoPrompter error: ${chat.title}`, chat.lastError, `launch-${chat.id}`);
  }
  return maybeFinishScheduler(state);
}

async function startScheduler(chats, settings, mode = "work") {
  const normalizedSettings = normalizeSettings(settings);
  const normalizedChats = [];
  const seen = new Set();
  for (const chat of Array.isArray(chats) ? chats : []) {
    const normalized = normalizeChat(chat, normalizedSettings);
    if (!normalized || seen.has(normalized.id)) continue;
    if (chat?.settings?.continuityEnabled && !normalized.settings.repository) {
      throw new Error(`Repository continuity requires a valid GitHub owner/repository value for ${normalized.title}.`);
    }
    seen.add(normalized.id);
    normalizedChats.push(normalized);
  }
  if (normalizedChats.length === 0) throw new Error("Select at least one ChatGPT conversation.");
  if (normalizedChats.length > MAX_CONCURRENT_CHATS) {
    throw new Error(`Select at most ${MAX_CONCURRENT_CHATS} chats for one concurrent run.`);
  }

  const normalizedMode = mode === "initialize" ? "initialize" : "work";
  if (normalizedMode === "initialize") {
    for (const chat of normalizedChats) {
      if (!chat.settings.continuityEnabled || !chat.settings.repository) {
        throw new Error(`Continuity initialization requires a valid repository for ${chat.title}.`);
      }
      chat.settings.maxContinuations = 1;
    }
  }

  const previous = await loadState();
  if (previous?.running) await stopScheduler("Restarted", "", true);

  const state = {
    running: true,
    token: Math.max(Date.now(), Number(previous?.token || 0) + 2),
    status: "Starting concurrent workers",
    lastError: "",
    pausedReason: "",
    settings: normalizedSettings,
    mode: normalizedMode,
    chats: normalizedChats,
    handoffHistory: [],
    startedAt: Date.now()
  };
  await clearBadge();
  await saveState(state);
  return launchAllWorkers(state);
}

async function updateJobStatus(message, sender) {
  const state = await loadState();
  const index = findChatIndexForMessage(state, message, sender);
  if (index < 0) return publicState(state);
  const chat = state.chats[index];
  chat.status = String(message.status || "Working").slice(0, 160);
  if (Number.isFinite(message.contextEstimateTokens)) chat.contextEstimateTokens = Math.round(message.contextEstimateTokens);
  if (Number.isFinite(message.contextPercent)) chat.contextPercent = Math.round(message.contextPercent * 10) / 10;
  updateOverallStatus(state, `${chat.title}: ${chat.status}`);
  await saveState(state);
  return publicState(state);
}

async function finishJob(message, sender) {
  const state = await loadState();
  const index = findChatIndexForMessage(state, message, sender);
  if (index < 0) return publicState(state);
  const chat = state.chats[index];
  chat.sentCount = Number(chat.sentCount || 0) + 1;
  chat.currentJobId = null;
  chat.lastError = "";
  if (message.checkpoint) chat.lastCheckpoint = String(message.checkpoint).slice(0, 200);
  if (Number.isFinite(message.contextEstimateTokens)) chat.contextEstimateTokens = Math.round(message.contextEstimateTokens);
  if (Number.isFinite(message.contextPercent)) chat.contextPercent = Math.round(message.contextPercent * 10) / 10;

  const completed = Boolean(message.initialized) || !isChatEligible(state, chat);
  chat.status = message.initialized ? "Initialized" : (completed ? "Finished" : "Queued");
  updateOverallStatus(state, `${chat.title}: ${chat.status}`);
  await saveState(state);

  if (state.settings.notifyOnPromptDone) {
    await notify(
      state,
      message.initialized ? `Continuity initialized: ${chat.title}` : `Prompt completed: ${chat.title}`,
      `${chat.sentCount}/${chatLimit(state, chat)}${chat.lastCheckpoint ? ` · checkpoint ${chat.lastCheckpoint}` : ""}`,
      `prompt-${chat.id}`
    );
  }

  if (completed) {
    const tabId = chat.workerTabId;
    chat.workerTabId = null;
    await saveState(state);
    await removeManagedTab(tabId);
    return maybeFinishScheduler(state);
  }
  return queueNextChatJob(state, index);
}

async function failJob(message, sender) {
  const state = await loadState();
  const index = findChatIndexForMessage(state, message, sender);
  if (index < 0) return publicState(state);
  return failChatWorker(state, index, message.error || "The chat job failed.");
}

async function beginSuccessor(state, index, message) {
  const chat = state.chats[index];
  const chatSettings = chat.settings || state.settings;
  const checkpoint = String(message.checkpoint || chat.lastCheckpoint || "").slice(0, 200);
  const reason = String(message.reason || message.message || "Continuity rollover requested.").slice(0, 500);
  const rolloverCount = Number(chat.rolloverCount || 0) + 1;
  const kind = String(message.kind || "unknown");
  const verified = Boolean(chatSettings.continuityEnabled && chatSettings.repository && checkpoint);
  const bestEffortAllowed = Boolean(message.forceFreshStart || kind === "context_limit");

  if (!verified && !bestEffortAllowed) {
    return failChatWorker(state, index, `Continuity handoff required: ${reason}`);
  }
  if (rolloverCount > chatSettings.maxRollovers) {
    return failChatWorker(state, index, `The chat reached the configured limit of ${chatSettings.maxRollovers} successor chats.`);
  }

  chat.status = verified ? "Creating verified successor" : "Creating best-effort successor";
  chat.lastCheckpoint = checkpoint;
  chat.rolloverCount = rolloverCount;
  chat.currentJobId = `${state.token}:successor:${chat.chainId}:${rolloverCount}:${Date.now()}`;
  chat.pendingSuccessor = {
    parentChat: { ...chat, startInNewChat: false, pendingSuccessor: null },
    checkpoint,
    reason,
    prompt: verified
      ? buildSuccessorPrompt(chatSettings, chat, checkpoint, reason)
      : buildFreshStartPrompt(chatSettings, chat, reason),
    settings: verified ? chatSettings : { ...chatSettings, checkpointAfterPrompt: false },
    resumeSettings: chatSettings,
    kind: verified ? "verified_handoff" : "best_effort",
    verified
  };
  updateOverallStatus(state, `${chat.status} for ${chat.title}`);
  await saveState(state);
  await notify(
    state,
    verified ? `Creating successor: ${chat.title}` : `Creating fresh chat: ${chat.title}`,
    verified ? `${reason} · checkpoint ${checkpoint}` : `${reason} · no verified handoff was available`,
    `rollover-${chat.id}`
  );

  let tab = null;
  if (Number.isInteger(chat.workerTabId)) {
    try { tab = await chrome.tabs.get(chat.workerTabId); } catch { tab = null; }
  }
  if (!tab) {
    try {
      tab = await chrome.tabs.create({ url: "about:blank", active: false });
      chat.workerTabId = tab.id;
      await saveState(state);
    } catch (error) {
      return failChatWorker(state, index, `Could not create a successor tab: ${error.message}`, false);
    }
  }
  try {
    await chrome.tabs.update(chat.workerTabId, { url: NEW_CHAT_URL, active: false });
  } catch (error) {
    return failChatWorker(state, index, `Could not open a new ChatGPT conversation: ${error.message}`);
  }
  return publicState(state);
}

async function interruptJob(message, sender) {
  const state = await loadState();
  const index = findChatIndexForMessage(state, message, sender);
  if (index < 0) return publicState(state);
  const chat = state.chats[index];

  if (message.checkpoint) chat.lastCheckpoint = String(message.checkpoint).slice(0, 200);
  if (Number.isFinite(message.contextEstimateTokens)) chat.contextEstimateTokens = Math.round(message.contextEstimateTokens);
  if (Number.isFinite(message.contextPercent)) chat.contextPercent = Math.round(message.contextPercent * 10) / 10;
  const kind = String(message.kind || "unknown");
  const reason = String(message.message || "ChatGPT interrupted the job.").slice(0, 500);

  if (["context_limit", "stalled", "content_removed"].includes(kind)) {
    return beginSuccessor(state, index, { ...message, kind, reason });
  }

  // A restriction in any managed tab stops the entire concurrent run unless the
  // user has disabled heuristic circuit-breaker detection in settings.
  if (["rate_limit", "account_restriction", "safety_restriction"].includes(kind)) {
    return stopScheduler("Circuit breaker activated", `${chat.title}: ${reason}`, true, true);
  }

  return failChatWorker(state, index, `Manual review required: ${reason}`);
}

async function successorCreated(message, sender) {
  const state = await loadState();
  const index = findChatIndexForMessage(state, message, sender);
  if (index < 0) return publicState(state);
  const current = state.chats[index];
  if (!current.pendingSuccessor) return publicState(state);

  const info = normalizeConversationUrl(message.conversation?.url || "");
  if (!info || info.id !== message.conversation?.id) {
    return failChatWorker(state, index, "The new ChatGPT conversation URL could not be verified.");
  }

  const pending = current.pendingSuccessor;
  const parent = pending.parentChat;
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
    lastCheckpoint: String(message.checkpoint || pending.checkpoint || "").slice(0, 200),
    contextEstimateTokens: Number(message.contextEstimateTokens || 0),
    contextPercent: Number(message.contextPercent || 0),
    workerTabId: current.workerTabId,
    currentJobId: null,
    pendingSuccessor: null,
    startInNewChat: false,
    settings: pending.resumeSettings || current.settings || parent.settings || state.settings
  };

  state.handoffHistory = [...(state.handoffHistory || []), {
    id: parent.id,
    title: parent.title,
    url: parent.url,
    successorId: successor.id,
    checkpoint: pending.checkpoint,
    reason: pending.reason,
    kind: pending.kind || "successor",
    verified: Boolean(pending.verified),
    at: Date.now()
  }].slice(-50);
  state.chats[index] = successor;
  updateOverallStatus(state, `Successor created for ${parent.title}`);
  await saveState(state);
  await saveSuccessorToCatalog(successor, parent.id);
  const successorDetail = successor.lastCheckpoint
    ? `${successor.title} · checkpoint ${successor.lastCheckpoint}`
    : `${successor.title} · best-effort fresh start`;
  await notify(state, "Successor chat ready", successorDetail, `successor-${successor.id}`);

  if (!isChatEligible(state, successor)) {
    const tabId = successor.workerTabId;
    successor.workerTabId = null;
    successor.status = "Finished";
    await saveState(state);
    await removeManagedTab(tabId);
    return maybeFinishScheduler(state);
  }
  return queueNextChatJob(state, index);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.scope !== MESSAGE_SCOPE) return false;

  const operation = async () => {
    switch (message.type) {
      case "GET_SCHEDULER_STATE":
        return publicState(await loadState());
      case "START_SCHEDULER":
        return startScheduler(message.chats, message.settings, message.mode);
      case "STOP_SCHEDULER":
        return stopScheduler("Stopped by user", "", true);
      case "CONTENT_READY": {
        const state = await loadState();
        const index = findChatIndexByTab(state, sender.tab?.id);
        if (state?.running && index >= 0) await sendChatJob(state, index);
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
    const index = findChatIndexByTab(state, tabId);
    if (state?.running && index >= 0) {
      state.chats[index].workerTabId = null;
      await failChatWorker(state, index, "The managed ChatGPT tab was closed.", false);
    }
  }).catch(() => {});
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status !== "complete") return;
  enqueue(async () => {
    const state = await loadState();
    const index = findChatIndexByTab(state, tabId);
    if (state?.running && index >= 0) await sendChatJob(state, index);
  }).catch(() => {});
});

if (typeof module !== "undefined") {
  module.exports = {
    DEFAULTS,
    MAX_CONCURRENT_CHATS,
    normalizeSettings,
    normalizeRepository,
    normalizeHandoffFile,
    normalizeConversationUrl,
    isNewChatUrl,
    normalizeChat,
    nextEligibleIndex,
    eligibleChatIndexes,
    isChatEligible,
    buildSuccessorPrompt,
    buildFreshStartPrompt
  };
}
