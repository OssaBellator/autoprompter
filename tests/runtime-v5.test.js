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

test("manifest loads AutoContinue and the isolated repair content worker", () => {
  const manifest = JSON.parse(read("manifest.json"));
  assert.equal(manifest.version, "5.1.0");
  assert.deepEqual(manifest.content_scripts[0].js, ["content.js", "self-repair-content.js"]);
  assert.deepEqual(manifest.permissions, ["storage", "tabs", "notifications"]);
  assert.deepEqual(manifest.host_permissions, ["https://chatgpt.com/*", "https://chat.openai.com/*"]);
});

test("service worker installs recovery adapters before deferred terminal dispatch", () => {
  const entry = read("background-entry.js");
  assert.match(entry, /autocontinue-unlimited-retries\.js/);
  assert.match(entry, /autocontinue-extended-thinking\.js/);
  assert.match(entry, /autocontinue-transient-thinking\.js/);
  assert.match(entry, /autocontinue-deferred-dispatch\.js/);
  assert.match(entry, /autocontinue-self-repair\.js/);
  assert.match(entry, /AutoPrompterTransientThinkingRecovery\.install\(\)/);
  assert.match(entry, /AutoPrompterDeferredDispatch\.install\(\)/);
  assert.ok(entry.indexOf("AutoPrompterTransientThinkingRecovery.install()")
    < entry.indexOf("AutoPrompterDeferredDispatch.install()"));
  assert.doesNotMatch(entry, /project-mode-retirement|project-github|project-orchestrator|project-task-board|planner-compiler|project-role-kick/);
});

test("active background and content runtimes expose no retired Project Mode commands", () => {
  const background = read("background.js");
  const content = read("content.js");
  assert.doesNotMatch(background, /GET_PROJECTS|START_PROJECT_BOOTSTRAP|PROJECT_TASK_RESULT|START_PROJECT_MODE/);
  assert.doesNotMatch(content, /RUN_PROJECT|PROJECT_TASK_|PROJECT_BOOTSTRAP_/);
});

test("retired Project Mode source is absent from mainline files", () => {
  const retired = [
    "project-store.js",
    "project-orchestrator.js",
    "project-ui.js",
    "project-github-workflow.js",
    "planner-compiler.js",
    "worker-protocol.js",
    "reviewer-protocol.js",
    "integration-protocol.js",
    "project-mode-retirement.js"
  ];
  for (const name of retired) assert.equal(fs.existsSync(path.join(root, name)), false, name);
});

test("folder and self-repair popup adapters are loaded without legacy command compatibility", () => {
  assert.equal(typeof Runtime.isLegacyProjectCommand, "undefined");
  assert.equal(typeof Runtime.retiredProjectResponse, "undefined");
  const source = read("runtime-compat.js");
  assert.match(source, /project-folders\.js/);
  assert.match(source, /project-folders-ui\.js/);
  assert.match(source, /self-repair-ui\.js/);
  assert.doesNotMatch(source, /project-mode-retirement|project-github-ui\.js|project-ui\.js/);
});

test("popup folder adapter provides notes and scheduler enrichment", () => {
  const source = read("project-folders-ui.js");
  assert.match(source, /chatNotes/);
  assert.match(source, /START_SCHEDULER/);
  assert.match(source, /Load project chats into AutoContinue/);
  assert.match(source, /Projects are folders only/);
});

test("self-repair UI is opt-in and exposes bounded status controls", () => {
  const source = read("self-repair-ui.js");
  assert.match(source, /Automatically diagnose extension failures/);
  assert.match(source, /Maximum repairs per day/);
  assert.match(source, /connected write-capable GitHub tool/);
  assert.match(source, /GET_SELF_REPAIR_STATUS/);
});
