"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const RepositoryBootstrap = require("../repository-bootstrap.js");
const Scope = require("../repository-bootstrap-scope.js");

test("repository bootstrap approval target names every file in the bundle", () => {
  assert.equal(Scope.BUNDLE_PATHS.length, 5);
  for (const path of Scope.BUNDLE_PATHS) assert.match(Scope.BUNDLE_TARGET, new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal(RepositoryBootstrap.WORKFLOW_PATH, Scope.BUNDLE_TARGET);
});

test("scope patch changes action identity without changing generated repository file paths", () => {
  const project = {
    projectId: "scope-project",
    title: "Scope project",
    goal: "Validate the bootstrap scope.",
    repository: { slug: "OssaBellator/autoprompter", defaultBranch: "main", handoffFile: "AUTOPROMPTER_HANDOFF.md" },
    scheduler: { maxConcurrentWorkers: 1, revisionLimit: 1, approvalActions: ["modify_workflow"] },
    modelPolicy: null,
    createdAt: "2026-08-02T03:00:00.000Z",
    updatedAt: "2026-08-02T03:00:00.000Z"
  };
  const plan = {
    projectId: project.projectId,
    revision: 1,
    tasks: [{ id: "task-one" }]
  };
  const bundle = RepositoryBootstrap.buildRepositoryBootstrapBundle(project, plan);
  assert.deepEqual(bundle.files.map(file => file.path), Scope.BUNDLE_PATHS);
  assert.equal(bundle.approval.target, ".github/workflows/autoprompter-plan-validation.yml");
});
