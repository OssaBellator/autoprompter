"use strict";

(() => {
  if (typeof document === "undefined" || typeof chrome === "undefined") return;
  const MESSAGE_SCOPE = "AUTOPROMPTER_RUNTIME";
  const ADMIN_SCOPE = "AUTOPROMPTER_PROJECT_ADMIN";
  const DELETE_CONFIRM_MS = 4000;
  const deletedProjectIds = new Set();
  let armedDelete = null;
  let pickerObserver = null;

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
      ".project-advanced-panel:not([open]){padding-bottom:2px}",
      ".project-toolbar.project-picker-toolbar{display:block}",
      ".project-native-select{display:none!important}",
      ".project-picker{display:grid;gap:5px;position:relative}",
      ".project-picker-label{font-size:12px;font-weight:650}",
      ".project-picker-button{width:100%;display:flex;align-items:center;justify-content:space-between;gap:10px;text-align:left;padding:8px;margin:0;background:Canvas;color:CanvasText}",
      ".project-picker-button span:first-child{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".project-picker-chevron{color:GrayText;font-size:11px;transition:transform .12s ease}",
      ".project-picker-button[aria-expanded=true] .project-picker-chevron{transform:rotate(180deg)}",
      ".project-picker-menu{display:grid;max-height:230px;overflow:auto;border:1px solid color-mix(in srgb, CanvasText 18%, transparent);border-radius:8px;background:Canvas;box-shadow:0 8px 24px color-mix(in srgb, CanvasText 18%, transparent)}",
      ".project-picker-row{display:grid;grid-template-columns:minmax(0,1fr) 30px;align-items:center;gap:4px;padding:3px;border-bottom:1px solid color-mix(in srgb, CanvasText 10%, transparent)}",
      ".project-picker-row:last-child{border-bottom:0}",
      ".project-picker-row.active{background:color-mix(in srgb, Highlight 10%, transparent)}",
      ".project-picker-select{min-width:0;border:0;background:transparent;text-align:left;padding:8px;font-weight:600;color:CanvasText}",
      ".project-picker-select strong,.project-picker-select small{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".project-picker-select small{margin-top:2px;color:GrayText;font-size:10px;font-weight:600}",
      ".project-delete-icon{width:28px;height:28px;padding:5px;border-radius:7px;display:grid;place-items:center;color:GrayText;opacity:0;pointer-events:none;transition:opacity .12s ease,background .12s ease,color .12s ease}",
      ".project-picker-row:hover .project-delete-icon,.project-picker-row:focus-within .project-delete-icon,.project-delete-icon.armed{opacity:1;pointer-events:auto}",
      ".project-delete-icon:hover,.project-delete-icon:focus-visible{color:#b42318;background:color-mix(in srgb,#b42318 10%,transparent)}",
      ".project-delete-icon.armed{color:white;background:#b42318;border-color:#b42318}",
      ".project-delete-icon svg{width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}",
      ".project-picker-empty{padding:12px;color:GrayText;font-size:11px;text-align:center}"
    ].join("");
    document.head.append(style);
  }

  function pickerProjects() {
    const select = element("projectSelect");
    if (!select) return [];
    for (const option of [...select.options]) {
      if (option.value && deletedProjectIds.has(option.value)) option.remove();
    }
    return [...select.options]
      .filter(option => option.value && !deletedProjectIds.has(option.value))
      .map(option => {
        const separator = option.textContent.lastIndexOf(" · ");
        return {
          projectId: option.value,
          title: separator >= 0 ? option.textContent.slice(0, separator) : option.textContent,
          status: separator >= 0 ? option.textContent.slice(separator + 3) : ""
        };
      });
  }

  function closePicker() {
    const button = element("projectPickerButton");
    const menu = element("projectPickerMenu");
    if (!button || !menu) return;
    button.setAttribute("aria-expanded", "false");
    menu.hidden = true;
  }

  function togglePicker() {
    const button = element("projectPickerButton");
    const menu = element("projectPickerMenu");
    if (!button || !menu) return;
    const opening = menu.hidden;
    menu.hidden = !opening;
    button.setAttribute("aria-expanded", String(opening));
    if (opening) menu.querySelector(".project-picker-row.active .project-picker-select, .project-picker-select")?.focus();
  }

  function syncPickerLabel() {
    const select = element("projectSelect");
    const label = element("projectPickerValue");
    if (!select || !label) return;
    const selected = pickerProjects().find(project => project.projectId === select.value);
    label.textContent = selected ? `${selected.title} · ${selected.status}` : (pickerProjects().length ? "Choose a project" : "No projects yet");
  }

  function selectProject(projectId) {
    const select = element("projectSelect");
    if (!select || ![...select.options].some(option => option.value === projectId)) return;
    select.value = projectId;
    syncPickerLabel();
    closePicker();
    select.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function trashIcon() {
    return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="M7 7l1 13h8l1-13"/><path d="M10 11v5M14 11v5"/></svg>';
  }

  function resetArmedDelete() {
    const previous = armedDelete;
    armedDelete = null;
    if (previous?.timer) clearTimeout(previous.timer);
    document.querySelectorAll(".project-delete-icon.armed").forEach(button => {
      button.classList.remove("armed");
      button.setAttribute("aria-label", button.dataset.defaultLabel || "Delete project");
      button.title = button.dataset.defaultLabel || "Delete project";
    });
  }

  function armOrDeleteProject(projectId, title, button) {
    const now = Date.now();
    if (armedDelete?.projectId === projectId && armedDelete.expiresAt > now) {
      resetArmedDelete();
      deleteProject(projectId, title, button).catch(error => {
        const message = element("projectMessage");
        if (message) message.textContent = error.message;
      });
      return;
    }
    resetArmedDelete();
    button.classList.add("armed");
    button.setAttribute("aria-label", `Confirm deletion of ${title}`);
    button.title = `Click again to delete ${title}`;
    const message = element("projectMessage");
    if (message) message.textContent = `Click the trash icon again within ${DELETE_CONFIRM_MS / 1000} seconds to delete ${title}. GitHub content and ChatGPT conversations are not deleted.`;
    const timer = setTimeout(resetArmedDelete, DELETE_CONFIRM_MS);
    armedDelete = { projectId, expiresAt: now + DELETE_CONFIRM_MS, timer };
  }

  function renderProjectPicker() {
    const menu = element("projectPickerMenu");
    if (!menu) return;
    const selectedId = selectedProjectId();
    const projects = pickerProjects();
    menu.textContent = "";
    if (!projects.length) {
      const empty = document.createElement("div");
      empty.className = "project-picker-empty";
      empty.textContent = "No projects yet";
      menu.append(empty);
      syncPickerLabel();
      return;
    }
    for (const project of projects) {
      const row = document.createElement("div");
      row.className = `project-picker-row${project.projectId === selectedId ? " active" : ""}`;
      const choose = document.createElement("button");
      choose.type = "button";
      choose.className = "project-picker-select";
      choose.setAttribute("role", "option");
      choose.setAttribute("aria-selected", String(project.projectId === selectedId));
      const title = document.createElement("strong");
      title.textContent = project.title;
      const status = document.createElement("small");
      status.textContent = project.status || project.projectId;
      choose.append(title, status);
      choose.addEventListener("click", () => selectProject(project.projectId));

      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "project-delete-icon";
      remove.dataset.defaultLabel = `Delete ${project.title}`;
      remove.setAttribute("aria-label", remove.dataset.defaultLabel);
      remove.title = remove.dataset.defaultLabel;
      remove.innerHTML = trashIcon();
      remove.addEventListener("click", event => {
        event.preventDefault();
        event.stopPropagation();
        armOrDeleteProject(project.projectId, project.title, remove);
      });
      row.append(choose, remove);
      menu.append(row);
    }
    syncPickerLabel();
  }

  function installProjectPicker(existingPanel) {
    if (element("projectPicker")) return;
    const select = element("projectSelect");
    const inspect = element("inspectProject");
    const toolbar = inspect?.closest(".project-toolbar") || existingPanel.querySelector(".project-toolbar");
    const selectLabel = select?.closest("label");
    if (!select || !toolbar || !selectLabel) return;

    toolbar.classList.add("project-picker-toolbar");
    selectLabel.classList.add("project-native-select");
    selectLabel.hidden = true;
    select.tabIndex = -1;
    select.setAttribute("aria-hidden", "true");
    if (inspect) inspect.hidden = true;

    const picker = document.createElement("div");
    picker.id = "projectPicker";
    picker.className = "project-picker";
    const label = document.createElement("span");
    label.className = "project-picker-label";
    label.textContent = "Saved project";
    const button = document.createElement("button");
    button.id = "projectPickerButton";
    button.className = "project-picker-button";
    button.type = "button";
    button.setAttribute("aria-haspopup", "listbox");
    button.setAttribute("aria-expanded", "false");
    button.setAttribute("aria-controls", "projectPickerMenu");
    button.innerHTML = '<span id="projectPickerValue">No projects yet</span><span class="project-picker-chevron" aria-hidden="true">▾</span>';
    const menu = document.createElement("div");
    menu.id = "projectPickerMenu";
    menu.className = "project-picker-menu";
    menu.setAttribute("role", "listbox");
    menu.hidden = true;
    picker.append(label, button, menu);
    toolbar.append(picker);

    button.addEventListener("click", togglePicker);
    button.addEventListener("keydown", event => {
      if (["ArrowDown", "Enter", " "].includes(event.key)) {
        event.preventDefault();
        if (menu.hidden) togglePicker();
      } else if (event.key === "Escape") closePicker();
    });
    menu.addEventListener("keydown", event => {
      if (event.key === "Escape") {
        event.preventDefault();
        closePicker();
        button.focus();
      }
    });
    document.addEventListener("click", event => {
      if (!picker.contains(event.target)) closePicker();
    });
    select.addEventListener("change", () => {
      resetArmedDelete();
      renderProjectPicker();
      refreshTaskBoard();
    });
    pickerObserver = new MutationObserver(() => renderProjectPicker());
    pickerObserver.observe(select, { childList: true, subtree: true, attributes: true });
    renderProjectPicker();
  }

  function setupLayout() {
    const existingPanel = element("projectExistingPanel");
    const statusCard = element("projectStatusCard");
    const planner = element("plannerWorkbench");
    const workers = element("workerWorkbench");
    if (!existingPanel || !statusCard || !planner || !workers || element("projectAdvancedPanel")) return;
    installStyles();
    installProjectPicker(existingPanel);

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

    element("inspectProject")?.addEventListener("click", () => setTimeout(refreshTaskBoard, 150));
    element("retryProjectAutomation")?.addEventListener("click", retryAutomation);
    chrome.storage?.onChanged?.addListener((changes, area) => {
      if (area === "local" && (changes.autoprompterProjects || changes.autoprompterProjectRoleJobs)) {
        renderProjectPicker();
        refreshTaskBoard();
      }
    });
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
    for (const project of projects.filter(project => !deletedProjectIds.has(project.projectId))) {
      const option = document.createElement("option");
      option.value = project.projectId;
      option.textContent = `${project.title} · ${project.status}`;
      select.append(option);
    }
    select.value = projects.some(project => project.projectId === activeProjectId) ? activeProjectId : "";
    renderProjectPicker();
  }

  async function deleteProject(projectId, title, button) {
    if (!projectId) return;
    button.disabled = true;
    try {
      const response = await adminRuntime("DELETE_PROJECT", { projectId });
      deletedProjectIds.add(projectId);
      rebuildProjectSelect(response.projects || [], response.activeProjectId || "");
      closePicker();
      const message = element("projectMessage");
      if (message) message.textContent = `Deleted ${title} from AutoPrompter. GitHub content and ChatGPT conversations were not deleted.`;
      const select = element("projectSelect");
      if (response.activeProjectId && [...select.options].some(option => option.value === response.activeProjectId)) {
        select.value = response.activeProjectId;
        select.dispatchEvent(new Event("change", { bubbles: true }));
      } else {
        select.value = "";
        const card = element("projectStatusCard");
        if (card) card.hidden = true;
        summaryReset();
      }
    } finally {
      button.disabled = false;
      renderProjectPicker();
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