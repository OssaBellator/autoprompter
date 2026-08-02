"use strict";

(function attachGitHubIssueDispatch(root, factory) {
  const projectStore = root.AutoPrompterProjectStore
    || (typeof require === "function" ? require("./project-store.js") : null);
  const freshDispatch = root.AutoPrompterProjectFreshDispatch
    || (typeof require === "function" ? require("./project-fresh-dispatch.js") : null);
  const api = factory(root, projectStore, freshDispatch);
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.AutoPrompterGitHubIssueDispatch = api;
})(typeof globalThis !== "undefined" ? globalThis : self, (root, ProjectStore, FreshDispatch) => {
  const SESSION_KEY = "autoprompterScheduler";
  const MODE = "github_issues_and_pull_requests";

  function conversationUrl(conversationId) {
    const id = String(conversationId || "").trim();
    if (!id) return "";
    return `https://chatgpt.com/c/${encodeURIComponent(id)}`;
  }

  function targetUrl(dispatch) {
    if (dispatch?.conversationId && !dispatch?.freshRequestId) return conversationUrl(dispatch.conversationId);
    return FreshDispatch.freshChatUrl(dispatch);
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
    if (!root.chrome?.tabs || !root.chrome?.storage?.local || !ProjectStore || !FreshDispatch) {
      throw new Error("GitHub issue chat dispatch is unavailable.");
    }
    const schedulerState = root.chrome.storage?.session
      ? await root.chrome.storage.session.get(SESSION_KEY)
      : await root.chrome.storage.local.get(SESSION_KEY);
    if (schedulerState?.[SESSION_KEY]?.running) {
      throw new Error("Stop the normal AutoPrompter scheduler before running GitHub issue workers.");
    }

    let store = await loadStore();
    const project = store.projects?.[projectId];
    if (!project || project.status !== "running") throw new Error("Project must be running before issue dispatch.");
    if (project.githubWorkflowMode !== MODE) return FreshDispatch.dispatchPreparedAssignments(projectId, dispatchIds, true);

    const wanted = new Set(Array.isArray(dispatchIds) ? dispatchIds : []);
    const prepared = Object.values(store.dispatchesByProject?.[projectId] || {})
      .filter(dispatch => dispatch?.status === "prepared" && (!wanted.size || wanted.has(dispatch.dispatchId)))
      .sort((a, b) => String(a.assignedAt).localeCompare(String(b.assignedAt)));
    const started = [];

    for (const dispatch of prepared) {
      const url = targetUrl(dispatch);
      if (!url) throw new Error(`${dispatch.dispatchId} has no issue worker conversation target.`);
      const tab = await root.chrome.tabs.create({ url, active: false });
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
    if (!root || !ProjectStore || !FreshDispatch) throw new Error("GitHub issue dispatch dependencies are unavailable.");
    root.dispatchPreparedProjectAssignmentsState = dispatchPreparedAssignments;
    return dispatchPreparedAssignments;
  }

  const installed = typeof importScripts === "function" ? install() : null;
  return { SESSION_KEY, MODE, conversationUrl, targetUrl, dispatchPreparedAssignments, install, installed };
});