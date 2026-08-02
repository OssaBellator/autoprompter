"use strict";

(function attachPlannerCompiler(root, factory) {
  const plannerProtocol = root.AutoPrompterPlannerProtocol
    || (typeof require === "function" ? require("./planner-protocol.js") : null);
  const projectStore = root.AutoPrompterProjectStore
    || (typeof require === "function" ? require("./project-store.js") : null);
  const api = factory(plannerProtocol);
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.AutoPrompterPlannerCompiler = api;
  if (projectStore && typeof importScripts === "function") api.install(projectStore);
})(typeof globalThis !== "undefined" ? globalThis : self, PlannerProtocol => {
  const PROPOSAL_BEGIN = "AUTOPROMPTER_PROPOSAL_BEGIN";
  const PROPOSAL_END = "AUTOPROMPTER_PROPOSAL_END";
  const PROPOSAL_SCHEMA_VERSION = "1.0";
  const PATCH_FLAG = Symbol.for("autoprompter.plannerCompiler.installed");
  const ROLES = new Set(["implementation", "research", "testing", "documentation", "review", "integration"]);
  const DIFFICULTIES = new Set(["small", "medium", "large", "critical"]);
  const MODEL_CLASSES = new Set(["fast", "standard", "deep"]);

  class PlannerProposalError extends Error {
    constructor(code, message, details = {}) {
      super(`[${code}] ${message}`);
      this.name = "PlannerProposalError";
      this.code = code;
      this.details = details;
    }
  }

  function assertPlannerProtocol() {
    if (!PlannerProtocol) throw new PlannerProposalError("PLAN_COMPILER_UNAVAILABLE", "Planner protocol is unavailable.");
    return PlannerProtocol;
  }

  function asString(value, fallback = "") {
    return typeof value === "string" ? value.trim() : fallback;
  }

  function asStringArray(value) {
    if (Array.isArray(value)) return value.map(item => asString(item)).filter(Boolean);
    if (typeof value === "string" && value.trim()) return [value.trim()];
    return [];
  }

  function slug(value, fallback = "task") {
    return String(value || fallback)
      .normalize("NFKD")
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "")
      .slice(0, 120) || fallback;
  }

  function uniqueKey(base, used) {
    let key = slug(base, "task");
    let candidate = key;
    let suffix = 2;
    while (used.has(candidate)) candidate = `${key.slice(0, 110)}-${suffix++}`;
    used.add(candidate);
    return candidate;
  }

  function normalizeComparable(value) {
    return String(value || "")
      .normalize("NFKD")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim()
      .replace(/\s+/g, " ");
  }

  function extractBalancedJson(text) {
    const start = text.indexOf("{");
    if (start < 0) return "";
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < text.length; index += 1) {
      const char = text[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') inString = true;
      else if (char === "{") depth += 1;
      else if (char === "}") {
        depth -= 1;
        if (depth === 0) return text.slice(start, index + 1);
      }
    }
    return "";
  }

  function proposalPayload(output) {
    let text = String(output || "").replace(/^\uFEFF/, "").trim();
    if (!text) throw new PlannerProposalError("PLAN_PROPOSAL_EMPTY", "Planner proposal is empty.");
    const begin = text.indexOf(PROPOSAL_BEGIN);
    const end = text.indexOf(PROPOSAL_END);
    if (begin >= 0 || end >= 0) {
      if (begin < 0 || end < 0 || begin >= end) {
        throw new PlannerProposalError("PLAN_PROPOSAL_MARKERS", "Planner proposal markers are missing or out of order.");
      }
      text = text.slice(begin + PROPOSAL_BEGIN.length, end).trim();
    } else {
      text = extractBalancedJson(text);
    }
    if (!text) throw new PlannerProposalError("PLAN_PROPOSAL_JSON_MISSING", "No JSON object was found in the planner response.");
    return text
      .replace(/[\u201C\u201D]/g, '"')
      .replace(/[\u2018\u2019]/g, "'")
      .replace(/,\s*([}\]])/g, "$1");
  }

  function parseProposal(output) {
    const protocol = assertPlannerProtocol();
    const text = String(output || "");
    const planBegin = protocol.PLAN_BEGIN || "AUTOPROMPTER_PLAN_BEGIN";
    const planEnd = protocol.PLAN_END || "AUTOPROMPTER_PLAN_END";
    if (text.includes(planBegin) && text.includes(planEnd)) return { kind: "canonical-envelope", output: text };

    let proposal;
    try {
      proposal = JSON.parse(proposalPayload(text));
    } catch (error) {
      if (error instanceof PlannerProposalError) throw error;
      throw new PlannerProposalError("PLAN_PROPOSAL_PARSE_FAILED", `Planner proposal JSON could not be parsed: ${error.message}`);
    }
    if (!proposal || typeof proposal !== "object" || Array.isArray(proposal)) {
      throw new PlannerProposalError("PLAN_PROPOSAL_TYPE", "Planner proposal must be a JSON object.");
    }
    return { kind: "proposal", proposal };
  }

  function inferRole(task) {
    const supplied = asString(task.role).toLowerCase();
    const aliases = {
      code: "implementation", coding: "implementation", development: "implementation", developer: "implementation",
      test: "testing", qa: "testing", quality: "testing",
      docs: "documentation", document: "documentation",
      investigate: "research", analysis: "research",
      merge: "integration", integrator: "integration",
      reviewer: "review"
    };
    if (ROLES.has(supplied)) return supplied;
    if (aliases[supplied]) return aliases[supplied];
    const haystack = `${task.title || ""} ${task.description || ""}`.toLowerCase();
    if (/\b(test|spec|qa|coverage|verify)\b/.test(haystack)) return "testing";
    if (/\b(doc|readme|guide|manual)\b/.test(haystack)) return "documentation";
    if (/\b(research|investigate|evaluate|compare|spike)\b/.test(haystack)) return "research";
    if (/\b(review|audit)\b/.test(haystack)) return "review";
    if (/\b(integrat|merge|release)\b/.test(haystack)) return "integration";
    return "implementation";
  }

  function inferDifficulty(task) {
    const supplied = asString(task.difficulty).toLowerCase();
    const aliases = { tiny: "small", easy: "small", moderate: "medium", hard: "large", high: "large", urgent: "critical" };
    if (DIFFICULTIES.has(supplied)) return supplied;
    if (aliases[supplied]) return aliases[supplied];
    const length = asString(task.description).length;
    const criteria = asStringArray(task.acceptanceCriteria || task.acceptance).length;
    if (length > 3000 || criteria > 8) return "large";
    if (length < 500 && criteria <= 3) return "small";
    return "medium";
  }

  function inferModelClass(task, difficulty) {
    const supplied = asString(task.preferredModelClass || task.modelClass || task.model_class).toLowerCase();
    const aliases = { mini: "fast", quick: "fast", normal: "standard", reasoning: "deep", advanced: "deep" };
    if (MODEL_CLASSES.has(supplied)) return supplied;
    if (aliases[supplied]) return aliases[supplied];
    if (difficulty === "critical" || difficulty === "large") return "deep";
    if (difficulty === "small") return "fast";
    return "standard";
  }

  function safeRelativePath(value) {
    const path = asString(value).replace(/\\/g, "/").replace(/^\.\//, "");
    if (!path || path.length > 300 || path.includes("\0") || path.startsWith("/") || /^[A-Za-z]:\//.test(path)) return "";
    if (path.split("/").some(segment => segment === "..")) return "";
    return path;
  }

  function safeVerificationCommand(value) {
    const command = asString(value);
    if (!command || command.length > 1000 || /[\r\n\0]/.test(command)) return "";
    if (/(?:^|\s)(?:sudo\s+|rm\s+-rf\b|git\s+reset\s+--hard\b|git\s+push\s+--force\b|curl\b[^|]*\|\s*(?:sh|bash)\b|wget\b[^|]*\|\s*(?:sh|bash)\b)/i.test(command)) return "";
    return command;
  }

  function normalizeTask(raw, index, usedKeys, diagnostics) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new PlannerProposalError("PLAN_TASK_TYPE", `Task ${index + 1} must be an object.`);
    }
    const title = asString(raw.title || raw.name || raw.key, `Task ${index + 1}`).slice(0, 200);
    const key = uniqueKey(raw.key || raw.taskKey || raw.id || title, usedKeys);
    const description = asString(raw.description || raw.scope || raw.deliverable || title).slice(0, 12000);
    const difficulty = inferDifficulty(raw);
    const paths = asStringArray(raw.allowedPaths || raw.allowed_paths || raw.paths)
      .map(safeRelativePath)
      .filter(Boolean);
    if (!paths.length) {
      paths.push("**/*");
      diagnostics.push({ code: "PLAN_PATHS_DEFAULTED", taskKey: key, message: "No safe allowed paths were supplied; repository-wide paths were used." });
    }
    const commands = asStringArray(raw.verificationCommands || raw.verification_commands || raw.checks)
      .map(safeVerificationCommand)
      .filter(Boolean);
    const suppliedCommands = asStringArray(raw.verificationCommands || raw.verification_commands || raw.checks);
    if (commands.length !== suppliedCommands.length) {
      diagnostics.push({ code: "PLAN_UNSAFE_COMMAND_REMOVED", taskKey: key, message: "One or more unsafe verification commands were omitted." });
    }
    const acceptanceCriteria = asStringArray(raw.acceptanceCriteria || raw.acceptance_criteria || raw.acceptance)
      .map(item => item.slice(0, 1000));
    if (!acceptanceCriteria.length) acceptanceCriteria.push("The scoped deliverable is complete and verifiably satisfies the task description.");
    return {
      sourceKey: key,
      sourceAliases: [raw.key, raw.taskKey, raw.id, title].map(normalizeComparable).filter(Boolean),
      rawDependencies: asStringArray(raw.dependencies || raw.dependsOn || raw.depends_on),
      id: `task-${key}`.slice(0, 200),
      title,
      description,
      dependencies: [],
      role: inferRole(raw),
      difficulty,
      preferredModelClass: inferModelClass(raw, difficulty),
      allowedPaths: [...new Set(paths)].slice(0, 50),
      acceptanceCriteria: acceptanceCriteria.slice(0, 30),
      verificationCommands: [...new Set(commands)].slice(0, 20)
    };
  }

  function dependencyLookup(tasks) {
    const lookup = new Map();
    const ambiguous = new Set();
    for (const task of tasks) {
      for (const alias of [...task.sourceAliases, normalizeComparable(task.id), normalizeComparable(task.sourceKey)]) {
        if (!alias) continue;
        if (lookup.has(alias) && lookup.get(alias) !== task.id) ambiguous.add(alias);
        else lookup.set(alias, task.id);
      }
    }
    for (const alias of ambiguous) lookup.delete(alias);
    return lookup;
  }

  function resolveDependencies(tasks, diagnostics) {
    const lookup = dependencyLookup(tasks);
    for (const task of tasks) {
      const dependencies = [];
      for (const raw of task.rawDependencies) {
        const normalized = normalizeComparable(String(raw).replace(/^task-/, ""));
        const resolved = lookup.get(normalized) || lookup.get(normalizeComparable(raw));
        if (!resolved) {
          diagnostics.push({ code: "PLAN_DEPENDENCY_IGNORED", taskKey: task.sourceKey, dependency: raw, message: "An unknown or ambiguous dependency was ignored." });
          continue;
        }
        if (resolved === task.id) {
          diagnostics.push({ code: "PLAN_SELF_DEPENDENCY_REMOVED", taskKey: task.sourceKey, dependency: raw, message: "A self dependency was removed." });
          continue;
        }
        if (!dependencies.includes(resolved)) dependencies.push(resolved);
      }
      task.dependencies = dependencies;
    }
  }

  function removeCycles(tasks, diagnostics) {
    const byId = new Map(tasks.map(task => [task.id, task]));
    const visiting = new Set();
    const visited = new Set();
    function visit(task) {
      if (visited.has(task.id)) return;
      visiting.add(task.id);
      task.dependencies = task.dependencies.filter(dependencyId => {
        if (!byId.has(dependencyId)) return false;
        if (visiting.has(dependencyId)) {
          diagnostics.push({ code: "PLAN_CYCLE_EDGE_REMOVED", taskKey: task.sourceKey, dependency: dependencyId, message: "A dependency edge was removed to keep the task graph acyclic." });
          return false;
        }
        visit(byId.get(dependencyId));
        return true;
      });
      visiting.delete(task.id);
      visited.add(task.id);
    }
    for (const task of tasks) visit(task);
  }

  function taskDepths(tasks) {
    const byId = new Map(tasks.map(task => [task.id, task]));
    const memo = new Map();
    function depth(task) {
      if (memo.has(task.id)) return memo.get(task.id);
      const value = task.dependencies.length
        ? 1 + Math.max(...task.dependencies.map(id => depth(byId.get(id))))
        : 0;
      memo.set(task.id, value);
      return value;
    }
    for (const task of tasks) depth(task);
    return memo;
  }

  function buildPhases(tasks) {
    const depths = taskDepths(tasks);
    const groups = new Map();
    for (const task of tasks) {
      const depth = depths.get(task.id) || 0;
      if (!groups.has(depth)) groups.set(depth, []);
      groups.get(depth).push(task);
    }
    return [...groups.entries()].sort(([a], [b]) => a - b).map(([depth, phaseTasks]) => ({
      id: `phase-${depth + 1}`,
      title: depth === 0 ? "Foundation" : `Dependent work ${depth + 1}`,
      taskIds: phaseTasks.map(task => task.id),
      acceptanceCriteria: phaseTasks.map(task => task.acceptanceCriteria[0]).slice(0, 30)
    }));
  }

  function buildCriticalPath(tasks) {
    const byId = new Map(tasks.map(task => [task.id, task]));
    const memo = new Map();
    function pathTo(task) {
      if (memo.has(task.id)) return memo.get(task.id);
      let prefix = [];
      for (const dependencyId of task.dependencies) {
        const candidate = pathTo(byId.get(dependencyId));
        if (candidate.length > prefix.length) prefix = candidate;
      }
      const result = [...prefix, task.id];
      memo.set(task.id, result);
      return result;
    }
    let longest = [];
    for (const task of tasks) {
      const candidate = pathTo(task);
      if (candidate.length > longest.length) longest = candidate;
    }
    return longest;
  }

  function canonicalPlanFromProposal(proposal, project, revision, clock = Date.now) {
    if (!project?.projectId) throw new PlannerProposalError("PLAN_PROJECT_MISSING", "A project is required to compile the proposal.");
    const rawTasks = Array.isArray(proposal.tasks) ? proposal.tasks : [];
    if (!rawTasks.length) throw new PlannerProposalError("PLAN_TASKS_EMPTY", "Planner proposal must contain at least one task.");
    const diagnostics = [];
    const usedKeys = new Set();
    const tasks = rawTasks.slice(0, 100).map((task, index) => normalizeTask(task, index, usedKeys, diagnostics));
    resolveDependencies(tasks, diagnostics);
    removeCycles(tasks, diagnostics);
    const canonicalTasks = tasks.map(({ sourceKey, sourceAliases, rawDependencies, ...task }) => task);
    const rationale = asString(proposal.summary || proposal.rationale || proposal.reasoning,
      `Compiled ${canonicalTasks.length} bounded task${canonicalTasks.length === 1 ? "" : "s"} from the planner proposal.`).slice(0, 4000);
    const plan = {
      schemaVersion: PlannerProtocol?.PLAN_SCHEMA_VERSION || "1.0",
      projectId: project.projectId,
      revision,
      requiresMultipleAgents: canonicalTasks.length > 1,
      rationale,
      phases: buildPhases(canonicalTasks),
      tasks: canonicalTasks,
      criticalPath: buildCriticalPath(canonicalTasks),
      createdAt: new Date(clock()).toISOString()
    };
    const validated = assertPlannerProtocol().validatePlan(plan, project, revision);
    return { plan: validated, diagnostics };
  }

  function serializePlan(plan) {
    const protocol = assertPlannerProtocol();
    return [
      protocol.PLAN_BEGIN || "AUTOPROMPTER_PLAN_BEGIN",
      JSON.stringify(plan, null, 2),
      protocol.PLAN_END || "AUTOPROMPTER_PLAN_END"
    ].join("\n");
  }

  function compilePlannerOutput(output, project, revision, clock = Date.now) {
    const parsed = parseProposal(output);
    if (parsed.kind === "canonical-envelope") return { output: parsed.output, diagnostics: [], mode: "canonical" };
    const proposal = parsed.proposal;
    if (proposal.schemaVersion && proposal.projectId && Array.isArray(proposal.phases) && Array.isArray(proposal.tasks)) {
      const plan = assertPlannerProtocol().validatePlan(proposal, project, revision);
      return { output: serializePlan(plan), plan, diagnostics: [], mode: "canonical-json" };
    }
    const compiled = canonicalPlanFromProposal(proposal, project, revision, clock);
    return { output: serializePlan(compiled.plan), plan: compiled.plan, diagnostics: compiled.diagnostics, mode: "compiled-proposal" };
  }

  function buildProposalPrompt(project, revision) {
    const example = {
      schemaVersion: PROPOSAL_SCHEMA_VERSION,
      summary: "Why this decomposition is appropriate.",
      tasks: [
        {
          key: "inspect-current-runtime",
          title: "Inspect the current runtime",
          description: "Identify the relevant files, constraints, and verified current behavior.",
          dependsOn: [],
          role: "research",
          difficulty: "small",
          modelClass: "fast",
          allowedPaths: ["src/**", "tests/**"],
          acceptance: ["The affected code paths and constraints are documented."],
          checks: []
        },
        {
          key: "implement-change",
          title: "Implement the bounded change",
          description: "Implement the requested behavior and focused regression tests.",
          dependsOn: ["inspect-current-runtime"],
          role: "implementation",
          difficulty: "medium",
          modelClass: "standard",
          allowedPaths: ["src/**", "tests/**"],
          acceptance: ["The requested behavior works and regression tests pass."],
          checks: ["npm test"]
        }
      ]
    };
    return [
      "You are the planning agent for an AutoPrompter Project Mode project.",
      "Plan the work; do not implement it, edit files, create branches, or dispatch chats.",
      "AutoPrompter will generate all internal IDs, phases, timestamps, critical paths, dispatch records, and schema fields.",
      "",
      `Project ID: ${project.projectId}`,
      `Project title: ${project.title}`,
      `Goal: ${project.goal}`,
      `Repository: ${project.repository.slug}`,
      `Default branch: ${project.repository.defaultBranch}`,
      `Worker chats available: ${project.roles.workerChatIds.length}`,
      `Maximum concurrent workers: ${project.scheduler.maxConcurrentWorkers}`,
      `Plan revision: ${revision}`,
      "",
      "Return a compact task proposal. Use unique task keys and make dependsOn reference those keys.",
      "Keep tasks independently reviewable, use least-privilege repository-relative allowedPaths, and use only non-destructive checks.",
      "Supported roles: implementation, research, testing, documentation, review, integration.",
      "Supported difficulty values: small, medium, large, critical.",
      "Supported modelClass values: fast, standard, deep.",
      "Do not include generated timestamps, project IDs, phase IDs, task IDs, branch names, dispatch IDs, or a critical path.",
      "",
      `Return exactly one ${PROPOSAL_BEGIN} / ${PROPOSAL_END} JSON envelope with no prose outside it:`,
      PROPOSAL_BEGIN,
      JSON.stringify(example, null, 2),
      PROPOSAL_END
    ].join("\n");
  }

  function install(projectStore) {
    if (!projectStore || typeof projectStore !== "object") throw new PlannerProposalError("PLAN_STORE_MISSING", "Project store is unavailable.");
    if (projectStore[PATCH_FLAG]) return projectStore[PATCH_FLAG];
    if (typeof projectStore.buildProjectPlannerPrompt !== "function" || typeof projectStore.submitProjectPlannerOutput !== "function") {
      throw new PlannerProposalError("PLAN_STORE_INCOMPATIBLE", "Project store does not expose planner operations.");
    }
    const originalBuild = projectStore.buildProjectPlannerPrompt.bind(projectStore);
    const originalSubmit = projectStore.submitProjectPlannerOutput.bind(projectStore);

    projectStore.buildProjectPlannerPrompt = function compiledPlannerPrompt(storeInput, projectId = "") {
      const result = originalBuild(storeInput, projectId);
      return { ...result, prompt: buildProposalPrompt(result.project, result.revision), plannerProtocol: "compiled-proposal-v1" };
    };

    projectStore.submitProjectPlannerOutput = function compiledPlannerSubmit(storeInput, projectId, output, clock = Date.now) {
      const id = String(projectId || storeInput?.activeProjectId || "");
      const project = storeInput?.projects?.[id];
      if (!project) return originalSubmit(storeInput, projectId, output, clock);
      const revision = Number(storeInput?.approvedPlansByProject?.[id]?.revision || 0) + 1;
      const compiled = compilePlannerOutput(output, project, revision, clock);
      const result = originalSubmit(storeInput, projectId, compiled.output, clock);
      return {
        ...result,
        plannerCompilation: {
          mode: compiled.mode,
          diagnosticCount: compiled.diagnostics.length,
          diagnostics: compiled.diagnostics.slice(0, 50)
        }
      };
    };

    const installed = { originalBuild, originalSubmit, protocol: "compiled-proposal-v1" };
    Object.defineProperty(projectStore, PATCH_FLAG, { value: installed, enumerable: false, configurable: false });
    return installed;
  }

  return {
    PROPOSAL_BEGIN,
    PROPOSAL_END,
    PROPOSAL_SCHEMA_VERSION,
    PlannerProposalError,
    parseProposal,
    canonicalPlanFromProposal,
    compilePlannerOutput,
    buildProposalPrompt,
    serializePlan,
    install
  };
});
