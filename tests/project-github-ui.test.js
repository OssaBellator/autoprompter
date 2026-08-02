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

test("popup adapter uses bounded startup retries instead of a self-triggering mutation observer", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "project-github-ui.js"), "utf8");
  assert.doesNotMatch(source, /new MutationObserver/);
  assert.equal(GitHubUi.MAX_APPLY_ATTEMPTS, 20);
  assert.equal(GitHubUi.APPLY_RETRY_MS, 50);
  assert.match(source, /attempts < MAX_APPLY_ATTEMPTS/);
});
