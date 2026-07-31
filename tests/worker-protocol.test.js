"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  DISPATCH_SCHEMA_VERSION,
  MAX_WORKER_PROMPT_CHARS,
  buildDispatchId,
  buildBranchName,
  buildWorkerPrompt,
  isLeaseExpired,
  summarizeRuntime
} = require("../worker-protocol.js");

const project = {
  projectId: "project-mode",
  title: "Project Mode",
  repository: {
    slug: "OssaBellator/autoprompter",
    defaultBranch: "main",
    handoffFile: "AUTOPROMPTER_HANDOFF.md"
  },
  roles: { workerChatIds: ["worker-a", "worker-b"] }
};

const task = {
  id: "task-store",
  title: "Implement store",
  description: "Implement deterministic worker leases.",
  role: "implementation",
  preferredModelClass: "standard",
  allowedPaths: ["project-store.js", "tests/**"],
  acceptanceCriteria: ["Leases survive restart.", "Duplicate dispatch is prevented."],
  verificationCommands: ["npm test"]
};

function dispatch() {
  return {
    schemaVersion: DISPATCH_SCHEMA_VERSION,
    dispatchId: buildDispatchId({ projectId: project.projectId, revision: 1, taskId: task.id, attempt: 1, workerChatId: "worker-a" }),
    projectId: project.projectId,
    planRevision: 1,
    taskId: task.id,
    workerChatId: "worker-a",
    attempt: 1,
    branch: buildBranchName(project.projectId, task.id, 1),
    status: "prepared",
    assignedAt: "2026-07-31T05:00:00.000Z",
    expiresAt: "2026-07-31T07:00:00.000Z"
  };
}

test("dispatch IDs and branch names are deterministic and bounded", () => {
  const first = dispatch();
  const second = dispatch();
  assert.equal(first.dispatchId, second.dispatchId);
  assert.match(first.dispatchId, /^dispatch-store-a1-[a-z0-9]+$/);
  assert.equal(first.branch, "agent/project-mode/store-a1");
  assert.ok(first.dispatchId.length <= 200);
  assert.ok(first.branch.length <= 240);
});

test("different worker or attempt produces a distinct idempotency key", () => {
  const first = dispatch().dispatchId;
  const workerChanged = buildDispatchId({ projectId: project.projectId, revision: 1, taskId: task.id, attempt: 1, workerChatId: "worker-b" });
  const retry = buildDispatchId({ projectId: project.projectId, revision: 1, taskId: task.id, attempt: 2, workerChatId: "worker-a" });
  assert.notEqual(first, workerChanged);
  assert.notEqual(first, retry);
});

test("worker prompts are bounded, repository-anchored, and explicitly non-integrating", () => {
  const prompt = buildWorkerPrompt(project, task, dispatch());
  assert.ok(prompt.length <= MAX_WORKER_PROMPT_CHARS);
  assert.match(prompt, /OssaBellator\/autoprompter/);
  assert.match(prompt, /Dispatch ID:/);
  assert.match(prompt, /Work only on this task/);
  assert.match(prompt, /Do not merge, publish, modify permissions/);
  assert.match(prompt, /AUTOPROMPTER_TASK_RESULT_BEGIN/);
  assert.match(prompt, /AUTOPROMPTER_TASK_RESULT_END/);
});

test("lease expiry is conservative for invalid or elapsed timestamps", () => {
  assert.equal(isLeaseExpired(null, Date.parse("2026-07-31T06:00:00Z")), false);
  assert.equal(isLeaseExpired({ expiresAt: "invalid" }, Date.parse("2026-07-31T06:00:00Z")), true);
  assert.equal(isLeaseExpired({ expiresAt: "2026-07-31T07:00:00Z" }, Date.parse("2026-07-31T06:00:00Z")), false);
  assert.equal(isLeaseExpired({ expiresAt: "2026-07-31T05:00:00Z" }, Date.parse("2026-07-31T06:00:00Z")), true);
});

test("runtime summaries expose worker capacity and task states", () => {
  const prepared = dispatch();
  const summary = summarizeRuntime(project, {
    "task-store": { status: "leased" },
    "task-tests": { status: "blocked" }
  }, { [prepared.dispatchId]: prepared });
  assert.equal(summary.taskCount, 2);
  assert.equal(summary.statusCounts.leased, 1);
  assert.equal(summary.activeLeaseCount, 1);
  assert.equal(summary.availableWorkerCount, 1);
  assert.deepEqual(summary.activeDispatchIds, [prepared.dispatchId]);
});
