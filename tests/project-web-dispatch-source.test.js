"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const read = file => fs.readFileSync(path.join(root, file), "utf8");

test("content script exposes a one-shot Project Mode task runner", () => {
  const source = read("content.js");
  assert.match(source, /RUN_PROJECT_TASK/);
  assert.match(source, /PROJECT_TASK_RESULT/);
  assert.match(source, /PROJECT_TASK_INTERRUPTED/);
  assert.match(source, /Connection interrupted; retrying task prompt/);
});

test("background requires manual model verification and does not overlap the normal scheduler", () => {
  const source = read("background.js");
  assert.match(source, /Verify the configured ChatGPT model in every worker chat before dispatching/);
  assert.match(source, /Stop the normal AutoPrompter scheduler before dispatching Project Mode workers/);
  assert.match(source, /DISPATCH_PROJECT_ASSIGNMENTS/);
  assert.match(source, /rate_limit.*account_restriction.*safety_restriction/s);
});

test("popup exposes result, review, integration, and explicit dispatch controls", () => {
  const html = read("popup.html");
  const js = read("popup.js");
  for (const id of [
    "projectModelVerified", "dispatchProjectAssignments", "projectResultInput", "submitProjectResult",
    "buildProjectReviewerPrompt", "projectReviewInput", "submitProjectReview",
    "buildProjectIntegratorPrompt", "projectIntegrationInput", "approveProjectIntegration"
  ]) {
    assert.match(html, new RegExp(`id=["']${id}["']`));
    assert.match(js, new RegExp(id));
  }
  assert.match(html, /Model selection is never automated/);
});
