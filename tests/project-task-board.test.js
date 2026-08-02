"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const ProjectStore = require("../project-store.js");
const PlannerCompiler = require("../planner-compiler.js");
global.AutoPrompterProjectStore = ProjectStore;
global.AutoPrompterWorkerProtocol = require("../worker-protocol.js");
PlannerCompiler.install(ProjectStore);
const TaskBoard = require("../project-task-board.js");

const CLOCK_MS = Date.parse("2026-08-02T05:00:00.000Z");
const clock = () => CLOCK_MS;

function plannedStore() {
  let store = ProjectStore.createProject(ProjectStore.emptyStore(), {
    projectId: "branch-board",
    title: "Branch board",
    goal: "Run independent tasks on separate branches and integrate reviewed work.",
    repository: "OssaBellator/autoprompter",
    defaultBranch: "main",
    workerChatIds: ["legacy-worker-one", "legacy-worker-two"],
    maxConcurrentWorkers: 2
  }, clock).store;
  const projectId = store.activeProjectId;
  const proposal = [
    PlannerCompiler.PROPOSAL_BEGIN,
    JSON.stringify({
      schemaVersion: "1.0",
      summary: "Two independent tasks followed by one dependent task.",
      tasks: [
        {
          key: "alpha",
          title: "Implement alpha",
          description: "Implement the alpha change.",
          dependsOn: [],
          allowedPaths: ["src/alpha/**"],
          acceptance: ["Alpha is implemented."],
          checks: ["npm test"]
        },
        {
          key: "beta",
          title: "Implement beta",
          description: "Implement the beta change.",
          dependsOn: [],
          allowedPaths: ["src/beta/**"],
          acceptance: ["Beta is implemented."],
          checks: ["npm test"]
        },
        {
          key: "combine",
          title: "Combine alpha and beta",
          description: "Build the dependent result from both reviewed changes.",
          dependsOn: ["alpha", "beta"],
          allowedPaths: ["src/combine/**"],
          acceptance: ["The reviewed dependencies are combined."],
          checks: ["npm test"]
        }
      ]
    }),
    PlannerCompiler.PROPOSAL_END
  ].join("\n");
  store = ProjectStore.submitProjectPlannerOutput(store, projectId, proposal, clock).store;
  store = ProjectStore.approveProjectPlan(store, projectId, clock).store;
  return { store, projectId };
}

test("new projects use fresh task chats instead of a preselected worker pool", () => {
  const { store, projectId } = plannedStore();
  const project = store.projects[projectId];
  assert.deepEqual(project.roles.workerChatIds, []);
  assert.equal(project.scheduler.maxConcurrentWorkers, 2);
  assert.equal(TaskBoard.MODE, "fresh_chat_per_task");
});

test("independent tasks receive distinct branches and fresh conversations concurrently", () => {
  let { store, projectId } = plannedStore();
  store = ProjectStore.startProject(store, projectId, clock).store;
  const prepared = ProjectStore.prepareProjectDispatches(store, projectId, clock);
  assert.equal(prepared.assignments.length, 2);
  assert.equal(prepared.prepared.length, 2);
  assert.equal(new Set(prepared.assignments.map(item => item.branch)).size, 2);
  assert.ok(prepared.assignments.every(item => item.workerChatId.startsWith("fresh-task-")));
  assert.ok(prepared.assignments.every(item => item.successorGeneration === 1));
  assert.ok(prepared.assignments.every(item => item.freshRequestId.startsWith("project-task:")));
  assert.ok(prepared.assignments.every(item => /separate ChatGPT conversations and Git branches/.test(item.prompt)));
  assert.ok(prepared.assignments.every(item => /This task is independent and may start immediately/.test(item.prompt)));
});

test("dependent tasks wait for accepted commits and receive branch ancestry evidence", () => {
  let { store, projectId } = plannedStore();
  store = ProjectStore.startProject(store, projectId, clock).store;
  const first = ProjectStore.prepareProjectDispatches(store, projectId, clock);
  store = first.store;

  const tasks = store.tasksByProject[projectId];
  const dispatches = store.dispatchesByProject[projectId];
  for (const assignment of first.assignments) {
    const task = tasks[assignment.taskId];
    task.status = "accepted";
    task.lease = null;
    task.acceptedBranch = assignment.branch;
    task.acceptedCommit = assignment.taskId.endsWith("alpha") ? "aaaaaaa" : "bbbbbbb";
    dispatches[assignment.dispatchId].status = "accepted";
  }

  const second = ProjectStore.prepareProjectDispatches(store, projectId, clock);
  assert.equal(second.assignments.length, 1);
  const dependent = second.assignments[0];
  assert.equal(dependent.taskId, "task-combine");
  assert.deepEqual(dependent.dependencyEvidence.map(item => item.commit).sort(), ["aaaaaaa", "bbbbbbb"]);
  assert.match(dependent.prompt, /Create or reset agent\/branch-board\/combine-a1 from dependency commit/);
  assert.match(dependent.prompt, /Incorporate reviewed dependency commit/);
});
