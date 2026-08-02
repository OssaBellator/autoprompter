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

test("planner repair reuses created issues instead of creating duplicates", () => {
  const prompt = Repair.buildRepairPrompt("Issue URL mismatch", 1);
  assert.match(prompt, /Do not create duplicate GitHub issues/);
  assert.match(prompt, /AUTOPROMPTER_ISSUES_BEGIN/);
  assert.match(prompt, /AUTOPROMPTER_ISSUES_END/);
});

test("service worker loads GitHub issue bootstrap before the background API capture", () => {
  const entry = fs.readFileSync(path.join(__dirname, "..", "background-entry.js"), "utf8");
  assert.ok(entry.indexOf('"project-github-bootstrap.js"') < entry.indexOf('"background-project-api.js"'));
  assert.match(entry, /AutoPrompterGitHubIssueWorkflow\.install/);
  assert.match(entry, /AutoPrompterGitHubIssuePersistence\.install/);
  assert.match(entry, /AutoPrompterGitHubIssueDispatch\.install/);
});
