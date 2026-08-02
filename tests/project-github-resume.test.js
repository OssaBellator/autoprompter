"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const Resume = require("../project-github-resume.js");

function store(overrides = {}) {
  return {
    projects: { alpha: { projectId: "alpha" } },
    pendingPlansByProject: {},
    approvedPlansByProject: {},
    tasksByProject: { alpha: {} },
    ...overrides
  };
}

test("failed and cancelled GitHub bootstraps are explicitly resumable", () => {
  assert.equal(Resume.bootstrapCanResume({ status: "failed" }), true);
  assert.equal(Resume.bootstrapCanResume({ status: "cancelled" }), true);
  assert.equal(Resume.bootstrapCanResume({ status: "running" }), false);
  assert.equal(Resume.bootstrapCanResume({ status: "completed" }), false);
});

test("resume derives the durable GitHub workflow stage from stored records", () => {
  assert.equal(Resume.resumedStatus(store(), "alpha"), "draft");
  assert.equal(Resume.resumedStatus(store({ pendingPlansByProject: { alpha: { revision: 1 } } }), "alpha"), "planning");
  assert.equal(Resume.resumedStatus(store({
    approvedPlansByProject: { alpha: { revision: 1 } },
    tasksByProject: { alpha: { one: { status: "ready" } } }
  }), "alpha"), "running");
  assert.equal(Resume.resumedStatus(store({
    approvedPlansByProject: { alpha: { revision: 1 } },
    tasksByProject: { alpha: { one: { status: "accepted" }, two: { status: "accepted" } } }
  }), "alpha"), "completed");
});

test("service worker exposes a dedicated stage-resume listener before task-board controllers run", () => {
  const root = path.join(__dirname, "..");
  const entry = fs.readFileSync(path.join(root, "background-entry.js"), "utf8");
  const source = fs.readFileSync(path.join(root, "project-github-resume.js"), "utf8");
  assert.match(entry, /project-github-resume\.js/);
  assert.match(entry, /AutoPrompterGitHubIssueResume\.install\(\)/);
  assert.ok(entry.indexOf("AutoPrompterGitHubIssueResume.install()") < entry.indexOf("AutoPrompterProjectTaskBoardController.start()"));
  assert.equal(Resume.RESUME_SCOPE, "AUTOPROMPTER_GITHUB_RESUME");
  assert.equal(Resume.RESUME_TYPE, "RESUME_PROJECT_STAGE");
  assert.match(source, /startResumeListener/);
  assert.match(source, /message\?\.scope !== RESUME_SCOPE/);
  assert.match(source, /transitionGitHubProjectState/);
  assert.match(source, /startProjectBootstrap/);
  assert.match(source, /AutoPrompterProjectTaskBoardController\.reconcile/);
});
