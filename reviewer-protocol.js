"use strict";

(function attachReviewerProtocol(root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.AutoPrompterReviewerProtocol = api;
})(typeof globalThis !== "undefined" ? globalThis : self, () => {
  const REVIEW_BEGIN = "AUTOPROMPTER_REVIEW_BEGIN";
  const REVIEW_END = "AUTOPROMPTER_REVIEW_END";
  const REVIEW_SCHEMA_VERSION = "1.0";
  const MAX_REVIEW_OUTPUT_CHARS = 120000;
  const MAX_REVIEW_PROMPT_CHARS = 22000;
  const ROOT_KEYS = [
    "schemaVersion", "projectId", "taskId", "dispatchId", "attempt", "resultDigest", "decision",
    "summary", "acceptanceCriteria", "verificationChecks", "requiredChanges", "risks", "reviewedAt"
  ];
  const CRITERION_KEYS = ["criterion", "status", "evidence"];
  const CHECK_KEYS = ["command", "status", "evidence"];
  const DECISIONS = new Set(["accepted", "revision_required", "rejected"]);
  const CRITERION_STATUSES = new Set(["met", "not_met", "unclear"]);
  const CHECK_STATUSES = new Set(["verified", "failed", "not_verified"]);

  function assert(condition, message) {
    if (!condition) throw new Error(message);
  }

  function assertExactKeys(value, expected, label) {
    assert(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object.`);
    const actual = Object.keys(value).sort();
    const wanted = [...expected].sort();
    assert(actual.length === wanted.length && actual.every((key, index) => key === wanted[index]), `${label} contains missing or unknown fields.`);
  }

  function assertString(value, label, min, max) {
    assert(typeof value === "string", `${label} must be a string.`);
    const trimmed = value.trim();
    assert(trimmed.length >= min && trimmed.length <= max, `${label} must be between ${min} and ${max} characters.`);
    return trimmed;
  }

  function assertStringArray(value, label, { min = 0, max = 50, itemMax = 2000 } = {}) {
    assert(Array.isArray(value), `${label} must be an array.`);
    assert(value.length >= min && value.length <= max, `${label} must contain between ${min} and ${max} items.`);
    return value.map((item, index) => assertString(item, `${label}[${index}]`, 1, itemMax));
  }

  function countMarker(text, marker) {
    return text.split(marker).length - 1;
  }

  function parseReviewEnvelope(output) {
    const text = String(output || "").replace(/^\uFEFF/, "");
    assert(text.length > 0, "Reviewer output is empty.");
    assert(text.length <= MAX_REVIEW_OUTPUT_CHARS, `Reviewer output exceeds ${MAX_REVIEW_OUTPUT_CHARS} characters.`);
    assert(countMarker(text, REVIEW_BEGIN) === 1, `Reviewer output must contain exactly one ${REVIEW_BEGIN} marker.`);
    assert(countMarker(text, REVIEW_END) === 1, `Reviewer output must contain exactly one ${REVIEW_END} marker.`);
    const start = text.indexOf(REVIEW_BEGIN);
    const end = text.indexOf(REVIEW_END);
    assert(start < end, "Reviewer output markers are out of order.");
    assert(text.slice(0, start).trim() === "" && text.slice(end + REVIEW_END.length).trim() === "", "Reviewer output must not contain prose outside its envelope.");
    const payload = text.slice(start + REVIEW_BEGIN.length, end).trim();
    assert(payload && !/^```/.test(payload) && !/```$/.test(payload), "Reviewer JSON must be present without a code fence.");
    try {
      return JSON.parse(payload);
    } catch (error) {
      throw new Error(`Reviewer envelope does not contain valid JSON: ${error.message}`);
    }
  }

  function canonicalIso(value, label) {
    const raw = assertString(value, label, 20, 40);
    const parsed = new Date(raw);
    assert(Number.isFinite(parsed.getTime()), `${label} must be a valid ISO-8601 timestamp.`);
    const canonical = parsed.toISOString();
    assert(raw === canonical || raw === canonical.replace(".000Z", "Z"), `${label} must be canonical ISO-8601.`);
    return raw;
  }

  function buildReviewerPrompt(project, task, dispatch, result) {
    assert(project && task && dispatch && result, "Project, task, dispatch, and result are required.");
    const prompt = [
      "You are the independent reviewer for an AutoPrompter Project Mode task running through ChatGPT Web.",
      "Inspect repository evidence where tools permit. Do not trust the worker's claims without checking the branch, commit, diff, and test evidence.",
      "Do not merge, publish, change permissions, or perform unrelated implementation work.",
      "",
      `Project: ${project.title}`,
      `Project ID: ${project.projectId}`,
      `Repository: ${project.repository.slug}`,
      `Default branch: ${project.repository.defaultBranch}`,
      `Task ID: ${task.id}`,
      `Dispatch ID: ${dispatch.dispatchId}`,
      `Attempt: ${dispatch.attempt}`,
      `Worker branch: ${dispatch.branch}`,
      `Worker commit: ${result.commit || "none"}`,
      `Result digest: ${result.resultDigest}`,
      "",
      "Task description",
      task.description,
      "",
      "Acceptance criteria",
      ...task.acceptanceCriteria.map((criterion, index) => `${index + 1}. ${criterion}`),
      "",
      "Required verification commands",
      ...(task.verificationCommands.length ? task.verificationCommands.map(command => `- ${command}`) : ["- None specified"]),
      "",
      "Worker result",
      JSON.stringify(result, null, 2),
      "",
      "Review rules",
      "- accepted requires a completed worker result, a commit SHA, every acceptance criterion marked met, every required command verified, and no required changes.",
      "- revision_required requires concrete bounded changes and must not silently accept unresolved evidence.",
      "- rejected is terminal for this attempt and should be used for unsafe, unrelated, fabricated, or fundamentally invalid work.",
      "- Do not reveal hidden reasoning. Provide concise evidence summaries only.",
      "",
      `Return exactly one ${REVIEW_BEGIN} / ${REVIEW_END} JSON envelope with no prose outside it:`,
      REVIEW_BEGIN,
      JSON.stringify({
        schemaVersion: REVIEW_SCHEMA_VERSION,
        projectId: project.projectId,
        taskId: task.id,
        dispatchId: dispatch.dispatchId,
        attempt: dispatch.attempt,
        resultDigest: result.resultDigest,
        decision: "accepted | revision_required | rejected",
        summary: "concise evidence-based decision",
        acceptanceCriteria: task.acceptanceCriteria.map(criterion => ({ criterion, status: "met | not_met | unclear", evidence: "evidence summary" })),
        verificationChecks: task.verificationCommands.map(command => ({ command, status: "verified | failed | not_verified", evidence: "evidence summary" })),
        requiredChanges: ["bounded required change"],
        risks: ["remaining risk"],
        reviewedAt: "canonical ISO-8601 timestamp"
      }, null, 2),
      REVIEW_END
    ].join("\n");
    assert(prompt.length <= MAX_REVIEW_PROMPT_CHARS, `Reviewer prompt exceeds ${MAX_REVIEW_PROMPT_CHARS} characters.`);
    return prompt;
  }

  function validateReview(input, { project, task, dispatch, result }) {
    assertExactKeys(input, ROOT_KEYS, "Review");
    assert(input.schemaVersion === REVIEW_SCHEMA_VERSION, `Review schemaVersion must be ${REVIEW_SCHEMA_VERSION}.`);
    assert(input.projectId === project?.projectId, "Review projectId does not match.");
    assert(input.taskId === task?.id, "Review taskId does not match.");
    assert(input.dispatchId === dispatch?.dispatchId, "Review dispatchId does not match.");
    assert(Number.isInteger(input.attempt) && input.attempt === dispatch?.attempt && input.attempt === result?.attempt, "Review attempt does not match.");
    assert(input.resultDigest === result?.resultDigest, "Review resultDigest does not match the stored worker result.");
    assert(DECISIONS.has(input.decision), "Review decision is unsupported.");
    const summary = assertString(input.summary, "Review summary", 1, 12000);

    assert(Array.isArray(input.acceptanceCriteria), "Review acceptanceCriteria must be an array.");
    assert(input.acceptanceCriteria.length === task.acceptanceCriteria.length, "Review must evaluate every task acceptance criterion exactly once.");
    const acceptanceCriteria = input.acceptanceCriteria.map((entry, index) => {
      assertExactKeys(entry, CRITERION_KEYS, `Acceptance review ${index + 1}`);
      const criterion = assertString(entry.criterion, `Acceptance review ${index + 1} criterion`, 1, 1000);
      assert(criterion === task.acceptanceCriteria[index], "Review acceptance criteria must preserve the task order and exact text.");
      assert(CRITERION_STATUSES.has(entry.status), `${criterion} has an unsupported review status.`);
      return { criterion, status: entry.status, evidence: assertString(entry.evidence, `${criterion} evidence`, 1, 4000) };
    });

    assert(Array.isArray(input.verificationChecks), "Review verificationChecks must be an array.");
    assert(input.verificationChecks.length === task.verificationCommands.length, "Review must evaluate every verification command exactly once.");
    const verificationChecks = input.verificationChecks.map((entry, index) => {
      assertExactKeys(entry, CHECK_KEYS, `Verification review ${index + 1}`);
      const command = assertString(entry.command, `Verification review ${index + 1} command`, 1, 1000);
      assert(command === task.verificationCommands[index], "Review verification commands must preserve the task order and exact text.");
      assert(CHECK_STATUSES.has(entry.status), `${command} has an unsupported verification review status.`);
      return { command, status: entry.status, evidence: assertString(entry.evidence, `${command} evidence`, 1, 4000) };
    });

    const requiredChanges = assertStringArray(input.requiredChanges, "Review requiredChanges", { max: 30, itemMax: 2000 });
    const risks = assertStringArray(input.risks, "Review risks", { max: 50, itemMax: 2000 });
    const reviewedAt = canonicalIso(input.reviewedAt, "Review reviewedAt");

    if (input.decision === "accepted") {
      assert(result.status === "completed" && Boolean(result.commit), "Only a completed committed worker result can be accepted.");
      assert(acceptanceCriteria.every(entry => entry.status === "met"), "Accepted review must mark every acceptance criterion met.");
      assert(verificationChecks.every(entry => entry.status === "verified"), "Accepted review must verify every required command.");
      assert(requiredChanges.length === 0, "Accepted review cannot include required changes.");
    } else if (input.decision === "revision_required") {
      assert(requiredChanges.length > 0, "Revision-required review must include at least one required change.");
    }

    return {
      schemaVersion: REVIEW_SCHEMA_VERSION,
      projectId: project.projectId,
      taskId: task.id,
      dispatchId: dispatch.dispatchId,
      attempt: input.attempt,
      resultDigest: result.resultDigest,
      decision: input.decision,
      summary,
      acceptanceCriteria,
      verificationChecks,
      requiredChanges,
      risks,
      reviewedAt
    };
  }

  function parseAndValidateReview(output, context) {
    return validateReview(parseReviewEnvelope(output), context);
  }

  return {
    REVIEW_BEGIN,
    REVIEW_END,
    REVIEW_SCHEMA_VERSION,
    MAX_REVIEW_OUTPUT_CHARS,
    MAX_REVIEW_PROMPT_CHARS,
    parseReviewEnvelope,
    buildReviewerPrompt,
    validateReview,
    parseAndValidateReview
  };
});
