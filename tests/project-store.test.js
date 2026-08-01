"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  STORE_SCHEMA_VERSION,
  emptyStore,
  migrateStore,
  createProject,
  inspectProject,
  transitionProject,
  listProjects,
  buildProjectPlannerPrompt,
  submitProjectPlannerOutput,
  approveProjectPlan,
  discardProjectPlan,
  startProject,
  prepareProjectDispatches,
  recoverProjectLeases,
  recoverAllProjectLeases
} = require("../project-store.js");
const { PLAN_BEGIN, PLAN_END } = require("../planner-protocol.js");

const fixedClock = () => Date.parse("2026-07-31T04:30:00Z");

function validInput(overrides = {}) {
  return {
    title: "Project Mode",
    goal: "Coordinate planner and worker chats through ChatGPT Web.",
    repository: "https://github.com/OssaBellator/autoprompter.git",
    plannerChatId: "planner",
    reviewerChatId: "reviewer",
    integratorChatId: "integrator",
    workerChatIds: ["worker-a", "worker-b"],
    ...overrides
  };
}

test("initializes and migrates the versioned Project Mode store", () => {
  const initialized = migrateStore(null);
  assert.equal(initialized.migrated, true);
  assert.equal(initialized.store.schemaVersion, STORE_SCHEMA_VERSION);
  assert.deepEqual(initialized.store.projects, {});

  const created = createProject(emptyStore(), validInput(), fixedClock);
  const legacy = migrateStore({
    schemaVersion: "0.1",
    activeProjectId: created.project.projectId,
    projects: [created.project]
  });
  assert.equal(legacy.migrated, true);
  assert.equal(legacy.store.activeProjectId, created.project.projectId);
  assert.ok(legacy.store.projects[created.project.projectId]);
});

test("creates schema-compatible drafts and removes role chats from workers", () => {
  const result = createProject(emptyStore(), validInput({ workerChatIds: ["planner", "worker-a", "worker-a"] }), fixedClock);
  assert.equal(result.project.schemaVersion, "1.0");
  assert.equal(result.project.status, "draft");
  assert.equal(result.project.repository.slug, "OssaBellator/autoprompter");
  assert.deepEqual(result.project.roles.workerChatIds, ["worker-a"]);
  assert.equal(result.store.activeProjectId, result.project.projectId);
  assert.equal(result.store.events.at(-1).type, "project_created");
});

test("rejects duplicate fixed-role chats", () => {
  assert.throws(
    () => createProject(emptyStore(), validInput({ reviewerChatId: "planner" }), fixedClock),
    /must be different/
  );
});

test("pause and resume preserve the prior lifecycle state", () => {
  const created = createProject(emptyStore(), validInput(), fixedClock);
  created.store.projects[created.project.projectId].status = "planning";
  const paused = transitionProject(created.store, created.project.projectId, "pause", fixedClock);
  assert.equal(paused.project.status, "paused");
  const resumed = transitionProject(paused.store, created.project.projectId, "resume", fixedClock);
  assert.equal(resumed.project.status, "planning");
});

test("cancel is terminal and inspect returns project-specific events", () => {
  const created = createProject(emptyStore(), validInput(), fixedClock);
  const cancelled = transitionProject(created.store, created.project.projectId, "cancel", fixedClock);
  assert.equal(cancelled.project.status, "cancelled");
  assert.throws(() => transitionProject(cancelled.store, created.project.projectId, "resume", fixedClock), /paused/);
  assert.throws(() => transitionProject(cancelled.store, created.project.projectId, "cancel", fixedClock), /Cannot cancel/);
  const inspected = inspectProject(cancelled.store, created.project.projectId);
  assert.equal(inspected.project.status, "cancelled");
  assert.deepEqual(inspected.events.map(event => event.type), ["project_created", "project_cancelled"]);
});

test("lists projects by most recently updated", () => {
  let store = emptyStore();
  const first = createProject(store, validInput({ title: "First" }), () => Date.parse("2026-07-31T04:00:00Z"));
  store = first.store;
  const second = createProject(store, validInput({ title: "Second" }), () => Date.parse("2026-07-31T05:00:00Z"));
  assert.deepEqual(listProjects(second.store).map(project => project.title), ["Second", "First"]);
});

test("rejects unknown future store versions", () => {
  assert.throws(() => migrateStore({ schemaVersion: "99.0", projects: {} }), /Unsupported/);
});


function plannerPlan(projectId, overrides = {}) {
  return {
    schemaVersion: "1.0",
    projectId,
    revision: 1,
    requiresMultipleAgents: true,
    rationale: "The work has independent store and test tasks.",
    phases: [{
      id: "phase-foundation",
      title: "Foundation",
      taskIds: ["task-store", "task-tests"],
      acceptanceCriteria: ["The foundation is validated."]
    }],
    tasks: [
      {
        id: "task-store",
        title: "Implement store",
        description: "Implement the Project Mode store.",
        dependencies: [],
        role: "implementation",
        difficulty: "medium",
        preferredModelClass: "standard",
        allowedPaths: ["project-store.js"],
        acceptanceCriteria: ["The store persists."],
        verificationCommands: ["npm test"]
      },
      {
        id: "task-tests",
        title: "Test store",
        description: "Add store tests.",
        dependencies: ["task-store"],
        role: "testing",
        difficulty: "small",
        preferredModelClass: "fast",
        allowedPaths: ["tests/**"],
        acceptanceCriteria: ["Tests pass."],
        verificationCommands: ["npm test"]
      }
    ],
    criticalPath: ["task-store", "task-tests"],
    createdAt: "2026-07-31T05:00:00Z",
    ...overrides
  };
}

function plannerEnvelope(projectId, overrides = {}) {
  return `${PLAN_BEGIN}\n${JSON.stringify(plannerPlan(projectId, overrides))}\n${PLAN_END}`;
}

test("migrates older project stores to result-and-integration-capable schema 1.4", () => {
  const created = createProject(emptyStore(), validInput(), fixedClock);
  const migrated = migrateStore({
    schemaVersion: "1.0",
    activeProjectId: created.project.projectId,
    projects: created.store.projects,
    resumeStatusByProject: {},
    events: created.store.events
  });
  assert.equal(migrated.store.schemaVersion, "1.4");
  assert.deepEqual(migrated.store.pendingPlansByProject, {});
  assert.deepEqual(migrated.store.approvedPlansByProject, {});
  assert.deepEqual(migrated.store.tasksByProject, {});
  assert.deepEqual(migrated.store.dispatchesByProject, {});
  assert.deepEqual(migrated.store.resultsByProject, {});
  assert.deepEqual(migrated.store.reviewsByProject, {});
  assert.deepEqual(migrated.store.integrationsByProject, {});
});

test("planner output remains pending until explicit approval creates tasks", () => {
  const created = createProject(emptyStore(), validInput(), fixedClock);
  const projectId = created.project.projectId;
  const prompt = buildProjectPlannerPrompt(created.store, projectId);
  assert.equal(prompt.revision, 1);
  assert.match(prompt.prompt, /AUTOPROMPTER_PLAN_BEGIN/);

  const submitted = submitProjectPlannerOutput(created.store, projectId, plannerEnvelope(projectId), fixedClock);
  assert.equal(submitted.project.status, "planning");
  assert.equal(submitted.pendingPlan.tasks.length, 2);
  assert.deepEqual(submitted.store.tasksByProject[projectId], undefined);
  assert.equal(submitted.store.events.at(-1).type, "plan_validated");

  const approved = approveProjectPlan(submitted.store, projectId, fixedClock);
  assert.equal(approved.project.status, "ready");
  assert.equal(approved.tasks["task-store"].status, "ready");
  assert.equal(approved.tasks["task-tests"].status, "blocked");
  assert.equal(approved.store.pendingPlansByProject[projectId], undefined);
  assert.equal(approved.store.events.at(-1).type, "plan_approved");
});

test("discarding a pending plan creates no tasks and returns to draft", () => {
  const created = createProject(emptyStore(), validInput(), fixedClock);
  const projectId = created.project.projectId;
  const submitted = submitProjectPlannerOutput(created.store, projectId, plannerEnvelope(projectId), fixedClock);
  const discarded = discardProjectPlan(submitted.store, projectId, fixedClock);
  assert.equal(discarded.project.status, "draft");
  assert.equal(discarded.store.pendingPlansByProject[projectId], undefined);
  assert.deepEqual(discarded.store.tasksByProject[projectId], undefined);
  assert.equal(discarded.store.events.at(-1).type, "plan_discarded");
});

test("invalid planner output cannot mutate project state", () => {
  const created = createProject(emptyStore(), validInput(), fixedClock);
  const projectId = created.project.projectId;
  assert.throws(
    () => submitProjectPlannerOutput(created.store, projectId, `${PLAN_BEGIN}\n{}\n${PLAN_END}`, fixedClock),
    /missing or unknown fields/
  );
  assert.equal(created.store.projects[projectId].status, "draft");
  assert.deepEqual(created.store.pendingPlansByProject, {});
});


function approvedProjectStore(overrides = {}) {
  const created = createProject(emptyStore(), validInput(overrides), fixedClock);
  const projectId = created.project.projectId;
  const submitted = submitProjectPlannerOutput(created.store, projectId, plannerEnvelope(projectId), fixedClock);
  const approved = approveProjectPlan(submitted.store, projectId, fixedClock);
  return { projectId, ...approved };
}

test("project start is explicit and does not create a dispatch", () => {
  const approved = approvedProjectStore();
  assert.throws(() => prepareProjectDispatches(approved.store, approved.projectId, fixedClock), /Start the ready project/);
  const started = startProject(approved.store, approved.projectId, fixedClock);
  assert.equal(started.project.status, "running");
  assert.deepEqual(started.store.dispatchesByProject, {});
  assert.equal(started.store.events.at(-1).type, "project_started");
});

test("prepares bounded idempotent worker leases in deterministic order", () => {
  const approved = approvedProjectStore({ maxConcurrentWorkers: 2 });
  const started = startProject(approved.store, approved.projectId, fixedClock);
  const prepared = prepareProjectDispatches(started.store, approved.projectId, fixedClock);
  assert.equal(prepared.assignments.length, 1);
  const assignment = prepared.assignments[0];
  assert.equal(assignment.taskId, "task-store");
  assert.equal(assignment.workerChatId, "worker-a");
  assert.match(assignment.dispatchId, /^dispatch-store-a1-/);
  assert.equal(prepared.tasks["task-store"].status, "leased");
  assert.equal(prepared.tasks["task-store"].lease.dispatchId, assignment.dispatchId);
  assert.match(assignment.branch, /^agent\/project-mode\/store-a1$/);
  assert.match(assignment.prompt, /No ChatGPT prompt was sent|bounded worker|AUTOPROMPTER_TASK_RESULT_BEGIN/i);

  const repeated = prepareProjectDispatches(prepared.store, approved.projectId, fixedClock);
  assert.equal(repeated.assignments.length, 0);
  assert.equal(Object.keys(repeated.dispatches).length, 1);
  assert.equal(repeated.runtimeSummary.activeLeaseCount, 1);
});

test("expired leases return eligible tasks to the queue and preserve attempt history", () => {
  const approved = approvedProjectStore();
  const started = startProject(approved.store, approved.projectId, fixedClock);
  const prepared = prepareProjectDispatches(started.store, approved.projectId, fixedClock);
  const dispatchId = prepared.assignments[0].dispatchId;
  const later = () => Date.parse("2026-07-31T06:31:00Z");
  const recovered = recoverProjectLeases(prepared.store, approved.projectId, later);
  assert.deepEqual(recovered.expiredDispatchIds, [dispatchId]);
  assert.equal(recovered.tasks["task-store"].status, "ready");
  assert.equal(recovered.tasks["task-store"].lease, null);
  assert.equal(recovered.tasks["task-store"].attempt, 1);
  assert.equal(recovered.dispatches[dispatchId].status, "expired");

  const retried = prepareProjectDispatches(recovered.store, approved.projectId, later);
  assert.equal(retried.assignments[0].attempt, 2);
  assert.notEqual(retried.assignments[0].dispatchId, dispatchId);
});

test("accepted dependencies unlock blocked tasks during recovery", () => {
  const approved = approvedProjectStore();
  const started = startProject(approved.store, approved.projectId, fixedClock);
  started.store.tasksByProject[approved.projectId]["task-store"].status = "accepted";
  const recovered = recoverProjectLeases(started.store, approved.projectId, fixedClock);
  assert.deepEqual(recovered.unlockedTaskIds, ["task-tests"]);
  assert.equal(recovered.tasks["task-tests"].status, "ready");
  const prepared = prepareProjectDispatches(recovered.store, approved.projectId, fixedClock);
  assert.equal(prepared.assignments[0].taskId, "task-tests");
});

test("restart recovery expires stale leases across every project", () => {
  const approved = approvedProjectStore();
  const started = startProject(approved.store, approved.projectId, fixedClock);
  const prepared = prepareProjectDispatches(started.store, approved.projectId, fixedClock);
  const later = () => Date.parse("2026-07-31T06:31:00Z");
  const recovered = recoverAllProjectLeases(prepared.store, later);
  assert.equal(recovered.changed, true);
  assert.equal(recovered.store.tasksByProject[approved.projectId]["task-store"].status, "ready");
  assert.equal(Object.keys(recovered.recovered).length, 1);
});

test("cancelling a running project releases leases and cancels prepared dispatches", () => {
  const approved = approvedProjectStore();
  const started = startProject(approved.store, approved.projectId, fixedClock);
  const prepared = prepareProjectDispatches(started.store, approved.projectId, fixedClock);
  const dispatchId = prepared.assignments[0].dispatchId;
  const cancelled = transitionProject(prepared.store, approved.projectId, "cancel", fixedClock);
  assert.equal(cancelled.project.status, "cancelled");
  assert.equal(cancelled.store.tasksByProject[approved.projectId]["task-store"].lease, null);
  assert.equal(cancelled.store.tasksByProject[approved.projectId]["task-store"].status, "cancelled");
  assert.equal(cancelled.store.dispatchesByProject[approved.projectId][dispatchId].status, "cancelled");
});


test("assignment preparation respects the project concurrency ceiling", () => {
  const created = createProject(emptyStore(), validInput({
    workerChatIds: ["worker-a", "worker-b", "worker-c"],
    maxConcurrentWorkers: 2
  }), fixedClock);
  const projectId = created.project.projectId;
  const baseTask = {
    description: "Independent bounded task.",
    dependencies: [],
    role: "implementation",
    difficulty: "small",
    preferredModelClass: "fast",
    allowedPaths: ["src/**"],
    acceptanceCriteria: ["Task completes."],
    verificationCommands: ["npm test"]
  };
  const tasks = ["alpha", "beta", "gamma"].map(name => ({
    ...baseTask,
    id: `task-${name}`,
    title: `Task ${name}`
  }));
  const plan = plannerPlan(projectId, {
    phases: [{
      id: "phase-parallel",
      title: "Parallel",
      taskIds: tasks.map(task => task.id),
      acceptanceCriteria: ["All independent tasks are validated."]
    }],
    tasks,
    criticalPath: ["task-alpha"]
  });
  const submitted = submitProjectPlannerOutput(created.store, projectId, `${PLAN_BEGIN}\n${JSON.stringify(plan)}\n${PLAN_END}`, fixedClock);
  const approved = approveProjectPlan(submitted.store, projectId, fixedClock);
  const started = startProject(approved.store, projectId, fixedClock);
  const prepared = prepareProjectDispatches(started.store, projectId, fixedClock);
  assert.equal(prepared.assignments.length, 2);
  assert.deepEqual(prepared.assignments.map(item => item.taskId), ["task-alpha", "task-beta"]);
  assert.deepEqual(prepared.assignments.map(item => item.workerChatId), ["worker-a", "worker-b"]);
  assert.equal(prepared.tasks["task-gamma"].status, "ready");
  assert.equal(prepared.runtimeSummary.availableWorkerCount, 1);
});

test("restart recovery closes orphaned dispatches and malformed leased tasks", () => {
  const approved = approvedProjectStore();
  const started = startProject(approved.store, approved.projectId, fixedClock);
  const prepared = prepareProjectDispatches(started.store, approved.projectId, fixedClock);
  const dispatchId = prepared.assignments[0].dispatchId;
  prepared.store.tasksByProject[approved.projectId]["task-store"].lease = null;
  const recovered = recoverAllProjectLeases(prepared.store, fixedClock);
  assert.equal(recovered.changed, true);
  assert.equal(recovered.store.tasksByProject[approved.projectId]["task-store"].status, "ready");
  assert.equal(recovered.store.dispatchesByProject[approved.projectId][dispatchId].status, "expired");
});
