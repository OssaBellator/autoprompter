"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const ResultProtocol = require("../result-protocol.js");
const ReviewerProtocol = require("../reviewer-protocol.js");
const IntegrationProtocol = require("../integration-protocol.js");

const project = {
  projectId: "autoprompter-v3",
  title: "AutoPrompter V3",
  repository: { slug: "OssaBellator/autoprompter", defaultBranch: "main", handoffFile: "AUTOPROMPTER_HANDOFF.md" },
  scheduler: { revisionLimit: 2 }
};
const task = {
  id: "task-result-protocol",
  title: "Implement result protocol",
  description: "Add strict worker-result validation.",
  attempt: 1,
  allowedPaths: ["result-protocol.js", "tests/**"],
  acceptanceCriteria: ["Strict envelope parsing exists.", "Unsafe paths are rejected."],
  verificationCommands: ["npm test"]
};
const dispatch = {
  dispatchId: "dispatch-result-protocol-a1-example1",
  projectId: project.projectId,
  taskId: task.id,
  attempt: 1,
  branch: "agent/autoprompter-v3/result-protocol-a1"
};

function resultObject(overrides = {}) {
  return {
    schemaVersion: "1.0",
    projectId: project.projectId,
    taskId: task.id,
    dispatchId: dispatch.dispatchId,
    attempt: 1,
    status: "completed",
    summary: "Implemented strict result parsing.",
    commit: "abcdef1234567",
    tests: [{ command: "npm test", status: "passed", summary: "All tests passed." }],
    filesChanged: ["result-protocol.js", "tests/frontier-protocols.test.js"],
    risks: [],
    followUpTaskSuggestions: [],
    producedAt: "2026-08-01T01:00:00.000Z",
    ...overrides
  };
}

function envelope(begin, value, end) {
  return `${begin}\n${JSON.stringify(value)}\n${end}`;
}

test("worker results are strictly parsed, identity checked, and digested", () => {
  const result = ResultProtocol.parseAndValidateResult(
    envelope(ResultProtocol.RESULT_BEGIN, resultObject(), ResultProtocol.RESULT_END),
    { project, task, dispatch }
  );
  assert.equal(result.commit, "abcdef1234567");
  assert.match(result.resultDigest, /^[a-z0-9]{7}$/);
  assert.equal(ResultProtocol.stableHash({ b: 2, a: 1 }), ResultProtocol.stableHash({ a: 1, b: 2 }));
});

test("worker result parser rejects prose, wrong dispatches, missing tests, and out-of-scope paths", () => {
  assert.throws(() => ResultProtocol.parseResultEnvelope(`hello\n${envelope(ResultProtocol.RESULT_BEGIN, resultObject(), ResultProtocol.RESULT_END)}`), /prose outside/);
  assert.throws(() => ResultProtocol.validateResult(resultObject({ dispatchId: "dispatch-other-a1-example1" }), { project, task, dispatch }), /dispatchId/);
  assert.throws(() => ResultProtocol.validateResult(resultObject({ tests: [] }), { project, task, dispatch }), /missing verification evidence/);
  assert.throws(() => ResultProtocol.validateResult(resultObject({ filesChanged: ["background.js"] }), { project, task, dispatch }), /outside the task allowlist/);
});

test("completed worker results require commits and passing required commands", () => {
  assert.throws(() => ResultProtocol.validateResult(resultObject({ commit: null }), { project, task, dispatch }), /commit SHA/);
  assert.throws(() => ResultProtocol.validateResult(resultObject({ tests: [{ command: "npm test", status: "failed", summary: "failed" }] }), { project, task, dispatch }), /did not pass required verification/);
  const blocked = ResultProtocol.validateResult(resultObject({ status: "blocked", commit: null, tests: [{ command: "npm test", status: "not_run", summary: "permission missing" }] }), { project, task, dispatch });
  assert.equal(blocked.status, "blocked");
});

test("reviewer prompt binds the exact result digest and bounded decision schema", () => {
  const result = ResultProtocol.validateResult(resultObject(), { project, task, dispatch });
  const prompt = ReviewerProtocol.buildReviewerPrompt(project, task, dispatch, result);
  assert.match(prompt, new RegExp(result.resultDigest));
  assert.match(prompt, /Do not merge, publish/);
  assert.match(prompt, /AUTOPROMPTER_REVIEW_BEGIN/);
});

function reviewObject(result, overrides = {}) {
  return {
    schemaVersion: "1.0",
    projectId: project.projectId,
    taskId: task.id,
    dispatchId: dispatch.dispatchId,
    attempt: 1,
    resultDigest: result.resultDigest,
    decision: "accepted",
    summary: "Commit and evidence satisfy the task.",
    acceptanceCriteria: task.acceptanceCriteria.map(criterion => ({ criterion, status: "met", evidence: "Verified in the diff and tests." })),
    verificationChecks: [{ command: "npm test", status: "verified", evidence: "Test output passed." }],
    requiredChanges: [],
    risks: [],
    reviewedAt: "2026-08-01T01:05:00.000Z",
    ...overrides
  };
}

test("accepted reviews require complete evidence and exact result identity", () => {
  const result = ResultProtocol.validateResult(resultObject(), { project, task, dispatch });
  const review = ReviewerProtocol.parseAndValidateReview(
    envelope(ReviewerProtocol.REVIEW_BEGIN, reviewObject(result), ReviewerProtocol.REVIEW_END),
    { project, task, dispatch, result }
  );
  assert.equal(review.decision, "accepted");
  assert.throws(() => ReviewerProtocol.validateReview(reviewObject(result, { resultDigest: "wrong" }), { project, task, dispatch, result }), /resultDigest/);
  assert.throws(() => ReviewerProtocol.validateReview(reviewObject(result, { requiredChanges: ["fix"] }), { project, task, dispatch, result }), /cannot include required changes/);
});

test("revision reviews require bounded changes and rejected decisions remain valid", () => {
  const result = ResultProtocol.validateResult(resultObject(), { project, task, dispatch });
  assert.throws(() => ReviewerProtocol.validateReview(reviewObject(result, {
    decision: "revision_required",
    acceptanceCriteria: task.acceptanceCriteria.map(criterion => ({ criterion, status: "unclear", evidence: "Not enough evidence." })),
    verificationChecks: [{ command: "npm test", status: "not_verified", evidence: "No independent run." }],
    requiredChanges: []
  }), { project, task, dispatch, result }), /at least one required change/);
  const rejected = ReviewerProtocol.validateReview(reviewObject(result, {
    decision: "rejected",
    requiredChanges: ["Replace unrelated implementation."],
    acceptanceCriteria: task.acceptanceCriteria.map(criterion => ({ criterion, status: "not_met", evidence: "Not present." })),
    verificationChecks: [{ command: "npm test", status: "failed", evidence: "Tests failed." }]
  }), { project, task, dispatch, result });
  assert.equal(rejected.decision, "rejected");
});

test("integrator protocol requires every accepted task and passing project-wide tests", () => {
  const result = ResultProtocol.validateResult(resultObject(), { project, task, dispatch });
  const review = ReviewerProtocol.validateReview(reviewObject(result), { project, task, dispatch, result });
  const acceptedTask = { ...task, status: "accepted", acceptedDispatchId: dispatch.dispatchId, acceptedBranch: dispatch.branch, acceptedCommit: result.commit };
  const tasks = { [task.id]: acceptedTask };
  const results = { [dispatch.dispatchId]: result };
  const reviews = { [dispatch.dispatchId]: review };
  const plan = { revision: 1 };
  const built = IntegrationProtocol.buildIntegratorPrompt(project, plan, tasks, results, reviews);
  assert.match(built.prompt, /Do not merge to the default branch/);
  const output = {
    schemaVersion: "1.1",
    integrationId: built.integrationId,
    integrationAttempt: built.attempt,
    projectId: project.projectId,
    planRevision: 1,
    status: "completed",
    summary: "Integrated accepted work.",
    branch: "agent/autoprompter-v3/integration-r1-a1",
    commit: "1234567890abcdef",
    includedTasks: [task.id],
    tests: [{ command: "npm test", status: "passed", summary: "All tests passed." }],
    conflicts: [],
    risks: [],
    producedAt: "2026-08-01T01:10:00.000Z"
  };
  const integration = IntegrationProtocol.parseAndValidateIntegration(
    envelope(IntegrationProtocol.INTEGRATION_BEGIN, output, IntegrationProtocol.INTEGRATION_END),
    { project, plan, tasks, expectedIntegrationId: built.integrationId, expectedAttempt: built.attempt }
  );
  assert.equal(integration.status, "completed");
  assert.throws(() => IntegrationProtocol.validateIntegration(
    { ...output, tests: [] },
    { project, plan, tasks, expectedIntegrationId: built.integrationId, expectedAttempt: built.attempt }
  ), /passing project-wide test evidence/);
});
