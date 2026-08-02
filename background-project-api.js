"use strict";

(() => {
  if (typeof startProjectBootstrapState !== "function" || typeof dispatchPreparedProjectAssignmentsState !== "function") {
    throw new Error("AutoPrompter background Project Mode operations are unavailable.");
  }
  globalThis.AutoPrompterBackgroundProjectApi = Object.freeze({
    startProjectBootstrap(projectId) {
      return startProjectBootstrapState(projectId);
    },
    dispatchPreparedAssignments(projectId, dispatchIds) {
      return dispatchPreparedProjectAssignmentsState(projectId, dispatchIds, true);
    }
  });
})();
