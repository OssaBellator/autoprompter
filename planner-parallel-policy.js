"use strict";

(function attachPlannerParallelPolicy(root, factory) {
  const projectStore = root.AutoPrompterProjectStore
    || (typeof require === "function" ? require("./project-store.js") : null);
  const api = factory(projectStore);
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.AutoPrompterPlannerParallelPolicy = api;
})(typeof globalThis !== "undefined" ? globalThis : self, ProjectStore => {
  const PATCH_FLAG = Symbol.for("autoprompter.plannerParallelPolicy.installed");
  const PARALLEL_POLICY = [
    "",
    "Parallel task graph rules:",
    "- Add a dependency only when a task literally cannot start from the default branch without an accepted commit from that dependency.",
    "- Ordering in this response is not a dependency. Do not serialize inspection, implementation, testing, or documentation merely because one is listed first.",
    "- Split work by independent files, subsystems, or deliverables so separate worker chats can work concurrently.",
    "- When the plan has two or more tasks, provide at least two root tasks with empty dependsOn arrays unless the repository work is technically indivisible.",
    "- Do not add a planner task for final integration; AutoPrompter has a separate reviewer and integrator after worker branches finish."
  ].join("\n");

  function install(projectStore = ProjectStore) {
    if (!projectStore?.buildProjectPlannerPrompt) {
      throw new Error("AutoPrompter planner parallel-policy dependencies are unavailable.");
    }
    if (projectStore[PATCH_FLAG]) return projectStore[PATCH_FLAG];
    const originalBuild = projectStore.buildProjectPlannerPrompt.bind(projectStore);

    projectStore.buildProjectPlannerPrompt = function buildParallelPlannerPrompt(...args) {
      const built = originalBuild(...args);
      if (!built?.prompt || built.prompt.includes("Parallel task graph rules:")) return built;
      return { ...built, prompt: `${built.prompt}${PARALLEL_POLICY}` };
    };

    const installed = { originalBuild, policy: PARALLEL_POLICY };
    Object.defineProperty(projectStore, PATCH_FLAG, { value: installed, enumerable: false });
    return installed;
  }

  return { PARALLEL_POLICY, install };
});
