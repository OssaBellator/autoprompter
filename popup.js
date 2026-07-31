"use strict";

const MESSAGE_SCOPE = "AUTOPROMPTER_RUNTIME";
const SETTINGS_KEY = "autoprompterSettings";
const CATALOG_KEY = "autoprompterChatCatalog";
const SELECTION_KEY = "autoprompterSelectedChatIds";
const CHAT_CONFIGS_KEY = "autoprompterChatConfigs";
const MAX_CONCURRENT_CHATS = 12;
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

const elements = Object.fromEntries([
  "prompt", "delaySeconds", "maxContinuations", "notificationsEnabled", "notifyOnPromptDone", "disableCircuitBreaker",
  "continuityPanel", "continuityEnabled", "repository", "handoffFile", "pluginInstruction",
  "contextCapacityTokens", "contextThresholdPercent", "stallMinutes", "maxRollovers",
  "checkpointBeforePrompt", "checkpointAfterPrompt", "refresh", "filter", "selectAll", "selectNone",
  "chatList", "catalogHint", "selectionSummary", "start", "initializeContinuity", "stop", "statusDot",
  "statusText", "statusDetail", "chatConfigPanel", "chatConfigChat", "chatPrompt", "chatContinuityMode",
  "chatRepository", "chatHandoffFile", "chatPluginInstruction", "saveChatConfig", "clearChatConfig",
  "selectionControls", "progressPanel", "progressSummary", "progressList"
].map(id => [id, document.getElementById(id)]));

let catalog = [];
let selectedIds = new Set();
let chatConfigs = {};
let schedulerState = null;
let editorOptionKey = "";
let activeChatEditorId = "";
let loadingChatEditor = false;
let chatConfigPersistTimer = null;
let wasRunning = false;

function isChatGptUrl(value = "") {
  try {
    const host = new URL(value).hostname;
    return host === "chatgpt.com" || host === "chat.openai.com";
  } catch { return false; }
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function formSettings() {
  return {
    prompt: elements.prompt.value.trim() || DEFAULTS.prompt,
    delaySeconds: Math.min(120, Math.max(5, Number(elements.delaySeconds.value) || DEFAULTS.delaySeconds)),
    maxContinuations: Math.min(50, Math.max(1, Math.round(Number(elements.maxContinuations.value) || DEFAULTS.maxContinuations))),
    notificationsEnabled: elements.notificationsEnabled.checked,
    notifyOnPromptDone: elements.notifyOnPromptDone.checked,
    circuitBreakerEnabled: !elements.disableCircuitBreaker.checked,
    continuityEnabled: elements.continuityEnabled.checked,
    repository: elements.repository.value.trim(),
    handoffFile: elements.handoffFile.value.trim() || DEFAULTS.handoffFile,
    pluginInstruction: elements.pluginInstruction.value.trim() || DEFAULTS.pluginInstruction,
    contextCapacityTokens: Math.min(1000000, Math.max(16000, Math.round(Number(elements.contextCapacityTokens.value) || DEFAULTS.contextCapacityTokens))),
    contextThresholdPercent: Math.min(98, Math.max(50, Number(elements.contextThresholdPercent.value) || DEFAULTS.contextThresholdPercent)),
    stallMinutes: Math.min(180, Math.max(5, Number(elements.stallMinutes.value) || DEFAULTS.stallMinutes)),
    checkpointBeforePrompt: elements.checkpointBeforePrompt.checked,
    checkpointAfterPrompt: elements.checkpointAfterPrompt.checked,
    maxRollovers: Math.min(10, Math.max(1, Math.round(Number(elements.maxRollovers.value) || DEFAULTS.maxRollovers)))
  };
}

function fillSettings(settings) {
  const merged = { ...DEFAULTS, ...settings };
  for (const key of ["prompt", "delaySeconds", "maxContinuations", "repository", "handoffFile", "pluginInstruction", "contextCapacityTokens", "contextThresholdPercent", "stallMinutes", "maxRollovers"]) elements[key].value = merged[key];
  for (const key of ["notificationsEnabled", "notifyOnPromptDone", "continuityEnabled", "checkpointBeforePrompt", "checkpointAfterPrompt"]) elements[key].checked = Boolean(merged[key]);
  elements.disableCircuitBreaker.checked = merged.circuitBreakerEnabled === false;
  elements.continuityPanel.open = Boolean(merged.continuityEnabled);
  updateFieldAvailability();
}

async function runtimeMessage(type, extra = {}) {
  return chrome.runtime.sendMessage({ scope: MESSAGE_SCOPE, type, ...extra });
}

async function persistSelection() {
  await chrome.storage.local.set({ [SELECTION_KEY]: [...selectedIds] });
}

async function persistChatConfigs() {
  await chrome.storage.local.set({ [CHAT_CONFIGS_KEY]: chatConfigs });
}

function mergedChatState(chat) {
  return schedulerState?.chats?.find(item => item.id === chat.id) || null;
}

function visibleCatalog() {
  const query = elements.filter.value.trim().toLowerCase();
  if (!query) return catalog;
  return catalog.filter(chat => chat.title.toLowerCase().includes(query));
}

function configFor(chatId) {
  const value = chatConfigs[chatId];
  return value && typeof value === "object" ? value : {};
}

function effectiveSettings(chatId, globalSettings, mode = "work") {
  const config = configFor(chatId);
  const continuityMode = config.continuityMode || "inherit";
  const repository = String(config.repository || globalSettings.repository || "").trim();
  const continuityEnabled = mode === "initialize"
    ? Boolean(repository)
    : continuityMode === "enabled" ? true : continuityMode === "disabled" ? false : globalSettings.continuityEnabled;
  return {
    ...globalSettings,
    prompt: String(config.prompt || globalSettings.prompt).trim(),
    repository,
    handoffFile: String(config.handoffFile || globalSettings.handoffFile).trim(),
    pluginInstruction: String(config.pluginInstruction || globalSettings.pluginInstruction).trim(),
    continuityEnabled
  };
}

function readChatEditorConfig() {
  const existing = configFor(activeChatEditorId);
  const config = {
    prompt: elements.chatPrompt.value.trim(),
    continuityMode: elements.chatContinuityMode.value,
    repository: elements.chatRepository.value.trim(),
    handoffFile: elements.chatHandoffFile.value.trim(),
    pluginInstruction: elements.chatPluginInstruction.value.trim(),
    startInNewChat: existing.startInNewChat === true
  };
  for (const key of Object.keys(config)) if (!config[key] || config[key] === "inherit") delete config[key];
  return config;
}

function captureChatEditor({ persist = false, render = false } = {}) {
  if (loadingChatEditor || !activeChatEditorId) return Promise.resolve();
  const config = readChatEditorConfig();
  if (Object.keys(config).length) chatConfigs[activeChatEditorId] = config;
  else delete chatConfigs[activeChatEditorId];
  if (render) renderCatalog();
  if (persist) return persistChatConfigs();
  clearTimeout(chatConfigPersistTimer);
  chatConfigPersistTimer = setTimeout(() => persistChatConfigs().catch(() => {}), 250);
  return Promise.resolve();
}

function loadChatEditor() {
  const id = elements.chatConfigChat.value;
  const config = configFor(id);
  loadingChatEditor = true;
  activeChatEditorId = id;
  elements.chatPrompt.value = config.prompt || "";
  elements.chatContinuityMode.value = config.continuityMode || "inherit";
  elements.chatRepository.value = config.repository || "";
  elements.chatHandoffFile.value = config.handoffFile || "";
  elements.chatPluginInstruction.value = config.pluginInstruction || "";
  loadingChatEditor = false;
}

function refreshChatEditorOptions() {
  captureChatEditor();
  const selectedChats = catalog.filter(item => selectedIds.has(item.id));
  const nextKey = selectedChats.map(chat => `${chat.id}:${chat.title}`).join("|");
  elements.chatConfigPanel.hidden = selectedChats.length === 0;
  if (nextKey === editorOptionKey) return;
  editorOptionKey = nextKey;
  const previous = elements.chatConfigChat.value;
  elements.chatConfigChat.textContent = "";
  for (const chat of selectedChats) {
    const option = document.createElement("option");
    option.value = chat.id;
    option.textContent = chat.title;
    elements.chatConfigChat.append(option);
  }
  if ([...elements.chatConfigChat.options].some(option => option.value === previous)) elements.chatConfigChat.value = previous;
  loadChatEditor();
}

async function setStartInNewChat(chatId, enabled) {
  const config = { ...configFor(chatId) };
  if (enabled) config.startInNewChat = true;
  else delete config.startInNewChat;
  if (Object.keys(config).length) chatConfigs[chatId] = config;
  else delete chatConfigs[chatId];
  await persistChatConfigs();
  renderCatalog();
}

function renderProgressPanel() {
  const chats = Array.isArray(schedulerState?.chats) ? schedulerState.chats : [];
  elements.progressList.textContent = "";
  const completed = chats.filter(chat => chat.failed || chat.retired || chat.status === "Finished" || chat.status === "Initialized").length;
  const active = chats.filter(chat => chat.currentJobId && !chat.failed).length;
  elements.progressSummary.textContent = `${completed}/${chats.length} complete · ${active} active`;
  for (const chat of chats) {
    const row = document.createElement("div");
    row.className = "progress-row";
    const left = document.createElement("div");
    const title = document.createElement("div");
    title.className = "progress-title";
    title.title = chat.title;
    title.textContent = chat.title;
    const meta = document.createElement("small");
    meta.className = "progress-meta";
    const generation = Number(chat.generation || 0) + 1;
    const context = Number(chat.contextPercent || 0);
    meta.textContent = `${chat.status || "Queued"}${generation > 1 ? ` · chat ${generation}` : ""}${context ? ` · context≈${context.toFixed(1)}%` : ""}`;
    left.append(title, meta);
    const value = document.createElement("div");
    value.className = `progress-value${chat.failed ? " error" : ""}`;
    const limit = Number(chat.settings?.maxContinuations || schedulerState?.settings?.maxContinuations || DEFAULTS.maxContinuations);
    value.textContent = `${Number(chat.sentCount || 0)}/${limit}`;
    row.append(left, value);
    elements.progressList.append(row);
  }
}

function updateFieldAvailability() {
  const running = Boolean(schedulerState?.running);
  const continuity = elements.continuityEnabled.checked;
  const continuityFields = [elements.repository, elements.handoffFile, elements.pluginInstruction, elements.contextCapacityTokens, elements.contextThresholdPercent, elements.stallMinutes, elements.maxRollovers, elements.checkpointBeforePrompt, elements.checkpointAfterPrompt];
  for (const field of continuityFields) field.disabled = running || !continuity;
  for (const field of [elements.prompt, elements.delaySeconds, elements.maxContinuations, elements.notificationsEnabled, elements.notifyOnPromptDone, elements.disableCircuitBreaker, elements.continuityEnabled]) field.disabled = running;
  elements.notifyOnPromptDone.disabled = running || !elements.notificationsEnabled.checked;
  for (const field of [elements.chatConfigChat, elements.chatPrompt, elements.chatContinuityMode, elements.chatRepository, elements.chatHandoffFile, elements.chatPluginInstruction, elements.saveChatConfig, elements.clearChatConfig]) field.disabled = running || elements.chatConfigChat.options.length === 0;
}

function renderCatalog() {
  const running = Boolean(schedulerState?.running);
  elements.selectionControls.hidden = running;
  elements.progressPanel.hidden = !running;

  if (running) {
    renderProgressPanel();
  } else {
    const visible = visibleCatalog();
    elements.chatList.textContent = "";
    if (!visible.length) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = catalog.length ? "No chats match the filter." : "No chats loaded.";
      elements.chatList.append(empty);
    }

    for (const chat of visible) {
      const row = document.createElement("div");
      row.className = "chat-row";
      row.setAttribute("role", "option");
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = selectedIds.has(chat.id);
      checkbox.setAttribute("aria-label", `Select ${chat.title}`);
      checkbox.addEventListener("change", async () => {
        if (checkbox.checked) selectedIds.add(chat.id); else selectedIds.delete(chat.id);
        await persistSelection();
        renderCatalog();
      });

      const titleWrap = document.createElement("span");
      const title = document.createElement("span");
      title.className = "chat-title";
      title.title = chat.title;
      title.textContent = chat.title;
      titleWrap.append(title);
      const config = configFor(chat.id);
      const badges = [];
      if (Object.keys(config).some(key => key !== "startInNewChat")) badges.push("custom settings");
      if (config.startInNewChat) badges.push("new chat first");
      if (badges.length) {
        const badge = document.createElement("span");
        badge.className = config.startInNewChat ? "fresh-start-badge" : "configured-badge";
        badge.textContent = badges.join(" · ");
        titleWrap.append(document.createElement("br"), badge);
      }

      const freshStart = document.createElement("button");
      freshStart.type = "button";
      freshStart.className = `fresh-start-button${config.startInNewChat ? " active" : ""}`;
      freshStart.textContent = "↗";
      freshStart.title = config.startInNewChat
        ? "Start in the existing chat instead"
        : "Start this goal in a new chat when the run begins";
      freshStart.setAttribute("aria-label", freshStart.title);
      freshStart.setAttribute("aria-pressed", String(Boolean(config.startInNewChat)));
      freshStart.addEventListener("click", () => setStartInNewChat(chat.id, !config.startInNewChat).catch(error => renderStatus({ ok: false, error: error.message })));

      row.append(checkbox, titleWrap, freshStart);
      elements.chatList.append(row);
    }
  }

  elements.selectionSummary.textContent = running
    ? `${schedulerState?.chats?.length || 0} selected chats running`
    : `${selectedIds.size} selected · ${catalog.length} discovered · max ${MAX_CONCURRENT_CHATS} concurrent`;
  elements.start.disabled = running || selectedIds.size === 0;
  elements.initializeContinuity.disabled = running || selectedIds.size === 0;
  elements.stop.disabled = !running;
  elements.refresh.disabled = running;
  elements.selectAll.disabled = running;
  elements.selectNone.disabled = running;
  refreshChatEditorOptions();
  updateFieldAvailability();
}

function renderStatus(state) {
  schedulerState = state || null;
  const running = Boolean(state?.running);
  if (running && !wasRunning) elements.progressPanel.open = true;
  wasRunning = running;
  const error = Boolean(state?.lastError) || state?.ok === false;
  elements.statusDot.className = `dot${running ? " running" : ""}${error ? " error" : ""}`;
  elements.statusText.textContent = state?.status || state?.error || "Stopped";
  const total = state?.chats?.reduce((sum, chat) => sum + Number(chat.sentCount || 0), 0) || 0;
  const target = state?.chats?.reduce((sum, chat) => sum + Number(chat.settings?.maxContinuations || state.settings?.maxContinuations || 0), 0) || 0;
  const handoffs = state?.handoffHistory?.length ? ` · ${state.handoffHistory.length} handoff${state.handoffHistory.length === 1 ? "" : "s"}` : "";
  elements.statusDetail.textContent = state?.lastError || state?.pausedReason || (target ? `${total} of ${target} prompts completed${handoffs} · v${state.version}` : `v${chrome.runtime.getManifest().version}`);
  renderCatalog();
}

async function saveSettings() {
  const settings = formSettings();
  fillSettings(settings);
  await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
  return settings;
}

async function refreshCatalog() {
  const tab = await activeTab();
  if (!tab?.id || !isChatGptUrl(tab.url)) throw new Error("Open ChatGPT in the active tab, then press Refresh.");
  let response;
  try { response = await chrome.tabs.sendMessage(tab.id, { type: "GET_CHAT_CATALOG" }); }
  catch { throw new Error("Reload the ChatGPT page once after installing the extension."); }
  const previousById = new Map(catalog.map(chat => [chat.id, chat]));
  const observed = Array.isArray(response?.chats) ? response.chats : [];
  const observedIds = new Set(observed.map(chat => chat.id));
  const now = Date.now();
  catalog = [
    ...observed.map((chat, index) => ({ ...previousById.get(chat.id), ...chat, sidebarIndex: index, lastSeenAt: now })),
    ...catalog.filter(chat => !observedIds.has(chat.id))
  ];
  await chrome.storage.local.set({ [CATALOG_KEY]: catalog });
  elements.catalogHint.textContent = `${response?.chats?.length || 0} chats found in current sidebar order (most recent first). Scroll the ChatGPT sidebar and refresh again to collect more.`;
  renderCatalog();
}

function selectedChats(settings, mode) {
  return catalog.filter(chat => selectedIds.has(chat.id)).map(chat => {
    const startInNewChat = mode === "work" && configFor(chat.id).startInNewChat === true;
    const effective = effectiveSettings(chat.id, settings, mode);
    if (startInNewChat && !effective.repository) effective.continuityEnabled = false;
    return { ...chat, startInNewChat, settings: effective };
  });
}

async function start(mode = "work") {
  try {
    await captureChatEditor({ persist: true });
    const settings = await saveSettings();
    const chats = selectedChats(settings, mode);
    if (chats.length > MAX_CONCURRENT_CHATS) throw new Error(`Select at most ${MAX_CONCURRENT_CHATS} chats for one concurrent run.`);
    if (mode === "work") {
      const missing = chats.filter(chat => chat.settings.continuityEnabled && !chat.settings.repository);
      if (missing.length) throw new Error(`Add a repository for: ${missing.map(chat => chat.title).join(", ")}`);
    }
    if (mode === "initialize") {
      const missing = chats.filter(chat => !chat.settings.repository);
      if (missing.length) throw new Error(`Add a repository for: ${missing.map(chat => chat.title).join(", ")}`);
    }
    renderStatus(await runtimeMessage("START_SCHEDULER", { chats, settings, mode }));
  } catch (error) {
    renderStatus({ ok: false, error: error.message, running: false });
  }
}

async function stop() {
  try { renderStatus(await runtimeMessage("STOP_SCHEDULER")); }
  catch (error) { renderStatus({ ok: false, error: error.message, running: false }); }
}

async function refreshState() {
  try { renderStatus(await runtimeMessage("GET_SCHEDULER_STATE")); }
  catch (error) { renderStatus({ ok: false, error: error.message, running: false }); }
}

async function saveChatEditor() {
  await captureChatEditor({ persist: true, render: true });
}

async function clearChatEditor() {
  const id = elements.chatConfigChat.value;
  if (!id) return;
  delete chatConfigs[id];
  await persistChatConfigs();
  activeChatEditorId = id;
  loadChatEditor();
  renderCatalog();
}

async function initialize() {
  const stored = await chrome.storage.local.get([SETTINGS_KEY, CATALOG_KEY, SELECTION_KEY, CHAT_CONFIGS_KEY]);
  fillSettings({ ...DEFAULTS, ...(stored[SETTINGS_KEY] || {}) });
  catalog = Array.isArray(stored[CATALOG_KEY]) ? stored[CATALOG_KEY] : [];
  selectedIds = new Set(Array.isArray(stored[SELECTION_KEY]) ? stored[SELECTION_KEY] : []);
  chatConfigs = stored[CHAT_CONFIGS_KEY] && typeof stored[CHAT_CONFIGS_KEY] === "object" ? stored[CHAT_CONFIGS_KEY] : {};
  renderCatalog();
  await refreshState();
}

elements.refresh.addEventListener("click", () => refreshCatalog().catch(error => renderStatus({ ok: false, error: error.message })));
elements.filter.addEventListener("input", renderCatalog);
elements.selectAll.addEventListener("click", async () => { for (const chat of visibleCatalog()) selectedIds.add(chat.id); await persistSelection(); renderCatalog(); });
elements.selectNone.addEventListener("click", async () => { selectedIds.clear(); await persistSelection(); renderCatalog(); });
elements.start.addEventListener("click", () => start("work"));
elements.initializeContinuity.addEventListener("click", () => start("initialize"));
elements.stop.addEventListener("click", stop);
elements.chatConfigChat.addEventListener("change", async () => {
  await captureChatEditor({ persist: true });
  loadChatEditor();
});
elements.saveChatConfig.addEventListener("click", () => saveChatEditor().catch(error => renderStatus({ ok: false, error: error.message })));
elements.clearChatConfig.addEventListener("click", () => clearChatEditor().catch(error => renderStatus({ ok: false, error: error.message })));
elements.continuityEnabled.addEventListener("change", () => { elements.continuityPanel.open = elements.continuityEnabled.checked; updateFieldAvailability(); saveSettings().catch(() => {}); });
elements.notificationsEnabled.addEventListener("change", () => { updateFieldAvailability(); saveSettings().catch(() => {}); });
elements.disableCircuitBreaker.addEventListener("change", () => saveSettings().catch(() => {}));
for (const input of [elements.prompt, elements.delaySeconds, elements.maxContinuations, elements.notifyOnPromptDone, elements.repository, elements.handoffFile, elements.pluginInstruction, elements.contextCapacityTokens, elements.contextThresholdPercent, elements.stallMinutes, elements.maxRollovers, elements.checkpointBeforePrompt, elements.checkpointAfterPrompt]) input.addEventListener("change", () => saveSettings().catch(() => {}));
for (const input of [elements.chatPrompt, elements.chatContinuityMode, elements.chatRepository, elements.chatHandoffFile, elements.chatPluginInstruction]) {
  input.addEventListener(input.tagName === "SELECT" ? "change" : "input", () => captureChatEditor());
}

initialize().catch(error => renderStatus({ ok: false, error: error.message }));
const timer = setInterval(refreshState, 1000);
addEventListener("unload", () => clearInterval(timer));
