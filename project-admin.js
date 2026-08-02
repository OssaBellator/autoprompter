"use strict";

(function attachProjectAdmin(root, factory) {
  const projectStore = root.AutoPrompterProjectStore
    || (typeof require === "function" ? require("./project-store.js") : null);
  const api = factory(root, projectStore);
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.AutoPrompterProjectAdmin = api;
})(typeof globalThis !== "undefined" ? globalThis : self, (root, ProjectStore) => {
  const MESSAGE_SCOPE = "AUTOPROMPTER_PROJECT_ADMIN";
  const DELETE_PROJECT = "DELETE_PROJECT";
  const BOOTSTRAP_KEY = "autoprompterProjectBootstraps";
  const ROLE_JOBS_KEY = "autoprompterProjectRoleJobs";
  const ACTION_JOBS_KEY = "autoprompterProjectActionJobs";
  let started = false;

  function clone(value) {
    return value == null ? value : structuredClone(value);
  }

  function normalizeProjectId(value) {
    const projectId = String(value || "").trim();
    if (!/^[a-z0-9][a-z0-9._-]{2,63}$/.test(projectId)) throw new Error("A valid project ID is required.");
    return projectId;
  }

  function collectTabIds(value, target = new Set()) {
    if (!value || typeof value !== "object") return target;
    for (const [key, item] of Object.entries(value)) {
      if ((key === "tabId" || key === "workerTabId") && Number.isInteger(item)) target.add(item);
      else if (item && typeof item === "object") collectTabIds(item, target);
    }
    return target;
  }

  function deleteProjectFromStore(storeInput, projectIdInput) {
    const projectId = normalizeProjectId(projectIdInput);
    const store = clone(storeInput);
    const project = store?.projects?.[projectId];
    if (!project) throw new Error("Project not found.");

    const tabIds = collectTabIds(store.dispatchesByProject?.[projectId]);
    delete store.projects[projectId];
    for (const key of [
      "resumeStatusByProject",
      "pendingPlansByProject",
      "approvedPlansByProject",
      "tasksByProject",
      "dispatchesByProject",
      "resultsByProject",
      "reviewsByProject",
      "integrationsByProject",
      "approvalsByProject",
      "reconciliationsByProject"
    ]) {
      if (store[key] && typeof store[key] === "object") delete store[key][projectId];
    }
    store.events = Array.isArray(store.events) ? store.events.filter(event => event?.projectId !== projectId) : [];
    const remaining = Object.values(store.projects || {})
      .sort((a, b) => String(b.updatedAt || b.createdAt || "").localeCompare(String(a.updatedAt || a.createdAt || "")));
    store.activeProjectId = remaining[0]?.projectId || null;
    return { store, project: clone(project), tabIds: [...tabIds] };
  }

  function pruneProjectRecords(recordsInput, projectIdInput) {
    const projectId = normalizeProjectId(projectIdInput);
    const records = recordsInput && typeof recordsInput === "object" ? clone(recordsInput) : {};
    const tabIds = new Set();
    for (const [key, record] of Object.entries(records)) {
      if (key !== projectId && record?.projectId !== projectId) continue;
      collectTabIds(record, tabIds);
      delete records[key];
    }
    return { records, tabIds: [...tabIds] };
  }

  async function deleteProjectState(projectIdInput) {
    if (!ProjectStore || !root.chrome?.storage?.local) throw new Error("Project storage is unavailable.");
    const projectId = normalizeProjectId(projectIdInput);
    const keys = [ProjectStore.PROJECTS_KEY, BOOTSTRAP_KEY, ROLE_JOBS_KEY, ACTION_JOBS_KEY];
    const stored = await root.chrome.storage.local.get(keys);
    const store = ProjectStore.migrateStore(stored?.[ProjectStore.PROJECTS_KEY]).store;
    const deleted = deleteProjectFromStore(store, projectId);
    const bootstraps = pruneProjectRecords(stored?.[BOOTSTRAP_KEY], projectId);
    const roleJobs = pruneProjectRecords(stored?.[ROLE_JOBS_KEY], projectId);
    const actionJobs = pruneProjectRecords(stored?.[ACTION_JOBS_KEY], projectId);
    const detachedTabIds = [...new Set([
      ...deleted.tabIds,
      ...bootstraps.tabIds,
      ...roleJobs.tabIds,
      ...actionJobs.tabIds
    ].filter(Number.isInteger))];

    await root.chrome.storage.local.set({
      [ProjectStore.PROJECTS_KEY]: deleted.store,
      [BOOTSTRAP_KEY]: bootstraps.records,
      [ROLE_JOBS_KEY]: roleJobs.records,
      [ACTION_JOBS_KEY]: actionJobs.records
    });

    // Do not remove browser tabs here. Closing or refocusing tabs while a toolbar
    // popup is open dismisses the popup. The tabs become ordinary unmanaged
    // ChatGPT tabs after their project records are removed.
    return {
      projectId,
      deletedProject: deleted.project,
      detachedTabIds,
      activeProjectId: deleted.store.activeProjectId,
      projects: Object.values(deleted.store.projects || {})
        .sort((a, b) => String(b.updatedAt || b.createdAt || "").localeCompare(String(a.updatedAt || a.createdAt || "")))
    };
  }

  function start() {
    if (started || !root.chrome?.runtime?.onMessage) return;
    started = true;
    root.chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message?.scope !== MESSAGE_SCOPE || message?.type !== DELETE_PROJECT) return false;
      deleteProjectState(message.projectId)
        .then(result => sendResponse({ ok: true, ...result }))
        .catch(error => sendResponse({ ok: false, error: error?.message || String(error) }));
      return true;
    });
  }

  return {
    MESSAGE_SCOPE,
    DELETE_PROJECT,
    BOOTSTRAP_KEY,
    ROLE_JOBS_KEY,
    ACTION_JOBS_KEY,
    collectTabIds,
    deleteProjectFromStore,
    pruneProjectRecords,
    deleteProjectState,
    start
  };
});
