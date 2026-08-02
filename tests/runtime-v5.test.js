"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Runtime = require("../runtime-compat.js");

const root = path.join(__dirname, "..");

function read(name) {
  return fs.readFileSync(path.join(root, name), "utf8");
}

test("manifest loads only the AutoContinue content runtime", () => {
  const manifest = JSON.parse(read("manifest.json"));
  assert.equal(manifest.version, "5.0.0");
  assert.deepEqual(manifest.content_scripts[0].js, ["content.js"]);
  assert.deepEqual(manifest.permissions, ["storage", "tabs", "notifications"]);
});

test("service worker no longer loads planner, worker, reviewer, or integrator controllers", () => {
  const entry = read("background-entry.js");
  assert.match(entry, /autocontinue-unlimited-retries\.js/);
  assert.match(entry, /autocontinue-extended-thinking\.js/);
  assert.match(entry, /project-mode-retirement\.js/);
  assert.doesNotMatch(entry, /project-github|project-orchestrator|project-task-board|planner-compiler|project-role-kick/);
});

test("legacy project commands are blocked while folder UI assets are loaded", () => {
  assert.equal(Runtime.isLegacyProjectCommand("START_PROJECT_BOOTSTRAP"), true);
  assert.equal(Runtime.isLegacyProjectCommand("BUILD_PLANNER_PROMPT"), true);
  assert.equal(Runtime.isLegacyProjectCommand("START_SCHEDULER"), false);
  assert.deepEqual(Runtime.retiredProjectResponse("GET_PROJECTS"), {
    ok: true,
    projects: [],
    activeProjectId: null
  });
  assert.match(Runtime.retiredProjectResponse("START_PROJECT_MODE").error, /retired/i);
  const source = read("runtime-compat.js");
  assert.match(source, /project-folders\.js/);
  assert.match(source, /project-folders-ui\.js/);
  assert.doesNotMatch(source, /project-github-ui\.js|project-ui\.js/);
});

test("popup folder adapter provides notes and scheduler enrichment", () => {
  const source = read("project-folders-ui.js");
  assert.match(source, /chatNotes/);
  assert.match(source, /START_SCHEDULER/);
  assert.match(source, /Load project chats into AutoContinue/);
  assert.match(source, /Projects are folders only/);
});
