"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const RoleKick = require("../project-role-kick.js");

function baseStore() {
  return {
    projects: {
      alpha: {
        projectId: "alpha",
        status: "running",
        roles: { reviewerChatId: "reviewer-chat", integratorChatId: "integrator-chat" }
      }
    },
    tasksByProject: { alpha: {} },
    dispatchesByProject: { alpha: {} },
    resultsByProject: { alpha: {} },
    reviewsByProject: { alpha: {} },
    integrationsByProject: { alpha: null }
  };
}

test("stored worker result waiting for review wakes role automation", () => {
  const store = baseStore();
  store.tasksByProject.alpha.task = { id: "task", status: "review", lastResultDispatchId: "dispatch" };
  store.dispatchesByProject.alpha.dispatch = { dispatchId: "dispatch", taskId: "task" };
  store.resultsByProject.alpha.dispatch = { dispatchId: "dispatch", status: "completed" };
  assert.equal(RoleKick.needsRoleWork(store, {}), true);
  assert.equal(RoleKick.needsRoleWork(store, {
    job: { projectId: "alpha", role: "reviewer", status: "running" }
  }), false);
});

test("all accepted tasks wake integration automation", () => {
  const store = baseStore();
  store.tasksByProject.alpha.one = { id: "one", status: "accepted" };
  store.tasksByProject.alpha.two = { id: "two", status: "accepted" };
  assert.equal(RoleKick.needsRoleWork(store, {}), true);
  store.integrationsByProject.alpha = { pending: { status: "completed" } };
  assert.equal(RoleKick.needsRoleWork(store, {}), false);
});

test("service worker loads the role wakeup bridge", () => {
  const root = path.join(__dirname, "..");
  const entry = fs.readFileSync(path.join(root, "background-entry.js"), "utf8");
  assert.match(entry, /project-role-kick\.js/);
  assert.match(entry, /AutoPrompterProjectRoleKick\.start\(\)/);
});
