"use strict";

(function attachProjectActionProtocol(root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.AutoPrompterProjectActionProtocol = api;
})(typeof globalThis !== "undefined" ? globalThis : self, () => {
  const ACTION_BEGIN = "AUTOPROMPTER_ACTION_RESULT_BEGIN";
  const ACTION_END = "AUTOPROMPTER_ACTION_RESULT_END";
  const ACTION_SCHEMA_VERSION = "1.0";
  const ACTIONS = new Set([
    "merge_to_default_branch",
    "publish_release",
    "modify_workflow",
    "change_permissions",
    "delete_branch",
    "external_side_effect"
  ]);
  const STATUSES = new Set(["completed", "blocked", "failed"]);

  function assert(condition, message) {
    if (!condition) throw new Error(message);
  }

  function extractJson(output) {
    const text = String(output || "").replace(/^\uFEFF/, "").trim();
    assert(text, "Repository action output is empty.");
    const begin = text.indexOf(ACTION_BEGIN);
    const end = text.indexOf(ACTION_END);
    let payload = "";
    if (begin >= 0 || end >= 0) {
      assert(begin >= 0 && end > begin, "Repository action result markers are missing or out of order.");
      payload = text.slice(begin + ACTION_BEGIN.length, end).trim();
    } else {
      const start = text.indexOf("{");
      const finish = text.lastIndexOf("}");
      assert(start >= 0 && finish > start, "Repository action output does not contain a JSON object.");
      payload = text.slice(start, finish + 1);
    }
    try {
      return JSON.parse(payload.replace(/,\s*([}\]])/g, "$1"));
    } catch (error) {
      throw new Error(`Repository action result JSON could not be parsed: ${error.message}`);
    }
  }

  function validateResult(output, expected) {
    const value = extractJson(output);
    assert(value && typeof value === "object" && !Array.isArray(value), "Repository action result must be an object.");
    assert(value.schemaVersion === ACTION_SCHEMA_VERSION, `Repository action schemaVersion must be ${ACTION_SCHEMA_VERSION}.`);
    assert(value.projectId === expected.projectId, "Repository action project identity does not match.");
    assert(value.actionId === expected.actionId, "Repository action ID does not match.");
    assert(value.approvalId === expected.approvalId, "Repository approval ID does not match.");
    assert(value.action === expected.action && ACTIONS.has(value.action), "Repository action does not match the approved action.");
    assert(value.target === expected.target, "Repository action target does not match the approved target.");
    assert(STATUSES.has(value.status), "Repository action status is unsupported.");
    const summary = String(value.summary || "").trim();
    assert(summary.length >= 1 && summary.length <= 4000, "Repository action summary is required.");
    const evidence = value.evidence && typeof value.evidence === "object" && !Array.isArray(value.evidence)
      ? structuredClone(value.evidence)
      : {};
    if (value.status === "completed") {
      assert(Object.keys(evidence).length > 0, "Completed repository actions require evidence.");
    }
    return {
      schemaVersion: ACTION_SCHEMA_VERSION,
      projectId: value.projectId,
      actionId: value.actionId,
      approvalId: value.approvalId,
      action: value.action,
      target: value.target,
      status: value.status,
      summary,
      evidence,
      completedAt: value.completedAt ? String(value.completedAt) : new Date().toISOString()
    };
  }

  function buildPrompt({ project, approval, actionId, extraInstructions = "" }) {
    assert(project?.projectId && project?.repository?.slug, "A valid project is required.");
    assert(approval?.status === "approved" && approval?.instruction, "An approved external-action instruction is required.");
    assert(ACTIONS.has(approval.action), "Unsupported repository action.");
    const template = {
      schemaVersion: ACTION_SCHEMA_VERSION,
      projectId: project.projectId,
      actionId,
      approvalId: approval.approvalId,
      action: approval.action,
      target: approval.target,
      status: "completed",
      summary: "Describe exactly what changed or why the action was blocked.",
      evidence: {
        repository: project.repository.slug,
        url: "https://github.com/owner/repository/...",
        beforeCommit: "optional commit SHA",
        afterCommit: "optional commit SHA",
        details: "verifiable evidence"
      },
      completedAt: new Date().toISOString()
    };
    return [
      "You are the repository action executor for an AutoPrompter Project Mode project.",
      "Use a connected write-capable GitHub plugin, MCP app, or Codex repository tool. Do not claim success without checking the repository after the action.",
      "Perform only the exact approved action and target below. Use the minimum permissions necessary. Do not broaden scope, reveal secrets, disable protections, or perform unrelated changes.",
      "",
      approval.instruction,
      extraInstructions ? `\nAction-specific instructions:\n${extraInstructions}` : "",
      "",
      `Return exactly one ${ACTION_BEGIN} / ${ACTION_END} JSON envelope.`,
      "Use status completed only when repository evidence proves the action happened. Use blocked when the required plugin, permission, confirmation, or repository state is unavailable. Use failed for an attempted action that produced an error.",
      ACTION_BEGIN,
      JSON.stringify(template, null, 2),
      ACTION_END
    ].filter(Boolean).join("\n");
  }

  return {
    ACTION_BEGIN,
    ACTION_END,
    ACTION_SCHEMA_VERSION,
    ACTIONS: [...ACTIONS],
    extractJson,
    validateResult,
    buildPrompt
  };
});
