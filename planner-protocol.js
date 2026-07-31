"use strict";

(function attachPlannerProtocol(root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.AutoPrompterPlannerProtocol = api;
})(typeof globalThis !== "undefined" ? globalThis : self, () => {
  const PLAN_BEGIN = "AUTOPROMPTER_PLAN_BEGIN";
  const PLAN_END = "AUTOPROMPTER_PLAN_END";
  const PLAN_SCHEMA_VERSION = "1.0";
  const MAX_PLANNER_PROMPT_CHARS = 18000;
  const MAX_PLANNER_OUTPUT_CHARS = 120000;
  const MAX_PLAN_TASKS = 100;
  const MAX_PLAN_PHASES = 30;
  const TASK_ID_PATTERN = /^task-[a-z0-9._-]+$/;
  const PHASE_ID_PATTERN = /^phase-[a-z0-9._-]+$/;
  const TASK_ROLES = new Set(["implementation", "research", "testing", "documentation", "review", "integration"]);
  const DIFFICULTIES = new Set(["small", "medium", "large", "critical"]);
  const MODEL_CLASSES = new Set(["fast", "standard", "deep"]);
  const ROOT_KEYS = ["schemaVersion", "projectId", "revision", "requiresMultipleAgents", "rationale", "phases", "tasks", "criticalPath", "createdAt"];
  const PHASE_KEYS = ["id", "title", "taskIds", "acceptanceCriteria"];
  const TASK_KEYS = [
    "id", "title", "description", "dependencies", "role", "difficulty", "preferredModelClass",
    "allowedPaths", "acceptanceCriteria", "verificationCommands"
  ];

  function clone(value) {
    return value == null ? value : structuredClone(value);
  }

  function assert(condition, message) {
    if (!condition) throw new Error(message);
  }

  function assertExactKeys(value, expected, label) {
    assert(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object.`);
    const actual = Object.keys(value).sort();
    const wanted = [...expected].sort();
    assert(actual.length === wanted.length && actual.every((key, index) => key === wanted[index]), `${label} contains missing or unknown fields.`);
  }

  function assertString(value, label, min, max, pattern = null) {
    assert(typeof value === "string", `${label} must be a string.`);
    const trimmed = value.trim();
    assert(trimmed.length >= min && trimmed.length <= max, `${label} must be between ${min} and ${max} characters.`);
    if (pattern) assert(pattern.test(trimmed), `${label} has an invalid format.`);
    return trimmed;
  }

  function assertStringArray(value, label, { min = 0, max = 100, itemMax = 1000, pattern = null, unique = false } = {}) {
    assert(Array.isArray(value), `${label} must be an array.`);
    assert(value.length >= min && value.length <= max, `${label} must contain between ${min} and ${max} items.`);
    const normalized = value.map((item, index) => assertString(item, `${label}[${index}]`, 1, itemMax, pattern));
    if (unique) assert(new Set(normalized).size === normalized.length, `${label} must not contain duplicates.`);
    return normalized;
  }

  function isSafeRelativePath(value) {
    if (typeof value !== "string") return false;
    const path = value.trim();
    if (!path || path.length > 300 || path.includes("\0") || path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path)) return false;
    return !path.split(/[\\/]+/).some(segment => segment === "..");
  }

  function isSafeVerificationCommand(value) {
    if (typeof value !== "string") return false;
    const command = value.trim();
    if (!command || command.length > 1000 || /[\r\n\0]/.test(command)) return false;
    return !/(?:^|\s)(?:sudo\s+|rm\s+-rf\b|git\s+reset\s+--hard\b|git\s+push\s+--force\b|curl\b[^|]*\|\s*(?:sh|bash)\b|wget\b[^|]*\|\s*(?:sh|bash)\b)/i.test(command);
  }

  function countMarker(text, marker) {
    return text.split(marker).length - 1;
  }

  function parsePlannerEnvelope(output) {
    const text = String(output || "").replace(/^\uFEFF/, "");
    assert(text.length > 0, "Planner output is empty.");
    assert(text.length <= MAX_PLANNER_OUTPUT_CHARS, `Planner output exceeds ${MAX_PLANNER_OUTPUT_CHARS} characters.`);
    assert(countMarker(text, PLAN_BEGIN) === 1, `Planner output must contain exactly one ${PLAN_BEGIN} marker.`);
    assert(countMarker(text, PLAN_END) === 1, `Planner output must contain exactly one ${PLAN_END} marker.`);
    const start = text.indexOf(PLAN_BEGIN);
    const end = text.indexOf(PLAN_END);
    assert(start < end, "Planner output markers are out of order.");
    assert(text.slice(0, start).trim() === "" && text.slice(end + PLAN_END.length).trim() === "", "Planner output must not contain prose outside the plan envelope.");
    const payload = text.slice(start + PLAN_BEGIN.length, end).trim();
    assert(payload.length > 0, "Planner plan envelope is empty.");
    assert(!/^```/.test(payload) && !/```$/.test(payload), "Planner JSON must not be wrapped in a code fence.");
    let plan;
    try {
      plan = JSON.parse(payload);
    } catch (error) {
      throw new Error(`Planner envelope does not contain valid JSON: ${error.message}`);
    }
    return plan;
  }

  function assertAcyclic(tasks) {
    const byId = new Map(tasks.map(task => [task.id, task]));
    const visiting = new Set();
    const visited = new Set();
    function visit(id) {
      if (visited.has(id)) return;
      assert(!visiting.has(id), `Plan dependency cycle detected at ${id}.`);
      visiting.add(id);
      for (const dependency of byId.get(id).dependencies) visit(dependency);
      visiting.delete(id);
      visited.add(id);
    }
    for (const task of tasks) visit(task.id);
  }

  function validatePlan(planInput, project, expectedRevision = 1) {
    assertExactKeys(planInput, ROOT_KEYS, "Plan");
    assert(planInput.schemaVersion === PLAN_SCHEMA_VERSION, `Plan schemaVersion must be ${PLAN_SCHEMA_VERSION}.`);
    assert(planInput.projectId === project?.projectId, "Plan projectId does not match the selected project.");
    assert(Number.isInteger(planInput.revision) && planInput.revision === expectedRevision, `Plan revision must be ${expectedRevision}.`);
    assert(typeof planInput.requiresMultipleAgents === "boolean", "Plan requiresMultipleAgents must be a boolean.");
    const rationale = assertString(planInput.rationale, "Plan rationale", 1, 4000);
    assert(Array.isArray(planInput.phases) && planInput.phases.length >= 1 && planInput.phases.length <= MAX_PLAN_PHASES, `Plan must contain between 1 and ${MAX_PLAN_PHASES} phases.`);
    assert(Array.isArray(planInput.tasks) && planInput.tasks.length >= 1 && planInput.tasks.length <= MAX_PLAN_TASKS, `Plan must contain between 1 and ${MAX_PLAN_TASKS} tasks.`);
    const createdAt = assertString(planInput.createdAt, "Plan createdAt", 20, 40);
    const parsedCreatedAt = new Date(createdAt);
    assert(Number.isFinite(parsedCreatedAt.getTime()), "Plan createdAt must be a valid ISO-8601 timestamp.");
    const canonicalCreatedAt = parsedCreatedAt.toISOString();
    assert(createdAt === canonicalCreatedAt || createdAt === canonicalCreatedAt.replace(".000Z", "Z"), "Plan createdAt must be a canonical ISO-8601 timestamp.");

    const tasks = planInput.tasks.map((task, index) => {
      assertExactKeys(task, TASK_KEYS, `Task ${index + 1}`);
      const id = assertString(task.id, `Task ${index + 1} id`, 6, 200, TASK_ID_PATTERN);
      const dependencies = assertStringArray(task.dependencies, `${id} dependencies`, { max: MAX_PLAN_TASKS, itemMax: 200, pattern: TASK_ID_PATTERN, unique: true });
      assert(!dependencies.includes(id), `${id} cannot depend on itself.`);
      const role = assertString(task.role, `${id} role`, 1, 40);
      assert(TASK_ROLES.has(role), `${id} has an unsupported role.`);
      const difficulty = assertString(task.difficulty, `${id} difficulty`, 1, 20);
      assert(DIFFICULTIES.has(difficulty), `${id} has an unsupported difficulty.`);
      const preferredModelClass = assertString(task.preferredModelClass, `${id} preferredModelClass`, 1, 20);
      assert(MODEL_CLASSES.has(preferredModelClass), `${id} has an unsupported model class.`);
      const allowedPaths = assertStringArray(task.allowedPaths, `${id} allowedPaths`, { min: 1, max: 50, itemMax: 300, unique: true });
      for (const path of allowedPaths) assert(isSafeRelativePath(path), `${id} contains an unsafe allowed path: ${path}`);
      const verificationCommands = assertStringArray(task.verificationCommands, `${id} verificationCommands`, { max: 20, itemMax: 1000, unique: true });
      for (const command of verificationCommands) assert(isSafeVerificationCommand(command), `${id} contains an unsafe verification command.`);
      return {
        id,
        title: assertString(task.title, `${id} title`, 1, 200),
        description: assertString(task.description, `${id} description`, 1, 12000),
        dependencies,
        role,
        difficulty,
        preferredModelClass,
        allowedPaths,
        acceptanceCriteria: assertStringArray(task.acceptanceCriteria, `${id} acceptanceCriteria`, { min: 1, max: 30, itemMax: 1000 }),
        verificationCommands
      };
    });

    const taskIds = tasks.map(task => task.id);
    assert(new Set(taskIds).size === taskIds.length, "Plan task IDs must be unique.");
    const knownTaskIds = new Set(taskIds);
    for (const task of tasks) {
      for (const dependency of task.dependencies) assert(knownTaskIds.has(dependency), `${task.id} references unknown dependency ${dependency}.`);
    }
    assertAcyclic(tasks);

    const phaseIds = new Set();
    const assignedTaskIds = new Set();
    const phases = planInput.phases.map((phase, index) => {
      assertExactKeys(phase, PHASE_KEYS, `Phase ${index + 1}`);
      const id = assertString(phase.id, `Phase ${index + 1} id`, 7, 200, PHASE_ID_PATTERN);
      assert(!phaseIds.has(id), "Plan phase IDs must be unique.");
      phaseIds.add(id);
      const phaseTaskIds = assertStringArray(phase.taskIds, `${id} taskIds`, { min: 1, max: MAX_PLAN_TASKS, itemMax: 200, pattern: TASK_ID_PATTERN, unique: true });
      for (const taskId of phaseTaskIds) {
        assert(knownTaskIds.has(taskId), `${id} references unknown task ${taskId}.`);
        assert(!assignedTaskIds.has(taskId), `${taskId} is assigned to more than one phase.`);
        assignedTaskIds.add(taskId);
      }
      return {
        id,
        title: assertString(phase.title, `${id} title`, 1, 160),
        taskIds: phaseTaskIds,
        acceptanceCriteria: assertStringArray(phase.acceptanceCriteria, `${id} acceptanceCriteria`, { min: 1, max: 30, itemMax: 1000 })
      };
    });
    assert(assignedTaskIds.size === taskIds.length, "Every plan task must be assigned to exactly one phase.");

    const criticalPath = assertStringArray(planInput.criticalPath, "Plan criticalPath", { max: MAX_PLAN_TASKS, itemMax: 200, pattern: TASK_ID_PATTERN, unique: true });
    for (const taskId of criticalPath) assert(knownTaskIds.has(taskId), `Plan criticalPath references unknown task ${taskId}.`);

    return {
      schemaVersion: PLAN_SCHEMA_VERSION,
      projectId: project.projectId,
      revision: planInput.revision,
      requiresMultipleAgents: planInput.requiresMultipleAgents,
      rationale,
      phases,
      tasks,
      criticalPath,
      createdAt
    };
  }

  function buildPlannerPrompt(project, revision = 1) {
    assert(project && typeof project === "object", "Project is required to build a planner prompt.");
    assert(Number.isInteger(revision) && revision >= 1, "Planner revision must be a positive integer.");
    const taskTemplate = {
      id: "task-example",
      title: "Bounded task title",
      description: "Concrete scope, deliverable, and non-goals.",
      dependencies: [],
      role: "implementation",
      difficulty: "medium",
      preferredModelClass: "standard",
      allowedPaths: ["src/example/**", "tests/example/**"],
      acceptanceCriteria: ["A testable result is produced."],
      verificationCommands: ["npm test"]
    };
    const template = {
      schemaVersion: PLAN_SCHEMA_VERSION,
      projectId: project.projectId,
      revision,
      requiresMultipleAgents: true,
      rationale: "Explain why this decomposition is appropriate.",
      phases: [{ id: "phase-foundation", title: "Foundation", taskIds: ["task-example"], acceptanceCriteria: ["The phase is verifiably complete."] }],
      tasks: [taskTemplate],
      criticalPath: ["task-example"],
      createdAt: new Date().toISOString()
    };
    const prompt = [
      "You are the planning agent for an AutoPrompter Project Mode project running entirely through subscription-backed ChatGPT Web.",
      "Do not implement the project, edit files, create branches, or dispatch other chats. Produce only a bounded executable plan.",
      "",
      `Project ID: ${project.projectId}`,
      `Project title: ${project.title}`,
      `Goal: ${project.goal}`,
      `Repository: ${project.repository.slug}`,
      `Default branch: ${project.repository.defaultBranch}`,
      `Worker chats available: ${project.roles.workerChatIds.length}`,
      `Maximum concurrent workers: ${project.scheduler.maxConcurrentWorkers}`,
      `Required plan revision: ${revision}`,
      "",
      "Planning rules:",
      `- Create between 1 and ${MAX_PLAN_TASKS} tasks and no more than ${MAX_PLAN_PHASES} phases.`,
      "- Use immutable task IDs matching task-[a-z0-9._-]+ and phase IDs matching phase-[a-z0-9._-]+.",
      "- Every task must belong to exactly one phase; all dependencies must be known and acyclic.",
      "- Keep tasks independently reviewable. Put architectural decisions before dependent implementation.",
      "- Use only the roles implementation, research, testing, documentation, review, and integration.",
      "- Use model classes fast, standard, or deep, never hard-coded model names.",
      "- allowedPaths must be repository-relative, least-privilege paths with no absolute paths or parent traversal.",
      "- verificationCommands must be non-destructive and suitable for a worker to run locally.",
      "- Include measurable acceptance criteria for every task and phase.",
      "- Do not include secrets, private transcript text, hidden reasoning, or account-specific data.",
      "",
      `Return exactly one ${PLAN_BEGIN} / ${PLAN_END} envelope with JSON between the markers.`,
      "Do not use Markdown fences and do not add prose outside the envelope.",
      "Use this exact object shape:",
      JSON.stringify(template, null, 2),
      "",
      PLAN_BEGIN,
      "{...valid JSON...}",
      PLAN_END
    ].join("\n");
    assert(prompt.length <= MAX_PLANNER_PROMPT_CHARS, "Generated planner prompt exceeds its size limit.");
    return prompt;
  }

  function buildTaskRecords(plan, project, clock = Date.now) {
    const at = new Date(clock()).toISOString();
    return Object.fromEntries(plan.tasks.map(task => [task.id, {
      schemaVersion: "1.0",
      projectId: project.projectId,
      id: task.id,
      title: task.title,
      description: task.description,
      status: task.dependencies.length ? "blocked" : "ready",
      role: task.role,
      difficulty: task.difficulty,
      preferredModelClass: task.preferredModelClass,
      dependencies: clone(task.dependencies),
      allowedPaths: clone(task.allowedPaths),
      acceptanceCriteria: clone(task.acceptanceCriteria),
      verificationCommands: clone(task.verificationCommands),
      branch: null,
      attempt: 0,
      lease: null,
      resultCommit: null,
      createdAt: at,
      updatedAt: at
    }]));
  }

  function summarizePlan(plan) {
    const ready = plan.tasks.filter(task => task.dependencies.length === 0).length;
    return {
      revision: plan.revision,
      phaseCount: plan.phases.length,
      taskCount: plan.tasks.length,
      initiallyReadyTaskCount: ready,
      requiresMultipleAgents: plan.requiresMultipleAgents,
      criticalPathLength: plan.criticalPath.length
    };
  }

  return {
    PLAN_BEGIN,
    PLAN_END,
    PLAN_SCHEMA_VERSION,
    MAX_PLANNER_PROMPT_CHARS,
    MAX_PLANNER_OUTPUT_CHARS,
    MAX_PLAN_TASKS,
    MAX_PLAN_PHASES,
    TASK_ROLES: [...TASK_ROLES],
    parsePlannerEnvelope,
    validatePlan,
    buildPlannerPrompt,
    buildTaskRecords,
    summarizePlan,
    isSafeRelativePath,
    isSafeVerificationCommand
  };
});
