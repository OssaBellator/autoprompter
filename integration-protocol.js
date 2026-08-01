"use strict";

(function attachIntegrationProtocol(root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.AutoPrompterIntegrationProtocol = api;
})(typeof globalThis !== "undefined" ? globalThis : self, () => {
  const INTEGRATION_BEGIN = "AUTOPROMPTER_INTEGRATION_BEGIN";
  const INTEGRATION_END = "AUTOPROMPTER_INTEGRATION_END";
  const INTEGRATION_SCHEMA_VERSION = "1.0";
  const MAX_INTEGRATION_OUTPUT_CHARS = 120000;
  const MAX_INTEGRATOR_PROMPT_CHARS = 24000;
  const ROOT_KEYS = [
    "schemaVersion", "projectId", "planRevision", "status", "summary", "branch", "commit",
    "includedTasks", "tests", "conflicts", "risks", "producedAt"
  ];
  const TEST_KEYS = ["command", "status", "summary"];
  const STATUSES = new Set(["completed", "blocked", "failed"]);
  const TEST_STATUSES = new Set(["passed", "failed", "not_run"]);

  function assert(condition, message) {
    if (!condition) throw new Error(message);
  }
  function assertExactKeys(value, expected, label) {
    assert(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object.`);
    const actual = Object.keys(value).sort();
    const wanted = [...expected].sort();
    assert(actual.length === wanted.length && actual.every((key, index) => key === wanted[index]), `${label} contains missing or unknown fields.`);
  }
  function assertString(value, label, min, max, pattern = null) {
    assert(typeof value === "string", `${label} must be a string.`);
    const trimmed = value.trim();
    assert(trimmed.length >= min && trimmed.length <= max, `${label} must be between ${min} and ${max} characters.`);
    if (pattern) assert(pattern.test(trimmed), `${label} has an invalid format.`);
    return trimmed;
  }
  function assertStringArray(value, label, { min = 0, max = 100, itemMax = 2000, unique = false } = {}) {
    assert(Array.isArray(value), `${label} must be an array.`);
    assert(value.length >= min && value.length <= max, `${label} must contain between ${min} and ${max} items.`);
    const normalized = value.map((item, index) => assertString(item, `${label}[${index}]`, 1, itemMax));
    if (unique) assert(new Set(normalized).size === normalized.length, `${label} must not contain duplicates.`);
    return normalized;
  }
  function countMarker(text, marker) { return text.split(marker).length - 1; }
  function parseIntegrationEnvelope(output) {
    const text = String(output || "").replace(/^\uFEFF/, "");
    assert(text.length > 0, "Integrator output is empty.");
    assert(text.length <= MAX_INTEGRATION_OUTPUT_CHARS, `Integrator output exceeds ${MAX_INTEGRATION_OUTPUT_CHARS} characters.`);
    assert(countMarker(text, INTEGRATION_BEGIN) === 1, `Integrator output must contain exactly one ${INTEGRATION_BEGIN} marker.`);
    assert(countMarker(text, INTEGRATION_END) === 1, `Integrator output must contain exactly one ${INTEGRATION_END} marker.`);
    const start = text.indexOf(INTEGRATION_BEGIN);
    const end = text.indexOf(INTEGRATION_END);
    assert(start < end, "Integrator output markers are out of order.");
    assert(text.slice(0, start).trim() === "" && text.slice(end + INTEGRATION_END.length).trim() === "", "Integrator output must not contain prose outside its envelope.");
    const payload = text.slice(start + INTEGRATION_BEGIN.length, end).trim();
    assert(payload && !/^```/.test(payload) && !/```$/.test(payload), "Integrator JSON must be present without a code fence.");
    try { return JSON.parse(payload); } catch (error) { throw new Error(`Integrator envelope does not contain valid JSON: ${error.message}`); }
  }
  function canonicalIso(value, label) {
    const raw = assertString(value, label, 20, 40);
    const parsed = new Date(raw);
    assert(Number.isFinite(parsed.getTime()), `${label} must be a valid ISO-8601 timestamp.`);
    const canonical = parsed.toISOString();
    assert(raw === canonical || raw === canonical.replace(".000Z", "Z"), `${label} must be canonical ISO-8601.`);
    return raw;
  }

  function buildIntegratorPrompt(project, plan, tasks, results, reviews) {
    const acceptedTasks = Object.values(tasks).filter(task => task.status === "accepted");
    assert(acceptedTasks.length === Object.keys(tasks).length && acceptedTasks.length > 0, "Every task must be accepted before integration.");
    const evidence = acceptedTasks.map(task => {
      const dispatchId = task.acceptedDispatchId;
      return {
        taskId: task.id,
        title: task.title,
        branch: task.acceptedBranch || task.branch,
        commit: task.acceptedCommit,
        workerResult: results[dispatchId],
        review: reviews[dispatchId]
      };
    });
    const prompt = [
      "You are the bounded integrator for an AutoPrompter Project Mode project running through ChatGPT Web.",
      "Inspect the accepted branches and commits. Integrate only reviewed work, resolve straightforward conflicts conservatively, and run project-wide validation.",
      "Do not merge to the default branch, publish a release, delete branches, or change permissions. Produce an integration branch and evidence only.",
      "",
      `Project: ${project.title}`,
      `Project ID: ${project.projectId}`,
      `Repository: ${project.repository.slug}`,
      `Default branch: ${project.repository.defaultBranch}`,
      `Plan revision: ${plan.revision}`,
      `Suggested integration branch: agent/${project.projectId}/integration-r${plan.revision}`,
      "",
      "Accepted task evidence",
      JSON.stringify(evidence, null, 2),
      "",
      "Return exactly one JSON envelope with no prose outside it:",
      INTEGRATION_BEGIN,
      JSON.stringify({
        schemaVersion: INTEGRATION_SCHEMA_VERSION,
        projectId: project.projectId,
        planRevision: plan.revision,
        status: "completed | blocked | failed",
        summary: "concise integration result",
        branch: `agent/${project.projectId}/integration-r${plan.revision}`,
        commit: "commit SHA or null",
        includedTasks: acceptedTasks.map(task => task.id),
        tests: [{ command: "project-wide command", status: "passed | failed | not_run", summary: "evidence" }],
        conflicts: ["unresolved conflict"],
        risks: ["remaining risk"],
        producedAt: "canonical ISO-8601 timestamp"
      }, null, 2),
      INTEGRATION_END
    ].join("\n");
    assert(prompt.length <= MAX_INTEGRATOR_PROMPT_CHARS, `Integrator prompt exceeds ${MAX_INTEGRATOR_PROMPT_CHARS} characters.`);
    return prompt;
  }

  function validateIntegration(input, { project, plan, tasks }) {
    assertExactKeys(input, ROOT_KEYS, "Integration result");
    assert(input.schemaVersion === INTEGRATION_SCHEMA_VERSION, `Integration schemaVersion must be ${INTEGRATION_SCHEMA_VERSION}.`);
    assert(input.projectId === project?.projectId, "Integration result projectId does not match.");
    assert(Number.isInteger(input.planRevision) && input.planRevision === plan?.revision, "Integration result planRevision does not match.");
    assert(STATUSES.has(input.status), "Integration result status is unsupported.");
    const summary = assertString(input.summary, "Integration summary", 1, 12000);
    const branch = assertString(input.branch, "Integration branch", 1, 240, /^agent\/[a-z0-9._/-]+$/);
    let commit = input.commit;
    assert(commit === null || typeof commit === "string", "Integration commit must be a SHA or null.");
    if (typeof commit === "string") {
      commit = commit.trim();
      assert(/^[0-9a-f]{7,64}$/i.test(commit), "Integration commit has an invalid format.");
    }
    if (input.status === "completed") assert(Boolean(commit), "Completed integration must include a commit SHA.");
    const expectedTaskIds = Object.values(tasks).filter(task => task.status === "accepted").map(task => task.id).sort();
    const includedTasks = assertStringArray(input.includedTasks, "Integration includedTasks", { min: input.status === "completed" ? expectedTaskIds.length : 0, max: 100, itemMax: 200, unique: true }).sort();
    if (input.status === "completed") assert(JSON.stringify(includedTasks) === JSON.stringify(expectedTaskIds), "Completed integration must include every accepted task exactly once.");
    assert(Array.isArray(input.tests) && input.tests.length <= 30, "Integration tests contains too many entries.");
    const tests = input.tests.map((entry, index) => {
      assertExactKeys(entry, TEST_KEYS, `Integration test ${index + 1}`);
      assert(TEST_STATUSES.has(entry.status), `Integration test ${index + 1} has an unsupported status.`);
      return {
        command: assertString(entry.command, `Integration test ${index + 1} command`, 1, 1000),
        status: entry.status,
        summary: assertString(entry.summary, `Integration test ${index + 1} summary`, 0, 4000)
      };
    });
    if (input.status === "completed") assert(tests.length > 0 && tests.every(test => test.status === "passed"), "Completed integration must include passing project-wide test evidence.");
    const conflicts = assertStringArray(input.conflicts, "Integration conflicts", { max: 50, itemMax: 2000 });
    if (input.status === "completed") assert(conflicts.length === 0, "Completed integration cannot contain unresolved conflicts.");
    const risks = assertStringArray(input.risks, "Integration risks", { max: 50, itemMax: 2000 });
    return {
      schemaVersion: INTEGRATION_SCHEMA_VERSION,
      projectId: project.projectId,
      planRevision: plan.revision,
      status: input.status,
      summary,
      branch,
      commit,
      includedTasks,
      tests,
      conflicts,
      risks,
      producedAt: canonicalIso(input.producedAt, "Integration producedAt")
    };
  }

  function parseAndValidateIntegration(output, context) {
    return validateIntegration(parseIntegrationEnvelope(output), context);
  }

  return {
    INTEGRATION_BEGIN,
    INTEGRATION_END,
    INTEGRATION_SCHEMA_VERSION,
    MAX_INTEGRATION_OUTPUT_CHARS,
    MAX_INTEGRATOR_PROMPT_CHARS,
    parseIntegrationEnvelope,
    buildIntegratorPrompt,
    validateIntegration,
    parseAndValidateIntegration
  };
});
