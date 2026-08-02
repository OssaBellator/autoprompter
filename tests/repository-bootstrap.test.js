"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const ProjectStore = require("../project-store.js");
const PlannerCompiler = require("../planner-compiler.js");
const RepositoryBootstrap = require("../repository-bootstrap.js");

const clock = () => Date.parse("2026-08-02T03:00:00.000Z");

function fixture() {
  const created = ProjectStore.createProject(ProjectStore.emptyStore(), {
    projectId: "repository-bootstrap",
    title: "Repository bootstrap",
    goal: "Create durable project coordination manifests.",
    repository: "OssaBellator/autoprompter",
    plannerChatId: "planner-private-chat",
    reviewerChatId: "reviewer-private-chat",
    integratorChatId: "integrator-private-chat",
    workerChatIds: ["worker-private-chat"]
  }, clock);
  const project = created.project;
  const plan = PlannerCompiler.canonicalPlanFromProposal({
    summary: "Create and validate durable coordination state.",
    tasks: [{
      key: "bootstrap-state",
      title: "Bootstrap repository state",
      description: "Create the public project and plan manifests.",
      allowedPaths: [".autoprompter/**"],
      acceptance: ["The manifests are reviewable and contain no chat identifiers."],
      checks: []
    }]
  }, project, 1, clock).plan;
  return { project, plan };
}

test("repository bootstrap produces durable manifests without conversation identifiers", () => {
  const { project, plan } = fixture();
  const bundle = RepositoryBootstrap.buildRepositoryBootstrapBundle(project, plan);
  const byPath = new Map(bundle.files.map(file => [file.path, file.content]));
  const publicProject = JSON.parse(byPath.get(".autoprompter/project.json"));

  assert.equal(bundle.applicationMode, "proposal_only");
  assert.equal(bundle.approval.action, "modify_workflow");
  assert.equal(bundle.approval.target, RepositoryBootstrap.WORKFLOW_PATH);
  assert.ok(byPath.has(".autoprompter/plan.json"));
  assert.ok(byPath.has(".autoprompter/AGENT_INSTRUCTIONS.md"));
  assert.equal(publicProject.projectId, project.projectId);
  assert.equal(JSON.stringify(publicProject).includes("private-chat"), false);
  assert.equal(Object.hasOwn(publicProject, "roles"), false);
});

test("generated GitHub workflow is read-only and avoids privileged pull-request execution", () => {
  const workflow = RepositoryBootstrap.workflowSource();

  assert.match(workflow, /pull_request:/);
  assert.match(workflow, /contents: read/);
  assert.match(workflow, /\.autoprompter\/plan\.json/);
  assert.doesNotMatch(workflow, /pull_request_target/);
  assert.doesNotMatch(workflow, /contents: write/);
  assert.doesNotMatch(workflow, /secrets\./);
});

test("repository bootstrap refuses a plan for a different project", () => {
  const { project, plan } = fixture();
  assert.throws(
    () => RepositoryBootstrap.buildRepositoryBootstrapBundle(project, { ...plan, projectId: "other-project" }),
    /identities must match/
  );
});
