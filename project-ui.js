"use strict";

(() => {
  if (typeof document === "undefined" || typeof chrome === "undefined") return;
  const MESSAGE_SCOPE = "AUTOPROMPTER_RUNTIME";

  function element(id) {
    return document.getElementById(id);
  }

  function installStyles() {
    if (element("projectAutomationStyles")) return;
    const style = document.createElement("style");
    style.id = "projectAutomationStyles";
    style.textContent = [
      ".project-automation-card{display:grid;gap:8px;margin-top:12px;padding:12px;border:1px solid var(--border,#d0d7de);border-radius:10px}",
      ".project-automation-card>strong{grid-column:1}",
      ".project-automation-card>.project-status-badge{grid-column:2;justify-self:end}",
      ".project-automation-card>small,.project-automation-actions,.project-automation-card>button{grid-column:1/-1}",
      ".project-automation-actions{display:grid;gap:6px}",
      ".project-automation-row{display:grid;gap:2px;padding:7px 0;border-top:1px solid var(--border,#d0d7de)}",
      ".project-automation-row:first-child{border-top:0}",
      ".project-automation-row small{overflow-wrap:anywhere}",
      ".project-advanced-panel{margin-top:12px}",
      ".project-advanced-panel>summary{cursor:pointer;font-weight:600}",
      ".project-advanced-panel:not([open]){padding-bottom:2px}"
    ].join("");
    document.head.append(style);
  }

  function setupLayout() {
    const existingPanel = element("projectExistingPanel");
    const statusCard = element("projectStatusCard");
    const planner = element("plannerWorkbench");
    const workers = element("workerWorkbench");
    if (!existingPanel || !statusCard || !planner || !workers || element("projectAdvancedPanel")) return;
    installStyles();

    const hint = existingPanel.querySelector(":scope > .hint");
    if (hint) hint.textContent = "Select a saved project. Planning, worker dispatch, independent review, integration approval, workflow setup, merge, and release actions advance automatically.";

    const automation = document.createElement("section");
    automation.id = "projectAutomationCard";
    automation.className = "project-automation-card";
    automation.innerHTML = [
      "<strong>Full automation</strong>",
      '<span id="projectAutomationBadge" class="project-status-badge">Enabled</span>',
      '<small id="projectAutomationSummary">Waiting for a project selection.</small>',
      '<div id="projectAutomationActions" class="project-automation-actions"></div>',
      '<button id="retryProjectAutomation" class="compact" type="button" hidden>Retry blocked automation</button>'
    ].join("");

    const advanced = document.createElement("details");
    advanced.id = "projectAdvancedPanel";
    advanced.className = "project-advanced-panel";
    const summary = document.createElement("summary");
    summary.textContent = "Advanced recovery and diagnostics";
    const note = document.createElement("p");
    note.className = "hint";
    note.textContent = "These controls are retained for inspection and recovery. Normal Project Mode operation does not require manual planner envelopes, model verification, result pasting, reviewer prompts, integration approval, or approval-queue input.";
    advanced.append(summary, note, planner, workers);
    statusCard.append(automation, advanced);

    const modelConfirmation = element("projectModelVerified")?.closest("label");
    if (modelConfirmation) modelConfirmation.hidden = true;
    const dispatchButton = element("dispatchProjectAssignments");
    if (dispatchButton) dispatchButton.hidden = true;
    const approveIntegration = element("approveProjectIntegration");
    if (approveIntegration) approveIntegration.hidden = true;

    element("projectSelect")?.addEventListener("change", refreshAutomation);
    element("inspectProject")?.addEventListener("click", () => setTimeout(refreshAutomation, 150));
    element("retryProjectAutomation")?.addEventListener("click", retryAutomation);
    chrome.storage?.onChanged?.addListener((changes, area) => {
      if (area === "local" && (changes.autoprompterProjectActionJobs || changes.autoprompterProjects || changes.autoprompterProjectRoleJobs)) {
        refreshAutomation();
      }
    });
    refreshAutomation();
  }

  async function runtime(type, extra = {}) {
    const response = await chrome.runtime.sendMessage({ scope: MESSAGE_SCOPE, type, ...extra });
    if (!response || response.ok === false) throw new Error(response?.error || "Project automation state is unavailable.");
    return response;
  }

  function selectedProjectId() {
    return element("projectSelect")?.value || "";
  }

  function actionLabel(action) {
    return {
      modify_workflow: "Validation workflow",
      change_permissions: "Minimum repository permissions",
      merge_to_default_branch: "Default-branch merge",
      publish_release: "Release publication",
      delete_branch: "Branch cleanup",
      external_side_effect: "External action"
    }[action] || action;
  }

  async function refreshAutomation() {
    const summary = element("projectAutomationSummary");
    const actions = element("projectAutomationActions");
    const retry = element("retryProjectAutomation");
    if (!summary || !actions || !retry) return;
    const projectId = selectedProjectId();
    actions.textContent = "";
    retry.hidden = true;
    if (!projectId) {
      summary.textContent = "Waiting for a project selection.";
      return;
    }
    try {
      const response = await runtime("GET_PROJECT_AUTOMATION");
      const jobs = Object.values(response.actions || {}).filter(job => job.projectId === projectId);
      const project = response.projects?.[projectId];
      summary.textContent = project
        ? `Project ${project.status}. AutoPrompter advances every eligible stage without manual form input.`
        : "Project automation state is loading.";
      if (!jobs.length) {
        const empty = document.createElement("small");
        empty.textContent = "Repository actions will appear here when their prerequisites are ready.";
        actions.append(empty);
        return;
      }
      let retryable = false;
      for (const job of jobs.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))) {
        const row = document.createElement("div");
        row.className = "project-automation-row";
        const name = document.createElement("span");
        name.textContent = actionLabel(job.action);
        const state = document.createElement("small");
        state.textContent = `${job.status}${job.summary ? ` · ${job.summary}` : job.error ? ` · ${job.error}` : ""}`;
        row.append(name, state);
        actions.append(row);
        if (["blocked", "failed"].includes(job.status)) retryable = true;
      }
      retry.hidden = !retryable;
    } catch (error) {
      summary.textContent = error.message;
    }
  }

  async function retryAutomation() {
    const projectId = selectedProjectId();
    if (!projectId) return;
    const button = element("retryProjectAutomation");
    button.disabled = true;
    try {
      await runtime("RETRY_PROJECT_AUTOMATION", { projectId });
      await refreshAutomation();
    } catch (error) {
      element("projectAutomationSummary").textContent = error.message;
    } finally {
      button.disabled = false;
    }
  }

  setupLayout();
})();
