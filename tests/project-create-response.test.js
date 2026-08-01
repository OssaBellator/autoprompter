"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Store = require("../project-store.js");

const root = path.join(__dirname, "..");
const popupJs = fs.readFileSync(path.join(root, "popup.js"), "utf8");
const backgroundJs = fs.readFileSync(path.join(root, "background.js"), "utf8");

test("project creation accepts the full GitHub .git URL and returns an ID", () => {
  const result = Store.createProject(Store.emptyStore(), {
    title: "Autoprompter",
    goal: "Build a web-first multi-agent framework.",
    repository: "https://github.com/OssaBellator/autoprompter.git",
    plannerChatId: "planner",
    reviewerChatId: "reviewer",
    integratorChatId: "integrator",
    workerChatIds: []
  }, () => Date.parse("2026-08-01T04:00:00.000Z"));
  assert.equal(result.project.projectId, "autoprompter");
  assert.equal(result.project.repository.slug, "OssaBellator/autoprompter");
  assert.equal(result.store.activeProjectId, result.project.projectId);
});

test("popup resolves a created project from activeProjectId without dereferencing a missing project", () => {
  assert.match(popupJs, /function resolveCreatedProject\(response\)/);
  assert.match(popupJs, /directProject\?\.projectId \|\| response\?\.activeProjectId/);
  assert.match(popupJs, /await inspectProject\(created\.projectId\)/);
  assert.doesNotMatch(popupJs, /response\.project\.projectId/);
  assert.match(popupJs, /Reload AutoPrompter at edge:\/\/extensions/);
});

test("popup rejects an absent background response before reading Project Mode fields", () => {
  assert.match(popupJs, /if \(!response \|\| typeof response !== "object"\)/);
  assert.match(popupJs, /background service did not return a valid response/);
});

test("unknown runtime commands fail instead of returning a successful-looking response", () => {
  assert.match(backgroundJs, /throw new Error\(`Unknown AutoPrompter runtime command:/);
  assert.doesNotMatch(backgroundJs, /return \{ running: false, status: "Unknown command" \}/);
});
