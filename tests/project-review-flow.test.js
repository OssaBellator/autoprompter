"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Store = require("../project-store.js");
const ResultProtocol = require("../result-protocol.js");
const ReviewerProtocol = require("../reviewer-protocol.js");
const IntegrationProtocol = require("../integration-protocol.js");

function clockAt(iso) {
  const value = Date.parse(iso);
  return () => value;
}

function planFor(projectId) {
  return {
    schemaVersion: "1.0",
    projectId,
    revision: 1,
    requiresMultipleAgents: true,
    rationale: "Two dependent tasks exercise review progression.",
    phases: [{
      id: "phase-build",
      title: "Build",
      taskIds: ["task-a", "task-b"],
      acceptanceCriteria: ["Both tasks are accepted."]
    }],
    tasks: [
      {
        id: "task-a",
        title: "Task A",
        description: "Implement the first bounded change.",
        dependencies: [],
        role: "implementation",
        difficulty: "medium",
        preferredModelClass: "standard",
        allowedPaths: ["src/a/**", "tests/a/**"],
        acceptanceCriteria: ["Task A behavior is tested."],
        verificationCommands: ["npm test -- a"]
      },
      {
        id: "task-b",
        title: "Task B",
        description: "Implement the dependent change.",
        dependencies: ["task-a"],
        role: "testing",
        difficulty: "medium",
        preferredModelClass: "standard",
        allowedPaths: ["src/b/**", "tests/b/**"],
        acceptanceCriteria: ["Task B behavior is tested."],
        verificationCommands: ["npm test -- b"]
      }
    ],
    criticalPath: ["task-a", "task-b"],
    createdAt: "2026-08-01T01:00:00.000Z"
  };
}

function resultEnvelope(project, task, dispatch, suffix = "a") {
  const output = {
    schemaVersion: "1.0",
    projectId: project.projectId,
    taskId: task.id,
    dispatchId: dispatch.dispatchId,
    attempt: dispatch.attempt,
    status: "completed",
    summary: `Completed ${task.id}`,
    commit: `${suffix.repeat(12)}1234567`,
    tests: task.verificationCommands.map(command => ({ command, status: "passed", summary: "Passed." })),
    filesChanged: [task.allowedPaths[0].replace("/**", "/index.js")],
    risks: [],
    followUpTaskSuggestions: [],
    producedAt: "2026-08-01T01:10:00.000Z"
  };
  return `${ResultProtocol.RESULT_BEGIN}\n${JSON.stringify(output)}\n${ResultProtocol.RESULT_END}`;
}

function reviewEnvelope(project, task, dispatch, result, decision, requiredChanges = []) {
  const accepted = decision === "accepted";
  const output = {
    schemaVersion: "1.0",
    projectId: project.projectId,
    taskId: task.id,
    dispatchId: dispatch.dispatchId,
    attempt: dispatch.attempt,
    resultDigest: result.resultDigest,
    decision,
    summary: accepted ? "Accepted with verified evidence." : "A bounded revision is required.",
    acceptanceCriteria: task.acceptanceCriteria.map(criterion => ({
      criterion,
      status: accepted ? "met" : "not_met",
      evidence: accepted ? "Verified." : "Coverage is incomplete."
    })),
    verificationChecks: task.verificationCommands.map(command => ({
      command,
      status: accepted ? "verified" : "not_verified",
      evidence: accepted ? "Independent evidence checked." : "Evidence needs improvement."
    })),
    requiredChanges,
    risks: [],
    reviewedAt: "2026-08-01T01:15:00.000Z"
  };
  return `${ReviewerProtocol.REVIEW_BEGIN}\n${JSON.stringify(output)}\n${ReviewerProtocol.REVIEW_END}`;
}

function setupProject() {
  let store = Store.emptyStore();
  let created = Store.createProject(store, {
    title: "Review flow",
    goal: "Exercise result and review progression.",
    repository: "OssaBellator/autoprompter",
    plannerChatId: "planner-chat",
    reviewerChatId: "reviewer-chat",
    integratorChatId: "integrator-chat",
    workerChatIds: ["worker-a", "worker-b"],
    maxConcurrentWorkers: 2,
    revisionLimit: 2
  }, clockAt("2026-08-01T01:00:00.000Z"));
  store = created.store;
  const project = created.project;
  const plan = planFor(project.projectId);
  const submitted = Store.submitProjectPlannerOutput(
    store,
    project.projectId,
    `AUTOPROMPTER_PLAN_BEGIN\n${JSON.stringify(plan)}\nAUTOPROMPTER_PLAN_END`,
    clockAt("2026-08-01T01:01:00.000Z")
  );
  store = submitted.store;
  store = Store.approveProjectPlan(store, project.projectId, clockAt("2026-08-01T01:02:00.000Z")).store;
  store = Store.startProject(store, project.projectId, clockAt("2026-08-01T01:03:00.000Z")).store;
  return { store, projectId: project.projectId };
}

test("results, revisions, accepted dependencies, and integration progress deterministically", () => {
  let { store, projectId } = setupProject();
  let prepared = Store.prepareProjectDispatches(store, projectId, clockAt("2026-08-01T01:04:00.000Z"));
  store = prepared.store;
  assert.equal(prepared.assignments.length, 1);
  const first = prepared.assignments[0];
  let task = store.tasksByProject[projectId][first.taskId];
  let received = Store.submitProjectTaskResult(store, projectId, first.dispatchId, resultEnvelope(store.projects[projectId], task, first), clockAt("2026-08-01T01:10:00.000Z"));
  store = received.store;
  assert.equal(store.tasksByProject[projectId][task.id].status, "review");
  assert.equal(received.result.resultDigest, store.resultsByProject[projectId][first.dispatchId].resultDigest);

  const reviewerPrompt = Store.buildProjectReviewerPrompt(store, projectId, first.dispatchId);
  assert.match(reviewerPrompt.prompt, new RegExp(received.result.resultDigest));
  let reviewed = Store.submitProjectReview(
    store,
    projectId,
    first.dispatchId,
    reviewEnvelope(store.projects[projectId], task, first, received.result, "revision_required", ["Add the missing edge-case test."]),
    clockAt("2026-08-01T01:15:00.000Z")
  );
  store = reviewed.store;
  assert.equal(store.tasksByProject[projectId][task.id].status, "ready");
  assert.deepEqual(store.tasksByProject[projectId][task.id].requiredChanges, ["Add the missing edge-case test."]);

  prepared = Store.prepareProjectDispatches(store, projectId, clockAt("2026-08-01T01:16:00.000Z"));
  store = prepared.store;
  const retry = prepared.assignments[0];
  assert.equal(retry.attempt, 2);
  assert.match(retry.prompt, /Add the missing edge-case test/);
  task = store.tasksByProject[projectId][retry.taskId];
  received = Store.submitProjectTaskResult(store, projectId, retry.dispatchId, resultEnvelope(store.projects[projectId], task, retry, "b"), clockAt("2026-08-01T01:20:00.000Z"));
  store = received.store;
  reviewed = Store.submitProjectReview(
    store,
    projectId,
    retry.dispatchId,
    reviewEnvelope(store.projects[projectId], task, retry, received.result, "accepted"),
    clockAt("2026-08-01T01:21:00.000Z")
  );
  store = reviewed.store;
  assert.equal(store.tasksByProject[projectId]["task-a"].status, "accepted");
  assert.equal(store.tasksByProject[projectId]["task-b"].status, "ready");

  prepared = Store.prepareProjectDispatches(store, projectId, clockAt("2026-08-01T01:22:00.000Z"));
  store = prepared.store;
  const second = prepared.assignments[0];
  task = store.tasksByProject[projectId][second.taskId];
  received = Store.submitProjectTaskResult(store, projectId, second.dispatchId, resultEnvelope(store.projects[projectId], task, second, "c"), clockAt("2026-08-01T01:25:00.000Z"));
  store = received.store;
  reviewed = Store.submitProjectReview(
    store,
    projectId,
    second.dispatchId,
    reviewEnvelope(store.projects[projectId], task, second, received.result, "accepted"),
    clockAt("2026-08-01T01:26:00.000Z")
  );
  store = reviewed.store;
  assert.equal(reviewed.integrationReady, true);

  const integrator = Store.buildProjectIntegratorPrompt(store, projectId);
  assert.match(integrator.prompt, /Accepted task evidence/);
  store = integrator.store;
  const integrationOutput = {
    schemaVersion: "1.1",
    integrationId: integrator.integrationId,
    integrationAttempt: integrator.integrationAttempt,
    projectId,
    planRevision: 1,
    status: "completed",
    summary: "Integrated both reviewed tasks.",
    branch: `agent/${projectId}/integration-r1-a1`,
    commit: "deadbeef1234567",
    includedTasks: ["task-a", "task-b"],
    tests: [{ command: "npm test", status: "passed", summary: "All tests passed." }],
    conflicts: [],
    risks: [],
    producedAt: "2026-08-01T01:30:00.000Z"
  };
  const integration = Store.submitProjectIntegrationOutput(
    store,
    projectId,
    `${IntegrationProtocol.INTEGRATION_BEGIN}\n${JSON.stringify(integrationOutput)}\n${IntegrationProtocol.INTEGRATION_END}`,
    clockAt("2026-08-01T01:30:00.000Z")
  );
  store = integration.store;
  assert.equal(store.projects[projectId].status, "running");
  const approved = Store.approveProjectIntegration(store, projectId, clockAt("2026-08-01T01:31:00.000Z"));
  assert.equal(approved.project.status, "completed");
});

test("web dispatch state transitions are explicit and transport failures release leases", () => {
  let { store, projectId } = setupProject();
  let prepared = Store.prepareProjectDispatches(store, projectId, clockAt("2026-08-01T02:00:00.000Z"));
  store = prepared.store;
  const dispatch = prepared.assignments[0];
  let started = Store.markProjectDispatchStarted(store, projectId, dispatch.dispatchId, 123, clockAt("2026-08-01T02:01:00.000Z"));
  store = started.store;
  assert.equal(started.dispatch.status, "dispatched");
  assert.equal(started.task.status, "running");
  const failed = Store.markProjectDispatchTransportError(store, projectId, dispatch.dispatchId, "Composer unavailable", clockAt("2026-08-01T02:02:00.000Z"));
  assert.equal(failed.dispatch.status, "transport_failed");
  assert.equal(failed.task.status, "ready");
  assert.equal(failed.task.lease, null);
});
