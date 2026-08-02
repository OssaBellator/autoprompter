"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

global.AutoPrompterProjectStore = require("../project-store.js");
global.AutoPrompterRepositoryBootstrap = require("../repository-bootstrap.js");
global.AutoPrompterProjectActionProtocol = require("../project-action-protocol.js");
const FullAuto = require("../project-full-auto.js");

function store({ integrated = false } = {}) {
  return {
    projects: {
      project: {
        projectId: "project",
        title: "Automatic project",
        goal: "Complete the project automatically.",
        status: integrated ? "completed" : "running",
        createdAt: "2026-08-02T03:00:00.000Z",
        repository: {
          slug: "OssaBellator/autoprompter",
          defaultBranch: "main"
        },
        roles: { integratorChatId: "integrator-chat" },
        scheduler: {
          approvalActions: ["modify_workflow", "change_permissions", "merge_to_default_branch", "publish_release"]
        }
      }
    },
    approvedPlansByProject: {
      project: { projectId: "project", revision: 1, tasks: [{ id: "task-one" }] }
    },
    integrationsByProject: integrated ? {
      project: {
        approved: { status: "completed", commit: "abc123" },
        pending: null,
        approvedAt: "2026-08-02T03:20:00.000Z"
      }
    } : {},
    approvalsByProject: { project: {} }
  };
}

function completedJob(projectId, action, target) {
  const id = FullAuto.actionId(projectId, action, target);
  return [id, {
    actionId: id,
    projectId,
    action,
    target,
    status: "completed",
    attempts: 1,
    createdAt: "2026-08-02T03:00:00.000Z"
  }];
}

test("repository setup actions are ready after plan approval and merge actions wait for integration", () => {
  const beforeStore = store();
  const before = FullAuto.actionDefinitions(beforeStore, beforeStore.projects.project);
  assert.deepEqual(before.map(item => item.action), ["modify_workflow", "change_permissions"]);

  const integratedStore = store({ integrated: true });
  const after = FullAuto.actionDefinitions(integratedStore, integratedStore.projects.project);
  assert.deepEqual(after.map(item => item.action), [
    "modify_workflow",
    "change_permissions",
    "merge_to_default_branch",
    "publish_release"
  ]);
  assert.equal(after.at(-1).dependsOn, "merge_to_default_branch");
});

test("full-auto action selection is deterministic and release publication waits for a completed merge", () => {
  const current = store({ integrated: true });
  const definitions = FullAuto.actionDefinitions(current, current.projects.project);
  const workflow = definitions[0];
  const permissions = definitions[1];
  const merge = definitions[2];

  let jobs = {};
  assert.equal(FullAuto.selectActionCandidate(current, jobs, {}).definition.action, "modify_workflow");

  jobs = Object.fromEntries([
    completedJob("project", workflow.action, workflow.target)
  ]);
  assert.equal(FullAuto.selectActionCandidate(current, jobs, {}).definition.action, "change_permissions");

  jobs = Object.fromEntries([
    completedJob("project", workflow.action, workflow.target),
    completedJob("project", permissions.action, permissions.target)
  ]);
  assert.equal(FullAuto.selectActionCandidate(current, jobs, {}).definition.action, "merge_to_default_branch");

  jobs = Object.fromEntries([
    completedJob("project", workflow.action, workflow.target),
    completedJob("project", permissions.action, permissions.target),
    completedJob("project", merge.action, merge.target)
  ]);
  assert.equal(FullAuto.selectActionCandidate(current, jobs, {}).definition.action, "publish_release");
});

test("reviewer or integrator activity prevents concurrent repository action prompts", () => {
  const current = store({ integrated: true });
  const roleJobs = {
    active: {
      projectId: "project",
      role: "integrator",
      status: "running"
    }
  };
  assert.equal(FullAuto.selectActionCandidate(current, {}, roleJobs), null);
});
