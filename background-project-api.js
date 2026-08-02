"use strict";

(() => {
  if (typeof startProjectBootstrapState !== "function" || typeof dispatchPreparedProjectAssignmentsState !== "function") {
    throw new Error("AutoPrompter background Project Mode operations are unavailable.");
  }

  const startBootstrap = startProjectBootstrapState;
  const dispatchAssignments = dispatchPreparedProjectAssignmentsState;

  // Imported classic service-worker scripts normally share global function bindings.
  // Assign them explicitly so the full-auto controller behaves consistently across
  // Chromium service-worker implementations and test harnesses.
  globalThis.startProjectBootstrapState = startBootstrap;
  globalThis.dispatchPreparedProjectAssignmentsState = dispatchAssignments;

  globalThis.AutoPrompterBackgroundProjectApi = Object.freeze({
    startProjectBootstrap(projectId) {
      return startBootstrap(projectId);
    },
    dispatchPreparedAssignments(projectId, dispatchIds) {
      return dispatchAssignments(projectId, dispatchIds, true);
    }
  });
})();
