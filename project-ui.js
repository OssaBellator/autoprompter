"use strict";

(() => {
  if (typeof document === "undefined" || typeof chrome === "undefined") return;
  const MESSAGE_SCOPE = "AUTOPROMPTER_RUNTIME";
  const ADMIN_SCOPE = "AUTOPROMPTER_PROJECT_ADMIN";

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

  function installDeleteButton(existingPanel) {
    if (element("deleteExistingProject")) return;
    const inspect = element("inspectProject");
    const toolbar = inspect?.closest(".project-toolbar") || existingPanel.querySelector(".project-toolbar");
    if (!toolbar || !inspect) return;
    const button = document.createElement("button");
    button.id = "deleteExistingProject";
    button.className = "compact";
    button.type = "button";
    button.textContent = "Delete";
    button.disabled = true;
    inspect.insertAdjacentElement("afterend", button);
  }

  function setupLayout() {
    const existingPanel = element("projectExistingPanel");
    const statusCard = element("projectStatusCard");
    const planner = element("plannerWorkbench");
    const workers = element("workerWorkbench");
    if (!existingPanel || !statusCard || !planner || !workers || element("projectAdvancedPanel")) return;
    installStyles();
    installDeleteButton(existingPanel);

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

    element("projectSelect")?.addEventListener("change", () => {
      updateDeleteButton();
      refreshAutomation();
    });
    element("inspectProject")?.addEventListener("click", () => setTimeout(refreshAutomation, 150));
    element("retryProjectAutomation")?.addEventListener("click", retryAutomation);
    element("deleteExistingProject")?.addEventListener("click", deleteSelectedProject);
    chrome.storage?.onChanged?.addListener((changes, area) => {
      if (area === "local" && (changes.autoprompterProjectActionJobs || changes.autoprompterProjects || changes.autoprompterProjectRoleJobs)) {
        updateDeleteButton();
        refreshAutomation();
      }
    });
    updateDeleteButton();
    refreshAutomation();
  }

  async function runtime(type, extra = {}) {
    const response = await chrome.runtime.sendMessage({ scope: MESSAGE_SCOPE, type, ...extra });
    if (!response || response.ok === false) throw new Error(response?.error || "Project automation state is unavailable.");
    return response;
  }

  async function adminRuntime(type, extra = {}) {
    const response = await chrome.runtime.sendMessage({ scope: ADMIN_SCOPE, type, ...extra });
    if (!response || response.ok === false) throw new Error(response?.error || "Project administration is unavailable.");
    return response;
  }

  function selectedProjectId() {
    return element("projectSelect")?.value || "";
  }

  function updateDeleteButton() {
    const button = element("deleteExistingProject");
    if (button) button.disabled = !selectedProjectId();
  }

  function actionLabel(action) {
    return {
      modify_workflow: "Repository bootstrap bundle",
      change_permissions: "Minimum repository permissions",
      merge_to_default_branch: "Default-branch merge",
      publish_release: "Release publication",
      delete_branch: "Branch cleanup",
      external_side_effect: "External action"
    }[action] || action;
  }

  function latestJobs(actions, projectId) {
    const latest = new Map();
    for (const job of Object.values(actions || {}).filter(item => item?.projectId === projectId)) {
      const existing = latest.get(job.action);
      const jobTime = String(job.updatedAt || job.createdAt || "");
      const existingTime = String(existing?.updatedAt || existing?.createdAt || "");
      if (!existing || jobTime.localeCompare(existingTime) >= 0) latest.set(job.action, job);
    }
    return [...latest.values()].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
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
      const jobs = latestJobs(response.actions, projectId);
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
      for (const job of jobs) {
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

  function rebuildProjectSelect(projects, activeProjectId) {
    const select = element("projectSelect");
    if (!select) return;
    select.textContent = "";
    const blank = document.createElement("option");
    blank.value = "";
    blank.textContent = projects.length ? "Choose a project" : "No projects yet";
    select.append(blank);
    for (const project of projects) {
      const option = document.createElement("option");
      option.value = project.projectId;
      option.textContent = `${project.title} · ${project.status}`;
      select.append(option);
    }
    select.value = projects.some(project => project.projectId === activeProjectId) ? activeProjectId : "";
  }

  async function deleteSelectedProject() {
    const projectId = selectedProjectId();
    if (!projectId) return;
    const select = element("projectSelect");
    const title = select?.selectedOptions?.[0]?.textContent?.replace(/\s+·\s+[^·]+$/, "") || projectId;
    const confirmed = globalThis.confirm(
      `Delete “${title}” from AutoPrompter?\n\nThis removes its local plan, tasks, reviews, integration state, approvals, and managed job tabs. It does not delete GitHub content or ChatGPT conversations.`
    );
    if (!confirmed) return;

    const button = element("deleteExistingProject");
    button.disabled = true;
    try {
      const response = await adminRuntime("DELETE_PROJECT", { projectId });
      rebuildProjectSelect(response.projects || [], response.activeProjectId || "");
      const message = element("projectMessage");
      if (message) message.textContent = `Deleted ${title} from AutoPrompter.`;
      if (response.activeProjectId) {
        select.dispatchEvent(new Event("change", { bubbles: true }));
        setTimeout(() => element("inspectProject")?.click(), 0);
      } else {
        const card = element("projectStatusCard");
        if (card) card.hidden = true;
        const summary = element("projectAutomationSummary");
        if (summary) summary.textContent = "Waiting for a project selection.";
        const actions = element("projectAutomationActions");
        if (actions) actions.textContent = "";
      }
    } catch (error) {
      const message = element("projectMessage");
      if (message) message.textContent = error.message;
    } finally {
      updateDeleteButton();
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
