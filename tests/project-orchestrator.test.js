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
        roles: {
          reviewerChatId: "reviewer-chat",
          integratorChatId: "integrator-chat"
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

test("a stored worker result selects the independent reviewer chat", () => {
  const store = baseStore();
  store.tasksByProject.project.task = { id: "task", status: "review", lastResultDispatchId: "dispatch-1" };
  store.dispatchesByProject.project["dispatch-1"] = { dispatchId: "dispatch-1", taskId: "task" };
  store.resultsByProject.project["dispatch-1"] = { dispatchId: "dispatch-1" };

  assert.deepEqual(Orchestrator.selectNextRoleJob(store, {}), {
    kind: "review",
    role: "reviewer",
    projectId: "project",
    roleChatId: "reviewer-chat",
    dispatchId: "dispatch-1"
  });
});

test("active or completed reviewer jobs are not duplicated", () => {
  const store = baseStore();
  store.tasksByProject.project.task = { id: "task", status: "review", lastResultDispatchId: "dispatch-1" };
  store.dispatchesByProject.project["dispatch-1"] = { dispatchId: "dispatch-1", taskId: "task" };
  store.resultsByProject.project["dispatch-1"] = { dispatchId: "dispatch-1" };

  const active = {
    "review:project:dispatch-1": {
      jobId: "review:project:dispatch-1",
      projectId: "project",
      role: "reviewer",
      status: "running"
    }
  };
  assert.equal(Orchestrator.selectNextRoleJob(store, active), null);

  store.reviewsByProject.project["dispatch-1"] = { decision: "accepted" };
  assert.equal(Orchestrator.selectNextRoleJob(store, {}), null);
});

test("accepted task graphs select the integrator only when no integration is pending", () => {
  const store = baseStore();
  store.tasksByProject.project = {
    one: { id: "one", status: "accepted" },
    two: { id: "two", status: "accepted" }
  };

  const candidate = Orchestrator.selectNextRoleJob(store, {});
  assert.equal(candidate.kind, "integration");
  assert.equal(candidate.role, "integrator");
  assert.equal(candidate.roleChatId, "integrator-chat");
  assert.equal(Orchestrator.roleJobId(candidate), "integration:project:1:0");

  store.integrationsByProject.project = { pending: { status: "completed" } };
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

test("extension adapts fresh task, reviewer, and integrator jobs into guarded content runners", () => {
  const root = path.join(__dirname, "..");
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
  const entry = fs.readFileSync(path.join(root, "background-entry.js"), "utf8");
  const roleRunner = fs.readFileSync(path.join(root, "project-role-runner.js"), "utf8");
  const content = fs.readFileSync(path.join(root, "content.js"), "utf8");
  const projectUi = fs.readFileSync(path.join(root, "project-ui.js"), "utf8");

  assert.deepEqual(manifest.content_scripts[0].js.slice(-2), ["project-role-runner.js", "content.js"]);
  assert.match(entry, /AutoPrompterProjectOrchestrator\.start\(\)/);
  assert.match(entry, /AutoPrompterProjectTaskBoardController\.start\(\)/);
  assert.match(entry, /AutoPrompterProjectAdmin\.start\(\)/);
  assert.doesNotMatch(entry, /AutoPrompterProjectFullAuto\.start\(\)/);
  assert.match(roleRunner, /RUN_PROJECT_ROLE_JOB/);
  assert.match(roleRunner, /type: "RUN_PROJECT_BOOTSTRAP_JOB"/);
  assert.match(roleRunner, /PROJECT_ROLE_RESULT/);
  assert.match(roleRunner, /activeJobs\.has\(message\.jobId\)/);
  assert.match(content, /message\.type === "RUN_PROJECT_BOOTSTRAP_JOB"/);
  assert.match(content, /RUN_PROJECT_SUCCESSOR_TASK/);
  assert.match(projectUi, /Advanced recovery and diagnostics/);
  assert.match(projectUi, /deleteExistingProject/);
  assert.match(projectUi, /Branch task board/);
  assert.equal(manifest.version, "3.4.0");
});
