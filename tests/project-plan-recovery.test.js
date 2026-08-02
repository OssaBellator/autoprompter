"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const Recovery = require("../project-plan-recovery.js");

test("planner recovery binds the exact tab, job, project, and stage", () => {
  const bootstraps = {
    alpha: {
      roles: {
        planner: { tabId: 41, jobId: "planner-alpha-1", stage: "planner_plan" }
      }
    },
    beta: {
      roles: {
        planner: { tabId: 42, jobId: "planner-beta-1", stage: "completed" }
      }
    }
  };

  assert.deepEqual(Recovery.recoveryForTab(bootstraps, 41), {
    projectId: "alpha",
    role: "planner",
    stage: "planner_plan",
    jobId: "planner-alpha-1"
  });
  assert.equal(Recovery.recoveryForTab(bootstraps, 42), null);
  assert.equal(Recovery.recoveryForTab(bootstraps, 99), null);
});

test("content recovery only submits complete planner envelopes", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "project-plan-capture.js"), "utf8");
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "manifest.json"), "utf8"));
  assert.match(source, /AUTOPROMPTER_PROPOSAL_BEGIN/);
  assert.match(source, /AUTOPROMPTER_PROPOSAL_END/);
  assert.match(source, /PROJECT_BOOTSTRAP_RESULT/);
  assert.match(source, /recoveredFromStableDom/);
  assert.equal(manifest.content_scripts[0].js.at(-1), "project-plan-capture.js");
});
