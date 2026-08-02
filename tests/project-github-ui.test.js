"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const GitHubUi = require("../project-github-ui.js");

function trackedProperty(initialValue) {
  let value = initialValue;
  let writes = 0;
  return {
    node: {
      get textContent() { return value; },
      set textContent(next) { writes += 1; value = next; }
    },
    writes: () => writes,
    value: () => value
  };
}

class FakeButton {
  constructor() {
    this._disabled = true;
    this.textContent = "Resume";
    this.title = "";
    this.listeners = {};
  }

  get disabled() { return this._disabled; }
  set disabled(value) { this._disabled = Boolean(value); }
  addEventListener(type, listener) { this.listeners[type] = listener; }
  setAttribute() {}
  removeAttribute() {}
}

test("GitHub project UI text writes are idempotent", () => {
  const tracked = trackedProperty("GitHub Issue and Pull Request Mode");
  assert.equal(GitHubUi.setText(tracked.node, "GitHub Issue and Pull Request Mode"), false);
  assert.equal(tracked.writes(), 0);

  assert.equal(GitHubUi.setText(tracked.node, "Updated"), true);
  assert.equal(tracked.writes(), 1);
  assert.equal(tracked.value(), "Updated");
});

test("GitHub project UI hidden-state writes are idempotent", () => {
  let hidden = true;
  let writes = 0;
  const node = {
    get hidden() { return hidden; },
    set hidden(next) { writes += 1; hidden = next; }
  };

  assert.equal(GitHubUi.setHidden(node, true), false);
  assert.equal(writes, 0);
  assert.equal(GitHubUi.setHidden(node, false), true);
  assert.equal(writes, 1);
  assert.equal(hidden, false);
});

test("failed GitHub bootstrap keeps Resume stage enabled when the popup renderer disables it", () => {
  const button = new FakeButton();
  const nodes = {
    resumeProject: button,
    projectSelect: { value: "alpha" },
    projectMessage: { textContent: "" },
    projectStatusBadge: { textContent: "draft" },
    projectInspectOutput: {
      textContent: JSON.stringify({ autonomousBootstrap: { status: "failed" } })
    }
  };
  const documentApi = { getElementById: id => nodes[id] || null };

  assert.equal(GitHubUi.applyResumeControl(documentApi), true);
  assert.equal(button.disabled, false);
  assert.equal(button.textContent, "Resume stage");
  assert.match(button.title, /issue, task-creation, or worker stage/i);

  // This is the conflicting assignment made by popup.js once per second.
  button.disabled = true;
  assert.equal(button.disabled, false);
});

test("Resume stage uses a dedicated command and scoped observer instead of a polling fight", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "project-github-ui.js"), "utf8");
  assert.equal(GitHubUi.MAX_APPLY_ATTEMPTS, 20);
  assert.equal(GitHubUi.APPLY_RETRY_MS, 50);
  assert.equal(GitHubUi.RESUME_SCOPE, "AUTOPROMPTER_GITHUB_RESUME");
  assert.equal(GitHubUi.RESUME_TYPE, "RESUME_PROJECT_STAGE");
  assert.match(source, /new Observer\(\(\) => applyResumeControl/);
  assert.match(source, /projectStatusBadge/);
  assert.match(source, /projectInspectOutput/);
  assert.doesNotMatch(source, /setInterval\(\(\) => applyResumeControl/);
  assert.match(source, /stopImmediatePropagation/);
  assert.match(source, /AUTOPROMPTER_GITHUB_RESUME/);
  assert.match(source, /attempts < MAX_APPLY_ATTEMPTS/);
});
