"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const AutoBootstrap = require("../project-auto-bootstrap.js");

function store(status = "draft") {
  return {
    projects: { alpha: { projectId: "alpha", status } },
    approvedPlansByProject: { alpha: null },
    tasksByProject: { alpha: {} }
  };
}

test("newly added project IDs are detected without retriggering existing projects", () => {
  const change = {
    oldValue: { projects: { old: { projectId: "old" } } },
    newValue: { projects: { old: { projectId: "old" }, alpha: { projectId: "alpha" } } }
  };
  assert.deepEqual(AutoBootstrap.addedProjectIds(change), ["alpha"]);
  assert.deepEqual(AutoBootstrap.addedProjectIds({ oldValue: change.newValue, newValue: change.newValue }), []);
});

test("only untouched draft projects need automatic bootstrap", () => {
  assert.equal(AutoBootstrap.projectNeedsBootstrap(store(), "alpha"), true);
  assert.equal(AutoBootstrap.projectNeedsBootstrap(store("planning"), "alpha"), false);
  const planned = store();
  planned.approvedPlansByProject.alpha = { revision: 1 };
  assert.equal(AutoBootstrap.projectNeedsBootstrap(planned, "alpha"), false);
  const tasked = store();
  tasked.tasksByProject.alpha.task = { id: "task" };
  assert.equal(AutoBootstrap.projectNeedsBootstrap(tasked, "alpha"), false);
});

test("an existing bootstrap record suppresses the watchdog fallback", () => {
  assert.equal(AutoBootstrap.bootstrapAlreadyStarted({ alpha: { status: "starting" } }, "alpha"), true);
  assert.equal(AutoBootstrap.bootstrapAlreadyStarted({ alpha: { status: "running" } }, "alpha"), true);
  assert.equal(AutoBootstrap.bootstrapAlreadyStarted({ alpha: { status: "completed" } }, "alpha"), true);
  assert.equal(AutoBootstrap.bootstrapAlreadyStarted({ alpha: { status: "failed" } }, "alpha"), false);
  assert.equal(AutoBootstrap.bootstrapAlreadyStarted({}, "alpha"), false);
});

test("watchdog waits long enough for the popup bootstrap to establish ownership", () => {
  assert.ok(AutoBootstrap.START_DELAY_MS >= 8000);
});

test("service worker loads GitHub issue bootstrap ownership and planner recovery", () => {
  const root = path.join(__dirname, "..");
  const entry = fs.readFileSync(path.join(root, "background-entry.js"), "utf8");
  const api = fs.readFileSync(path.join(root, "background-project-api.js"), "utf8");
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
  assert.match(entry, /project-github-bootstrap\.js/);
  assert.match(entry, /project-auto-bootstrap\.js/);
  assert.match(entry, /AutoPrompterProjectAutoBootstrap\.start\(\)/);
  assert.match(entry, /AutoPrompterProjectPlanRecovery\.start\(\)/);
  assert.match(api, /bootstrapStarts/);
  assert.match(api, /startBootstrapOnce/);
  assert.equal(manifest.version, "4.0.0");
});
