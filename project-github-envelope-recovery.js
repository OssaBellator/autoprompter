"use strict";

(function attachGitHubIssueEnvelopeRecovery(root, factory) {
  const projectStore = root.AutoPrompterProjectStore
    || (typeof require === "function" ? require("./project-store.js") : null);
  const api = factory(projectStore);
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.AutoPrompterGitHubIssueEnvelopeRecovery = api;
})(typeof globalThis !== "undefined" ? globalThis : self, ProjectStore => {
  const PATCH_FLAG = Symbol.for("autoprompter.githubIssueEnvelopeRecovery.installed");
  const MODE = "github_issues_and_pull_requests";
  const ISSUES_BEGIN = "AUTOPROMPTER_ISSUES_BEGIN";
  const ISSUES_END = "AUTOPROMPTER_ISSUES_END";

  function extractLatestEnvelope(output, begin = ISSUES_BEGIN, end = ISSUES_END) {
    const text = String(output || "").replace(/^\uFEFF/, "");
    const finish = text.lastIndexOf(end);
    if (finish < 0) return "";
    const start = text.lastIndexOf(begin, finish);
    if (start < 0 || start >= finish) return "";
    return text.slice(start, finish + end.length).trim();
  }

  function install(projectStore = ProjectStore) {
    if (!projectStore?.submitProjectPlannerOutput) {
      throw new Error("GitHub issue envelope recovery dependencies are unavailable.");
    }
    if (projectStore[PATCH_FLAG]) return projectStore[PATCH_FLAG];

    const originalSubmitPlannerOutput = projectStore.submitProjectPlannerOutput.bind(projectStore);
    projectStore.submitProjectPlannerOutput = function submitLatestGitHubIssueEnvelope(storeInput, projectId, output, clock = Date.now) {
      const id = String(projectId || storeInput?.activeProjectId || "");
      const project = storeInput?.projects?.[id];
      if (project?.githubWorkflowMode !== MODE) {
        return originalSubmitPlannerOutput(storeInput, projectId, output, clock);
      }
      const envelope = extractLatestEnvelope(output);
      return originalSubmitPlannerOutput(storeInput, projectId, envelope || output, clock);
    };

    const installed = { originalSubmitPlannerOutput };
    Object.defineProperty(projectStore, PATCH_FLAG, { value: installed, enumerable: false });
    return installed;
  }

  return {
    MODE,
    ISSUES_BEGIN,
    ISSUES_END,
    extractLatestEnvelope,
    install
  };
});
