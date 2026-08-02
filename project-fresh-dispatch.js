"use strict";

(function attachProjectFreshDispatch(root, factory) {
  const projectStore = root.AutoPrompterProjectStore
    || (typeof require === "function" ? require("./project-store.js") : null);
  const api = factory(root, projectStore);
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.AutoPrompterProjectFreshDispatch = api;
})(typeof globalThis !== "undefined" ? globalThis : self, (root, ProjectStore) => {
  const SESSION_KEY = "autoprompterScheduler";
  const NEW_CHAT_URL = "https://chatgpt.com/";

  function freshChatUrl(dispatch) {
    const url = new URL(NEW_CHAT_URL);
    url.searchParams.set("autoprompter_fresh", [
      dispatch.freshRequestId,
      dispatch.projectId,
      dispatch.taskId,
      dispatch.dispatchId,
      Date.now()
    ].filter(Boolean).join(":"));
    return url.href;
  }

  async function loadStore() {
    const stored = await root.chrome.storage.local.get(ProjectStore.PROJECTS_KEY);
    return ProjectStore.migrateStore(stored?.[ProjectStore.PROJECTS_KEY]).store;
  }

  async function saveStore(store) {
    await root.chrome.storage.local.set({ [ProjectStore.PROJECTS_KEY]: store });
  }

  async function removeTab(tabId) {
    if (!Number.isInteger(tabId)) return;
    try { await root.chrome.tabs.remove(tabId); } catch { /* already closed */ }
  }

  async function dispatchPreparedAssignments(projectId, dispatchIds, _modelVerified = true) {
    if (!root.chrome?.tabs || !root.chrome?.storage?.local || !ProjectStore) {
      throw new Error("Fresh task dispatch is unavailable.");
    }
    const schedulerState = await root.chrome.storage.local.get(SESSION_KEY);
    if (schedulerState?.[SESSION_KEY]?.running) {
      throw new Error("Stop the normal AutoPrompter scheduler before running a project task board.");
    }

    let store = await loadStore();
    const project = store.projects?.[projectId];
    if (!project || project.status !== "running") throw new Error("Project must be running before task dispatch.");
    const wanted = new Set(Array.isArray(dispatchIds) ? dispatchIds : []);
    const prepared = Object.values(store.dispatchesByProject?.[projectId] || {})
      .filter(dispatch => dispatch?.status === "prepared" && (!wanted.size || wanted.has(dispatch.dispatchId)))
      .sort((a, b) => String(a.assignedAt).localeCompare(String(b.assignedAt)));
    if (!prepared.length) return {
      projectStoreVersion: store.schemaVersion,
      activeProjectId: store.activeProjectId,
      projects: ProjectStore.listProjects(store),
      project,
      started: [],
      runtimeSummary: ProjectStore.summarizeProjectRuntime(store, projectId)
    };

    const started = [];
    for (const dispatch of prepared) {
      if (!dispatch.freshRequestId) throw new Error(`${dispatch.dispatchId} is not a fresh task-chat dispatch.`);
      const tab = await root.chrome.tabs.create({ url: freshChatUrl(dispatch), active: false });
      try {
        const marked = ProjectStore.markProjectDispatchStarted(store, projectId, dispatch.dispatchId, tab.id);
        store = marked.store;
        await saveStore(store);
        started.push(marked.dispatch);
      } catch (error) {
        await removeTab(tab.id);
        throw error;
      }
    }

    return {
      projectStoreVersion: store.schemaVersion,
      activeProjectId: store.activeProjectId,
      projects: ProjectStore.listProjects(store),
      project: store.projects[projectId],
      started,
      runtimeSummary: ProjectStore.summarizeProjectRuntime(store, projectId)
    };
  }

  function install() {
    if (!root || !ProjectStore) throw new Error("Fresh task dispatch dependencies are unavailable.");
    root.dispatchPreparedProjectAssignmentsState = dispatchPreparedAssignments;
    return dispatchPreparedAssignments;
  }

  const installed = ProjectStore ? install() : null;
  return { SESSION_KEY, freshChatUrl, dispatchPreparedAssignments, install, installed };
});
