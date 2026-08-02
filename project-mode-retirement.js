"use strict";

(function attachProjectModeRetirement(root, factory) {
  const api = factory(root);
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.AutoPrompterProjectModeRetirement = api;
})(typeof globalThis !== "undefined" ? globalThis : self, root => {
  const RETIREMENT_KEY = "autoprompterProjectModeRetiredV5";
  const LOCAL_EXECUTION_KEYS = [
    "autoprompterProjectBootstraps",
    "autoprompterProjectRoleJobs",
    "autoprompterProjectActionJobs"
  ];
  const SESSION_EXECUTION_KEYS = [
    "autoprompterProjectRoleJobs",
    "autoprompterProjectActionJobs"
  ];

  async function retire() {
    if (!root.chrome?.storage?.local) return false;
    const stored = await root.chrome.storage.local.get(RETIREMENT_KEY);
    if (stored?.[RETIREMENT_KEY]) return false;
    await root.chrome.storage.local.remove(LOCAL_EXECUTION_KEYS);
    if (root.chrome.storage.session) {
      try { await root.chrome.storage.session.remove(SESSION_EXECUTION_KEYS); } catch { /* best effort */ }
    }
    await root.chrome.storage.local.set({
      [RETIREMENT_KEY]: {
        retiredAt: new Date().toISOString(),
        note: "Project execution was retired; legacy project metadata remains available for folder migration."
      }
    });
    return true;
  }

  if (typeof importScripts === "function") retire().catch(() => {});

  return {
    RETIREMENT_KEY,
    LOCAL_EXECUTION_KEYS,
    SESSION_EXECUTION_KEYS,
    retire
  };
});