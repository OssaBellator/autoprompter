"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const ProjectStore = require("../project-store.js");
const PlannerCompiler = require("../planner-compiler.js");
const PlannerFallback = require("../planner-fallback.js");
const PlannerNoRepair = require("../planner-no-repair.js");

PlannerCompiler.install(ProjectStore);
PlannerFallback.install(ProjectStore);
PlannerNoRepair.install(ProjectStore);

const CLOCK_MS = Date.parse("2026-08-02T03:30:00.000Z");
const clock = () => CLOCK_MS;

function projectStore() {
  return ProjectStore.createProject(ProjectStore.emptyStore(), {
    projectId: "full-auto-project",
    title: "Full-auto project",
    goal: "Implement the requested repository change and verify it without manual orchestration forms.",
    repository: "OssaBellator/autoprompter",
    defaultBranch: "main",
    workerChatIds: ["worker-one", "worker-two"],
    maxConcurrentWorkers: 2
  }, clock).store;
}

test("non-JSON planner prose compiles locally instead of starting a repair loop", () => {
  const store = projectStore();
  const result = ProjectStore.submitProjectPlannerOutput(
    store,
    "full-auto-project",
    "I will inspect the current implementation, make the required changes, run the tests, and document the result.",
    clock
  );

  assert.equal(result.plannerCompilation.mode, "compiled-local-fallback");
  assert.ok(result.plannerCompilation.diagnostics.some(item => item.code === "PLAN_TEXT_COMPILED_LOCALLY"));
  assert.equal(result.pendingPlan.projectId, "full-auto-project");
  assert.ok(result.pendingPlan.tasks.length >= 3);
  assert.deepEqual(result.pendingPlan.criticalPath, result.pendingPlan.tasks.map(task => task.id));
});

test("planner bullet text becomes bounded sequential tasks with a final verification task", () => {
  const store = projectStore();
  const result = ProjectStore.submitProjectPlannerOutput(store, "full-auto-project", [
    "Plan:",
    "- Inspect the extension runtime and existing project state.",
    "- Implement automatic dispatch and integration approval.",
    "- Add regression tests for the new lifecycle."
  ].join("\n"), clock);

  assert.equal(result.plannerCompilation.mode, "compiled-local-fallback");
  assert.ok(result.pendingPlan.tasks.length >= 4);
  assert.equal(result.pendingPlan.tasks.at(-1).role, "testing");
  assert.ok(result.pendingPlan.tasks.every(task => task.allowedPaths.includes("**/*")));
});

test("semantic planner validation errors recover locally instead of reaching the legacy repair state", () => {
  const store = projectStore();
  const output = [
    PlannerCompiler.PROPOSAL_BEGIN,
    JSON.stringify({
      schemaVersion: "1.0",
      summary: "This proposal has no tasks and is semantically invalid.",
      tasks: []
    }),
    PlannerCompiler.PROPOSAL_END
  ].join("\n");

  const result = ProjectStore.submitProjectPlannerOutput(store, "full-auto-project", output, clock);
  assert.equal(result.plannerCompilation.mode, "compiled-local-recovery");
  assert.ok(result.plannerCompilation.diagnostics.some(item => item.code === "PLAN_VALIDATION_RECOVERED_LOCALLY"));
  assert.ok(result.pendingPlan.tasks.length >= 3);
});

test("valid compact proposals still use the normal deterministic compiler", () => {
  const store = projectStore();
  const output = [
    PlannerCompiler.PROPOSAL_BEGIN,
    JSON.stringify({
      schemaVersion: "1.0",
      summary: "One bounded task.",
      tasks: [{
        key: "bounded-task",
        title: "Implement a bounded task",
        description: "Implement and verify one bounded task.",
        dependsOn: [],
        allowedPaths: ["src/**"],
        acceptance: ["The task is complete."],
        checks: []
      }]
    }),
    PlannerCompiler.PROPOSAL_END
  ].join("\n");
  const result = ProjectStore.submitProjectPlannerOutput(store, "full-auto-project", output, clock);
  assert.equal(result.plannerCompilation.mode, "compiled-proposal");
  assert.equal(result.pendingPlan.tasks.length, 1);
});
