"use strict";

(function attachProjectFoldersUi(root, factory) {
  const api = factory(root, root.AutoPrompterProjectFolders);
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.AutoPrompterProjectFoldersUi = api;
})(typeof globalThis !== "undefined" ? globalThis : self, (root, Folders) => {
  const INSTALL_FLAG = Symbol.for("autoprompter.projectFoldersUi.installed");
  const SEND_FLAG = Symbol.for("autoprompter.projectFoldersUi.sendInstalled");
  let store = null;
  let catalog = [];
  let activeProjectId = "";
  let noteTimer = null;
  let currentNoteChatId = "";

  function element(id) {
    return root.document?.getElementById(id) || null;
  }

  function escapeHtml(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  async function readState() {
    const values = await root.chrome.storage.local.get([
      Folders.STORE_KEY,
      Folders.ACTIVE_KEY,
      Folders.CHAT_NOTES_KEY,
      Folders.LEGACY_PROJECTS_KEY,
      Folders.CATALOG_KEY,
      Folders.SELECTION_KEY
    ]);
    store = Folders.migrateLegacyStore(values[Folders.STORE_KEY], values[Folders.LEGACY_PROJECTS_KEY]);
    catalog = Array.isArray(values[Folders.CATALOG_KEY]) ? values[Folders.CATALOG_KEY] : [];
    activeProjectId = String(values[Folders.ACTIVE_KEY] || "");
    if (!store.projects[activeProjectId]) activeProjectId = Object.keys(store.projects)[0] || "";
    await root.chrome.storage.local.set({
      [Folders.STORE_KEY]: store,
      [Folders.ACTIVE_KEY]: activeProjectId
    });
    return values;
  }

  function installSchedulerEnrichment() {
    const runtime = root.chrome?.runtime;
    if (!runtime?.sendMessage || runtime[SEND_FLAG]) return false;
    const originalSendMessage = runtime.sendMessage.bind(runtime);
    runtime.sendMessage = async (...args) => {
      const messageIndex = args.findIndex(value => value && typeof value === "object" && !Array.isArray(value));
      if (messageIndex >= 0 && args[messageIndex]?.scope === "AUTOPROMPTER_RUNTIME" && args[messageIndex]?.type === "START_SCHEDULER") {
        const values = await root.chrome.storage.local.get([
          Folders.STORE_KEY,
          Folders.ACTIVE_KEY,
          Folders.CHAT_NOTES_KEY
        ]);
        const next = Folders.enrichSchedulerMessage(args[messageIndex], {
          projectStore: values[Folders.STORE_KEY],
          activeProjectId: values[Folders.ACTIVE_KEY],
          chatNotes: values[Folders.CHAT_NOTES_KEY]
        });
        args[messageIndex] = next;
      }
      return originalSendMessage(...args);
    };
    Object.defineProperty(runtime, SEND_FLAG, { value: true });
    return true;
  }

  async function loadNote(chatId) {
    const notes = (await root.chrome.storage.local.get(Folders.CHAT_NOTES_KEY))[Folders.CHAT_NOTES_KEY] || {};
    currentNoteChatId = String(chatId || "");
    const textarea = element("chatNotes");
    if (textarea) textarea.value = currentNoteChatId ? String(notes[currentNoteChatId] || "") : "";
  }

  async function saveCurrentNote() {
    const textarea = element("chatNotes");
    if (!textarea || !currentNoteChatId) return;
    const values = await root.chrome.storage.local.get(Folders.CHAT_NOTES_KEY);
    const notes = values[Folders.CHAT_NOTES_KEY] && typeof values[Folders.CHAT_NOTES_KEY] === "object"
      ? { ...values[Folders.CHAT_NOTES_KEY] }
      : {};
    const value = textarea.value.trim().slice(0, Folders.MAX_NOTES);
    if (value) notes[currentNoteChatId] = value;
    else delete notes[currentNoteChatId];
    await root.chrome.storage.local.set({ [Folders.CHAT_NOTES_KEY]: notes });
  }

  function installNotesEditor() {
    const panel = element("chatConfigPanel")?.querySelector?.(".details-body");
    const chatSelect = element("chatConfigChat");
    const prompt = element("chatPrompt");
    if (!panel || !chatSelect || !prompt || element("chatNotes")) return false;
    const label = root.document.createElement("label");
    label.innerHTML = `Notes and context<textarea id="chatNotes" rows="4" maxlength="${Folders.MAX_NOTES}" placeholder="Background, decisions, constraints, links, and context for this chat"></textarea>`;
    prompt.closest("label")?.after(label);
    const textarea = element("chatNotes");
    textarea.addEventListener("input", () => {
      clearTimeout(noteTimer);
      noteTimer = setTimeout(() => saveCurrentNote().catch(() => {}), 250);
    });
    chatSelect.addEventListener("change", async () => {
      await saveCurrentNote();
      await loadNote(chatSelect.value);
    });
    element("clearChatConfig")?.addEventListener("click", async () => {
      const id = chatSelect.value;
      if (!id) return;
      const values = await root.chrome.storage.local.get(Folders.CHAT_NOTES_KEY);
      const notes = { ...(values[Folders.CHAT_NOTES_KEY] || {}) };
      delete notes[id];
      await root.chrome.storage.local.set({ [Folders.CHAT_NOTES_KEY]: notes });
      await loadNote(id);
    }, true);
    loadNote(chatSelect.value).catch(() => {});
    return true;
  }

  function projectOptions() {
    return Object.values(store?.projects || {}).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }

  function projectPanelMarkup() {
    return `
      <summary>Projects</summary>
      <div class="details-body">
        <p class="hint">Projects are folders only. They group chats and store repository details and notes. They never create agents, issues, branches, pull requests, or prompts by themselves.</p>
        <div class="project-toolbar">
          <label>Saved project<select id="folderProjectSelect"></select></label>
          <button id="folderNewProject" class="compact" type="button">New</button>
        </div>
        <label>Project name<input id="folderProjectName" type="text" maxlength="160" placeholder="Project or workstream name"></label>
        <label>GitHub repository<input id="folderProjectRepository" type="text" placeholder="owner/repository"></label>
        <label>Project notes<textarea id="folderProjectNotes" rows="5" maxlength="${Folders.MAX_NOTES}" placeholder="Goals, decisions, constraints, links, and shared context"></textarea></label>
        <div>
          <strong>Chats in this project</strong>
          <div id="folderProjectChats" class="chat-list" role="group" aria-label="Project chats"></div>
        </div>
        <div class="inline-actions">
          <button id="folderUseCurrentSelection" class="compact" type="button">Use current selection</button>
          <button id="folderSaveProject" class="primary" type="button">Save project</button>
          <button id="folderDeleteProject" class="compact" type="button">Delete</button>
        </div>
        <button id="folderLoadProject" type="button">Load project chats into AutoContinue</button>
        <p id="folderProjectMessage" class="hint" aria-live="polite"></p>
      </div>`;
  }

  function renderProjectSelect() {
    const select = element("folderProjectSelect");
    if (!select) return;
    select.textContent = "";
    const blank = root.document.createElement("option");
    blank.value = "";
    blank.textContent = "New project";
    select.append(blank);
    for (const project of projectOptions()) {
      const option = root.document.createElement("option");
      option.value = project.id;
      option.textContent = `${project.name}${project.chatIds.length ? ` · ${project.chatIds.length} chats` : ""}`;
      select.append(option);
    }
    select.value = store.projects[activeProjectId] ? activeProjectId : "";
  }

  function checkedChatIds() {
    return [...(element("folderProjectChats")?.querySelectorAll?.('input[type="checkbox"]:checked') || [])]
      .map(input => input.value)
      .filter(Boolean);
  }

  function renderProjectChats(chatIds = []) {
    const container = element("folderProjectChats");
    if (!container) return;
    const selected = new Set(chatIds);
    container.textContent = "";
    if (!catalog.length) {
      container.innerHTML = '<div class="empty">Refresh the ChatGPT chat list to add chats to projects.</div>';
      return;
    }
    for (const chat of catalog) {
      const label = root.document.createElement("label");
      label.className = "chat-row";
      label.innerHTML = `<input type="checkbox" value="${escapeHtml(chat.id)}"><span class="chat-title" title="${escapeHtml(chat.title)}">${escapeHtml(chat.title)}</span>`;
      label.querySelector("input").checked = selected.has(chat.id);
      container.append(label);
    }
  }

  function loadProjectEditor(projectId = "") {
    activeProjectId = store.projects[projectId] ? projectId : "";
    const project = store.projects[activeProjectId] || null;
    element("folderProjectSelect").value = activeProjectId;
    element("folderProjectName").value = project?.name || "";
    element("folderProjectRepository").value = project?.repository || "";
    element("folderProjectNotes").value = project?.notes || "";
    renderProjectChats(project?.chatIds || []);
    element("folderDeleteProject").disabled = !project;
  }

  async function saveProject() {
    const result = Folders.upsertProject(store, {
      id: activeProjectId,
      name: element("folderProjectName").value,
      repository: element("folderProjectRepository").value,
      notes: element("folderProjectNotes").value,
      chatIds: checkedChatIds()
    });
    store = result.store;
    activeProjectId = result.project.id;
    await root.chrome.storage.local.set({
      [Folders.STORE_KEY]: store,
      [Folders.ACTIVE_KEY]: activeProjectId
    });
    renderProjectSelect();
    loadProjectEditor(activeProjectId);
    element("folderProjectMessage").textContent = `Saved ${result.project.name}.`;
    return result.project;
  }

  async function deleteProject() {
    const project = store.projects[activeProjectId];
    if (!project) return;
    if (!root.confirm(`Delete the project folder “${project.name}”? Chats and AutoContinue settings will not be deleted.`)) return;
    store = Folders.deleteProject(store, activeProjectId);
    activeProjectId = Object.keys(store.projects)[0] || "";
    await root.chrome.storage.local.set({
      [Folders.STORE_KEY]: store,
      [Folders.ACTIVE_KEY]: activeProjectId
    });
    renderProjectSelect();
    loadProjectEditor(activeProjectId);
    element("folderProjectMessage").textContent = "Project folder deleted.";
  }

  async function useCurrentSelection() {
    const values = await root.chrome.storage.local.get(Folders.SELECTION_KEY);
    const ids = Array.isArray(values[Folders.SELECTION_KEY]) ? values[Folders.SELECTION_KEY] : [];
    renderProjectChats(ids);
    element("folderProjectMessage").textContent = `Loaded ${ids.length} currently selected chat${ids.length === 1 ? "" : "s"} into the editor.`;
  }

  async function loadProjectIntoAutoContinue() {
    const project = await saveProject();
    await root.chrome.storage.local.set({
      [Folders.SELECTION_KEY]: project.chatIds,
      [Folders.ACTIVE_KEY]: project.id
    });
    element("folderProjectMessage").textContent = `Loaded ${project.chatIds.length} chat${project.chatIds.length === 1 ? "" : "s"}. Refreshing the popup…`;
    root.setTimeout(() => root.location.reload(), 150);
  }

  function bindProjectPanel() {
    element("folderProjectSelect").addEventListener("change", event => loadProjectEditor(event.target.value));
    element("folderNewProject").addEventListener("click", () => loadProjectEditor(""));
    element("folderSaveProject").addEventListener("click", () => saveProject().catch(error => {
      element("folderProjectMessage").textContent = error.message;
    }));
    element("folderDeleteProject").addEventListener("click", () => deleteProject().catch(error => {
      element("folderProjectMessage").textContent = error.message;
    }));
    element("folderUseCurrentSelection").addEventListener("click", () => useCurrentSelection().catch(error => {
      element("folderProjectMessage").textContent = error.message;
    }));
    element("folderLoadProject").addEventListener("click", () => loadProjectIntoAutoContinue().catch(error => {
      element("folderProjectMessage").textContent = error.message;
    }));
  }

  async function install() {
    if (root[INSTALL_FLAG] || !Folders || !root.chrome?.storage?.local || !root.document) return false;
    Object.defineProperty(root, INSTALL_FLAG, { value: true });
    installSchedulerEnrichment();
    await readState();
    installNotesEditor();
    const panel = element("projectModePanel");
    if (!panel) return false;
    panel.innerHTML = projectPanelMarkup();
    panel.classList.remove("project-mode");
    renderProjectSelect();
    loadProjectEditor(activeProjectId);
    bindProjectPanel();
    return true;
  }

  if (root.document) root.setTimeout(() => install().catch(() => {}), 250);

  return {
    installSchedulerEnrichment,
    installNotesEditor,
    projectPanelMarkup,
    install
  };
});