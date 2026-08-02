"use strict";

(function attachBootstrapUpgrade(root, factory) {
  const api = factory(root);
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.AutoPrompterBootstrapUpgrade = api;
})(typeof globalThis !== "undefined" ? globalThis : self, root => {
  const BOOTSTRAP_KEY = "autoprompterProjectBootstraps";
  const UPGRADE_KEY = "autoprompterBootstrapProtocolUpgrade";
  const PROTOCOL_VERSION = "compiled-local-fallback-v1";
  let started = false;

  function isLegacyRepair(bootstrap) {
    const planner = bootstrap?.roles?.planner || {};
    return Number(bootstrap?.repairAttempts || 0) > 0
      || /repair/i.test(String(planner.stage || ""))
      || /repairing planner/i.test(String(planner.status || ""))
      || /AUTOPROMPTER_PLAN_BEGIN/.test(String(planner.prompt || ""));
  }

  async function restart(projectIds) {
    if (typeof root.startProjectBootstrapState !== "function") return;
    for (const projectId of projectIds) {
      try {
        await root.startProjectBootstrapState(projectId);
      } catch {
        // The project may already be running, completed, or otherwise ineligible.
      }
    }
  }

  async function run() {
    if (typeof chrome === "undefined" || !chrome.storage?.local) return { reset: [] };
    const stored = await chrome.storage.local.get([BOOTSTRAP_KEY, UPGRADE_KEY]);
    const bootstraps = stored?.[BOOTSTRAP_KEY] && typeof stored[BOOTSTRAP_KEY] === "object"
      ? { ...stored[BOOTSTRAP_KEY] }
      : {};
    const reset = [];
    for (const [projectId, bootstrap] of Object.entries(bootstraps)) {
      if (!isLegacyRepair(bootstrap)) continue;
      delete bootstraps[projectId];
      reset.push(projectId);
    }
    if (reset.length || stored?.[UPGRADE_KEY] !== PROTOCOL_VERSION) {
      await chrome.storage.local.set({
        [BOOTSTRAP_KEY]: bootstraps,
        [UPGRADE_KEY]: PROTOCOL_VERSION
      });
    }
    if (reset.length) setTimeout(() => restart(reset), 250);
    return { reset };
  }

  function start() {
    if (started) return;
    started = true;
    run().catch(() => {});
  }

  return { BOOTSTRAP_KEY, PROTOCOL_VERSION, isLegacyRepair, run, start };
});
