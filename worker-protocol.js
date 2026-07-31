"use strict";

(function attachWorkerProtocol(root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.AutoPrompterWorkerProtocol = api;
})(typeof globalThis !== "undefined" ? globalThis : self, () => {
  const DISPATCH_SCHEMA_VERSION = "1.0";
  const TASK_RESULT_BEGIN = "AUTOPROMPTER_TASK_RESULT_BEGIN";
  const TASK_RESULT_END = "AUTOPROMPTER_TASK_RESULT_END";
  const MAX_WORKER_PROMPT_CHARS = 18000;
  const ACTIVE_DISPATCH_STATUSES = new Set(["prepared", "dispatched", "running"]);

  function clone(value) {
    return value == null ? value : structuredClone(value);
  }

  function stableHash(value) {
    let hash = 0x811c9dc5;
    const text = String(value || "");
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(36).padStart(7, "0");
  }

  function safeSegment(value, fallback = "item", maxLength = 48) {
    return String(value || fallback)
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "")
      .slice(0, maxLength) || fallback;
  }

  function buildDispatchId({ projectId, revision, taskId, attempt, workerChatId }) {
    const normalizedAttempt = Math.max(1, Math.min(50, Math.round(Number(attempt) || 1)));
    const fingerprint = stableHash(`${projectId}|${revision}|${taskId}|${normalizedAttempt}|${workerChatId}`);
    return `dispatch-${safeSegment(taskId.replace(/^task-/, ""), "task", 32)}-a${normalizedAttempt}-${fingerprint}`;
  }

  function buildBranchName(projectId, taskId, attempt) {
    const normalizedAttempt = Math.max(1, Math.min(50, Math.round(Number(attempt) || 1)));
    return `agent/${safeSegment(projectId, "project", 48)}/${safeSegment(taskId.replace(/^task-/, ""), "task", 80)}-a${normalizedAttempt}`.slice(0, 240);
  }

  function isLeaseExpired(lease, now = Date.now()) {
    if (!lease || typeof lease !== "object") return false;
    const expiresAt = Date.parse(lease.expiresAt);
    return !Number.isFinite(expiresAt) || expiresAt <= Number(now);
  }

  function activeDispatches(dispatches) {
    return Object.values(dispatches && typeof dispatches === "object" ? dispatches : {})
      .filter(dispatch => dispatch && ACTIVE_DISPATCH_STATUSES.has(dispatch.status));
  }

  function buildWorkerPrompt(project, task, dispatch) {
    const acceptance = task.acceptanceCriteria.map((item, index) => `${index + 1}. ${item}`).join("\n");
    const commands = task.verificationCommands.length
      ? task.verificationCommands.map(command => `- ${command}`).join("\n")
      : "- No command was specified; report what validation was possible.";
    const prompt = [
      "You are a bounded worker in AutoPrompter Project Mode.",
      "",
      `Project: ${project.title}`,
      `Project ID: ${project.projectId}`,
      `Repository: ${project.repository.slug}`,
      `Default branch: ${project.repository.defaultBranch}`,
      `Continuity file: ${project.repository.handoffFile}`,
      `Dispatch ID: ${dispatch.dispatchId}`,
      `Task ID: ${task.id}`,
      `Attempt: ${dispatch.attempt}`,
      `Assigned branch: ${dispatch.branch}`,
      `Lease expires: ${dispatch.expiresAt}`,
      `Role: ${task.role}`,
      `Preferred model class: ${task.preferredModelClass}`,
      "",
      "Task",
      task.description,
      "",
      "Allowed paths",
      task.allowedPaths.map(path => `- ${path}`).join("\n"),
      "",
      "Acceptance criteria",
      acceptance,
      "",
      "Verification commands",
      commands,
      "",
      "Rules",
      "- Read the repository and continuity file before changing anything.",
      "- Work only on this task and the allowlisted paths.",
      "- Do not merge, publish, modify permissions, or perform unrelated work.",
      "- Commit completed reviewable changes to the assigned branch.",
      "- Do not invent repository state or claim tests that were not run.",
      "- Stop and report a blocker when required information or permissions are missing.",
      "",
      "Return exactly one JSON object between these markers, with no prose outside them:",
      TASK_RESULT_BEGIN,
      JSON.stringify({
        schemaVersion: "1.0",
        projectId: project.projectId,
        taskId: task.id,
        dispatchId: dispatch.dispatchId,
        attempt: dispatch.attempt,
        status: "completed | blocked | failed",
        summary: "concise result or blocker explanation",
        commit: "commit SHA or null",
        tests: [{ command: "command", status: "passed | failed | not_run", summary: "evidence" }],
        filesChanged: ["relative/path"],
        risks: ["remaining risk"],
        followUpTaskSuggestions: ["optional follow-up"],
        producedAt: "canonical ISO-8601 timestamp"
      }, null, 2),
      TASK_RESULT_END
    ].join("\n");
    if (prompt.length > MAX_WORKER_PROMPT_CHARS) throw new Error(`Worker prompt exceeds ${MAX_WORKER_PROMPT_CHARS} characters.`);
    return prompt;
  }

  function summarizeRuntime(project, tasks, dispatches) {
    const taskValues = Object.values(tasks && typeof tasks === "object" ? tasks : {});
    const statusCounts = {};
    for (const task of taskValues) statusCounts[task.status] = (statusCounts[task.status] || 0) + 1;
    const active = activeDispatches(dispatches);
    const workerIds = Array.isArray(project?.roles?.workerChatIds) ? project.roles.workerChatIds : [];
    const occupied = new Set(active.map(dispatch => dispatch.workerChatId));
    return {
      taskCount: taskValues.length,
      statusCounts,
      activeLeaseCount: active.length,
      preparedDispatchCount: active.filter(dispatch => dispatch.status === "prepared").length,
      workerCount: workerIds.length,
      availableWorkerCount: workerIds.filter(id => !occupied.has(id)).length,
      activeDispatchIds: active.map(dispatch => dispatch.dispatchId).sort()
    };
  }

  return {
    DISPATCH_SCHEMA_VERSION,
    TASK_RESULT_BEGIN,
    TASK_RESULT_END,
    MAX_WORKER_PROMPT_CHARS,
    ACTIVE_DISPATCH_STATUSES: [...ACTIVE_DISPATCH_STATUSES],
    stableHash,
    buildDispatchId,
    buildBranchName,
    isLeaseExpired,
    activeDispatches,
    buildWorkerPrompt,
    summarizeRuntime,
    clone
  };
});
