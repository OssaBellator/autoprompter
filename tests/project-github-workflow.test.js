"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const ProjectStore = require("../project-store.js");
const PlannerCompiler = require("../planner-compiler.js");
const ProjectTaskBoard = require("../project-task-board.js");
const GitHubWorkflow = require("../project-github-workflow.js");
const GitHubPersistence = require("../project-github-persistence.js");

PlannerCompiler.install(ProjectStore);
ProjectTaskBoard.install(ProjectStore);
GitHubWorkflow.install(ProjectStore);
GitHubPersistence.install(ProjectStore);

let now = Date.parse("2026-08-02T08:00:00.000Z");
const clock = () => now;
const tick = () => { now += 1000; };

function issue(number, title, dependsOnIssueNumbers = []) {
  return {
    number,
    url: `https://github.com/OssaBellator/autoprompter/issues/${number}`,
    title,
    body: `Implement ${title} with bounded repository changes and evidence.`,
    dependsOnIssueNumbers,
    allowedPaths: ["src/**", "tests/**"],
    acceptanceCriteria: [`${title} is implemented and verified.`],
    verificationCommands: ["npm test"],
    labels: ["autoprompter"]
  };
}

function manifest(projectId) {
  return [
    GitHubWorkflow.ISSUES_BEGIN,
    JSON.stringify({
      schemaVersion: "1.0",
      projectId,
      repository: "OssaBellator/autoprompter",
      issues: [
        issue(101, "Implement the core change"),
        issue(102, "Add dependent verification", [101])
      ],
      createdAt: new Date(clock()).toISOString()
    }),
    GitHubWorkflow.ISSUES_END
  ].join("\n");
}

function workerResult(projectId, task, dispatch, pullNumber, headSha) {
  return [
    GitHubWorkflow.ISSUE_WORK_BEGIN,
    JSON.stringify({
      schemaVersion: "1.0",
      projectId,
      taskId: task.id,
      dispatchId: dispatch.dispatchId,
      issueNumber: task.githubIssue.number,
      status: "pull_request_opened",
      summary: `Opened pull request #${pullNumber} for issue #${task.githubIssue.number}.`,
      pullRequest: {
        number: pullNumber,
        url: `https://github.com/OssaBellator/autoprompter/pull/${pullNumber}`,
        branch: dispatch.branch,
        headSha,
        baseBranch: "main",
        state: "open"
      },
      tests: [{ command: "npm test", status: "passed", summary: "The repository test suite passed." }],
      filesChanged: ["src/change.js", "tests/change.test.js"],
      risks: [],
      producedAt: new Date(clock()).toISOString()
    }),
    GitHubWorkflow.ISSUE_WORK_END
  ].join("\n");
}

function reviewResult(projectId, task, dispatch, decision, options = {}) {
  return [
    GitHubWorkflow.PR_REVIEW_BEGIN,
    JSON.stringify({
      schemaVersion: "1.0",
      projectId,
      taskId: task.id,
      dispatchId: dispatch.dispatchId,
      issueNumber: task.githubIssue.number,
      pullRequestNumber: task.pullRequest.number,
      decision,
      summary: options.summary || (decision === "merged" ? "Verified and merged the pull request." : "The pull request needs a bounded correction."),
      feedback: options.feedback || [],
      mergeCommit: options.mergeCommit || null,
      issueClosed: decision === "merged",
      reviewedAt: new Date(clock()).toISOString()
    }),
    GitHubWorkflow.PR_REVIEW_END
  ].join("\n");
}

function onlyAssignment(result) {
  assert.equal(result.assignments.length, 1);
  return result.assignments[0];
}

test("GitHub issues drive persistent worker PRs, review feedback, merges, and dependency unlocks", () => {
  let store = ProjectStore.createProject(ProjectStore.emptyStore(), {
    projectId: "github-issue-project",
    title: "GitHub issue project",
    goal: "Implement the requested change through GitHub issues and reviewed pull requests.",
    repository: "OssaBellator/autoprompter",
    defaultBranch: "main",
    reviewerChatId: "reviewer-chat"
  }, clock).store;
  const projectId = store.activeProjectId;
  const project = store.projects[projectId];

  assert.equal(project.githubWorkflowMode, GitHubWorkflow.MODE);
  assert.equal(project.roles.integratorChatId, null);
  assert.match(ProjectStore.buildProjectPlannerPrompt(store, projectId).prompt, /create the actual GitHub issues/i);

  const submitted = ProjectStore.submitProjectPlannerOutput(store, projectId, manifest(projectId), clock);
  store = submitted.store;
  assert.equal(submitted.plannerCompilation.mode, "github-issues");
  assert.equal(submitted.pendingPlan.tasks.length, 2);

  const approved = ProjectStore.approveProjectPlan(store, projectId, clock);
  store = approved.store;
  assert.equal(approved.tasks["task-issue-101"].githubIssue.number, 101);
  assert.equal(approved.tasks["task-issue-102"].status, "blocked");

  store = ProjectStore.startProject(store, projectId, clock).store;
  let prepared = ProjectStore.prepareProjectDispatches(store, projectId, clock);
  store = prepared.store;
  let dispatch = onlyAssignment(prepared);
  assert.equal(dispatch.taskId, "task-issue-101");
  assert.equal(dispatch.successorGeneration, 1);
  assert.match(dispatch.prompt, /persistent implementation agent assigned to one GitHub issue/i);

  store = ProjectStore.bindProjectSuccessorConversation(store, projectId, dispatch.dispatchId, "issue-chat-101", clock).store;
  let task = store.tasksByProject[projectId][dispatch.taskId];
  tick();
  let completed = ProjectStore.submitProjectTaskResult(
    store,
    projectId,
    dispatch.dispatchId,
    workerResult(projectId, task, dispatch, 201, "a".repeat(40)),
    clock
  );
  store = completed.store;
  task = completed.task;
  assert.equal(task.workerConversationId, "issue-chat-101");
  assert.equal(task.pullRequest.number, 201);
  assert.equal(task.status, "review");
  assert.match(ProjectStore.buildProjectReviewerPrompt(store, projectId, dispatch.dispatchId).prompt, /reviewer and integrator/i);

  tick();
  let reviewed = ProjectStore.submitProjectReview(
    store,
    projectId,
    dispatch.dispatchId,
    reviewResult(projectId, task, dispatch, "changes_requested", { feedback: ["Add a regression test for the edge case."] }),
    clock
  );
  store = reviewed.store;
  assert.equal(reviewed.task.status, "ready");
  assert.equal(reviewed.task.pullRequest.state, "open");
  assert.deepEqual(reviewed.task.requiredChanges, ["Add a regression test for the edge case."]);

  tick();
  prepared = ProjectStore.prepareProjectDispatches(store, projectId, clock);
  store = prepared.store;
  dispatch = onlyAssignment(prepared);
  assert.equal(dispatch.conversationId, "issue-chat-101");
  assert.equal(dispatch.workerChatId, "issue-chat-101");
  assert.equal(dispatch.freshRequestId, null);
  assert.equal(dispatch.successorGeneration, 0);
  assert.equal(dispatch.branch, reviewed.task.pullRequest.branch);
  assert.match(dispatch.prompt, /Continue the existing pull request/);
  assert.match(dispatch.prompt, /Add a regression test for the edge case/);

  task = store.tasksByProject[projectId][dispatch.taskId];
  tick();
  completed = ProjectStore.submitProjectTaskResult(
    store,
    projectId,
    dispatch.dispatchId,
    workerResult(projectId, task, dispatch, 201, "b".repeat(40)),
    clock
  );
  store = completed.store;
  task = completed.task;

  tick();
  reviewed = ProjectStore.submitProjectReview(
    store,
    projectId,
    dispatch.dispatchId,
    reviewResult(projectId, task, dispatch, "merged", { mergeCommit: "c".repeat(40) }),
    clock
  );
  store = reviewed.store;
  assert.equal(reviewed.task.status, "accepted");
  assert.equal(reviewed.task.pullRequest.state, "merged");
  assert.equal(store.tasksByProject[projectId]["task-issue-102"].status, "ready");

  tick();
  prepared = ProjectStore.prepareProjectDispatches(store, projectId, clock);
  store = prepared.store;
  dispatch = onlyAssignment(prepared);
  assert.equal(dispatch.taskId, "task-issue-102");
  assert.equal(dispatch.successorGeneration, 1);
  store = ProjectStore.bindProjectSuccessorConversation(store, projectId, dispatch.dispatchId, "issue-chat-102", clock).store;
  task = store.tasksByProject[projectId][dispatch.taskId];

  tick();
  completed = ProjectStore.submitProjectTaskResult(
    store,
    projectId,
    dispatch.dispatchId,
    workerResult(projectId, task, dispatch, 202, "d".repeat(40)),
    clock
  );
  store = completed.store;
  task = completed.task;

  tick();
  reviewed = ProjectStore.submitProjectReview(
    store,
    projectId,
    dispatch.dispatchId,
    reviewResult(projectId, task, dispatch, "merged", { mergeCommit: "e".repeat(40) }),
    clock
  );
  store = reviewed.store;
  assert.equal(reviewed.project.status, "completed");
  assert.equal(ProjectStore.summarizeProjectRuntime(store, projectId).mergedPullRequestCount, 2);

  const migrated = ProjectStore.migrateStore(store).store;
  assert.equal(migrated.projects[projectId].githubWorkflowMode, GitHubWorkflow.MODE);
  assert.equal(migrated.projects[projectId].roles.integratorChatId, null);
});
