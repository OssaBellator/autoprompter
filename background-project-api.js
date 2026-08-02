"use strict";

(() => {
  if (typeof startProjectBootstrapState !== "function" || typeof dispatchPreparedProjectAssignmentsState !== "function") {
    throw new Error("AutoPrompter background Project Mode operations are unavailable.");
  }

  const originalStartBootstrap = startProjectBootstrapState;
  const dispatchAssignments = dispatchPreparedProjectAssignmentsState;
  const bootstrapStarts = new Map();

  function startBootstrapOnce(projectId) {
    const id = String(projectId || "").trim();
    if (!id) return Promise.reject(new Error("A project ID is required for bootstrap."));
    if (bootstrapStarts.has(id)) return bootstrapStarts.get(id);
    const operation = Promise.resolve()
      .then(() => originalStartBootstrap(id))
      .finally(() => bootstrapStarts.delete(id));
    bootstrapStarts.set(id, operation);
    return operation;
  }

  // Imported classic service-worker scripts share global function bindings.
  // Replace the bootstrap binding with a single-flight wrapper so the popup and
  // background fallback cannot create duplicate planner/reviewer/integrator chats.
  globalThis.startProjectBootstrapState = startBootstrapOnce;
  globalThis.dispatchPreparedProjectAssignmentsState = dispatchAssignments;

  globalThis.AutoPrompterBackgroundProjectApi = Object.freeze({
    startProjectBootstrap: startBootstrapOnce,
    dispatchPreparedAssignments(projectId, dispatchIds) {
      return dispatchAssignments(projectId, dispatchIds, true);
    },
    bootstrapInFlight(projectId) {
      return bootstrapStarts.has(String(projectId || "").trim());
    }
  });
})();
