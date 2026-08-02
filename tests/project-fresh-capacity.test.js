"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const FreshCapacity = require("../project-fresh-capacity.js");

test("fresh-chat projects default to three concurrent workers", () => {
  const fakeStore = {
    createProject(_store, input) {
      return { input };
    },
    migrateStore(raw) {
      return { store: raw, migrated: false };
    }
  };
  FreshCapacity.install(fakeStore);

  const created = fakeStore.createProject({}, { workerChatIds: [] });
  assert.equal(created.input.maxConcurrentWorkers, 3);

  const explicit = fakeStore.createProject({}, { workerChatIds: [], maxConcurrentWorkers: 1 });
  assert.equal(explicit.input.maxConcurrentWorkers, 1);
});

test("stored fresh-chat projects using the legacy one-worker default upgrade to three", () => {
  const store = {
    projects: {
      fresh: {
        roles: { workerChatIds: [] },
        scheduler: { maxConcurrentWorkers: 1 }
      },
      pooled: {
        roles: { workerChatIds: ["worker"] },
        scheduler: { maxConcurrentWorkers: 1 }
      }
    }
  };

  assert.equal(FreshCapacity.upgradeFreshCapacity(store), true);
  assert.equal(store.projects.fresh.scheduler.maxConcurrentWorkers, 3);
  assert.equal(store.projects.pooled.scheduler.maxConcurrentWorkers, 1);
});
