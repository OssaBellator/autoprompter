"use strict";

(function attachRepositoryBootstrap(root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.AutoPrompterRepositoryBootstrap = api;
})(typeof globalThis !== "undefined" ? globalThis : self, () => {
  const BUNDLE_SCHEMA_VERSION = "1.0";
  const WORKFLOW_PATH = ".github/workflows/autoprompter-plan-validation.yml";

  function clone(value) {
    return value == null ? value : structuredClone(value);
  }

  function assert(condition, message) {
    if (!condition) throw new Error(message);
  }

  function stableJson(value) {
    return `${JSON.stringify(value, null, 2)}\n`;
  }

  function publicProject(project) {
    assert(project?.projectId && project?.repository?.slug, "A valid Project Mode project is required.");
    return {
      schemaVersion: BUNDLE_SCHEMA_VERSION,
      projectId: project.projectId,
      title: project.title,
      goal: project.goal,
      repository: clone(project.repository),
      scheduler: {
        maxConcurrentWorkers: project.scheduler?.maxConcurrentWorkers,
        revisionLimit: project.scheduler?.revisionLimit,
        approvalActions: clone(project.scheduler?.approvalActions || [])
      },
      modelPolicy: clone(project.modelPolicy || null),
      createdAt: project.createdAt,
      updatedAt: project.updatedAt
    };
  }

  function workflowSource() {
    return [
      "name: AutoPrompter plan validation",
      "",
      "on:",
      "  pull_request:",
      "    paths:",
      '      - ".autoprompter/**"',
      '      - ".github/workflows/autoprompter-plan-validation.yml"',
      "  workflow_dispatch:",
      "",
      "permissions:",
      "  contents: read",
      "",
      "jobs:",
      "  validate-plan:",
      "    runs-on: ubuntu-latest",
      "    steps:",
      "      - uses: actions/checkout@v4",
      "      - uses: actions/setup-node@v4",
      "        with:",
      "          node-version: 20",
      "      - name: Validate AutoPrompter manifests",
      "        shell: bash",
      "        run: |",
      "          node <<'NODE'",
      '          const fs = require("node:fs");',
      '          const plan = JSON.parse(fs.readFileSync(".autoprompter/plan.json", "utf8"));',
      '          const project = JSON.parse(fs.readFileSync(".autoprompter/project.json", "utf8"));',
      "          const fail = message => { throw new Error(message); };",
      '          if (!project.projectId || plan.projectId !== project.projectId) fail("Project identity mismatch.");',
      '          if (!Number.isInteger(plan.revision) || plan.revision < 1) fail("Plan revision is invalid.");',
      '          if (!Array.isArray(plan.tasks) || !plan.tasks.length) fail("Plan must contain tasks.");',
      "          const byId = new Map();",
      "          for (const task of plan.tasks) {",
      '            if (!/^task-[a-z0-9._-]+$/.test(task.id || "")) fail("Invalid task ID: " + task.id);',
      '            if (byId.has(task.id)) fail("Duplicate task ID: " + task.id);',
      '            if (!Array.isArray(task.allowedPaths) || !task.allowedPaths.length) fail(task.id + " has no allowed paths.");',
      "            for (const path of task.allowedPaths) {",
      '              if (!path || path.startsWith("/") || path.split(/[\\/]+/).includes("..")) fail(task.id + " has an unsafe path.");',
      "            }",
      "            for (const command of task.verificationCommands || []) {",
      '              if (/(?:^|\\s)(?:sudo\\s+|rm\\s+-rf\\b|git\\s+reset\\s+--hard\\b|git\\s+push\\s+--force\\b)/i.test(command)) fail(task.id + " has an unsafe command.");',
      "            }",
      "            byId.set(task.id, task);",
      "          }",
      "          for (const task of plan.tasks) {",
      '            for (const dependency of task.dependencies || []) if (!byId.has(dependency)) fail(task.id + " has unknown dependency " + dependency + ".");',
      "          }",
      "          const visiting = new Set();",
      "          const visited = new Set();",
      "          function visit(id) {",
      "            if (visited.has(id)) return;",
      '            if (visiting.has(id)) fail("Dependency cycle at " + id + ".");',
      "            visiting.add(id);",
      "            for (const dependency of byId.get(id).dependencies || []) visit(dependency);",
      "            visiting.delete(id);",
      "            visited.add(id);",
      "          }",
      "          for (const id of byId.keys()) visit(id);",
      '          console.log("Validated " + plan.tasks.length + " AutoPrompter tasks for " + project.projectId + ".");',
      "          NODE",
      ""
    ].join("\n");
  }

  function readmeSource(project) {
    return `# AutoPrompter project state

This directory contains durable, reviewable coordination state for **${project.title}**.

- \`project.json\` records public project configuration without ChatGPT conversation IDs.
- \`plan.json\` is the canonical validated task graph compiled by AutoPrompter.
- Task branches and pull requests remain the source of truth for implementation evidence.
- Worker claims are not accepted without repository and CI evidence.
- Workflow changes, default-branch merges, releases, permission changes, and external side effects require explicit approval.

The generated workflow uses read-only repository permissions and validates only these manifests. It intentionally does not use \`pull_request_target\`, secrets, or write permissions.
`;
  }

  function agentInstructions(project) {
    return `# AutoPrompter agent instructions

Repository: ${project.repository.slug}
Default branch: ${project.repository.defaultBranch}

1. Read \`.autoprompter/project.json\` and \`.autoprompter/plan.json\` before acting.
2. Work only on the assigned task, branch, and allowlisted paths.
3. Use a connected repository app, MCP tool, or Codex only when the user has granted the necessary repository permissions.
4. Never modify workflows, permissions, secrets, releases, or the default branch without an explicit approval record.
5. Commit reviewable work and report the actual branch, commit, changed paths, and test evidence.
6. Treat repository state and CI checks as authoritative; do not invent missing evidence.
`;
  }

  function buildRepositoryBootstrapBundle(project, plan) {
    assert(plan?.projectId === project?.projectId, "Plan and project identities must match.");
    assert(Array.isArray(plan.tasks) && plan.tasks.length > 0, "A validated plan is required.");
    const files = [
      { path: ".autoprompter/project.json", content: stableJson(publicProject(project)) },
      { path: ".autoprompter/plan.json", content: stableJson(plan) },
      { path: ".autoprompter/README.md", content: readmeSource(project) },
      { path: ".autoprompter/AGENT_INSTRUCTIONS.md", content: agentInstructions(project) },
      { path: WORKFLOW_PATH, content: workflowSource() }
    ];
    return {
      schemaVersion: BUNDLE_SCHEMA_VERSION,
      projectId: project.projectId,
      repository: project.repository.slug,
      defaultBranch: project.repository.defaultBranch,
      files,
      approval: {
        action: "modify_workflow",
        target: WORKFLOW_PATH,
        justification: "Install a read-only validation workflow for the canonical AutoPrompter project and plan manifests."
      },
      applicationMode: "proposal_only"
    };
  }

  return {
    BUNDLE_SCHEMA_VERSION,
    WORKFLOW_PATH,
    publicProject,
    workflowSource,
    buildRepositoryBootstrapBundle
  };
});
