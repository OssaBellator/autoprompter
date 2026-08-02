(() => {
  "use strict";

  if (typeof document === "undefined") return;
  let applying = false;

  function text(selector, value) {
    const node = document.querySelector(selector);
    if (node && node.textContent !== value) node.textContent = value;
  }

  function hide(selector) {
    const node = document.querySelector(selector);
    if (node) node.hidden = true;
  }

  function labelText(controlId, value) {
    const control = document.getElementById(controlId);
    const label = control?.closest("label");
    if (!label) return;
    let caption = label.querySelector(":scope > .github-mode-caption");
    if (!caption) {
      caption = document.createElement("span");
      caption.className = "github-mode-caption";
      label.prepend(caption);
    }
    caption.textContent = value;
    for (const node of [...label.childNodes]) {
      if (node === caption || node === control || node.nodeType !== Node.TEXT_NODE) continue;
      node.textContent = "";
    }
  }

  function addModeNote() {
    const panel = document.getElementById("projectNewPanel");
    if (!panel || document.getElementById("githubIssueModeNote")) return;
    const note = document.createElement("p");
    note.id = "githubIssueModeNote";
    note.className = "hint";
    note.textContent = "The planner creates real GitHub issues with the connected write-capable plugin. AutoPrompter opens one persistent worker chat per ready issue. The combined reviewer/merger inspects each pull request, merges it when ready, or posts feedback and returns the same issue to its worker chat.";
    panel.insertBefore(note, panel.firstElementChild?.nextSibling || panel.firstChild);
  }

  function apply() {
    if (applying) return;
    applying = true;
    try {
      const integrator = document.getElementById("projectIntegratorChat");
      if (integrator?.closest("label")) integrator.closest("label").hidden = true;
      hide(".integration-workbench");
      hide(".approval-workbench");
      hide(".reconciliation-workbench");

      labelText("projectReviewerChat", "Pull-request reviewer and merger chat");
      text("#projectModePanel > summary", "GitHub Issue and Pull Request Mode");
      text("#projectNewPanel > .hint", "Create a GitHub-native project. The planner and combined pull-request reviewer/merger can be created automatically or bound to existing chats.");
      text("#projectWorkerHint", "Worker chats are created automatically—one persistent ChatGPT conversation for each ready GitHub issue.");
      text("#createProject", "Create GitHub issue project");
      text("#plannerWorkbench > strong", "GitHub issue planner");
      text("#plannerWorkbench > .hint", "The planner uses the connected GitHub plugin to create real issues, then returns their verified issue numbers and URLs. Manual controls remain only for recovery.");
      text("#workerWorkbench > strong", "Issue workers and pull-request review");
      text("#workerWorkbench > .hint", "Each ready issue receives a persistent worker chat. A worker creates or updates one pull request; the combined reviewer/merger either merges it or posts feedback and returns it to the same chat.");
      text("#projectAutomationCard > strong", "GitHub issue and pull request board");
      text("#projectAutomationBadge", "Issue → PR → review/merge");

      const plannerInput = document.getElementById("plannerResponseInput");
      if (plannerInput) plannerInput.placeholder = "AUTOPROMPTER_ISSUES_BEGIN\n{ ... verified GitHub issues ... }\nAUTOPROMPTER_ISSUES_END";
      const resultInput = document.getElementById("projectResultInput");
      if (resultInput) resultInput.placeholder = "AUTOPROMPTER_ISSUE_WORK_BEGIN\n{ ... open pull request ... }\nAUTOPROMPTER_ISSUE_WORK_END";
      const reviewInput = document.getElementById("projectReviewInput");
      if (reviewInput) reviewInput.placeholder = "AUTOPROMPTER_PR_REVIEW_BEGIN\n{ ... merged or changes requested ... }\nAUTOPROMPTER_PR_REVIEW_END";
      addModeNote();
    } finally {
      applying = false;
    }
  }

  const observer = new MutationObserver(apply);
  observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", apply, { once: true });
  else apply();
})();