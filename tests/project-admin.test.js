"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ProjectStore = require("../project-store.js");
const ProjectAdmin = require("../project-admin.js");

function project(id, updatedAt) {
  return {
    projectId: id,
    title: id,
    updatedAt,
    createdAt: updatedAt
  };
}

test("deleting a project removes every project-scoped store collection", () => {
  const store = ProjectStore.emptyStore();
  store.projects.one = project("one", "2026-08-02T01:00:00.000Z");
  store.projects.two = project("two", "2026-08-02T02:00:00.000Z");
  store.activeProjectId = "one";
  for (const key of [
    "resumeStatusByProject",
    "pendingPlansByProject",
    "approvedPlansByProject",
    "tasksByProject",
    "dispatchesByProject",
    "resultsByProject",
    "reviewsByProject",
    "integrationsByProject",
    "approvalsByProject",
    "reconciliationsByProject"
  ]) {
    store[key].one = { projectId: "one", workerTabId: 77 };
    store[key].two = { projectId: "two" };
  }
  store.events = [
    { projectId: "one", type: "deleted" },
    { projectId: "two", type: "kept" }
  ];

  const result = ProjectAdmin.deleteProjectFromStore(store, "one");
  assert.equal(result.project.projectId, "one");
  assert.equal(result.store.projects.one, undefined);
  assert.equal(result.store.activeProjectId, "two");
  assert.deepEqual(result.store.events, [{ projectId: "two", type: "kept" }]);
  assert.ok(result.tabIds.includes(77));
  for (const key of [
    "resumeStatusByProject",
    "pendingPlansByProject",
    "approvedPlansByProject",
    "tasksByProject",
    "dispatchesByProject",
    "resultsByProject",
    "reviewsByProject",
    "integrationsByProject",
    "approvalsByProject",
    "reconciliationsByProject"
  ]) {
    assert.equal(result.store[key].one, undefined);
    assert.ok(result.store[key].two);
  }
});

test("project job cleanup removes keyed and identity-bound records and collects managed tabs", () => {
  const result = ProjectAdmin.pruneProjectRecords({
    one: { projectId: "one", roles: { planner: { tabId: 10 } } },
    "review:one:1": { projectId: "one", tabId: 11 },
    "review:two:1": { projectId: "two", tabId: 12 }
  }, "one");

  assert.deepEqual(Object.keys(result.records), ["review:two:1"]);
  assert.deepEqual(result.tabIds.sort((a, b) => a - b), [10, 11]);
});

test("deleting a project detaches managed tabs without closing browser tabs", async () => {
  const created = ProjectStore.createProject(ProjectStore.emptyStore(), {
    projectId: "one",
    title: "One",
    goal: "Exercise project deletion without closing browser tabs.",
    repository: "OssaBellator/autoprompter",
    defaultBranch: "main",
    plannerChatId: null,
    reviewerChatId: null,
    integratorChatId: null,
    workerChatIds: []
  }, () => Date.parse("2026-08-02T01:00:00.000Z"));
  const store = created.store;
  store.dispatchesByProject.one = {
    dispatch: { projectId: "one", workerTabId: 77 }
  };
  const values = {
    [ProjectStore.PROJECTS_KEY]: store,
    [ProjectAdmin.BOOTSTRAP_KEY]: { one: { projectId: "one", roles: { reviewer: { tabId: 78 } } } },
    [ProjectAdmin.ROLE_JOBS_KEY]: {},
    [ProjectAdmin.ACTION_JOBS_KEY]: {}
  };
  let removed = 0;
  const previousChrome = global.chrome;
  global.chrome = {
    storage: {
      local: {
        async get(keys) {
          return Object.fromEntries(keys.map(key => [key, values[key]]));
        },
        async set(next) {
          Object.assign(values, next);
        }
      }
    },
    tabs: {
      async remove() {
        removed += 1;
      }
    }
  };

  try {
    const result = await ProjectAdmin.deleteProjectState("one");
    assert.equal(removed, 0);
    assert.deepEqual(result.detachedTabIds.sort((a, b) => a - b), [77, 78]);
    assert.equal(result.projects.length, 0);
  } finally {
    global.chrome = previousChrome;
  }
});

test("Existing Projects UI uses an in-popup listbox and hover delete icon", () => {
  const ui = fs.readFileSync(path.join(__dirname, "..", "project-ui.js"), "utf8");
  const admin = fs.readFileSync(path.join(__dirname, "..", "project-admin.js"), "utf8");
  const entry = fs.readFileSync(path.join(__dirname, "..", "background-entry.js"), "utf8");
  assert.match(ui, /projectPickerMenu/);
  assert.match(ui, /project-delete-icon/);
  assert.match(ui, /DELETE_CONFIRM_MS/);
  assert.match(ui, /AUTOPROMPTER_PROJECT_ADMIN/);
  assert.match(ui, /GitHub content and ChatGPT conversations are not deleted/);
  assert.doesNotMatch(ui, /globalThis\.confirm/);
  assert.doesNotMatch(admin, /chrome\.tabs\.remove/);
  assert.match(admin, /ordinary unmanaged/);
  assert.match(entry, /project-admin\.js/);
  assert.match(entry, /AutoPrompterProjectAdmin\.start\(\)/);
});
