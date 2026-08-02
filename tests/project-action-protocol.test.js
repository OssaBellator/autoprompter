"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const ActionProtocol = require("../project-action-protocol.js");

const project = {
  projectId: "full-auto-project",
  repository: { slug: "OssaBellator/autoprompter", defaultBranch: "main" }
};
const approval = {
  approvalId: "approval-merge",
  status: "approved",
  action: "merge_to_default_branch",
  target: "OssaBellator/autoprompter:main:abc123",
  instruction: "Perform only the approved merge to the default branch."
};

test("repository action prompts bind one approved action and structured result envelope", () => {
  const prompt = ActionProtocol.buildPrompt({
    project,
    approval,
    actionId: "action:full-auto-project:merge",
    extraInstructions: "Require passing checks and do not force-push."
  });
  assert.match(prompt, /write-capable GitHub plugin, MCP app, or Codex/);
  assert.match(prompt, /AUTOPROMPTER_ACTION_RESULT_BEGIN/);
  assert.match(prompt, /Require passing checks and do not force-push/);
  assert.match(prompt, /merge_to_default_branch/);
});

test("completed action results require exact identity and repository evidence", () => {
  const expected = {
    projectId: project.projectId,
    actionId: "action:full-auto-project:merge",
    approvalId: approval.approvalId,
    action: approval.action,
    target: approval.target
  };
  const output = [
    ActionProtocol.ACTION_BEGIN,
    JSON.stringify({
      schemaVersion: "1.0",
      ...expected,
      status: "completed",
      summary: "Merged the validated integration pull request.",
      evidence: {
        repository: project.repository.slug,
        url: "https://github.com/OssaBellator/autoprompter/pull/99",
        afterCommit: "def456"
      },
      completedAt: "2026-08-02T03:40:00.000Z"
    }),
    ActionProtocol.ACTION_END
  ].join("\n");
  const result = ActionProtocol.validateResult(output, expected);
  assert.equal(result.status, "completed");
  assert.equal(result.evidence.afterCommit, "def456");
});

test("repository action results fail closed on changed scope or evidence-free success", () => {
  const expected = {
    projectId: project.projectId,
    actionId: "action:full-auto-project:merge",
    approvalId: approval.approvalId,
    action: approval.action,
    target: approval.target
  };

  assert.throws(
    () => ActionProtocol.validateResult(JSON.stringify({
      schemaVersion: "1.0",
      ...expected,
      target: "another/repository:main",
      status: "completed",
      summary: "Done",
      evidence: { url: "https://example.invalid" }
    }), expected),
    /target does not match/
  );

  assert.throws(
    () => ActionProtocol.validateResult(JSON.stringify({
      schemaVersion: "1.0",
      ...expected,
      status: "completed",
      summary: "Done",
      evidence: {}
    }), expected),
    /require evidence/
  );
});
