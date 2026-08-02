"use strict";

(function attachProjectFreshCapacity(root, factory) {
  const projectStore = root.AutoPrompterProjectStore
    || (typeof require === "function" ? require("./project-store.js") : null);
  const api = factory(projectStore);
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.AutoPrompterProjectFreshCapacity = api;
})(typeof globalThis !== "undefined" ? globalThis : self, ProjectStore => {
  const PATCH_FLAG = Symbol.for("autoprompter.projectFreshCapacity.installed");
  const DEFAULT_FRESH_CAPACITY = 3;

  function usesFreshTaskChats(project) {
    return Array.isArray(project?.roles?.workerChatIds) && project.roles.workerChatIds.length === 0;
  }

  function upgradeFreshCapacity(store) {
    let changed = false;
    for (const project of Object.values(store?.projects || {})) {
      if (!usesFreshTaskChats(project)) continue;
      if (Number(project.scheduler?.maxConcurrentWorkers) !== 1) continue;
      project.scheduler.maxConcurrentWorkers = DEFAULT_FRESH_CAPACITY;
      changed = true;
    }
    return changed;
  }

  function install(projectStore = ProjectStore) {
    if (!projectStore?.createProject || !projectStore?.migrateStore) {
      throw new Error("AutoPrompter fresh-capacity dependencies are unavailable.");
    }
    if (projectStore[PATCH_FLAG]) return projectStore[PATCH_FLAG];

    const originalCreateProject = projectStore.createProject.bind(projectStore);
    const originalMigrateStore = projectStore.migrateStore.bind(projectStore);

    projectStore.createProject = function createFreshCapacityProject(storeInput, input = {}, clock = Date.now) {
      const workerChatIds = Array.isArray(input.workerChatIds) ? input.workerChatIds.filter(Boolean) : [];
      const nextInput = input.maxConcurrentWorkers == null && workerChatIds.length === 0
        ? { ...input, maxConcurrentWorkers: DEFAULT_FRESH_CAPACITY }
        : input;
      return originalCreateProject(storeInput, nextInput, clock);
    };

    projectStore.migrateStore = function migrateFreshCapacityStore(raw) {
      const migrated = originalMigrateStore(raw);
      const changed = upgradeFreshCapacity(migrated.store);
      return { ...migrated, migrated: migrated.migrated || changed };
    };

    const installed = {
      originalCreateProject,
      originalMigrateStore,
      defaultFreshCapacity: DEFAULT_FRESH_CAPACITY
    };
    Object.defineProperty(projectStore, PATCH_FLAG, { value: installed, enumerable: false });
    return installed;
  }

  return {
    DEFAULT_FRESH_CAPACITY,
    usesFreshTaskChats,
    upgradeFreshCapacity,
    install
  };
});
