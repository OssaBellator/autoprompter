"use strict";

const MESSAGE_SCOPE = "AUTOPROMPTER_RUNTIME";
const SETTINGS_KEY = "autoprompterSettings";
const CATALOG_KEY = "autoprompterChatCatalog";
const SELECTION_KEY = "autoprompterSelectedChatIds";
const DEFAULTS = Object.freeze({
  prompt: "Continue from where you left off. Do not repeat completed material.",
  delaySeconds: 10,
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

const elements = Object.fromEntries([
  "prompt", "delaySeconds", "maxContinuations", "notificationsEnabled", "notifyOnPromptDone",
  "continuityPanel", "continuityEnabled", "repository", "handoffFile", "pluginInstruction",
  "contextCapacityTokens", "contextThresholdPercent", "stallMinutes", "maxRollovers",
  "checkpointBeforePrompt", "checkpointAfterPrompt", "refresh", "filter", "selectAll", "selectNone",
  "chatList", "catalogHint", "selectionSummary", "start", "stop", "statusDot", "statusText", "statusDetail"
].map(id => [id, document.getElementById(id)]));

let catalog = [];
let selectedIds = new Set();
let schedulerState = null;

function isChatGptUrl(value = "") {
  try {
    const host = new URL(value).hostname;
    return host === "chatgpt.com" || host === "chat.openai.com";
  } catch {
    return false;
  }
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
  for (const key of [
    "prompt", "delaySeconds", "maxContinuations", "repository", "handoffFile", "pluginInstruction",
    "contextCapacityTokens", "contextThresholdPercent", "stallMinutes", "maxRollovers"
  ]) elements[key].value = merged[key];
  for (const key of [
    "notificationsEnabled", "notifyOnPromptDone", "continuityEnabled",
    "checkpointBeforePrompt", "checkpointAfterPrompt"
  ]) elements[key].checked = Boolean(merged[key]);
  elements.continuityPanel.open = Boolean(merged.continuityEnabled);
  updateFieldAvailability();
}

async function runtimeMessage(type, extra = {}) {
  return chrome.runtime.sendMessage({ scope: MESSAGE_SCOPE, type, ...extra });
}

async function persistSelection() {
  await chrome.storage.local.set({ [SELECTION_KEY]: [...selectedIds] });
}

function mergedChatState(chat) {
  return schedulerState?.chats?.find(item => item.id === chat.id) || null;
}

function visibleCatalog() {
  const query = elements.filter.value.trim().toLowerCase();
  if (!query) return catalog;
  return catalog.filter(chat => chat.title.toLowerCase().includes(query));
}

function updateFieldAvailability() {
  const running = Boolean(schedulerState?.running);
  const continuity = elements.continuityEnabled.checked;
  const continuityFields = [
    elements.repository, elements.handoffFile, elements.pluginInstruction, elements.contextCapacityTokens,
    elements.contextThresholdPercent, elements.stallMinutes, elements.maxRollovers,
    elements.checkpointBeforePrompt, elements.checkpointAfterPrompt
  ];
  for (const field of continuityFields) field.disabled = running || !continuity;
  for (const field of [
    elements.prompt, elements.delaySeconds, elements.maxContinuations, elements.notificationsEnabled,
    elements.notifyOnPromptDone, elements.continuityEnabled
  ]) field.disabled = running;
  elements.notifyOnPromptDone.disabled = running || !elements.notificationsEnabled.checked;
}

function renderCatalog() {
  const visible = visibleCatalog();
  elements.chatList.textContent = "";
  if (!visible.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = catalog.length ? "No chats match the filter." : "No chats loaded.";
    elements.chatList.append(empty);
  }

  for (const chat of visible) {
    const row = document.createElement("label");
    row.className = "chat-row";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = selectedIds.has(chat.id);
    checkbox.disabled = Boolean(schedulerState?.running);
    checkbox.addEventListener("change", async () => {
      if (checkbox.checked) selectedIds.add(chat.id); else selectedIds.delete(chat.id);
      await persistSelection();
      renderCatalog();
    });

    const title = document.createElement("span");
    title.className = "chat-title";
    title.title = chat.title;
    title.textContent = chat.title;

    const runtime = mergedChatState(chat);
    const progress = document.createElement("span");
    progress.className = `chat-progress${runtime?.failed ? " error" : ""}`;
    const context = runtime?.contextPercent ? ` · ctx≈${Number(runtime.contextPercent).toFixed(1)}%` : "";
    const generation = runtime?.generation ? ` · gen ${runtime.generation + 1}` : "";
    progress.textContent = runtime
      ? `${runtime.sentCount}/${schedulerState.settings.maxContinuations} · ${runtime.status}${context}${generation}`
      : "";

    row.append(checkbox, title, progress);
    elements.chatList.append(row);
  }

  elements.selectionSummary.textContent = `${selectedIds.size} selected · ${catalog.length} discovered`;
  const running = Boolean(schedulerState?.running);
  elements.start.disabled = running || selectedIds.size === 0;
  elements.stop.disabled = !running;
  elements.selectAll.disabled = running;
  elements.selectNone.disabled = running;
  updateFieldAvailability();
}

function renderStatus(state) {
  schedulerState = state || null;
  const running = Boolean(state?.running);
  const error = Boolean(state?.lastError) || state?.ok === false;
  elements.statusDot.className = `dot${running ? " running" : ""}${error ? " error" : ""}`;
  elements.statusText.textContent = state?.status || state?.error || "Stopped";
  const total = state?.chats?.reduce((sum, chat) => sum + Number(chat.sentCount || 0), 0) || 0;
  const target = state?.chats?.length && state?.settings
    ? state.chats.length * state.settings.maxContinuations
    : 0;
  const handoffs = state?.handoffHistory?.length ? ` · ${state.handoffHistory.length} handoff${state.handoffHistory.length === 1 ? "" : "s"}` : "";
  elements.statusDetail.textContent = state?.lastError || state?.pausedReason || (target
    ? `${total} of ${target} work prompts completed${handoffs} · v${state.version}`
    : `v${chrome.runtime.getManifest().version}`);
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
  try {
    response = await chrome.tabs.sendMessage(tab.id, { type: "GET_CHAT_CATALOG" });
  } catch {
    throw new Error("Reload the ChatGPT page once after installing the extension.");
  }
  const byId = new Map(catalog.map(chat => [chat.id, chat]));
  for (const chat of response?.chats || []) byId.set(chat.id, chat);
  catalog = [...byId.values()].sort((left, right) => left.title.localeCompare(right.title));
  await chrome.storage.local.set({ [CATALOG_KEY]: catalog });
  elements.catalogHint.textContent = `${response?.chats?.length || 0} chats found in the current page. Scroll the ChatGPT sidebar and refresh again to collect more.`;
  renderCatalog();
}

async function start() {
  try {
    const settings = await saveSettings();
    if (settings.continuityEnabled && !settings.repository) {
      throw new Error("Enter a GitHub repository before enabling continuity.");
    }
    const chats = catalog.filter(chat => selectedIds.has(chat.id));
    const response = await runtimeMessage("START_SCHEDULER", { chats, settings });
    renderStatus(response);
  } catch (error) {
    renderStatus({ ok: false, error: error.message, running: false });
  }
}

async function stop() {
  try {
    renderStatus(await runtimeMessage("STOP_SCHEDULER"));
  } catch (error) {
    renderStatus({ ok: false, error: error.message, running: false });
  }
}

async function refreshState() {
  try {
    renderStatus(await runtimeMessage("GET_SCHEDULER_STATE"));
  } catch (error) {
    renderStatus({ ok: false, error: error.message, running: false });
  }
}

async function initialize() {
  const stored = await chrome.storage.local.get([SETTINGS_KEY, CATALOG_KEY, SELECTION_KEY]);
  fillSettings({ ...DEFAULTS, ...(stored[SETTINGS_KEY] || {}) });
  catalog = Array.isArray(stored[CATALOG_KEY]) ? stored[CATALOG_KEY] : [];
  selectedIds = new Set(Array.isArray(stored[SELECTION_KEY]) ? stored[SELECTION_KEY] : []);
  renderCatalog();
  await refreshState();
}

elements.refresh.addEventListener("click", () => refreshCatalog().catch(error => renderStatus({ ok: false, error: error.message })));
elements.filter.addEventListener("input", renderCatalog);
elements.selectAll.addEventListener("click", async () => {
  for (const chat of visibleCatalog()) selectedIds.add(chat.id);
  await persistSelection();
  renderCatalog();
});
elements.selectNone.addEventListener("click", async () => {
  selectedIds.clear();
  await persistSelection();
  renderCatalog();
});
elements.start.addEventListener("click", start);
elements.stop.addEventListener("click", stop);
elements.continuityEnabled.addEventListener("change", () => {
  elements.continuityPanel.open = elements.continuityEnabled.checked;
  updateFieldAvailability();
  saveSettings().catch(() => {});
});
elements.notificationsEnabled.addEventListener("change", () => {
  updateFieldAvailability();
  saveSettings().catch(() => {});
});
for (const input of [
  elements.prompt, elements.delaySeconds, elements.maxContinuations, elements.notifyOnPromptDone,
  elements.repository, elements.handoffFile, elements.pluginInstruction, elements.contextCapacityTokens,
  elements.contextThresholdPercent, elements.stallMinutes, elements.maxRollovers,
  elements.checkpointBeforePrompt, elements.checkpointAfterPrompt
]) input.addEventListener("change", () => saveSettings().catch(() => {}));

initialize().catch(error => renderStatus({ ok: false, error: error.message }));
const timer = setInterval(refreshState, 1000);
addEventListener("unload", () => clearInterval(timer));
