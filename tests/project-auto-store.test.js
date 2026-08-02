"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const AutoStore = require("../project-auto-store.js");

test("automatic assignment store exposes prepared leases from the canonical assignments array", () => {
  const projectStore = {
    prepareProjectDispatches(projectId) {
      return {
        store: { projectId },
        assignments: [
          { dispatchId: "dispatch-one", status: "prepared" },
          { dispatchId: "dispatch-two", status: "prepared" }
        ]
      };
    }
  };

  AutoStore.install(projectStore);
  const result = projectStore.prepareProjectDispatches("project");
  assert.deepEqual(result.prepared, result.assignments);
  assert.equal(result.prepared.length, 2);
});

test("background bridge explicitly binds automatic bootstrap and worker dispatch functions", () => {
  const root = path.join(__dirname, "..");
  const source = fs.readFileSync(path.join(root, "background-project-api.js"), "utf8");
  const entry = fs.readFileSync(path.join(root, "background-entry.js"), "utf8");

  assert.match(source, /globalThis\.startProjectBootstrapState = startBootstrap/);
  assert.match(source, /globalThis\.dispatchPreparedProjectAssignmentsState = dispatchAssignments/);
  assert.match(source, /dispatchAssignments\(projectId, dispatchIds, true\)/);
  assert.match(entry, /AutoPrompterProjectAutoStore\.install/);
});
