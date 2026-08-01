"use strict";

(function attachReconciliationProtocol(root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.AutoPrompterReconciliationProtocol = api;
})(typeof globalThis !== "undefined" ? globalThis : self, () => {
  const RECONCILIATION_BEGIN = "AUTOPROMPTER_RECONCILIATION_BEGIN";
  const RECONCILIATION_END = "AUTOPROMPTER_RECONCILIATION_END";
  const RECONCILIATION_SCHEMA_VERSION = "1.0";
  const MAX_OUTPUT_CHARS = 120000;
  const ROOT_KEYS = [
    "schemaVersion", "projectId", "repository", "defaultBranch", "handoffFile", "planRevision",
    "observedAt", "defaultBranchCommit", "branches", "taskArtifacts", "integration", "notes"
  ];
  const BRANCH_KEYS = ["name", "commit"];
  const TASK_KEYS = ["taskId", "branch", "commit", "status"];
  const INTEGRATION_KEYS = ["branch", "commit", "status"];
  const TASK_STATUSES = new Set(["observed", "missing", "conflict"]);
  const INTEGRATION_STATUSES = new Set(["observed", "missing", "conflict"]);

  function assert(condition, message) { if (!condition) throw new Error(message); }
  function exactKeys(value, expected, label) {
    assert(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object.`);
    const actual = Object.keys(value).sort();
    const wanted = [...expected].sort();
    assert(actual.length === wanted.length && actual.every((key, index) => key === wanted[index]), `${label} contains missing or unknown fields.`);
  }
  function text(value, label, min, max, pattern = null) {
    assert(typeof value === "string", `${label} must be a string.`);
    const normalized = value.trim();
    assert(normalized.length >= min && normalized.length <= max, `${label} must be between ${min} and ${max} characters.`);
    if (pattern) assert(pattern.test(normalized), `${label} has an invalid format.`);
    return normalized;
  }
  function sha(value, label, nullable = false) {
    if (nullable && value === null) return null;
    return text(value, label, 7, 64, /^[0-9a-f]{7,64}$/i);
  }
  function iso(value, label) {
    const raw = text(value, label, 20, 40);
    const parsed = new Date(raw);
    assert(Number.isFinite(parsed.getTime()), `${label} must be a valid ISO timestamp.`);
    const canonical = parsed.toISOString();
    assert(raw === canonical || raw === canonical.replace(".000Z", "Z"), `${label} must be canonical ISO-8601.`);
    return raw;
  }
  function countMarker(value, marker) { return value.split(marker).length - 1; }
  function parseReconciliationEnvelope(output) {
    const value = String(output || "").replace(/^\uFEFF/, "");
    assert(value.length > 0 && value.length <= MAX_OUTPUT_CHARS, "Reconciliation output is empty or too large.");
    assert(countMarker(value, RECONCILIATION_BEGIN) === 1 && countMarker(value, RECONCILIATION_END) === 1, "Reconciliation output must contain one marker pair.");
    const start = value.indexOf(RECONCILIATION_BEGIN);
    const end = value.indexOf(RECONCILIATION_END);
    assert(start < end && !value.slice(0, start).trim() && !value.slice(end + RECONCILIATION_END.length).trim(), "Reconciliation output must contain no surrounding prose.");
    const payload = value.slice(start + RECONCILIATION_BEGIN.length, end).trim();
    assert(payload && !/^```/.test(payload) && !/```$/.test(payload), "Reconciliation JSON must not use a code fence.");
    try { return JSON.parse(payload); } catch (error) { throw new Error(`Reconciliation envelope does not contain valid JSON: ${error.message}`); }
  }
  function validateReconciliation(input, { project, plan, tasks }) {
    exactKeys(input, ROOT_KEYS, "Reconciliation snapshot");
    assert(input.schemaVersion === RECONCILIATION_SCHEMA_VERSION, `Reconciliation schemaVersion must be ${RECONCILIATION_SCHEMA_VERSION}.`);
    assert(input.projectId === project.projectId, "Reconciliation projectId does not match.");
    assert(input.repository === project.repository.slug, "Reconciliation repository does not match.");
    assert(input.defaultBranch === project.repository.defaultBranch, "Reconciliation default branch does not match.");
    assert(input.handoffFile === project.repository.handoffFile, "Reconciliation handoff file does not match.");
    assert(Number.isInteger(input.planRevision) && input.planRevision === plan.revision, "Reconciliation plan revision does not match.");
    const knownTasks = new Set(Object.keys(tasks));
    assert(Array.isArray(input.branches) && input.branches.length <= 200, "Reconciliation branches is invalid.");
    const branches = input.branches.map((entry, index) => {
      exactKeys(entry, BRANCH_KEYS, `Branch ${index + 1}`);
      return { name: text(entry.name, `Branch ${index + 1} name`, 1, 240), commit: sha(entry.commit, `Branch ${index + 1} commit`) };
    });
    assert(new Set(branches.map(entry => entry.name)).size === branches.length, "Reconciliation branch names must be unique.");
    assert(Array.isArray(input.taskArtifacts) && input.taskArtifacts.length <= knownTasks.size, "Reconciliation taskArtifacts is invalid.");
    const taskArtifacts = input.taskArtifacts.map((entry, index) => {
      exactKeys(entry, TASK_KEYS, `Task artifact ${index + 1}`);
      assert(knownTasks.has(entry.taskId), `Reconciliation references unknown task ${entry.taskId}.`);
      assert(TASK_STATUSES.has(entry.status), `${entry.taskId} has an unsupported reconciliation status.`);
      const commit = sha(entry.commit, `${entry.taskId} commit`, true);
      if (entry.status === "observed") assert(commit, `${entry.taskId} observed artifact requires a commit.`);
      return { taskId: entry.taskId, branch: text(entry.branch, `${entry.taskId} branch`, 1, 240), commit, status: entry.status };
    });
    assert(new Set(taskArtifacts.map(entry => entry.taskId)).size === taskArtifacts.length, "Reconciliation task artifacts must be unique.");
    let integration = null;
    if (input.integration !== null) {
      exactKeys(input.integration, INTEGRATION_KEYS, "Reconciliation integration");
      assert(INTEGRATION_STATUSES.has(input.integration.status), "Reconciliation integration status is unsupported.");
      integration = {
        branch: text(input.integration.branch, "Reconciliation integration branch", 1, 240),
        commit: sha(input.integration.commit, "Reconciliation integration commit", true),
        status: input.integration.status
      };
      if (integration.status === "observed") assert(integration.commit, "Observed integration requires a commit.");
    }
    assert(Array.isArray(input.notes) && input.notes.length <= 50, "Reconciliation notes is invalid.");
    const notes = input.notes.map((entry, index) => text(entry, `Reconciliation note ${index + 1}`, 1, 2000));
    return {
      schemaVersion: RECONCILIATION_SCHEMA_VERSION,
      projectId: project.projectId,
      repository: project.repository.slug,
      defaultBranch: project.repository.defaultBranch,
      handoffFile: project.repository.handoffFile,
      planRevision: plan.revision,
      observedAt: iso(input.observedAt, "Reconciliation observedAt"),
      defaultBranchCommit: sha(input.defaultBranchCommit, "Reconciliation defaultBranchCommit"),
      branches,
      taskArtifacts,
      integration,
      notes,
      conflictCount: taskArtifacts.filter(entry => entry.status === "conflict").length + (integration?.status === "conflict" ? 1 : 0),
      missingCount: taskArtifacts.filter(entry => entry.status === "missing").length + (integration?.status === "missing" ? 1 : 0)
    };
  }
  function buildReconciliationPrompt(project, plan, tasks, integrationRecord) {
    const expected = Object.values(tasks).map(task => ({
      taskId: task.id,
      expectedBranch: task.acceptedBranch || task.branch,
      expectedCommit: task.acceptedCommit || task.resultCommit,
      localStatus: task.status
    }));
    return [
      "Inspect the repository for an AutoPrompter Project Mode restart reconciliation.",
      "Do not change files, merge branches, publish, delete, or alter permissions. Report only repository evidence.",
      `Project ID: ${project.projectId}`,
      `Repository: ${project.repository.slug}`,
      `Default branch: ${project.repository.defaultBranch}`,
      `Handoff file: ${project.repository.handoffFile}`,
      `Plan revision: ${plan.revision}`,
      "Expected local task records:",
      JSON.stringify(expected, null, 2),
      "Expected integration record:",
      JSON.stringify(integrationRecord || null, null, 2),
      `Return exactly one ${RECONCILIATION_BEGIN} / ${RECONCILIATION_END} JSON envelope with no surrounding prose.`,
      RECONCILIATION_BEGIN,
      JSON.stringify({
        schemaVersion: RECONCILIATION_SCHEMA_VERSION,
        projectId: project.projectId,
        repository: project.repository.slug,
        defaultBranch: project.repository.defaultBranch,
        handoffFile: project.repository.handoffFile,
        planRevision: plan.revision,
        observedAt: new Date().toISOString(),
        defaultBranchCommit: "commit SHA",
        branches: [{ name: "branch", commit: "commit SHA" }],
        taskArtifacts: [{ taskId: "task-id", branch: "branch", commit: "commit SHA or null", status: "observed | missing | conflict" }],
        integration: null,
        notes: []
      }, null, 2),
      RECONCILIATION_END
    ].join("\n");
  }

  return {
    RECONCILIATION_BEGIN,
    RECONCILIATION_END,
    RECONCILIATION_SCHEMA_VERSION,
    parseReconciliationEnvelope,
    validateReconciliation,
    buildReconciliationPrompt
  };
});
