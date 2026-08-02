"use strict";

(function attachProjectTaskBoardController(root, factory) {
  const projectStore = root.AutoPrompterProjectStore
    || (typeof require === "function" ? require("./project-store.js") : null);
  const api = factory(root, projectStore);
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.AutoPrompterProjectTaskBoardController = api;
})(typeof globalThis !== "undefined" ? globalThis : self, (root, ProjectStore) => {
  const MESSAGE_SCOPE = "AUTOPROMPTER_RUNTIME";
  const ACTION_JOBS_KEY = "autoprompterProjectActionJobs";
  let started = false;
  let timer = null;
  let queue = Promise.resolve();

  function enqueue(operation) {
    queue = queue.catch(() => {}).then(operation);
    return queue;
  }

  async function loadStore() {
    const stored = await root.chrome.storage.local.get(ProjectStore.PROJECTS_KEY);
    return ProjectStore.migrateStore(stored?.[ProjectStore.PROJECTS_KEY]).store;
  }

  async function saveStore(store) {
    await root.chrome.storage.local.set({ [ProjectStore.PROJECTS_KEY]: store });
  }

  function schedule(delay = 150) {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      enqueue(reconcile).catch(() => {});
    }, delay);
  }

  async function clearLegacyRepositoryActions() {
    const stored = await root.chrome.storage.local.get(ACTION_JOBS_KEY);
    const jobs = stored?.[ACTION_JOBS_KEY] && typeof stored[ACTION_JOBS_KEY] === "object"
      ? stored[ACTION_JOBS_KEY]
      : {};
    const tabs = [...new Set(Object.values(jobs).map(job => job?.tabId).filter(Number.isInteger))];
    if (Object.keys(jobs).length) await root.chrome.storage.local.set({ [ACTION_JOBS_KEY]: {} });
    for (const tabId of tabs) {
      try { await root.chrome.tabs.remove(tabId); } catch { /* already closed */ }
    }
    return Object.keys(jobs).length;
  }

  async function advanceLifecycle(store) {
    let changed = false;
    for (const snapshot of Object.values(store.projects || {})) {
      const projectId = snapshot.projectId;
      let project = store.projects[projectId];
      if (project?.status === "ready" && store.approvedPlansByProject?.[projectId] && Object.keys(store.tasksByProject?.[projectId] || {}).length) {
        const startedProject = ProjectStore.startProject(store, projectId);
        store = startedProject.store;
        project = store.projects[projectId];
        changed = true;
      }
      if (project?.status === "running") {
        const hasReadyTasks = Object.values(store.tasksByProject?.[projectId] || {}).some(task => task?.status === "ready");
        if (hasReadyTasks) {
          try {
            const prepared = ProjectStore.prepareProjectDispatches(store, projectId);
            store = prepared.store;
            if (prepared.assignments?.length) changed = true;
          } catch {
            // Active leases or unresolved dependencies can temporarily leave no task ready.
          }
        }
      }
      const integration = store.integrationsByProject?.[projectId];
      if (store.projects?.[projectId]?.status === "running" && integration?.pending?.status === "completed") {
        const approved = ProjectStore.approveProjectIntegration(store, projectId);
        store = approved.store;
        changed = true;
      }
    }
    if (changed) await saveStore(store);
    return store;
  }

  async function dispatchPreparedTasks(store) {
    if (typeof root.dispatchPreparedProjectAssignmentsState !== "function") return;
    for (const project of Object.values(store.projects || {})) {
      if (project.status !== "running") continue;
      const preparedIds = Object.values(store.dispatchesByProject?.[project.projectId] || {})
        .filter(dispatch => dispatch?.status === "prepared")
        .map(dispatch => dispatch.dispatchId);
      if (!preparedIds.length) continue;
      try {
        await root.dispatchPreparedProjectAssignmentsState(project.projectId, preparedIds, true);
      } catch {
        // ChatGPT availability, the normal scheduler, or extension navigation can temporarily block dispatch.
      }
    }
  }

  function projectTaskBoard(store, projectId) {
    const project = store.projects?.[projectId];
    if (!project) return null;
    const tasks = store.tasksByProject?.[projectId] || {};
    const dispatches = store.dispatchesByProject?.[projectId] || {};
    const planOrder = (store.approvedPlansByProject?.[projectId]?.tasks || []).map(task => task.id);
    const known = new Set(planOrder);
    const ordered = [...planOrder, ...Object.keys(tasks).filter(id => !known.has(id)).sort()];
    return {
      projectId,
      status: project.status,
      mode: "fresh_chat_per_task",
      integrationReady: ordered.length > 0 && ordered.every(id => tasks[id]?.status === "accepted"),
      tasks: ordered.map(taskId => {
        const task = tasks[taskId];
        const taskDispatches = Object.values(dispatches)
          .filter(dispatch => dispatch?.taskId === taskId)
          .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
        const active = taskDispatches[0] || null;
        return {
          id: taskId,
          title: task?.title || taskId,
          status: task?.status || "unknown",
          dependencies: Array.isArray(task?.dependencies) ? task.dependencies : [],
          branch: task?.acceptedBranch || task?.branch || active?.branch || "",
          commit: task?.acceptedCommit || task?.resultCommit || "",
          dispatchId: active?.dispatchId || "",
          conversationId: active?.conversationId || "",
          attempt: Number(task?.attempt || active?.attempt || 0),
          lastStatus: active?.lastStatus || active?.status || ""
        };
      })
    };
  }

  function allTaskBoards(store) {
    return Object.fromEntries(Object.keys(store.projects || {}).map(projectId => [projectId, projectTaskBoard(store, projectId)]));
  }

  async function reconcile() {
    let store = await loadStore();
    store = await advanceLifecycle(store);
    await dispatchPreparedTasks(store);
    return store;
  }

  function start() {
    if (started || !root.chrome?.runtime?.onMessage || !ProjectStore) return;
    started = true;
    clearLegacyRepositoryActions().catch(() => {});
    root.chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes[ProjectStore.PROJECTS_KEY]) schedule();
    });
    root.chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message?.scope === MESSAGE_SCOPE && message?.type === "GET_PROJECT_AUTOMATION") {
        loadStore()
          .then(store => sendResponse({ ok: true, actions: {}, projects: store.projects, taskBoards: allTaskBoards(store) }))
          .catch(error => sendResponse({ ok: false, error: error?.message || String(error) }));
        return true;
      }
      if (message?.scope === MESSAGE_SCOPE && message?.type === "RETRY_PROJECT_AUTOMATION") {
        enqueue(async () => {
          let store = await loadStore();
          if (message.projectId && store.projects?.[message.projectId]) {
            store = ProjectStore.recoverProjectLeases(store, message.projectId).store;
            await saveStore(store);
          }
          schedule(0);
          return { ok: true };
        }).then(sendResponse).catch(error => sendResponse({ ok: false, error: error?.message || String(error) }));
        return true;
      }
      return false;
    });
    schedule(0);
  }

  return {
    MESSAGE_SCOPE,
    ACTION_JOBS_KEY,
    clearLegacyRepositoryActions,
    advanceLifecycle,
    projectTaskBoard,
    allTaskBoards,
    reconcile,
    start
  };
});
