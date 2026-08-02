"use strict";

(function attachProjectAutoBootstrap(root, factory) {
  const projectStore = root.AutoPrompterProjectStore
    || (typeof require === "function" ? require("./project-store.js") : null);
  const backgroundApi = root.AutoPrompterBackgroundProjectApi || null;
  const api = factory(root, projectStore, backgroundApi);
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.AutoPrompterProjectAutoBootstrap = api;
})(typeof globalThis !== "undefined" ? globalThis : self, (root, ProjectStore, BackgroundApi) => {
  const BOOTSTRAP_KEY = "autoprompterProjectBootstraps";
  const START_DELAY_MS = 8000;
  const pending = new Map();
  let started = false;

  function addedProjectIds(change) {
    const before = change?.oldValue?.projects && typeof change.oldValue.projects === "object"
      ? change.oldValue.projects
      : {};
    const after = change?.newValue?.projects && typeof change.newValue.projects === "object"
      ? change.newValue.projects
      : {};
    return Object.keys(after).filter(projectId => !Object.prototype.hasOwnProperty.call(before, projectId));
  }

  function projectNeedsBootstrap(store, projectId) {
    const project = store?.projects?.[projectId];
    if (!project || project.status !== "draft") return false;
    if (store?.approvedPlansByProject?.[projectId]) return false;
    return !Object.keys(store?.tasksByProject?.[projectId] || {}).length;
  }

  function bootstrapAlreadyStarted(bootstraps, projectId) {
    const status = bootstraps?.[projectId]?.status;
    return ["starting", "running", "completed", "failed", "cancelled"].includes(status);
  }

  async function startProjectIfNeeded(projectId) {
    if (!root.chrome?.storage?.local || !ProjectStore || !BackgroundApi?.startProjectBootstrap) return false;
    const stored = await root.chrome.storage.local.get([ProjectStore.PROJECTS_KEY, BOOTSTRAP_KEY]);
    const migrated = ProjectStore.migrateStore(stored?.[ProjectStore.PROJECTS_KEY]);
    const bootstraps = stored?.[BOOTSTRAP_KEY] && typeof stored[BOOTSTRAP_KEY] === "object"
      ? stored[BOOTSTRAP_KEY]
      : {};
    if (!projectNeedsBootstrap(migrated.store, projectId) || bootstrapAlreadyStarted(bootstraps, projectId)) return false;
    await BackgroundApi.startProjectBootstrap(projectId);
    return true;
  }

  function schedule(projectId, delay = START_DELAY_MS) {
    const id = String(projectId || "").trim();
    if (!id || pending.has(id)) return;
    const timer = setTimeout(() => {
      pending.delete(id);
      startProjectIfNeeded(id).catch(() => {});
    }, delay);
    if (typeof timer?.unref === "function") timer.unref();
    pending.set(id, timer);
  }

  function start() {
    if (started || !root.chrome?.storage?.onChanged || !ProjectStore || !BackgroundApi) return;
    started = true;
    root.chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      const change = changes?.[ProjectStore.PROJECTS_KEY];
      if (!change) return;
      for (const projectId of addedProjectIds(change)) schedule(projectId);
    });
  }

  return {
    BOOTSTRAP_KEY,
    START_DELAY_MS,
    addedProjectIds,
    projectNeedsBootstrap,
    bootstrapAlreadyStarted,
    startProjectIfNeeded,
    schedule,
    start
  };
});
