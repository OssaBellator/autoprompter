"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  PLAN_BEGIN,
  PLAN_END,
  MAX_PLANNER_PROMPT_CHARS,
  parsePlannerEnvelope,
  validatePlan,
  buildPlannerPrompt,
  buildTaskRecords
} = require("../planner-protocol.js");
const { emptyStore, createProject } = require("../project-store.js");

function project() {
  return createProject(emptyStore(), {
    title: "Web-first Project Mode",
    goal: "Coordinate planner, workers, reviewer, and integrator through ChatGPT Web.",
    repository: "OssaBellator/autoprompter",
    plannerChatId: "planner",
    reviewerChatId: "reviewer",
    integratorChatId: "integrator",
    workerChatIds: ["worker-a", "worker-b"]
  }, () => Date.parse("2026-07-31T05:00:00Z")).project;
}

function validPlan(overrides = {}) {
  const base = {
    schemaVersion: "1.0",
    projectId: project().projectId,
    revision: 1,
    requiresMultipleAgents: true,
    rationale: "The goal contains independently reviewable implementation and test work.",
    phases: [
      {
        id: "phase-foundation",
        title: "Foundation",
        taskIds: ["task-store", "task-tests"],
        acceptanceCriteria: ["The project store and its tests are complete."]
      }
    ],
    tasks: [
      {
        id: "task-store",
        title: "Implement the store",
        description: "Add the schema-versioned Project Mode store without dispatching chats.",
        dependencies: [],
        role: "implementation",
        difficulty: "medium",
        preferredModelClass: "standard",
        allowedPaths: ["project-store.js", "tests/project-store.test.js"],
        acceptanceCriteria: ["The store survives extension restart."],
        verificationCommands: ["npm test"]
      },
      {
        id: "task-tests",
        title: "Add tests",
        description: "Add regression coverage for project store lifecycle operations.",
        dependencies: ["task-store"],
        role: "testing",
        difficulty: "small",
        preferredModelClass: "fast",
        allowedPaths: ["tests/**"],
        acceptanceCriteria: ["Lifecycle regressions are covered."],
        verificationCommands: ["npm test"]
      }
    ],
    criticalPath: ["task-store", "task-tests"],
    createdAt: "2026-07-31T05:00:00Z"
  };
  return { ...base, ...overrides };
}

function envelope(plan = validPlan()) {
  return `${PLAN_BEGIN}\n${JSON.stringify(plan)}\n${PLAN_END}`;
}

test("builds a bounded web-first planner prompt without dispatch instructions", () => {
  const prompt = buildPlannerPrompt(project(), 1);
  assert.ok(prompt.length < MAX_PLANNER_PROMPT_CHARS);
  assert.match(prompt, /subscription-backed ChatGPT Web/);
  assert.match(prompt, /Do not implement the project/);
  assert.match(prompt, new RegExp(PLAN_BEGIN));
  assert.match(prompt, /allowedPaths/);
  assert.doesNotMatch(prompt, /OpenAI API key/);
});

test("parses exactly one strict planner envelope", () => {
  assert.deepEqual(parsePlannerEnvelope(envelope()), validPlan());
  assert.throws(() => parsePlannerEnvelope(`prose\n${envelope()}`), /must not contain prose/);
  assert.throws(() => parsePlannerEnvelope(`${envelope()}\n${PLAN_BEGIN}`), /exactly one/);
  assert.throws(() => parsePlannerEnvelope(`${PLAN_BEGIN}\n\`\`\`json\n{}\n\`\`\`\n${PLAN_END}`), /code fence/);
});

test("validates and canonicalizes a complete plan", () => {
  const result = validatePlan(validPlan(), project(), 1);
  assert.equal(result.tasks.length, 2);
  assert.deepEqual(result.tasks[1].dependencies, ["task-store"]);
  assert.deepEqual(result.phases[0].taskIds, ["task-store", "task-tests"]);
});

test("rejects project, revision, dependency, phase, and path violations", () => {
  assert.throws(() => validatePlan(validPlan({ projectId: "wrong-project" }), project(), 1), /projectId/);
  assert.throws(() => validatePlan(validPlan({ revision: 2 }), project(), 1), /revision must be 1/);

  const unknown = validPlan();
  unknown.tasks[1].dependencies = ["task-missing"];
  assert.throws(() => validatePlan(unknown, project(), 1), /unknown dependency/);

  const cycle = validPlan();
  cycle.tasks[0].dependencies = ["task-tests"];
  assert.throws(() => validatePlan(cycle, project(), 1), /cycle/);

  const duplicatePhase = validPlan();
  duplicatePhase.phases.push({
    id: "phase-second",
    title: "Second",
    taskIds: ["task-store"],
    acceptanceCriteria: ["Second phase"]
  });
  assert.throws(() => validatePlan(duplicatePhase, project(), 1), /more than one phase/);

  const unsafePath = validPlan();
  unsafePath.tasks[0].allowedPaths = ["../secrets"];
  assert.throws(() => validatePlan(unsafePath, project(), 1), /unsafe allowed path/);
});

test("rejects destructive verification commands", () => {
  const plan = validPlan();
  plan.tasks[0].verificationCommands = ["rm -rf /"];
  assert.throws(() => validatePlan(plan, project(), 1), /unsafe verification command/);
});

test("materializes blocked and ready task records only from a validated plan", () => {
  const selectedProject = project();
  const plan = validatePlan(validPlan(), selectedProject, 1);
  const records = buildTaskRecords(plan, selectedProject, () => Date.parse("2026-07-31T05:30:00Z"));
  assert.equal(records["task-store"].status, "ready");
  assert.equal(records["task-tests"].status, "blocked");
  assert.equal(records["task-store"].attempt, 0);
  assert.equal(records["task-store"].lease, null);
  assert.equal(records["task-store"].branch, null);
});
