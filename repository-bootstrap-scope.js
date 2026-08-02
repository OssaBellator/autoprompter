"use strict";

(function attachRepositoryBootstrapScope(root, factory) {
  const repositoryBootstrap = root.AutoPrompterRepositoryBootstrap
    || (typeof require === "function" ? require("./repository-bootstrap.js") : null);
  const api = factory(repositoryBootstrap);
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.AutoPrompterRepositoryBootstrapScope = api;
})(typeof globalThis !== "undefined" ? globalThis : self, RepositoryBootstrap => {
  const BUNDLE_PATHS = Object.freeze([
    ".autoprompter/project.json",
    ".autoprompter/plan.json",
    ".autoprompter/README.md",
    ".autoprompter/AGENT_INSTRUCTIONS.md",
    ".github/workflows/autoprompter-plan-validation.yml"
  ]);
  const BUNDLE_TARGET = `repository-bootstrap-bundle:${BUNDLE_PATHS.join(",")}`;
  const PATCH_FLAG = Symbol.for("autoprompter.repositoryBootstrapScope.installed");

  function install(repositoryBootstrap = RepositoryBootstrap) {
    if (!repositoryBootstrap || typeof repositoryBootstrap !== "object") {
      throw new Error("AutoPrompter repository bootstrap runtime is unavailable.");
    }
    if (repositoryBootstrap[PATCH_FLAG]) return repositoryBootstrap[PATCH_FLAG];
    const originalWorkflowPath = repositoryBootstrap.WORKFLOW_PATH;
    repositoryBootstrap.WORKFLOW_PATH = BUNDLE_TARGET;
    const installed = Object.freeze({ originalWorkflowPath, target: BUNDLE_TARGET, paths: BUNDLE_PATHS });
    Object.defineProperty(repositoryBootstrap, PATCH_FLAG, { value: installed, enumerable: false });
    return installed;
  }

  const installed = RepositoryBootstrap ? install(RepositoryBootstrap) : null;
  return { BUNDLE_PATHS, BUNDLE_TARGET, install, installed };
});
