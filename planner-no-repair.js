"use strict";

(function attachPlannerNoRepair(root, factory) {
  const compiler = root.AutoPrompterPlannerCompiler
    || (typeof require === "function" ? require("./planner-compiler.js") : null);
  const fallback = root.AutoPrompterPlannerFallback
    || (typeof require === "function" ? require("./planner-fallback.js") : null);
  const api = factory(compiler, fallback);
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.AutoPrompterPlannerNoRepair = api;
})(typeof globalThis !== "undefined" ? globalThis : self, (PlannerCompiler, PlannerFallback) => {
  const PATCH_FLAG = Symbol.for("autoprompter.plannerNoRepair.installed");
  const NON_RECOVERABLE_CODES = new Set([
    "PLAN_COMPILER_UNAVAILABLE",
    "PLAN_STORE_MISSING",
    "PLAN_STORE_INCOMPATIBLE"
  ]);

  function isPlannerValidationFailure(error) {
    if (!error) return false;
    const code = String(error.code || "");
    if (NON_RECOVERABLE_CODES.has(code)) return false;
    if (code.startsWith("PLAN_")) return true;
    const message = String(error.message || error);
    return /\b(?:planner|plan|task|phase|dependency|critical path|allowed paths?|verification commands?|model class|acceptance criteria)\b/i.test(message);
  }

  function fallbackEnvelope(project, output) {
    const proposal = PlannerFallback.buildFallbackProposal(project, output);
    return [
      PlannerCompiler.PROPOSAL_BEGIN,
      JSON.stringify(proposal),
      PlannerCompiler.PROPOSAL_END
    ].join("\n");
  }

  function install(projectStore) {
    if (!PlannerCompiler || !PlannerFallback || !projectStore || typeof projectStore.submitProjectPlannerOutput !== "function") {
      throw new Error("AutoPrompter no-repair planner dependencies are unavailable.");
    }
    if (projectStore[PATCH_FLAG]) return projectStore[PATCH_FLAG];
    const originalSubmit = projectStore.submitProjectPlannerOutput.bind(projectStore);

    projectStore.submitProjectPlannerOutput = function noRepairPlannerSubmit(storeInput, projectId, output, clock = Date.now) {
      try {
        return originalSubmit(storeInput, projectId, output, clock);
      } catch (error) {
        if (!isPlannerValidationFailure(error)) throw error;
        const id = String(projectId || storeInput?.activeProjectId || "");
        const project = storeInput?.projects?.[id];
        if (!project) throw error;
        const result = originalSubmit(storeInput, id, fallbackEnvelope(project, output), clock);
        const existing = result.plannerCompilation?.diagnostics || [];
        return {
          ...result,
          plannerCompilation: {
            mode: "compiled-local-recovery",
            diagnosticCount: existing.length + 1,
            diagnostics: [
              {
                code: "PLAN_VALIDATION_RECOVERED_LOCALLY",
                message: `Planner validation was recovered locally without a repair prompt: ${String(error.message || error).slice(0, 1000)}`
              },
              ...existing
            ].slice(0, 50)
          }
        };
      }
    };

    const installed = { originalSubmit, protocol: "no-planner-repair-v1" };
    Object.defineProperty(projectStore, PATCH_FLAG, { value: installed, enumerable: false });
    return installed;
  }

  return {
    NON_RECOVERABLE_CODES: [...NON_RECOVERABLE_CODES],
    isPlannerValidationFailure,
    fallbackEnvelope,
    install
  };
});
