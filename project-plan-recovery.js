"use strict";

(function attachProjectPlanRecovery(root, factory) {
  const api = factory(root);
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.AutoPrompterProjectPlanRecovery = api;
})(typeof globalThis !== "undefined" ? globalThis : self, root => {
  const MESSAGE_SCOPE = "AUTOPROMPTER_RUNTIME";
  const BOOTSTRAP_KEY = "autoprompterProjectBootstraps";
  const GET_RECOVERY = "GET_PROJECT_PLANNER_RECOVERY";
  const RECOVERABLE_STAGES = new Set(["planner_plan", "planner_repair"]);
  let started = false;

  function recoveryForTab(bootstraps, tabId) {
    if (!Number.isInteger(tabId)) return null;
    for (const [projectId, bootstrap] of Object.entries(bootstraps || {})) {
      const planner = bootstrap?.roles?.planner;
      if (
        planner?.tabId === tabId
        && RECOVERABLE_STAGES.has(planner.stage)
        && typeof planner.jobId === "string"
        && planner.jobId
      ) {
        return {
          projectId,
          role: "planner",
          stage: planner.stage,
          jobId: planner.jobId
        };
      }
    }
    return null;
  }

  async function getRecovery(sender) {
    if (!root.chrome?.storage?.local) return { ok: false, error: "Planner recovery storage is unavailable." };
    const stored = await root.chrome.storage.local.get(BOOTSTRAP_KEY);
    const bootstraps = stored?.[BOOTSTRAP_KEY] && typeof stored[BOOTSTRAP_KEY] === "object"
      ? stored[BOOTSTRAP_KEY]
      : {};
    return { ok: true, recovery: recoveryForTab(bootstraps, sender?.tab?.id) };
  }

  function start() {
    if (started || !root.chrome?.runtime?.onMessage) return false;
    started = true;
    root.chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message?.scope !== MESSAGE_SCOPE || message?.type !== GET_RECOVERY) return false;
      getRecovery(sender)
        .then(sendResponse)
        .catch(error => sendResponse({ ok: false, error: error?.message || String(error) }));
      return true;
    });
    return true;
  }

  return {
    MESSAGE_SCOPE,
    BOOTSTRAP_KEY,
    GET_RECOVERY,
    RECOVERABLE_STAGES: [...RECOVERABLE_STAGES],
    recoveryForTab,
    getRecovery,
    start
  };
});
