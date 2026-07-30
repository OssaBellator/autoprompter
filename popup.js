"use strict";

const MESSAGE_SCOPE = "AUTOPROMPTER_RUNTIME";
const SETTINGS_KEY = "autoprompterSettings";
const CATALOG_KEY = "autoprompterChatCatalog";
const SELECTION_KEY = "autoprompterSelectedChatIds";
const DEFAULTS = Object.freeze({
  prompt: "Continue from where you left off. Do not repeat completed material.",
  delaySeconds: 2,
  maxContinuations: 5
});

const elements = Object.fromEntries([
  "prompt", "delaySeconds", "maxContinuations", "refresh", "filter", "selectAll", "selectNone",
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
    delaySeconds: Math.min(60, Math.max(0.5, Number(elements.delaySeconds.value) || DEFAULTS.delaySeconds)),
    maxContinuations: Math.min(50, Math.max(1, Math.round(Number(elements.maxContinuations.value) || DEFAULTS.maxContinuations)))
  };
}

function fillSettings(settings) {
  elements.prompt.value = settings.prompt ?? DEFAULTS.prompt;
  elements.delaySeconds.value = settings.delaySeconds ?? DEFAULTS.delaySeconds;
  elements.maxContinuations.value = settings.maxContinuations ?? DEFAULTS.maxContinuations;
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
    progress.textContent = runtime
      ? `${runtime.sentCount}/${schedulerState.settings.maxContinuations} · ${runtime.status}`
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
  elements.statusDetail.textContent = state?.lastError || (target ? `${total} of ${target} prompts sent · v${state.version}` : `v${chrome.runtime.getManifest().version}`);
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
for (const input of [elements.prompt, elements.delaySeconds, elements.maxContinuations]) {
  input.addEventListener("change", () => saveSettings().catch(() => {}));
}

initialize().catch(error => renderStatus({ ok: false, error: error.message }));
const timer = setInterval(refreshState, 1000);
addEventListener("unload", () => clearInterval(timer));
