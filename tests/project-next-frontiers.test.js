"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Store = require("../project-store.js");
const Approval = require("../approval-protocol.js");
const Reconciliation = require("../reconciliation-protocol.js");
const Integration = require("../integration-protocol.js");

const at = iso => () => Date.parse(iso);

function plan(projectId) {
  return {
    schemaVersion: "1.0",
    projectId,
    revision: 1,
    requiresMultipleAgents: true,
    rationale: "One bounded task is sufficient for frontier state tests.",
    phases: [{ id: "phase-one", title: "One", taskIds: ["task-one"], acceptanceCriteria: ["Accepted evidence exists."] }],
    tasks: [{
      id: "task-one",
      title: "One task",
      description: "Produce one accepted branch.",
      dependencies: [],
      role: "implementation",
      difficulty: "medium",
      preferredModelClass: "standard",
      allowedPaths: ["src/**"],
      acceptanceCriteria: ["The task is complete."],
      verificationCommands: ["npm test"]
    }],
    criticalPath: ["task-one"],
    createdAt: "2026-08-01T00:00:00.000Z"
  };
}

function setupRunningProject() {
  let result = Store.createProject(Store.emptyStore(), {
    title: "Next frontiers",
    goal: "Exercise retry, approval, reconciliation, and successor state.",
    repository: "OssaBellator/autoprompter",
    plannerChatId: "planner",
    reviewerChatId: "reviewer",
    integratorChatId: "integrator",
    workerChatIds: ["worker-one"],
    revisionLimit: 2,
    leaseMinutes: 120
  }, at("2026-08-01T00:00:00.000Z"));
  let store = result.store;
  const projectId = result.project.projectId;
  const submitted = Store.submitProjectPlannerOutput(
    store,
    projectId,
    `AUTOPROMPTER_PLAN_BEGIN\n${JSON.stringify(plan(projectId))}\nAUTOPROMPTER_PLAN_END`,
    at("2026-08-01T00:01:00.000Z")
  );
  store = Store.approveProjectPlan(submitted.store, projectId, at("2026-08-01T00:02:00.000Z")).store;
  store = Store.startProject(store, projectId, at("2026-08-01T00:03:00.000Z")).store;
  return { store, projectId };
}

function acceptedStore() {
  let { store, projectId } = setupRunningProject();
  const task = store.tasksByProject[projectId]["task-one"];
  task.status = "accepted";
  task.acceptedDispatchId = "dispatch-one-a1-abcdefg";
  task.acceptedBranch = `agent/${projectId}/one-a1`;
  task.acceptedCommit = "abcdef1234567";
  store.resultsByProject[projectId] = {
    [task.acceptedDispatchId]: { resultDigest: "digest-accepted", commit: task.acceptedCommit, status: "completed" }
  };
  store.reviewsByProject[projectId] = {
    [task.acceptedDispatchId]: { decision: "accepted", resultDigest: "digest-accepted" }
  };
  return { store, projectId, task };
}

test("approval requests are explicit, scoped, expiring records and execute nothing", () => {
  const { store, projectId } = setupRunningProject();
  const requested = Store.requestProjectApproval(store, projectId, {
    action: "merge_to_default_branch",
    target: "agent/project/integration -> main",
    justification: "The reviewed integration is ready."
  }, at("2026-08-01T01:00:00.000Z"));
  assert.equal(requested.approval.status, "pending");
  assert.equal(requested.approval.instruction, null);
  const decided = Store.decideProjectApproval(
    requested.store,
    projectId,
    requested.approval.approvalId,
    "approved",
    "Approved only for this exact branch and target.",
    at("2026-08-01T01:01:00.000Z")
  );
  assert.equal(decided.approval.status, "approved");
  assert.match(decided.approval.instruction, /applies only to the named action and target/);
  assert.equal(decided.project.status, "running");
  assert.throws(() => Approval.decideApproval(decided.project, decided.approval, "approved", "again", "2026-08-01T01:02:00.000Z"), /pending/);
});

test("blocked integration evidence advances to a distinct bounded retry attempt", () => {
  let { store, projectId, task } = acceptedStore();
  const first = Store.buildProjectIntegratorPrompt(store, projectId);
  store = first.store;
  const blocked = {
    schemaVersion: "1.1",
    integrationId: first.integrationId,
    integrationAttempt: first.integrationAttempt,
    projectId,
    planRevision: 1,
    status: "blocked",
    summary: "A reviewed branch conflicts with the integration branch.",
    branch: `agent/${projectId}/integration-r1-a1`,
    commit: null,
    includedTasks: [task.id],
    tests: [{ command: "npm test", status: "not_run", summary: "Blocked before validation." }],
    conflicts: ["Resolve src/index.js without changing reviewed task scope."],
    risks: [],
    producedAt: "2026-08-01T01:10:00.000Z"
  };
  let submitted = Store.submitProjectIntegrationOutput(
    store,
    projectId,
    `${Integration.INTEGRATION_BEGIN}\n${JSON.stringify(blocked)}\n${Integration.INTEGRATION_END}`,
    at("2026-08-01T01:10:00.000Z")
  );
  const retried = Store.requestProjectIntegrationRetry(
    submitted.store,
    projectId,
    ["Re-run the full test suite after resolving the conflict."],
    at("2026-08-01T01:11:00.000Z")
  );
  const second = Store.buildProjectIntegratorPrompt(retried.store, projectId);
  assert.equal(second.integrationAttempt, 2);
  assert.notEqual(second.integrationId, first.integrationId);
  assert.match(second.prompt, /Re-run the full test suite/);
  assert.match(second.prompt, /Resolve src\/index\.js/);
});

test("repository reconciliation is identity-bound and only reports observed state", () => {
  let { store, projectId, task } = acceptedStore();
  const prompt = Store.buildProjectReconciliationPrompt(store, projectId);
  assert.match(prompt.prompt, /Do not change files/);
  const snapshot = {
    schemaVersion: "1.0",
    projectId,
    repository: "OssaBellator/autoprompter",
    defaultBranch: "main",
    handoffFile: "AUTOPROMPTER_HANDOFF.md",
    planRevision: 1,
    observedAt: "2026-08-01T02:00:00.000Z",
    defaultBranchCommit: "1234567890abcdef",
    branches: [{ name: task.acceptedBranch, commit: task.acceptedCommit }],
    taskArtifacts: [{ taskId: task.id, branch: task.acceptedBranch, commit: task.acceptedCommit, status: "observed" }],
    integration: null,
    notes: ["Repository evidence matches the accepted task record."]
  };
  const output = `${Reconciliation.RECONCILIATION_BEGIN}\n${JSON.stringify(snapshot)}\n${Reconciliation.RECONCILIATION_END}`;
  const reconciled = Store.submitProjectReconciliation(store, projectId, output, at("2026-08-01T02:01:00.000Z"));
  assert.equal(reconciled.project.repositoryReconciliationRequired, false);
  assert.equal(reconciled.reconciliation.latest.missingCount, 0);
  assert.throws(() => Reconciliation.validateReconciliation({
    ...snapshot,
    taskArtifacts: [{ ...snapshot.taskArtifacts[0], taskId: "task-unknown" }]
  }, { project: store.projects[projectId], plan: store.approvedPlansByProject[projectId], tasks: store.tasksByProject[projectId] }), /unknown task/);
});

test("context-limit successors preserve task identity and require a new conversation", () => {
  let { store, projectId } = setupRunningProject();
  let prepared = Store.prepareProjectDispatches(store, projectId, at("2026-08-01T03:00:00.000Z"));
  store = prepared.store;
  const original = prepared.assignments[0];
  store = Store.markProjectDispatchStarted(store, projectId, original.dispatchId, 101, at("2026-08-01T03:01:00.000Z")).store;
  const successor = Store.createProjectDispatchSuccessor(store, projectId, original.dispatchId, "Maximum conversation length", at("2026-08-01T03:10:00.000Z"));
  assert.equal(successor.parent.status, "superseded");
  assert.equal(successor.successor.originalDispatchId, original.dispatchId);
  assert.equal(successor.successor.successorGeneration, 1);
  assert.match(successor.successor.prompt, new RegExp(successor.successor.dispatchId));
  assert.throws(() => Store.bindProjectSuccessorConversation(successor.store, projectId, successor.successor.dispatchId, original.workerChatId), /invalid/);
  const bound = Store.bindProjectSuccessorConversation(successor.store, projectId, successor.successor.dispatchId, "new-chat-id", at("2026-08-01T03:11:00.000Z"));
  assert.equal(bound.dispatch.conversationId, "new-chat-id");
});

test("worker status heartbeats renew both the dispatch and task lease", () => {
  let { store, projectId } = setupRunningProject();
  const prepared = Store.prepareProjectDispatches(store, projectId, at("2026-08-01T04:00:00.000Z"));
  const dispatch = prepared.assignments[0];
  store = Store.markProjectDispatchStarted(prepared.store, projectId, dispatch.dispatchId, 202, at("2026-08-01T04:01:00.000Z")).store;
  const oldExpiry = store.dispatchesByProject[projectId][dispatch.dispatchId].expiresAt;
  const heartbeat = Store.updateProjectDispatchStatus(store, projectId, dispatch.dispatchId, "Waiting for the new response · activity 37m 12s", at("2026-08-01T05:30:00.000Z"));
  assert.ok(Date.parse(heartbeat.dispatch.expiresAt) > Date.parse(oldExpiry));
  assert.equal(heartbeat.task.lease.expiresAt, heartbeat.dispatch.expiresAt);
});
