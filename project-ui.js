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
      ".project-automation-card>small,.project-task-board,.project-automation-card>button{grid-column:1/-1}",
      ".project-task-board{display:grid;gap:6px}",
      ".project-task-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:3px 8px;padding:8px 0;border-top:1px solid var(--border,#d0d7de)}",
      ".project-task-row:first-child{border-top:0}",
      ".project-task-row strong,.project-task-row small{overflow-wrap:anywhere}",
      ".project-task-row small{grid-column:1/-1}",
      ".project-task-state{font-size:11px;font-weight:600;text-transform:uppercase}",
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
    if (hint) hint.textContent = "Select a saved project. The planner creates a dependency-aware task list; every ready task receives its own branch and fresh ChatGPT worker conversation.";
    const workerHint = element("projectWorkerHint");
    if (workerHint) workerHint.textContent = "Worker chats do not need to be selected. AutoPrompter opens one fresh ChatGPT conversation for each ready task branch. Planner, reviewer, and integrator chats remain separate roles.";

    const automation = document.createElement("section");
    automation.id = "projectAutomationCard";
    automation.className = "project-automation-card";
    automation.innerHTML = [
      "<strong>Branch task board</strong>",
      '<span id="projectAutomationBadge" class="project-status-badge">Fresh chat per task</span>',
      '<small id="projectAutomationSummary">Waiting for a project selection.</small>',
      '<div id="projectTaskBoard" class="project-task-board"></div>',
      '<button id="retryProjectAutomation" class="compact" type="button" hidden>Retry stalled tasks</button>'
    ].join("");

    const advanced = document.createElement("details");
    advanced.id = "projectAdvancedPanel";
    advanced.className = "project-advanced-panel";
    const summary = document.createElement("summary");
    summary.textContent = "Advanced recovery and diagnostics";
    const note = document.createElement("p");
    note.className = "hint";
    note.textContent = "Normal operation needs only the project goal and repository. These controls are retained for inspection, recovery, and manually validating a worker, reviewer, or integrator envelope.";
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
      refreshTaskBoard();
    });
    element("inspectProject")?.addEventListener("click", () => setTimeout(refreshTaskBoard, 150));
    element("retryProjectAutomation")?.addEventListener("click", retryAutomation);
    element("deleteExistingProject")?.addEventListener("click", deleteSelectedProject);
    chrome.storage?.onChanged?.addListener((changes, area) => {
      if (area === "local" && (changes.autoprompterProjects || changes.autoprompterProjectRoleJobs)) {
        updateDeleteButton();
        refreshTaskBoard();
      }
    });
    updateDeleteButton();
    refreshTaskBoard();
  }

  async function runtime(type, extra = {}) {
    const response = await chrome.runtime.sendMessage({ scope: MESSAGE_SCOPE, type, ...extra });
    if (!response || response.ok === false) throw new Error(response?.error || "Project task-board state is unavailable.");
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

  function renderTask(boardElement, task) {
    const row = document.createElement("div");
    row.className = "project-task-row";
    const title = document.createElement("strong");
    title.textContent = task.title || task.id;
    const state = document.createElement("span");
    state.className = "project-task-state";
    state.textContent = task.status;
    row.append(title, state);

    const branch = document.createElement("small");
    branch.textContent = task.branch ? `Branch: ${task.branch}` : "Branch will be assigned when dependencies are accepted.";
    row.append(branch);
    if (task.dependencies?.length) {
      const dependencies = document.createElement("small");
      dependencies.textContent = `Depends on: ${task.dependencies.join(", ")}`;
      row.append(dependencies);
    }
    if (task.commit) {
      const commit = document.createElement("small");
      commit.textContent = `Commit: ${task.commit}`;
      row.append(commit);
    } else if (task.lastStatus) {
      const activity = document.createElement("small");
      activity.textContent = `Activity: ${task.lastStatus}`;
      row.append(activity);
    }
    boardElement.append(row);
  }

  async function refreshTaskBoard() {
    const summary = element("projectAutomationSummary");
    const boardElement = element("projectTaskBoard");
    const retry = element("retryProjectAutomation");
    if (!summary || !boardElement || !retry) return;
    const projectId = selectedProjectId();
    boardElement.textContent = "";
    retry.hidden = true;
    if (!projectId) {
      summary.textContent = "Waiting for a project selection.";
      return;
    }
    try {
      const response = await runtime("GET_PROJECT_AUTOMATION");
      const project = response.projects?.[projectId];
      const board = response.taskBoards?.[projectId];
      if (!project || !board) {
        summary.textContent = "Project task-board state is loading.";
        return;
      }
      const total = board.tasks.length;
      const accepted = board.tasks.filter(task => task.status === "accepted").length;
      const active = board.tasks.filter(task => ["leased", "running", "review"].includes(task.status)).length;
      summary.textContent = `${project.status} · ${accepted}/${total} accepted · ${active} active. Independent tasks run concurrently on separate branches and fresh chats.`;
      if (!total) {
        const empty = document.createElement("small");
        empty.textContent = "The planner task list will appear here after bootstrap.";
        boardElement.append(empty);
        return;
      }
      for (const task of board.tasks) renderTask(boardElement, task);
      retry.hidden = !board.tasks.some(task => ["failed", "cancelled"].includes(task.status) || /expired|error/i.test(task.lastStatus || ""));
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
      `Delete “${title}” from AutoPrompter?\n\nThis removes its local task board, plans, reviews, integration state, and managed tabs. It does not delete GitHub branches or ChatGPT conversations.`
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
        summaryReset();
      }
    } catch (error) {
      const message = element("projectMessage");
      if (message) message.textContent = error.message;
    } finally {
      updateDeleteButton();
    }
  }

  function summaryReset() {
    const summary = element("projectAutomationSummary");
    if (summary) summary.textContent = "Waiting for a project selection.";
    const board = element("projectTaskBoard");
    if (board) board.textContent = "";
  }

  async function retryAutomation() {
    const projectId = selectedProjectId();
    if (!projectId) return;
    const button = element("retryProjectAutomation");
    button.disabled = true;
    try {
      await runtime("RETRY_PROJECT_AUTOMATION", { projectId });
      await refreshTaskBoard();
    } catch (error) {
      element("projectAutomationSummary").textContent = error.message;
    } finally {
      button.disabled = false;
    }
  }

  setupLayout();
})();
