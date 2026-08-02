"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const Bootstrap = require("../project-github-bootstrap.js");
const Repair = require("../project-github-repair.js");

test("GitHub Issue Mode bootstraps only planner and combined reviewer merger roles", () => {
  assert.deepEqual(Bootstrap.ROLE_KEYS, {
    planner: "plannerChatId",
    reviewer: "reviewerChatId"
  });
  const project = {
    projectId: "issue-project",
    title: "Issue project",
    repository: { slug: "OssaBellator/autoprompter" }
  };
  const planner = Bootstrap.rolePrompt(project, "planner");
  const reviewer = Bootstrap.rolePrompt(project, "reviewer");
  assert.match(planner, /create the actual scoped GitHub issues/i);
  assert.match(reviewer, /combined pull-request reviewer and merger/i);
  assert.match(reviewer, /Merge only when ready/i);
  assert.doesNotMatch(JSON.stringify(Bootstrap.ROLE_KEYS), /integrator/);
});

test("completed roles are reused while failed role initialization is retried", () => {
  assert.equal(Bootstrap.roleWasInitialized({ roles: { reviewer: { stage: "completed" } } }, "reviewer"), true);
  assert.equal(Bootstrap.roleWasInitialized({ roles: { reviewer: { stage: "failed" } } }, "reviewer"), false);
  assert.equal(Bootstrap.roleWasInitialized({
    repairAttempts: 1,
    roles: { planner: { stage: "failed" } }
  }, "planner"), true);
});

test("planner recovery inventories existing issues without assigning the role again", () => {
  const project = {
    projectId: "issue-project",
    title: "Issue project",
    goal: "Ship the project",
    repository: { slug: "OssaBellator/autoprompter", defaultBranch: "main" }
  };
  const prompt = Bootstrap.recoveryPlannerPrompt(project, "Create one issue for every independently executable unit of work.");
  assert.match(prompt, /Do not initialize or acknowledge the planner role again/i);
  assert.match(prompt, /Do not create duplicate issues/i);
  assert.match(prompt, /exact existing issue numbers and URLs/i);
});

test("planner repair reuses created issues instead of creating duplicates", () => {
  const prompt = Repair.buildRepairPrompt("Issue URL mismatch", 1);
  assert.match(prompt, /Do not create duplicate GitHub issues/);
  assert.match(prompt, /AUTOPROMPTER_ISSUES_BEGIN/);
  assert.match(prompt, /AUTOPROMPTER_ISSUES_END/);
});

test("service worker loads issue recovery after workflow installation and before controllers", () => {
  const entry = fs.readFileSync(path.join(__dirname, "..", "background-entry.js"), "utf8");
  assert.ok(entry.indexOf('"project-github-bootstrap.js"') < entry.indexOf('"background-project-api.js"'));
  assert.match(entry, /AutoPrompterGitHubIssueWorkflow\.install/);
  assert.match(entry, /AutoPrompterGitHubIssuePersistence\.install/);
  assert.match(entry, /AutoPrompterGitHubIssueEnvelopeRecovery\.install/);
  assert.match(entry, /AutoPrompterGitHubIssueResume\.install/);
  assert.match(entry, /AutoPrompterGitHubIssueDispatch\.install/);
  assert.ok(entry.indexOf("AutoPrompterGitHubIssueWorkflow.install") < entry.indexOf("AutoPrompterGitHubIssueEnvelopeRecovery.install"));
});
