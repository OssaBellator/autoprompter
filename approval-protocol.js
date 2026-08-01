"use strict";

(function attachApprovalProtocol(root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.AutoPrompterApprovalProtocol = api;
})(typeof globalThis !== "undefined" ? globalThis : self, () => {
  const APPROVAL_SCHEMA_VERSION = "1.0";
  const APPROVAL_ACTIONS = new Set([
    "merge_to_default_branch", "delete_branch", "publish_release", "modify_workflow",
    "change_permissions", "external_side_effect"
  ]);
  const DECISIONS = new Set(["approved", "rejected"]);

  function assert(condition, message) { if (!condition) throw new Error(message); }
  function stableHash(value) {
    let hash = 0x811c9dc5;
    for (const char of String(value || "")) {
      hash ^= char.charCodeAt(0);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(36).padStart(7, "0");
  }
  function canonicalIso(value, label) {
    const raw = String(value || "").trim();
    const parsed = new Date(raw);
    assert(raw.length >= 20 && raw.length <= 40 && Number.isFinite(parsed.getTime()), `${label} must be a valid ISO-8601 timestamp.`);
    const canonical = parsed.toISOString();
    assert(raw === canonical || raw === canonical.replace(".000Z", "Z"), `${label} must be canonical ISO-8601.`);
    return raw;
  }
  function normalizeTarget(value) {
    const target = String(value || "").trim();
    assert(target.length >= 1 && target.length <= 500, "Approval target must be between 1 and 500 characters.");
    assert(!/[\r\n\0]/.test(target), "Approval target must be one line.");
    return target;
  }
  function buildApprovalId(projectId, action, target, requestedAt) {
    return `approval-${action.replace(/_/g, "-")}-${stableHash(`${projectId}|${action}|${target}|${requestedAt}`)}`;
  }
  function createApprovalRequest({ projectId, action, target, justification, requestedAt, expiresAt = null }) {
    assert(/^[a-z0-9][a-z0-9._-]{2,63}$/.test(String(projectId || "")), "Approval projectId is invalid.");
    assert(APPROVAL_ACTIONS.has(action), "Approval action is unsupported.");
    const canonicalRequestedAt = canonicalIso(requestedAt, "Approval requestedAt");
    const canonicalExpiresAt = expiresAt == null ? null : canonicalIso(expiresAt, "Approval expiresAt");
    if (canonicalExpiresAt) assert(Date.parse(canonicalExpiresAt) > Date.parse(canonicalRequestedAt), "Approval expiry must be after its request time.");
    const normalizedTarget = normalizeTarget(target);
    const normalizedJustification = String(justification || "").trim();
    assert(normalizedJustification.length >= 1 && normalizedJustification.length <= 4000, "Approval justification must be between 1 and 4000 characters.");
    return {
      schemaVersion: APPROVAL_SCHEMA_VERSION,
      approvalId: buildApprovalId(projectId, action, normalizedTarget, canonicalRequestedAt),
      projectId,
      action,
      target: normalizedTarget,
      justification: normalizedJustification,
      status: "pending",
      requestedAt: canonicalRequestedAt,
      expiresAt: canonicalExpiresAt,
      decidedAt: null,
      decisionNote: null,
      instruction: null
    };
  }
  function isExpired(request, now = Date.now()) {
    return Boolean(request?.expiresAt && Date.parse(request.expiresAt) <= Number(now));
  }
  function buildApprovedInstruction(project, request) {
    assert(request?.status === "approved", "Only an approved request can produce an instruction.");
    return [
      "A user explicitly approved one external action for this AutoPrompter Project Mode project.",
      `Project ID: ${project.projectId}`,
      `Repository: ${project.repository.slug}`,
      `Approval ID: ${request.approvalId}`,
      `Action: ${request.action}`,
      `Target: ${request.target}`,
      `Justification: ${request.justification}`,
      `Decision note: ${request.decisionNote || "No additional note"}`,
      "This approval applies only to the named action and target. Re-check repository state and request a new approval if scope changes.",
      "Do not perform any other merge, release, deletion, workflow, permission, or external side effect."
    ].join("\n");
  }
  function decideApproval(project, requestInput, decision, note, decidedAt, now = Date.now()) {
    const request = structuredClone(requestInput);
    assert(request?.status === "pending", "Only a pending approval can be decided.");
    assert(!isExpired(request, now), "The approval request has expired.");
    assert(DECISIONS.has(decision), "Approval decision must be approved or rejected.");
    request.status = decision;
    request.decidedAt = canonicalIso(decidedAt, "Approval decidedAt");
    request.decisionNote = String(note || "").trim().slice(0, 4000) || null;
    request.instruction = decision === "approved" ? buildApprovedInstruction(project, request) : null;
    return request;
  }

  return {
    APPROVAL_SCHEMA_VERSION,
    APPROVAL_ACTIONS: [...APPROVAL_ACTIONS],
    buildApprovalId,
    createApprovalRequest,
    decideApproval,
    isExpired,
    buildApprovedInstruction
  };
});
