"use strict";

(function attachProjectRoleKick(root, factory) {
  const projectStore = root.AutoPrompterProjectStore
    || (typeof require === "function" ? require("./project-store.js") : null);
  const api = factory(root, projectStore);
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.AutoPrompterProjectRoleKick = api;
})(typeof globalThis !== "undefined" ? globalThis : self, (root, ProjectStore) => {
  const ROLE_JOBS_KEY = "autoprompterProjectRoleJobs";
  const ACTIVE_JOB_STATUSES = new Set(["opening", "dispatching", "running"]);
  let started = false;
  let timer = null;

  function activeJobFor(jobs, projectId, role) {
    return Object.values(jobs || {}).some(job =>
      job?.projectId === projectId
      && job?.role === role
      && ACTIVE_JOB_STATUSES.has(job.status)
    );
  }

  function needsRoleWork(store, jobs = {}) {
    for (const project of Object.values(store?.projects || {})) {
      if (project?.status !== "running") continue;
      const projectId = project.projectId;
      const tasks = store.tasksByProject?.[projectId] || {};
      const dispatches = store.dispatchesByProject?.[projectId] || {};
      const results = store.resultsByProject?.[projectId] || {};
      const reviews = store.reviewsByProject?.[projectId] || {};

      if (project.roles?.reviewerChatId && !activeJobFor(jobs, projectId, "reviewer")) {
        const pendingReview = Object.values(tasks).some(task => {
          const dispatchId = task?.lastResultDispatchId;
          return task?.status === "review"
            && dispatchId
            && Boolean(dispatches[dispatchId])
            && Boolean(results[dispatchId])
            && !reviews[dispatchId];
        });
        if (pendingReview) return true;
      }

      const taskValues = Object.values(tasks);
      const integration = store.integrationsByProject?.[projectId] || null;
      const integrationReady = taskValues.length > 0 && taskValues.every(task => task?.status === "accepted");
      if (
        integrationReady
        && project.roles?.integratorChatId
        && !activeJobFor(jobs, projectId, "integrator")
        && !integration?.pending
        && !integration?.approved
      ) return true;
    }
    return false;
  }

  async function loadState() {
    const stored = await root.chrome.storage.local.get([ProjectStore.PROJECTS_KEY, ROLE_JOBS_KEY]);
    return {
      store: ProjectStore.migrateStore(stored?.[ProjectStore.PROJECTS_KEY]).store,
      jobs: stored?.[ROLE_JOBS_KEY] && typeof stored[ROLE_JOBS_KEY] === "object"
        ? stored[ROLE_JOBS_KEY]
        : {}
    };
  }

  async function kickIfNeeded() {
    if (!root.chrome?.runtime?.sendMessage || !root.chrome?.storage?.local || !ProjectStore) return false;
    const { store, jobs } = await loadState();
    if (!needsRoleWork(store, jobs)) return false;
    const response = await root.chrome.runtime.sendMessage({ type: "RETRY_PROJECT_ROLE_AUTOMATION" });
    return response?.ok === true;
  }

  function schedule(delay = 100) {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      kickIfNeeded().catch(() => {});
    }, delay);
    if (typeof timer?.unref === "function") timer.unref();
  }

  function start() {
    if (started || !root.chrome?.storage?.onChanged || !ProjectStore) return false;
    started = true;
    root.chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes?.[ProjectStore.PROJECTS_KEY]) schedule();
    });
    schedule(0);
    return true;
  }

  return {
    ROLE_JOBS_KEY,
    ACTIVE_JOB_STATUSES: [...ACTIVE_JOB_STATUSES],
    activeJobFor,
    needsRoleWork,
    kickIfNeeded,
    schedule,
    start
  };
});
