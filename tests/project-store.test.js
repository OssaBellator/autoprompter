"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  STORE_SCHEMA_VERSION,
  emptyStore,
  migrateStore,
  createProject,
  inspectProject,
  transitionProject,
  listProjects
} = require("../project-store.js");

const fixedClock = () => Date.parse("2026-07-31T04:30:00Z");

function validInput(overrides = {}) {
  return {
    title: "Project Mode",
    goal: "Coordinate planner and worker chats through ChatGPT Web.",
    repository: "https://github.com/OssaBellator/autoprompter.git",
    plannerChatId: "planner",
    reviewerChatId: "reviewer",
    integratorChatId: "integrator",
    workerChatIds: ["worker-a", "worker-b"],
    ...overrides
  };
}

test("initializes and migrates the versioned Project Mode store", () => {
  const initialized = migrateStore(null);
  assert.equal(initialized.migrated, true);
  assert.equal(initialized.store.schemaVersion, STORE_SCHEMA_VERSION);
  assert.deepEqual(initialized.store.projects, {});

  const created = createProject(emptyStore(), validInput(), fixedClock);
  const legacy = migrateStore({
    schemaVersion: "0.1",
    activeProjectId: created.project.projectId,
    projects: [created.project]
  });
  assert.equal(legacy.migrated, true);
  assert.equal(legacy.store.activeProjectId, created.project.projectId);
  assert.ok(legacy.store.projects[created.project.projectId]);
});

test("creates schema-compatible drafts and removes role chats from workers", () => {
  const result = createProject(emptyStore(), validInput({ workerChatIds: ["planner", "worker-a", "worker-a"] }), fixedClock);
  assert.equal(result.project.schemaVersion, "1.0");
  assert.equal(result.project.status, "draft");
  assert.equal(result.project.repository.slug, "OssaBellator/autoprompter");
  assert.deepEqual(result.project.roles.workerChatIds, ["worker-a"]);
  assert.equal(result.store.activeProjectId, result.project.projectId);
  assert.equal(result.store.events.at(-1).type, "project_created");
});

test("rejects duplicate fixed-role chats", () => {
  assert.throws(
    () => createProject(emptyStore(), validInput({ reviewerChatId: "planner" }), fixedClock),
    /must be different/
  );
});

test("pause and resume preserve the prior lifecycle state", () => {
  const created = createProject(emptyStore(), validInput(), fixedClock);
  created.store.projects[created.project.projectId].status = "planning";
  const paused = transitionProject(created.store, created.project.projectId, "pause", fixedClock);
  assert.equal(paused.project.status, "paused");
  const resumed = transitionProject(paused.store, created.project.projectId, "resume", fixedClock);
  assert.equal(resumed.project.status, "planning");
});

test("cancel is terminal and inspect returns project-specific events", () => {
  const created = createProject(emptyStore(), validInput(), fixedClock);
  const cancelled = transitionProject(created.store, created.project.projectId, "cancel", fixedClock);
  assert.equal(cancelled.project.status, "cancelled");
  assert.throws(() => transitionProject(cancelled.store, created.project.projectId, "resume", fixedClock), /paused/);
  assert.throws(() => transitionProject(cancelled.store, created.project.projectId, "cancel", fixedClock), /Cannot cancel/);
  const inspected = inspectProject(cancelled.store, created.project.projectId);
  assert.equal(inspected.project.status, "cancelled");
  assert.deepEqual(inspected.events.map(event => event.type), ["project_created", "project_cancelled"]);
});

test("lists projects by most recently updated", () => {
  let store = emptyStore();
  const first = createProject(store, validInput({ title: "First" }), () => Date.parse("2026-07-31T04:00:00Z"));
  store = first.store;
  const second = createProject(store, validInput({ title: "Second" }), () => Date.parse("2026-07-31T05:00:00Z"));
  assert.deepEqual(listProjects(second.store).map(project => project.title), ["Second", "First"]);
});

test("rejects unknown future store versions", () => {
  assert.throws(() => migrateStore({ schemaVersion: "99.0", projects: {} }), /Unsupported/);
});
