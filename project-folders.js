"use strict";

(function attachProjectFolders(root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.AutoPrompterProjectFolders = api;
})(typeof globalThis !== "undefined" ? globalThis : self, () => {
  const STORE_KEY = "autoprompterChatProjects";
  const ACTIVE_KEY = "autoprompterActiveChatProject";
  const CHAT_NOTES_KEY = "autoprompterChatNotes";
  const LEGACY_PROJECTS_KEY = "autoprompterProjects";
  const CATALOG_KEY = "autoprompterChatCatalog";
  const SELECTION_KEY = "autoprompterSelectedChatIds";
  const SCHEMA_VERSION = "1.0";
  const MAX_PROJECTS = 100;
  const MAX_NOTES = 12000;

  function clone(value) {
    return value == null ? value : structuredClone(value);
  }

  function text(value, max = 12000) {
    return String(value || "").trim().slice(0, max);
  }

  function normalizeRepository(value) {
    const raw = text(value, 300);
    if (!raw) return "";
    let candidate = raw;
    try {
      if (/^https?:\/\//i.test(raw)) {
        const url = new URL(raw);
        if (!["github.com", "www.github.com"].includes(url.hostname)) return "";
        candidate = url.pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
      }
    } catch {
      return "";
    }
    return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(candidate) ? candidate : "";
  }

  function uniqueChatIds(values) {
    return [...new Set((Array.isArray(values) ? values : [])
      .map(value => text(value, 300))
      .filter(Boolean))].slice(0, 250);
  }

  function slug(value) {
    const normalized = text(value, 160)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60);
    return normalized || `project-${Date.now().toString(36)}`;
  }

  function normalizeProject(value, fallbackId = "") {
    if (!value || typeof value !== "object") return null;
    const name = text(value.name || value.title, 160);
    if (!name) return null;
    return {
      id: text(value.id || value.projectId || fallbackId || slug(name), 80),
      name,
      repository: normalizeRepository(value.repository?.slug || value.repository),
      notes: text(value.notes || value.goal, MAX_NOTES),
      chatIds: uniqueChatIds(value.chatIds),
      createdAt: text(value.createdAt, 50) || new Date().toISOString(),
      updatedAt: text(value.updatedAt, 50) || new Date().toISOString()
    };
  }

  function emptyStore() {
    return { schemaVersion: SCHEMA_VERSION, projects: {} };
  }

  function normalizeStore(value) {
    const store = emptyStore();
    const source = value?.projects && typeof value.projects === "object" ? value.projects : {};
    for (const [id, project] of Object.entries(source).slice(0, MAX_PROJECTS)) {
      const normalized = normalizeProject(project, id);
      if (normalized) store.projects[normalized.id] = normalized;
    }
    return store;
  }

  function legacyChatIds(project) {
    const roles = project?.roles || {};
    return uniqueChatIds([
      roles.plannerChatId,
      roles.reviewerChatId,
      roles.integratorChatId,
      ...(Array.isArray(roles.workerChatIds) ? roles.workerChatIds : [])
    ]);
  }

  function migrateLegacyStore(currentValue, legacyValue) {
    const current = normalizeStore(currentValue);
    if (Object.keys(current.projects).length || !legacyValue?.projects) return current;
    for (const [id, legacy] of Object.entries(legacyValue.projects).slice(0, MAX_PROJECTS)) {
      const normalized = normalizeProject({
        id,
        name: legacy.title || id,
        repository: legacy.repository?.slug || "",
        notes: [
          text(legacy.goal, MAX_NOTES - 100),
          "Imported from the retired Project Mode as a chat folder."
        ].filter(Boolean).join("\n\n"),
        chatIds: legacyChatIds(legacy),
        createdAt: legacy.createdAt,
        updatedAt: legacy.updatedAt
      }, id);
      if (normalized) current.projects[normalized.id] = normalized;
    }
    return current;
  }

  function upsertProject(storeValue, input, now = () => new Date().toISOString()) {
    const store = normalizeStore(storeValue);
    const existingId = text(input?.id, 80);
    const name = text(input?.name, 160);
    if (!name) throw new Error("Project name is required.");
    let id = existingId || slug(name);
    if (!existingId) {
      let suffix = 2;
      const base = id;
      while (store.projects[id]) id = `${base.slice(0, 55)}-${suffix++}`;
    }
    const previous = store.projects[id];
    const timestamp = now();
    store.projects[id] = normalizeProject({
      id,
      name,
      repository: input.repository,
      notes: input.notes,
      chatIds: input.chatIds,
      createdAt: previous?.createdAt || timestamp,
      updatedAt: timestamp
    }, id);
    return { store, project: clone(store.projects[id]) };
  }

  function deleteProject(storeValue, projectId) {
    const store = normalizeStore(storeValue);
    delete store.projects[text(projectId, 80)];
    return store;
  }

  function contextBlock(project, chatNotes) {
    const sections = [];
    if (project?.name) sections.push(`Project folder: ${project.name}`);
    if (project?.repository) sections.push(`GitHub repository: ${project.repository}`);
    if (project?.notes) sections.push(`Project notes:\n${text(project.notes, MAX_NOTES)}`);
    if (chatNotes) sections.push(`Chat notes:\n${text(chatNotes, MAX_NOTES)}`);
    if (!sections.length) return "";
    return ["AutoPrompter context for this chat:", ...sections].join("\n\n");
  }

  function appendContext(prompt, project, chatNotes) {
    const base = text(prompt, 12000);
    const context = contextBlock(project, chatNotes);
    if (!context) return base;
    return `${base}\n\n---\n${context}`.slice(0, 24000);
  }

  function enrichSchedulerMessage(message, values = {}) {
    if (!message || message.type !== "START_SCHEDULER" || !Array.isArray(message.chats)) return message;
    const store = normalizeStore(values.projectStore);
    const activeId = text(values.activeProjectId, 80);
    const project = store.projects[activeId] || null;
    const notes = values.chatNotes && typeof values.chatNotes === "object" ? values.chatNotes : {};
    const projectChats = new Set(project?.chatIds || []);
    return {
      ...message,
      chats: message.chats.map(chat => {
        const applies = Boolean(project && projectChats.has(chat.id));
        const settings = { ...(chat.settings || {}) };
        if (applies && !settings.repository && project.repository) settings.repository = project.repository;
        settings.prompt = appendContext(settings.prompt, applies ? project : null, notes[chat.id]);
        return { ...chat, settings, projectFolderId: applies ? project.id : "" };
      })
    };
  }

  return {
    STORE_KEY,
    ACTIVE_KEY,
    CHAT_NOTES_KEY,
    LEGACY_PROJECTS_KEY,
    CATALOG_KEY,
    SELECTION_KEY,
    SCHEMA_VERSION,
    MAX_NOTES,
    normalizeRepository,
    uniqueChatIds,
    normalizeProject,
    normalizeStore,
    migrateLegacyStore,
    upsertProject,
    deleteProject,
    contextBlock,
    appendContext,
    enrichSchedulerMessage
  };
});