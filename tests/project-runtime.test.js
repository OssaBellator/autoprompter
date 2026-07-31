"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const sessionStore = {};
const localStore = {};
let runtimeListener = null;

function clone(value) {
  return value == null ? value : structuredClone(value);
}

global.chrome = {
  runtime: {
    getManifest: () => ({ version: "2.8.0" }),
    onMessage: { addListener(listener) { runtimeListener = listener; } }
  },
  storage: {
    session: {
      async get(key) { return { [key]: clone(sessionStore[key]) }; },
      async set(values) { Object.assign(sessionStore, clone(values)); }
    },
    local: {
      async get(keys) {
        const result = {};
        for (const key of Array.isArray(keys) ? keys : [keys]) result[key] = clone(localStore[key]);
        return result;
      },
      async set(values) { Object.assign(localStore, clone(values)); }
    }
  },
  tabs: {
    onRemoved: { addListener() {} },
    onUpdated: { addListener() {} }
  },
  notifications: {},
  action: {}
};

require("../background.js");

function resetHarness() {
  for (const key of Object.keys(sessionStore)) delete sessionStore[key];
  for (const key of Object.keys(localStore)) delete localStore[key];
}

function dispatch(type, extra = {}) {
  return new Promise((resolve, reject) => {
    const handled = runtimeListener(
      { scope: "AUTOPROMPTER_RUNTIME", type, ...extra },
      {},
      response => resolve(response)
    );
    if (!handled) reject(new Error("message not handled"));
  });
}

function projectInput() {
  return {
    title: "Web-first Project Mode",
    goal: "Coordinate planner and worker chats without API inference.",
    repository: "OssaBellator/autoprompter",
    plannerChatId: "planner-chat",
    reviewerChatId: "reviewer-chat",
    integratorChatId: "integrator-chat",
    workerChatIds: ["worker-one", "worker-two"]
  };
}

test("GET_PROJECTS initializes and persists the current store schema", async () => {
  resetHarness();
  const response = await dispatch("GET_PROJECTS");
  assert.equal(response.ok, true);
  assert.equal(response.projectStoreVersion, "1.0");
  assert.deepEqual(response.projects, []);
  assert.equal(localStore.autoprompterProjects.schemaVersion, "1.0");
});

test("project lifecycle commands persist deterministic transitions", async () => {
  resetHarness();
  const created = await dispatch("CREATE_PROJECT", { project: projectInput() });
  assert.equal(created.ok, true);
  assert.equal(created.project.status, "draft");
  assert.equal(created.projects.length, 1);
  const projectId = created.project.projectId;

  const inspected = await dispatch("INSPECT_PROJECT", { projectId });
  assert.equal(inspected.project.projectId, projectId);
  assert.deepEqual(inspected.events.map(event => event.type), ["project_created"]);

  const paused = await dispatch("PAUSE_PROJECT", { projectId });
  assert.equal(paused.project.status, "paused");
  assert.equal(localStore.autoprompterProjects.projects[projectId].status, "paused");

  const resumed = await dispatch("RESUME_PROJECT", { projectId });
  assert.equal(resumed.project.status, "draft");

  const cancelled = await dispatch("CANCEL_PROJECT", { projectId });
  assert.equal(cancelled.project.status, "cancelled");
  const finalInspection = await dispatch("INSPECT_PROJECT", { projectId });
  assert.deepEqual(finalInspection.events.map(event => event.type), [
    "project_created",
    "project_paused",
    "project_resumed",
    "project_cancelled"
  ]);
});

test("invalid project commands fail without corrupting storage", async () => {
  resetHarness();
  const response = await dispatch("CREATE_PROJECT", {
    project: { ...projectInput(), repository: "not-a-repository" }
  });
  assert.equal(response.ok, false);
  assert.match(response.error, /valid GitHub repository/i);
  assert.deepEqual(localStore.autoprompterProjects.projects, {});
});
