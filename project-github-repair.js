"use strict";

(function attachGitHubIssueRepair(root, factory) {
  const api = factory(root);
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.AutoPrompterGitHubIssueRepair = api;
})(typeof globalThis !== "undefined" ? globalThis : self, root => {
  const ISSUES_BEGIN = "AUTOPROMPTER_ISSUES_BEGIN";
  const ISSUES_END = "AUTOPROMPTER_ISSUES_END";
  let installed = false;

  function buildRepairPrompt(error, attempt) {
    return [
      `Your previous AutoPrompter GitHub issue manifest failed validation on repair attempt ${attempt}.`,
      `Validation error: ${String(error || "Unknown issue manifest error").slice(0, 2000)}`,
      "Do not create duplicate GitHub issues. Reinspect the issues you already created and return their exact current numbers, URLs, titles, bodies, dependencies, path scopes, acceptance criteria, verification commands, and labels.",
      `Return the complete corrected ${ISSUES_BEGIN} / ${ISSUES_END} envelope again.`,
      "The content between the markers must be strict JSON parseable by JSON.parse: double-quoted keys and strings, escaped newlines, no comments, no trailing commas, and no Markdown fences.",
      "Keep the required projectId and repository unchanged. Do not add prose outside the envelope."
    ].join("\n");
  }

  function install() {
    if (installed) return true;
    if (typeof root.buildPlannerRepairPrompt !== "function") return false;
    root.buildPlannerRepairPrompt = buildRepairPrompt;
    installed = true;
    return true;
  }

  if (typeof importScripts === "function") install();

  return {
    ISSUES_BEGIN,
    ISSUES_END,
    buildRepairPrompt,
    install
  };
});