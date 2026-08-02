"use strict";

(function attachProjectAutoStore(root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.AutoPrompterProjectAutoStore = api;
})(typeof globalThis !== "undefined" ? globalThis : self, () => {
  const PATCH_FLAG = Symbol.for("autoprompter.projectAutoStore.installed");

  function install(projectStore) {
    if (!projectStore || typeof projectStore.prepareProjectDispatches !== "function") {
      throw new Error("AutoPrompter project assignment store is unavailable.");
    }
    if (projectStore[PATCH_FLAG]) return projectStore[PATCH_FLAG];
    const originalPrepare = projectStore.prepareProjectDispatches.bind(projectStore);

    projectStore.prepareProjectDispatches = function prepareAutomaticDispatches(...args) {
      const result = originalPrepare(...args);
      const assignments = Array.isArray(result?.assignments) ? result.assignments : [];
      return {
        ...result,
        prepared: assignments
      };
    };

    const installed = { originalPrepare };
    Object.defineProperty(projectStore, PATCH_FLAG, { value: installed, enumerable: false });
    return installed;
  }

  return { install };
});
