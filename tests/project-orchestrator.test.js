"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const Orchestrator = require("../project-orchestrator.js");

function baseStore() {
  return {
    projects: {
      project: {
        projectId: "project",
        status: "running",
        updatedAt: "2026-08-02T03:10:00.000Z",
        githubWorkflowMode: "github_issues_and_pull_requests",
        roles: {
          reviewerChatId: "reviewer-chat",
          integratorChatId: null
        }
      }
    },
    approvedPlansByProject: { project: { revision: 1 } },
    tasksByProject: { project: {} },
    dispatchesByProject: { project: {} },
    resultsByProject: { project: {} },
    reviewsByProject: { project: {} },
    integrationsByProject: {}
  };
}

test("a stored pull request result selects the combined reviewer merger chat", () => {
  const store = baseStore();
  store.tasksByProject.project.task = { id: "task", status: "review", lastResultDispatchId: "dispatch-1" };
  store.dispatchesByProject.project["dispatch-1"] = { dispatchId: "dispatch-1", taskId: "task" };
  store.resultsByProject.project["dispatch-1"] = { dispatchId: "dispatch-1", pullRequest: { number: 10 } };

  assert.deepEqual(Orchestrator.selectNextRoleJob(store, {}), {
    kind: "review",
    role: "reviewer",
    projectId: "project",
    roleChatId: "reviewer-chat",
    dispatchId: "dispatch-1"
  });
});

test("active or completed pull request review jobs are not duplicated", () => {
  const store = baseStore();
  store.tasksByProject.project.task = { id: "task", status: "review", lastResultDispatchId: "dispatch-1" };
  store.dispatchesByProject.project["dispatch-1"] = { dispatchId: "dispatch-1", taskId: "task" };
  store.resultsByProject.project["dispatch-1"] = { dispatchId: "dispatch-1", pullRequest: { number: 10 } };

  const active = {
    "review:project:dispatch-1": {
      jobId: "review:project:dispatch-1",
      projectId: "project",
      role: "reviewer",
      status: "running"
    }
  };
  assert.equal(Orchestrator.selectNextRoleJob(store, active), null);

  store.reviewsByProject.project["dispatch-1"] = { decision: "merged" };
  assert.equal(Orchestrator.selectNextRoleJob(store, {}), null);
});

test("accepted issue graphs do not start a separate integrator job", () => {
  const store = baseStore();
  store.tasksByProject.project = {
    one: { id: "one", status: "accepted" },
    two: { id: "two", status: "accepted" }
  };

  assert.equal(Orchestrator.selectNextRoleJob(store, {}), null);
});

test("role jobs disable continuity and preserve bounded interruption settings", () => {
  const settings = Orchestrator.normalizeSettings({
    continuityEnabled: true,
    delaySeconds: 30,
    stallMinutes: 2,
    contextCapacityTokens: 100,
    contextThresholdPercent: 120
  });

  assert.equal(settings.continuityEnabled, false);
  assert.equal(settings.delaySeconds, 0);
  assert.equal(settings.stallMinutes, 5);
  assert.equal(settings.contextCapacityTokens, 16000);
  assert.equal(settings.contextThresholdPercent, 98);
});

test("extension adapts planner issue capture, persistent workers, and combined PR review jobs", () => {
  const root = path.join(__dirname, "..");
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
  const entry = fs.readFileSync(path.join(root, "background-entry.js"), "utf8");
  const roleRunner = fs.readFileSync(path.join(root, "project-role-runner.js"), "utf8");
  const content = fs.readFileSync(path.join(root, "content.js"), "utf8");
  const capture = fs.readFileSync(path.join(root, "project-plan-capture.js"), "utf8");
  const workflow = fs.readFileSync(path.join(root, "project-github-workflow.js"), "utf8");
  const githubUi = fs.readFileSync(path.join(root, "project-github-ui.js"), "utf8");

  assert.deepEqual(manifest.content_scripts[0].js.slice(-3), ["project-role-runner.js", "content.js", "project-plan-capture.js"]);
  assert.match(entry, /AutoPrompterProjectPlanRecovery\.start\(\)/);
  assert.match(entry, /AutoPrompterProjectOrchestrator\.start\(\)/);
  assert.match(entry, /AutoPrompterProjectRoleKick\.start\(\)/);
  assert.match(entry, /AutoPrompterProjectTaskBoardController\.start\(\)/);
  assert.match(entry, /AutoPrompterProjectAutoBootstrap\.start\(\)/);
  assert.match(entry, /AutoPrompterProjectAdmin\.start\(\)/);
  assert.doesNotMatch(entry, /AutoPrompterProjectFullAuto\.start\(\)/);
  assert.match(roleRunner, /RUN_PROJECT_ROLE_JOB/);
  assert.match(roleRunner, /type: "RUN_PROJECT_BOOTSTRAP_JOB"/);
  assert.match(roleRunner, /PROJECT_ROLE_RESULT/);
  assert.match(roleRunner, /activeJobs\.has\(message\.jobId\)/);
  assert.match(content, /message\.type === "RUN_PROJECT_BOOTSTRAP_JOB"/);
  assert.match(content, /RUN_PROJECT_SUCCESSOR_TASK/);
  assert.match(capture, /GET_PROJECT_PLANNER_RECOVERY/);
  assert.match(capture, /PROJECT_BOOTSTRAP_RESULT/);
  assert.match(workflow, /AUTOPROMPTER_ISSUES_BEGIN/);
  assert.match(workflow, /AUTOPROMPTER_ISSUE_WORK_BEGIN/);
  assert.match(workflow, /AUTOPROMPTER_PR_REVIEW_BEGIN/);
  assert.match(workflow, /reviewer and integrator/);
  assert.match(githubUi, /GitHub Issue and Pull Request Mode/);
  assert.match(githubUi, /Pull-request reviewer and merger chat/);
  assert.equal(manifest.version, "4.0.1");
});
