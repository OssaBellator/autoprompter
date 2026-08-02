"use strict";

(function attachGitHubProjectUi(root, factory) {
  const api = factory(root);
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.AutoPrompterGitHubProjectUi = api;
})(typeof globalThis !== "undefined" ? globalThis : self, root => {
  const MAX_APPLY_ATTEMPTS = 20;
  const APPLY_RETRY_MS = 50;
  let started = false;

  function setText(node, value) {
    if (!node || node.textContent === value) return false;
    node.textContent = value;
    return true;
  }

  function setHidden(node, value = true) {
    if (!node || node.hidden === value) return false;
    node.hidden = value;
    return true;
  }

  function queryText(documentApi, selector, value) {
    return setText(documentApi.querySelector(selector), value);
  }

  function hide(documentApi, selector) {
    return setHidden(documentApi.querySelector(selector), true);
  }

  function labelText(documentApi, controlId, value) {
    const control = documentApi.getElementById(controlId);
    const label = control?.closest?.("label");
    if (!label) return false;
    let changed = false;
    let caption = label.querySelector?.(":scope > .github-mode-caption");
    if (!caption) {
      caption = documentApi.createElement("span");
      caption.className = "github-mode-caption";
      label.prepend(caption);
      changed = true;
    }
    changed = setText(caption, value) || changed;
    for (const node of [...(label.childNodes || [])]) {
      if (node === caption || node === control || node.nodeType !== 3 || node.textContent === "") continue;
      node.textContent = "";
      changed = true;
    }
    return changed;
  }

  function addModeNote(documentApi) {
    const panel = documentApi.getElementById("projectNewPanel");
    if (!panel || documentApi.getElementById("githubIssueModeNote")) return false;
    const note = documentApi.createElement("p");
    note.id = "githubIssueModeNote";
    note.className = "hint";
    note.textContent = "The planner creates real GitHub issues with the connected write-capable plugin. AutoPrompter opens one persistent worker chat per ready issue. The combined reviewer/merger inspects each pull request, merges it when ready, or posts feedback and returns the same issue to its worker chat.";
    panel.insertBefore(note, panel.firstElementChild?.nextSibling || panel.firstChild);
    return true;
  }

  function apply(documentApi = root.document) {
    if (!documentApi?.getElementById || !documentApi?.querySelector) return false;

    const integrator = documentApi.getElementById("projectIntegratorChat");
    setHidden(integrator?.closest?.("label"), true);
    hide(documentApi, ".integration-workbench");
    hide(documentApi, ".approval-workbench");
    hide(documentApi, ".reconciliation-workbench");

    labelText(documentApi, "projectReviewerChat", "Pull-request reviewer and merger chat");
    queryText(documentApi, "#projectModePanel > summary", "GitHub Issue and Pull Request Mode");
    queryText(documentApi, "#projectNewPanel > .hint", "Create a GitHub-native project. The planner and combined pull-request reviewer/merger can be created automatically or bound to existing chats.");
    queryText(documentApi, "#projectWorkerHint", "Worker chats are created automatically—one persistent ChatGPT conversation for each ready GitHub issue.");
    queryText(documentApi, "#createProject", "Create GitHub issue project");
    queryText(documentApi, "#plannerWorkbench > strong", "GitHub issue planner");
    queryText(documentApi, "#plannerWorkbench > .hint", "The planner uses the connected GitHub plugin to create real issues, then returns their verified issue numbers and URLs. Manual controls remain only for recovery.");
    queryText(documentApi, "#workerWorkbench > strong", "Issue workers and pull-request review");
    queryText(documentApi, "#workerWorkbench > .hint", "Each ready issue receives a persistent worker chat. A worker creates or updates one pull request; the combined reviewer/merger either merges it or posts feedback and returns it to the same chat.");
    queryText(documentApi, "#projectAutomationCard > strong", "GitHub issue and pull request board");
    queryText(documentApi, "#projectAutomationBadge", "Issue → PR → review/merge");

    const plannerInput = documentApi.getElementById("plannerResponseInput");
    if (plannerInput && plannerInput.placeholder !== "AUTOPROMPTER_ISSUES_BEGIN\n{ ... verified GitHub issues ... }\nAUTOPROMPTER_ISSUES_END") {
      plannerInput.placeholder = "AUTOPROMPTER_ISSUES_BEGIN\n{ ... verified GitHub issues ... }\nAUTOPROMPTER_ISSUES_END";
    }
    const resultInput = documentApi.getElementById("projectResultInput");
    if (resultInput && resultInput.placeholder !== "AUTOPROMPTER_ISSUE_WORK_BEGIN\n{ ... open pull request ... }\nAUTOPROMPTER_ISSUE_WORK_END") {
      resultInput.placeholder = "AUTOPROMPTER_ISSUE_WORK_BEGIN\n{ ... open pull request ... }\nAUTOPROMPTER_ISSUE_WORK_END";
    }
    const reviewInput = documentApi.getElementById("projectReviewInput");
    if (reviewInput && reviewInput.placeholder !== "AUTOPROMPTER_PR_REVIEW_BEGIN\n{ ... merged or changes requested ... }\nAUTOPROMPTER_PR_REVIEW_END") {
      reviewInput.placeholder = "AUTOPROMPTER_PR_REVIEW_BEGIN\n{ ... merged or changes requested ... }\nAUTOPROMPTER_PR_REVIEW_END";
    }
    addModeNote(documentApi);

    return Boolean(
      documentApi.getElementById("projectModePanel")
      && documentApi.getElementById("projectNewPanel")
      && documentApi.getElementById("projectAutomationCard")
    );
  }

  function start(documentApi = root.document, timerApi = root) {
    if (started || !documentApi) return false;
    started = true;
    let attempts = 0;

    const run = () => {
      attempts += 1;
      const ready = apply(documentApi);
      if (!ready && attempts < MAX_APPLY_ATTEMPTS) timerApi.setTimeout(run, APPLY_RETRY_MS);
    };

    if (documentApi.readyState === "loading") {
      documentApi.addEventListener("DOMContentLoaded", run, { once: true });
    } else {
      run();
    }
    return true;
  }

  if (root.document) start(root.document, root);

  return {
    MAX_APPLY_ATTEMPTS,
    APPLY_RETRY_MS,
    setText,
    setHidden,
    labelText,
    addModeNote,
    apply,
    start
  };
});
