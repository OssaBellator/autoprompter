"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const PlannerProtocol = require("../planner-protocol.js");
const ProjectStore = require("../project-store.js");
const PlannerCompiler = require("../planner-compiler.js");

PlannerCompiler.install(ProjectStore);

const CLOCK_MS = Date.parse("2026-08-02T02:50:00.000Z");
const clock = () => CLOCK_MS;

function newProjectStore(title = "Compiler project") {
  return ProjectStore.createProject(ProjectStore.emptyStore(), {
    projectId: title.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
    title,
    goal: "Coordinate independent ChatGPT Web agents through a deterministic project plan.",
    repository: "OssaBellator/autoprompter",
    defaultBranch: "main",
    workerChatIds: ["worker-one", "worker-two"],
    maxConcurrentWorkers: 2
  }, clock).store;
}

test("planner prompt asks for a compact proposal instead of internal orchestration state", () => {
  const store = newProjectStore();
  const built = ProjectStore.buildProjectPlannerPrompt(store, store.activeProjectId);

  assert.equal(built.plannerProtocol, "compiled-proposal-v1");
  assert.match(built.prompt, /AUTOPROMPTER_PROPOSAL_BEGIN/);
  assert.match(built.prompt, /AutoPrompter will generate all internal IDs, phases, timestamps/);
  assert.doesNotMatch(built.prompt, /"createdAt":/);
  assert.doesNotMatch(built.prompt, /"criticalPath":/);
});

test("compact proposals compile into the existing validated plan and task pipeline", () => {
  let store = newProjectStore("Compiled proposal");
  const projectId = store.activeProjectId;
  const output = [
    PlannerCompiler.PROPOSAL_BEGIN,
    "{",
    "  \"schemaVersion\": \"1.0\",",
    "  \"summary\": \"Inspect the runtime, implement the change, and verify it independently.\",",
    "  \"tasks\": [",
    "    {",
    "      \"key\": \"inspect-runtime\",",
    "      \"title\": \"Inspect the runtime\",",
    "      \"description\": \"Identify the affected Project Mode paths and constraints.\",",
    "      \"dependsOn\": [],",
    "      \"role\": \"research\",",
    "      \"difficulty\": \"small\",",
    "      \"modelClass\": \"fast\",",
    "      \"allowedPaths\": [\"background.js\", \"project-store.js\"],",
    "      \"acceptance\": [\"The affected paths are identified.\"],",
    "      \"checks\": []",
    "    },",
    "    {",
    "      \"key\": \"implement-fix\",",
    "      \"title\": \"Implement the fix\",",
    "      \"description\": \"Implement the bounded Project Mode change with regression coverage.\",",
    "      \"dependsOn\": [\"inspect-runtime\"],",
    "      \"role\": \"code\",",
    "      \"difficulty\": \"medium\",",
    "      \"modelClass\": \"standard\",",
    "      \"allowedPaths\": [\"background.js\", \"tests/**\"],",
    "      \"acceptance\": [\"The behavior works and tests pass.\"],",
    "      \"checks\": [\"npm test\", \"rm -rf /\"],",
    "    },",
    "  ],",
    "}",
    PlannerCompiler.PROPOSAL_END
  ].join("\n");

  const submitted = ProjectStore.submitProjectPlannerOutput(store, projectId, output, clock);
  store = submitted.store;

  assert.equal(submitted.plannerCompilation.mode, "compiled-proposal");
  assert.equal(submitted.pendingPlan.createdAt, "2026-08-02T02:50:00.000Z");
  assert.deepEqual(submitted.pendingPlan.criticalPath, ["task-inspect-runtime", "task-implement-fix"]);
  assert.equal(submitted.pendingPlan.tasks[1].role, "implementation");
  assert.deepEqual(submitted.pendingPlan.tasks[1].dependencies, ["task-inspect-runtime"]);
  assert.deepEqual(submitted.pendingPlan.tasks[1].verificationCommands, ["npm test"]);
  assert.equal(submitted.pendingPlan.phases.length, 2);
  assert.ok(submitted.plannerCompilation.diagnostics.some(item => item.code === "PLAN_UNSAFE_COMMAND_REMOVED"));

  const approved = ProjectStore.approveProjectPlan(store, projectId, clock);
  assert.equal(approved.project.status, "ready");
  assert.equal(approved.tasks["task-inspect-runtime"].status, "ready");
  assert.equal(approved.tasks["task-implement-fix"].status, "blocked");
});

test("existing strict planner envelopes remain backward compatible", () => {
  const store = newProjectStore("Legacy envelope");
  const project = store.projects[store.activeProjectId];
  const compiled = PlannerCompiler.canonicalPlanFromProposal({
    summary: "One bounded task.",
    tasks: [{
      key: "bounded-change",
      title: "Implement a bounded change",
      description: "Implement and verify one bounded change.",
      allowedPaths: ["src/**"],
      acceptance: ["The change is verified."],
      checks: ["npm test"]
    }]
  }, project, 1, clock);
  const output = PlannerCompiler.serializePlan(compiled.plan);

  const submitted = ProjectStore.submitProjectPlannerOutput(store, project.projectId, output, clock);
  assert.equal(submitted.plannerCompilation.mode, "canonical");
  assert.equal(submitted.pendingPlan.tasks[0].id, "task-bounded-change");
  assert.deepEqual(PlannerProtocol.validatePlan(submitted.pendingPlan, project, 1), submitted.pendingPlan);
});

test("cyclic and unknown proposal dependencies are repaired locally with diagnostics", () => {
  const store = newProjectStore("Dependency repair");
  const project = store.projects[store.activeProjectId];
  const compiled = PlannerCompiler.canonicalPlanFromProposal({
    summary: "Repair dependency mistakes locally.",
    tasks: [
      { key: "one", title: "One", description: "First task.", dependsOn: ["two"], allowedPaths: ["src/one/**"], acceptance: ["One is complete."] },
      { key: "two", title: "Two", description: "Second task.", dependsOn: ["one", "missing"], allowedPaths: ["src/two/**"], acceptance: ["Two is complete."] }
    ]
  }, project, 1, clock);

  assert.doesNotThrow(() => PlannerProtocol.validatePlan(compiled.plan, project, 1));
  assert.ok(compiled.diagnostics.some(item => item.code === "PLAN_CYCLE_EDGE_REMOVED"));
  assert.ok(compiled.diagnostics.some(item => item.code === "PLAN_DEPENDENCY_IGNORED"));
});

test("extension manifest loads the task-board planner entry point", () => {
  const root = path.join(__dirname, "..");
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
  const entry = fs.readFileSync(path.join(root, "background-entry.js"), "utf8");

  assert.equal(manifest.background.service_worker, "background-entry.js");
  assert.match(entry, /background-project-api\.js/);
  assert.match(entry, /planner-fallback\.js/);
  assert.match(entry, /AutoPrompterProjectTaskBoardController\.start\(\)/);
  assert.equal(manifest.version, "3.4.1");
});
