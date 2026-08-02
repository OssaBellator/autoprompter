"use strict";

(function attachGitHubProjectUi(root, factory) {
  const api = factory(root);
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.AutoPrompterGitHubProjectUi = api;
})(typeof globalThis !== "undefined" ? globalThis : self, root => {
  const MAX_APPLY_ATTEMPTS = 20;
  const APPLY_RETRY_MS = 50;
  const RESUME_SCOPE = "AUTOPROMPTER_GITHUB_RESUME";
  const RESUME_TYPE = "RESUME_PROJECT_STAGE";
  const RESUME_GUARD = Symbol.for("autoprompter.githubResumeButton.guard");
  const RESUME_BOUND = Symbol.for("autoprompter.githubResumeButton.bound");
  const resumeRequests = new WeakSet();
  let started = false;
  let resumeObserver = null;

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
    note.textContent = "The planner creates real GitHub issues with the connected write-capable plugin. AutoPrompter opens a fresh temporary managed worker tab for each ready issue. The combined reviewer/merger inspects each pull request, merges it when ready, or posts feedback and returns the same issue to its worker conversation.";
    panel.insertBefore(note, panel.firstElementChild?.nextSibling || panel.firstChild);
    return true;
  }

  function projectSnapshot(documentApi) {
    const output = documentApi.getElementById("projectInspectOutput")?.textContent || "";
    if (!output.trim()) return null;
    try {
      return JSON.parse(output);
    } catch {
      return null;
    }
  }

  function resumeState(documentApi) {
    const status = String(documentApi.getElementById("projectStatusBadge")?.textContent || "").trim();
    const bootstrapStatus = String(projectSnapshot(documentApi)?.autonomousBootstrap?.status || "").trim();
    return {
      status,
      bootstrapStatus,
      recoverableBootstrap: ["failed", "cancelled"].includes(bootstrapStatus)
    };
  }

  function findPropertyDescriptor(node, property) {
    let prototype = Object.getPrototypeOf(node);
    while (prototype) {
      const descriptor = Object.getOwnPropertyDescriptor(prototype, property);
      if (descriptor) return descriptor;
      prototype = Object.getPrototypeOf(prototype);
    }
    return null;
  }

  function installResumeDisabledGuard(button, documentApi) {
    if (!button || button[RESUME_GUARD]) return false;
    const descriptor = findPropertyDescriptor(button, "disabled");
    if (!descriptor?.get || !descriptor?.set) return false;
    Object.defineProperty(button, "disabled", {
      configurable: true,
      enumerable: descriptor.enumerable,
      get() {
        return descriptor.get.call(button);
      },
      set(value) {
        const forceEnabled = resumeState(documentApi).recoverableBootstrap && !resumeRequests.has(button);
        descriptor.set.call(button, forceEnabled ? false : Boolean(value));
      }
    });
    Object.defineProperty(button, RESUME_GUARD, { value: true });
    return true;
  }

  function stageLabel(stage) {
    return {
      issue_manifest: "existing-issue recovery",
      task_creation: "task creation",
      issue_workers: "worker dispatch"
    }[stage] || "stored project stage";
  }

  function bindResumeControl(documentApi = root.document) {
    const button = documentApi?.getElementById?.("resumeProject");
    if (!button || button[RESUME_BOUND]) return false;
    installResumeDisabledGuard(button, documentApi);
    button.addEventListener("click", event => {
      const state = resumeState(documentApi);
      if (!state.recoverableBootstrap) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (resumeRequests.has(button)) return;

      const projectId = String(documentApi.getElementById("projectSelect")?.value || "").trim();
      const message = documentApi.getElementById("projectMessage");
      if (!projectId) {
        if (message) message.textContent = "Choose a project before resuming its stored stage.";
        return;
      }

      resumeRequests.add(button);
      button.setAttribute?.("aria-busy", "true");
      setText(button, "Resuming stage…");
      if (message) message.textContent = "Resuming the saved GitHub project stage…";

      Promise.resolve(root.chrome?.runtime?.sendMessage?.({
        scope: RESUME_SCOPE,
        type: RESUME_TYPE,
        projectId
      })).then(response => {
        if (!response || response.ok === false) {
          throw new Error(response?.error || "The background resume service did not respond.");
        }
        if (message) message.textContent = `Resumed ${stageLabel(response.resumed?.stage)}.`;
      }).catch(error => {
        if (message) message.textContent = error?.message || String(error);
      }).finally(() => {
        resumeRequests.delete(button);
        button.removeAttribute?.("aria-busy");
        applyResumeControl(documentApi);
      });
    }, true);
    Object.defineProperty(button, RESUME_BOUND, { value: true });
    return true;
  }

  function applyResumeControl(documentApi = root.document) {
    if (!documentApi?.getElementById) return false;
    const button = documentApi.getElementById("resumeProject");
    if (!button) return false;
    bindResumeControl(documentApi);
    const state = resumeState(documentApi);
    const enabled = state.status === "paused" || state.recoverableBootstrap;
    button.disabled = !enabled;
    if (!resumeRequests.has(button)) setText(button, state.recoverableBootstrap ? "Resume stage" : "Resume");
    const title = state.recoverableBootstrap
      ? "Continue from the stored GitHub issue, task-creation, or worker stage without initializing completed roles again."
      : "Resume this paused project from its stored stage.";
    if (button.title !== title) button.title = title;
    return enabled;
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
    queryText(documentApi, "#projectWorkerHint", "Workers use fresh temporary managed ChatGPT tabs—one per ready GitHub issue. A worker conversation is reused only when that pull request needs revisions.");
    queryText(documentApi, "#createProject", "Create GitHub issue project");
    queryText(documentApi, "#plannerWorkbench > strong", "GitHub issue planner");
    queryText(documentApi, "#plannerWorkbench > .hint", "The planner uses the connected GitHub plugin to create or recover real issues, then returns their verified issue numbers and URLs. Manual controls remain only for recovery.");
    queryText(documentApi, "#workerWorkbench > strong", "Issue workers and pull-request review");
    queryText(documentApi, "#workerWorkbench > .hint", "Each ready issue receives a fresh temporary managed worker tab. A worker creates or updates one pull request; the combined reviewer/merger either merges it or posts feedback and returns it to the same worker conversation.");
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
    applyResumeControl(documentApi);

    return Boolean(
      documentApi.getElementById("projectModePanel")
      && documentApi.getElementById("projectNewPanel")
      && documentApi.getElementById("projectAutomationCard")
    );
  }

  function startResumeControl(documentApi = root.document) {
    if (resumeObserver || !documentApi) return false;
    bindResumeControl(documentApi);
    const Observer = root.MutationObserver;
    const targets = [
      documentApi.getElementById("projectStatusBadge"),
      documentApi.getElementById("projectInspectOutput")
    ].filter(Boolean);
    if (typeof Observer !== "function" || !targets.length) return true;
    resumeObserver = new Observer(() => applyResumeControl(documentApi));
    for (const target of targets) {
      resumeObserver.observe(target, { childList: true, subtree: true, characterData: true });
    }
    root.addEventListener?.("unload", () => {
      resumeObserver?.disconnect?.();
      resumeObserver = null;
    }, { once: true });
    return true;
  }

  function start(documentApi = root.document, timerApi = root) {
    if (started || !documentApi) return false;
    started = true;
    let attempts = 0;

    const run = () => {
      attempts += 1;
      const ready = apply(documentApi);
      if (!ready && attempts < MAX_APPLY_ATTEMPTS) timerApi.setTimeout(run, APPLY_RETRY_MS);
      if (ready) startResumeControl(documentApi);
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
    RESUME_SCOPE,
    RESUME_TYPE,
    setText,
    setHidden,
    labelText,
    addModeNote,
    projectSnapshot,
    resumeState,
    findPropertyDescriptor,
    installResumeDisabledGuard,
    bindResumeControl,
    applyResumeControl,
    apply,
    startResumeControl,
    start
  };
});
