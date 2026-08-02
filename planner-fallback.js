"use strict";

(function attachPlannerFallback(root, factory) {
  const compiler = root.AutoPrompterPlannerCompiler
    || (typeof require === "function" ? require("./planner-compiler.js") : null);
  const api = factory(compiler);
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.AutoPrompterPlannerFallback = api;
})(typeof globalThis !== "undefined" ? globalThis : self, PlannerCompiler => {
  const PATCH_FLAG = Symbol.for("autoprompter.plannerFallback.installed");
  const RECOVERABLE_CODES = new Set([
    "PLAN_PROPOSAL_EMPTY",
    "PLAN_PROPOSAL_JSON_MISSING",
    "PLAN_PROPOSAL_PARSE_FAILED",
    "PLAN_PROPOSAL_MARKERS",
    "PLAN_PROPOSAL_TYPE"
  ]);

  function cleanText(value) {
    return String(value || "")
      .replace(/```[a-z0-9_-]*|```/gi, "")
      .replace(/AUTOPROMPTER_(?:PROPOSAL|PLAN)_(?:BEGIN|END)/g, "")
      .replace(/\r/g, "")
      .trim()
      .slice(0, 12000);
  }

  function concise(value, fallback, limit = 1200) {
    const text = cleanText(value).replace(/\s+/g, " ").trim();
    return (text || fallback).slice(0, limit);
  }

  function candidateTasks(text) {
    const lines = cleanText(text).split("\n")
      .map(line => line.trim())
      .map(line => line.replace(/^#{1,6}\s+/, "").replace(/^[-*+]\s+/, "").replace(/^\d+[.)]\s+/, "").trim())
      .filter(line => line.length >= 12 && line.length <= 260)
      .filter(line => !/^(sure|okay|understood|i(?:'| a)m ready|here(?:'| i)s|plan:?$)/i.test(line));
    return [...new Set(lines)].slice(0, 6);
  }

  function slug(value, fallback) {
    return String(value || fallback)
      .normalize("NFKD")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || fallback;
  }

  function taskFromLine(line, index) {
    const key = slug(line, `task-${index + 1}`);
    return {
      key,
      title: concise(line, `Project task ${index + 1}`, 180),
      description: `Complete this independently executable part of the project goal from the default branch: ${concise(line, "Implement the required project change.", 1000)}`,
      dependsOn: [],
      role: index === 0 ? "research" : "implementation",
      difficulty: index === 0 ? "small" : "medium",
      modelClass: index === 0 ? "fast" : "standard",
      allowedPaths: ["**/*"],
      acceptance: [`${concise(line, "The assigned work", 500)} is completed with repository evidence.`],
      checks: []
    };
  }

  function buildFallbackProposal(project, output) {
    const lines = candidateTasks(output);
    if (lines.length >= 2) {
      const tasks = lines.map((line, index) => taskFromLine(line, index));
      tasks.push({
        key: "verify-project-outcome",
        title: "Verify the combined project outcome",
        description: "After the independent task branches are accepted, run the repository's available checks, inspect the combined result against the project goal, and record any remaining blockers.",
        dependsOn: tasks.map(task => task.key),
        role: "testing",
        difficulty: "medium",
        modelClass: "standard",
        allowedPaths: ["**/*"],
        acceptance: ["The combined project outcome is checked against the goal and supported by repository evidence."],
        checks: []
      });
      return {
        schemaVersion: "1.0",
        summary: concise(output, project.goal, 1800),
        tasks
      };
    }

    return {
      schemaVersion: "1.0",
      summary: `AutoPrompter compiled a safe fallback plan for: ${concise(project.goal, project.title, 1800)}`,
      tasks: [
        {
          key: "inspect-current-state",
          title: "Inspect the current repository state",
          description: `Independently inspect ${project.repository.slug}, identify the code and workflows relevant to the goal, and record constraints that the reviewer can use. Goal: ${concise(project.goal, project.title, 3000)}`,
          dependsOn: [],
          role: "research",
          difficulty: "small",
          modelClass: "fast",
          allowedPaths: ["**/*"],
          acceptance: ["The affected repository areas and implementation constraints are identified with evidence."],
          checks: []
        },
        {
          key: "implement-project-goal",
          title: "Implement the project goal",
          description: `Starting independently from the default branch, inspect what is necessary and implement the required repository changes for this goal: ${concise(project.goal, project.title, 5000)}`,
          dependsOn: [],
          role: "implementation",
          difficulty: "large",
          modelClass: "deep",
          allowedPaths: ["**/*"],
          acceptance: ["The requested project outcome is implemented in reviewable commits."],
          checks: []
        },
        {
          key: "verify-project-outcome",
          title: "Verify and document the completed outcome",
          description: "After the implementation branch is accepted, run applicable checks, compare the implementation with the project goal, repair regressions, and document any operational steps.",
          dependsOn: ["implement-project-goal"],
          role: "testing",
          difficulty: "medium",
          modelClass: "standard",
          allowedPaths: ["**/*"],
          acceptance: ["Applicable checks pass and the completed outcome is documented with repository evidence."],
          checks: []
        }
      ]
    };
  }

  function recoverable(error) {
    if (!error) return false;
    if (RECOVERABLE_CODES.has(error.code)) return true;
    return /PLAN_PROPOSAL_(?:EMPTY|JSON_MISSING|PARSE_FAILED|MARKERS|TYPE)/.test(String(error.message || ""));
  }

  function install(projectStore) {
    if (!PlannerCompiler || !projectStore || typeof projectStore.submitProjectPlannerOutput !== "function") {
      throw new Error("AutoPrompter planner fallback dependencies are unavailable.");
    }
    if (projectStore[PATCH_FLAG]) return projectStore[PATCH_FLAG];
    const originalSubmit = projectStore.submitProjectPlannerOutput.bind(projectStore);

    projectStore.submitProjectPlannerOutput = function fallbackPlannerSubmit(storeInput, projectId, output, clock = Date.now) {
      try {
        return originalSubmit(storeInput, projectId, output, clock);
      } catch (error) {
        if (!recoverable(error)) throw error;
        const id = String(projectId || storeInput?.activeProjectId || "");
        const project = storeInput?.projects?.[id];
        if (!project) throw error;
        const proposal = buildFallbackProposal(project, output);
        const envelope = [
          PlannerCompiler.PROPOSAL_BEGIN,
          JSON.stringify(proposal),
          PlannerCompiler.PROPOSAL_END
        ].join("\n");
        const result = originalSubmit(storeInput, id, envelope, clock);
        const diagnostics = result.plannerCompilation?.diagnostics || [];
        return {
          ...result,
          plannerCompilation: {
            mode: "compiled-local-fallback",
            diagnosticCount: diagnostics.length + 1,
            diagnostics: [
              {
                code: "PLAN_TEXT_COMPILED_LOCALLY",
                message: "The planner response did not contain usable JSON, so AutoPrompter compiled a bounded parallel task graph locally instead of entering a repair loop."
              },
              ...diagnostics
            ].slice(0, 50)
          }
        };
      }
    };

    const installed = { originalSubmit, protocol: "compiled-local-fallback-v2" };
    Object.defineProperty(projectStore, PATCH_FLAG, { value: installed, enumerable: false });
    return installed;
  }

  return { RECOVERABLE_CODES: [...RECOVERABLE_CODES], buildFallbackProposal, recoverable, install };
});
