"use strict";

const MESSAGE_SCOPE = "AUTOPROMPTER_RUNTIME";
const SETTINGS_KEY = "autoprompterSettings";
const CATALOG_KEY = "autoprompterChatCatalog";
const SELECTION_KEY = "autoprompterSelectedChatIds";
const CHAT_CONFIGS_KEY = "autoprompterChatConfigs";
const MAX_CONCURRENT_CHATS = 12;
const DEFAULTS = Object.freeze({
  prompt: "Continue from where you left off. Do not repeat completed material.",
  delaySeconds: 10,
  maxContinuations: 5,
  notificationsEnabled: true,
  notifyOnPromptDone: true,
  circuitBreakerEnabled: true,
  continuityEnabled: false,
  repository: "",
  handoffFile: "AUTOPROMPTER_HANDOFF.md",
  pluginInstruction: "Use an action-capable repository plugin or Codex. The read-only GitHub app is not sufficient for commits.",
  contextCapacityTokens: 128000,
  contextThresholdPercent: 90,
  stallMinutes: 15,
  checkpointBeforePrompt: true,
  checkpointAfterPrompt: true,
  maxRollovers: 3
});

const elements = Object.fromEntries([
  "prompt", "delaySeconds", "maxContinuations", "notificationsEnabled", "notifyOnPromptDone", "disableCircuitBreaker",
  "continuityPanel", "continuityEnabled", "repository", "handoffFile", "pluginInstruction",
  "contextCapacityTokens", "contextThresholdPercent", "stallMinutes", "maxRollovers",
  "checkpointBeforePrompt", "checkpointAfterPrompt", "refresh", "filter", "selectAll", "selectNone",
  "chatList", "catalogHint", "selectionSummary", "start", "initializeContinuity", "stop", "statusDot",
  "statusText", "statusDetail", "chatConfigPanel", "chatConfigChat", "chatPrompt", "chatContinuityMode",
  "chatRepository", "chatHandoffFile", "chatPluginInstruction", "saveChatConfig", "clearChatConfig",
  "selectionControls", "progressPanel", "progressSummary", "progressList",
  "projectModePanel", "projectSelect", "inspectProject", "projectStatusCard", "projectStatusTitle",
  "projectStatusBadge", "projectStatusMeta", "projectInspectOutput", "pauseProject", "resumeProject",
  "cancelProject", "projectTitle", "projectGoal", "projectRepository", "projectPlannerChat",
  "projectReviewerChat", "projectIntegratorChat", "projectWorkerHint", "createProject", "projectMessage",
  "plannerWorkbench", "buildPlannerPrompt", "plannerPromptOutput", "plannerResponseInput",
  "validatePlannerOutput", "approveProjectPlan", "discardProjectPlan", "plannerPlanSummary",
  "workerWorkbench", "startProjectMode", "prepareProjectAssignments", "recoverProjectLeases",
  "projectWorkerState", "projectDispatchSelect", "projectDispatchPrompt", "projectModelVerified",
  "dispatchProjectAssignments", "projectResultInput", "submitProjectResult", "buildProjectReviewerPrompt",
  "projectReviewerPrompt", "projectReviewInput", "submitProjectReview", "buildProjectIntegratorPrompt",
  "projectIntegratorPrompt", "projectIntegrationInput", "submitProjectIntegration",
  "approveProjectIntegration", "discardProjectIntegration", "requestProjectIntegrationRetry",
  "projectIntegrationRetryChanges", "projectApprovalAction", "projectApprovalTarget",
  "projectApprovalJustification", "requestProjectApproval", "projectApprovalSelect",
  "projectApprovalDecisionNote", "approveProjectAction", "rejectProjectAction",
  "projectApprovalInstruction", "buildProjectReconciliationPrompt", "projectReconciliationPrompt",
  "projectReconciliationInput", "submitProjectReconciliation", "projectReconciliationSummary",
  "checkProjectSelectorHealth", "projectSelectorHealthOutput"
].map(id => [id, document.getElementById(id)]));

let catalog = [];
let selectedIds = new Set();
let chatConfigs = {};
let schedulerState = null;
let editorOptionKey = "";
let activeChatEditorId = "";
let loadingChatEditor = false;
let chatConfigPersistTimer = null;
let wasRunning = false;
let projectState = {
  projects: [], activeProjectId: null, project: null, events: [],
  pendingPlan: null, approvedPlan: null, tasks: {}, dispatches: {}, results: {}, reviews: {}, integration: null,
  approvals: {}, reconciliation: null, runtimeSummary: null,
  plannerPromptProjectId: ""
};

function isChatGptUrl(value = "") {
  try {
    const host = new URL(value).hostname;
    return host === "chatgpt.com" || host === "chat.openai.com";
  } catch { return false; }
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function formSettings() {
  return {
    prompt: elements.prompt.value.trim() || DEFAULTS.prompt,
    delaySeconds: Math.min(120, Math.max(5, Number(elements.delaySeconds.value) || DEFAULTS.delaySeconds)),
    maxContinuations: Math.min(50, Math.max(1, Math.round(Number(elements.maxContinuations.value) || DEFAULTS.maxContinuations))),
    notificationsEnabled: elements.notificationsEnabled.checked,
    notifyOnPromptDone: elements.notifyOnPromptDone.checked,
    circuitBreakerEnabled: !elements.disableCircuitBreaker.checked,
    continuityEnabled: elements.continuityEnabled.checked,
    repository: elements.repository.value.trim(),
    handoffFile: elements.handoffFile.value.trim() || DEFAULTS.handoffFile,
    pluginInstruction: elements.pluginInstruction.value.trim() || DEFAULTS.pluginInstruction,
    contextCapacityTokens: Math.min(1000000, Math.max(16000, Math.round(Number(elements.contextCapacityTokens.value) || DEFAULTS.contextCapacityTokens))),
    contextThresholdPercent: Math.min(98, Math.max(50, Number(elements.contextThresholdPercent.value) || DEFAULTS.contextThresholdPercent)),
    stallMinutes: Math.min(180, Math.max(5, Number(elements.stallMinutes.value) || DEFAULTS.stallMinutes)),
    checkpointBeforePrompt: elements.checkpointBeforePrompt.checked,
    checkpointAfterPrompt: elements.checkpointAfterPrompt.checked,
    maxRollovers: Math.min(10, Math.max(1, Math.round(Number(elements.maxRollovers.value) || DEFAULTS.maxRollovers)))
  };
}

function fillSettings(settings) {
  const merged = { ...DEFAULTS, ...settings };
  for (const key of ["prompt", "delaySeconds", "maxContinuations", "repository", "handoffFile", "pluginInstruction", "contextCapacityTokens", "contextThresholdPercent", "stallMinutes", "maxRollovers"]) elements[key].value = merged[key];
  for (const key of ["notificationsEnabled", "notifyOnPromptDone", "continuityEnabled", "checkpointBeforePrompt", "checkpointAfterPrompt"]) elements[key].checked = Boolean(merged[key]);
  elements.disableCircuitBreaker.checked = merged.circuitBreakerEnabled === false;
  elements.continuityPanel.open = Boolean(merged.continuityEnabled);
  updateFieldAvailability();
}

async function runtimeMessage(type, extra = {}) {
  return chrome.runtime.sendMessage({ scope: MESSAGE_SCOPE, type, ...extra });
}

async function persistSelection() {
  await chrome.storage.local.set({ [SELECTION_KEY]: [...selectedIds] });
}

async function persistChatConfigs() {
  await chrome.storage.local.set({ [CHAT_CONFIGS_KEY]: chatConfigs });
}

function mergedChatState(chat) {
  return schedulerState?.chats?.find(item => item.id === chat.id) || null;
}

function visibleCatalog() {
  const query = elements.filter.value.trim().toLowerCase();
  if (!query) return catalog;
  return catalog.filter(chat => chat.title.toLowerCase().includes(query));
}

function projectRoleSelects() {
  return [elements.projectPlannerChat, elements.projectReviewerChat, elements.projectIntegratorChat];
}

function refreshProjectRoleOptions() {
  for (const select of projectRoleSelects()) {
    const previous = select.value;
    select.textContent = "";
    const blank = document.createElement("option");
    blank.value = "";
    blank.textContent = "Unassigned";
    select.append(blank);
    for (const chat of catalog) {
      const option = document.createElement("option");
      option.value = chat.id;
      option.textContent = chat.title;
      select.append(option);
    }
    if ([...select.options].some(option => option.value === previous)) select.value = previous;
  }
  updateProjectWorkerHint();
}

function projectRoleIds() {
  return new Set(projectRoleSelects().map(select => select.value).filter(Boolean));
}

function projectWorkerIds() {
  const fixedRoles = projectRoleIds();
  return catalog.filter(chat => selectedIds.has(chat.id) && !fixedRoles.has(chat.id)).map(chat => chat.id);
}

function updateProjectWorkerHint() {
  if (!elements.projectWorkerHint) return;
  const count = projectWorkerIds().length;
  elements.projectWorkerHint.textContent = `${count} selected chat${count === 1 ? "" : "s"} will be stored as workers. Fixed-role chats are excluded automatically.`;
}

function renderProjectWorkerState(project, tasks, dispatches, runtimeSummary) {
  elements.projectWorkerState.textContent = "";
  const activeByWorker = new Map(
    Object.values(dispatches).filter(dispatch => ["prepared", "dispatched", "running"].includes(dispatch.status))
      .map(dispatch => [dispatch.workerChatId, dispatch])
  );
  for (const workerChatId of project.roles.workerChatIds) {
    const row = document.createElement("div");
    row.className = "project-worker-row";
    const name = document.createElement("span");
    name.textContent = workerChatId;
    const state = document.createElement("small");
    const dispatch = activeByWorker.get(workerChatId);
    state.textContent = dispatch ? `${dispatch.taskId} · ${dispatch.status}` : "available";
    row.append(name, state);
    elements.projectWorkerState.append(row);
  }
  for (const task of Object.values(tasks)) {
    const row = document.createElement("div");
    row.className = "project-task-row";
    const name = document.createElement("span");
    name.textContent = `${task.id} · ${task.title}`;
    const state = document.createElement("small");
    state.textContent = task.lease ? `${task.status} · ${task.lease.workerChatId}` : task.status;
    row.append(name, state);
    elements.projectWorkerState.append(row);
  }
  if (!project.roles.workerChatIds.length && !Object.keys(tasks).length) {
    const empty = document.createElement("small");
    empty.textContent = "No workers or task records yet.";
    elements.projectWorkerState.append(empty);
  }

  const previousDispatch = elements.projectDispatchSelect.value;
  elements.projectDispatchSelect.textContent = "";
  const blank = document.createElement("option");
  blank.value = "";
  blank.textContent = Object.keys(dispatches).length ? "Choose a prepared assignment" : "No prepared assignments";
  elements.projectDispatchSelect.append(blank);
  for (const dispatch of Object.values(dispatches).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))) {
    const option = document.createElement("option");
    option.value = dispatch.dispatchId;
    option.textContent = `${dispatch.taskId} → ${dispatch.workerChatId} · ${dispatch.status}`;
    elements.projectDispatchSelect.append(option);
  }
  if ([...elements.projectDispatchSelect.options].some(option => option.value === previousDispatch)) {
    elements.projectDispatchSelect.value = previousDispatch;
  }
  const selected = dispatches[elements.projectDispatchSelect.value];
  elements.projectDispatchPrompt.value = selected?.prompt || "";
  elements.projectDispatchPrompt.placeholder = runtimeSummary?.activeLeaseCount
    ? "Choose a prepared assignment to inspect its local prompt"
    : "Prepared worker prompts remain local until a later dispatch milestone";
}

function renderProjectApprovalState(approvals) {
  const previous = elements.projectApprovalSelect.value;
  elements.projectApprovalSelect.textContent = "";
  const blank = document.createElement("option");
  blank.value = "";
  blank.textContent = Object.keys(approvals).length ? "Choose an approval request" : "No approval requests";
  elements.projectApprovalSelect.append(blank);
  for (const approval of Object.values(approvals).sort((a, b) => String(b.requestedAt).localeCompare(String(a.requestedAt)))) {
    const option = document.createElement("option");
    option.value = approval.approvalId;
    option.textContent = `${approval.action} · ${approval.target} · ${approval.status}`;
    elements.projectApprovalSelect.append(option);
  }
  if ([...elements.projectApprovalSelect.options].some(option => option.value === previous)) {
    elements.projectApprovalSelect.value = previous;
  }
  const selected = approvals[elements.projectApprovalSelect.value];
  elements.projectApprovalInstruction.value = selected?.instruction || "";
  elements.approveProjectAction.disabled = selected?.status !== "pending";
  elements.rejectProjectAction.disabled = selected?.status !== "pending";
}

function renderProjectReconciliationState(project, reconciliation) {
  const latest = reconciliation?.latest || null;
  elements.projectReconciliationSummary.textContent = JSON.stringify({
    required: Boolean(project.repositoryReconciliationRequired),
    lastReconciledAt: project.lastReconciledAt || null,
    latest: latest ? {
      observedAt: latest.observedAt,
      defaultBranchCommit: latest.defaultBranchCommit,
      conflictCount: latest.conflictCount,
      missingCount: latest.missingCount,
      notes: latest.notes
    } : null
  }, null, 2);
}

function renderProjectState() {
  const projects = Array.isArray(projectState.projects) ? projectState.projects : [];
  const previous = elements.projectSelect.value || projectState.activeProjectId || "";
  elements.projectSelect.textContent = "";
  const blank = document.createElement("option");
  blank.value = "";
  blank.textContent = projects.length ? "Choose a project" : "No projects yet";
  elements.projectSelect.append(blank);
  for (const project of projects) {
    const option = document.createElement("option");
    option.value = project.projectId;
    option.textContent = `${project.title} · ${project.status}`;
    elements.projectSelect.append(option);
  }
  if ([...elements.projectSelect.options].some(option => option.value === previous)) elements.projectSelect.value = previous;

  const project = projectState.project;
  elements.projectStatusCard.hidden = !project;
  elements.inspectProject.disabled = !elements.projectSelect.value;
  if (!project) {
    elements.pauseProject.disabled = true;
    elements.resumeProject.disabled = true;
    elements.cancelProject.disabled = true;
    elements.plannerWorkbench.hidden = true;
    elements.workerWorkbench.hidden = true;
    elements.projectWorkerState.textContent = "";
    elements.projectDispatchPrompt.value = "";
    elements.projectApprovalInstruction.value = "";
    elements.projectReconciliationSummary.textContent = "";
    return;
  }
  const tasks = projectState.tasks && typeof projectState.tasks === "object" ? projectState.tasks : {};
  const dispatches = projectState.dispatches && typeof projectState.dispatches === "object" ? projectState.dispatches : {};
  const runtimeSummary = projectState.runtimeSummary || null;
  const results = projectState.results && typeof projectState.results === "object" ? projectState.results : {};
  const reviews = projectState.reviews && typeof projectState.reviews === "object" ? projectState.reviews : {};
  const integration = projectState.integration || null;
  const approvals = projectState.approvals && typeof projectState.approvals === "object" ? projectState.approvals : {};
  const reconciliation = projectState.reconciliation || null;
  const pendingSummary = projectState.pendingPlan ? {
    revision: projectState.pendingPlan.revision,
    phases: projectState.pendingPlan.phases.length,
    tasks: projectState.pendingPlan.tasks.length,
    criticalPath: projectState.pendingPlan.criticalPath
  } : null;
  const approvedSummary = projectState.approvedPlan ? {
    revision: projectState.approvedPlan.revision,
    tasks: projectState.approvedPlan.tasks.length
  } : null;
  elements.projectStatusTitle.textContent = project.title;
  elements.projectStatusBadge.textContent = project.status;
  elements.projectStatusMeta.textContent = `${project.projectId} · ${project.repository.slug} · ${project.roles.workerChatIds.length} worker chat${project.roles.workerChatIds.length === 1 ? "" : "s"}`;
  elements.projectInspectOutput.textContent = JSON.stringify({
    goal: project.goal,
    roles: project.roles,
    scheduler: project.scheduler,
    pendingPlan: pendingSummary,
    approvedPlan: approvedSummary,
    taskStatusCounts: Object.values(tasks).reduce((counts, task) => {
      counts[task.status] = (counts[task.status] || 0) + 1;
      return counts;
    }, {}),
    runtime: runtimeSummary,
    resultCount: Object.keys(results).length,
    reviewCount: Object.keys(reviews).length,
    integration,
    pendingApprovalCount: Object.values(approvals).filter(item => item.status === "pending").length,
    reconciliation,
    recentEvents: (projectState.events || []).slice(-8)
  }, null, 2);
  elements.pauseProject.disabled = !["draft", "planning", "ready", "running"].includes(project.status);
  elements.resumeProject.disabled = project.status !== "paused";
  elements.cancelProject.disabled = ["completed", "failed", "cancelled"].includes(project.status);

  const terminal = ["completed", "failed", "cancelled"].includes(project.status);
  const planningBlocked = terminal || project.status === "paused";
  elements.plannerWorkbench.hidden = false;
  elements.buildPlannerPrompt.disabled = planningBlocked || Boolean(projectState.approvedPlan);
  elements.validatePlannerOutput.disabled = planningBlocked || Boolean(projectState.approvedPlan) || !elements.plannerResponseInput.value.trim();
  elements.approveProjectPlan.disabled = planningBlocked || !projectState.pendingPlan || Boolean(projectState.approvedPlan);
  elements.discardProjectPlan.disabled = !projectState.pendingPlan;
  elements.plannerPlanSummary.textContent = JSON.stringify({
    pending: pendingSummary,
    approved: approvedSummary,
    taskRecordsCreated: Object.keys(tasks).length,
    approvalRequiredBeforeTaskCreation: !projectState.approvedPlan
  }, null, 2);

  elements.workerWorkbench.hidden = false;
  elements.startProjectMode.disabled = project.status !== "ready" || !projectState.approvedPlan || !Object.keys(tasks).length;
  elements.prepareProjectAssignments.disabled = project.status !== "running" || !Object.values(tasks).some(task => task.status === "ready");
  elements.recoverProjectLeases.disabled = !Object.values(tasks).some(task => task.lease);
  const selectedDispatch = dispatches[elements.projectDispatchSelect.value];
  elements.dispatchProjectAssignments.disabled = project.status !== "running"
    || !elements.projectModelVerified.checked
    || !Object.values(dispatches).some(dispatch => dispatch.status === "prepared");
  elements.submitProjectResult.disabled = !selectedDispatch || !elements.projectResultInput.value.trim();
  elements.buildProjectReviewerPrompt.disabled = !selectedDispatch || !results[selectedDispatch.dispatchId];
  elements.submitProjectReview.disabled = !selectedDispatch || !results[selectedDispatch.dispatchId] || !elements.projectReviewInput.value.trim();
  elements.buildProjectIntegratorPrompt.disabled = !runtimeSummary?.integrationReady;
  elements.submitProjectIntegration.disabled = !runtimeSummary?.integrationReady || !elements.projectIntegrationInput.value.trim();
  elements.approveProjectIntegration.disabled = integration?.pending?.status !== "completed";
  elements.discardProjectIntegration.disabled = !integration?.pending;
  elements.requestProjectIntegrationRetry.disabled = !["blocked", "failed"].includes(integration?.pending?.status);
  elements.requestProjectApproval.disabled = terminal
    || !elements.projectApprovalTarget.value.trim()
    || !elements.projectApprovalJustification.value.trim();
  elements.buildProjectReconciliationPrompt.disabled = !projectState.approvedPlan;
  elements.submitProjectReconciliation.disabled = !projectState.approvedPlan || !elements.projectReconciliationInput.value.trim();
  renderProjectWorkerState(project, tasks, dispatches, runtimeSummary);
  renderProjectApprovalState(approvals);
  renderProjectReconciliationState(project, reconciliation);
}

async function refreshProjects({ inspectActive = true } = {}) {
  const response = await runtimeMessage("GET_PROJECTS");
  if (response.ok === false) throw new Error(response.error || "Could not load projects.");
  projectState.projects = response.projects || [];
  projectState.activeProjectId = response.activeProjectId || null;
  if (inspectActive && projectState.activeProjectId) await inspectProject(projectState.activeProjectId);
  else {
    projectState.project = null;
    projectState.events = [];
    projectState.pendingPlan = null;
    projectState.approvedPlan = null;
    projectState.tasks = {};
    projectState.dispatches = {};
    projectState.results = {};
    projectState.reviews = {};
    projectState.integration = null;
    projectState.approvals = {};
    projectState.reconciliation = null;
    projectState.runtimeSummary = null;
    renderProjectState();
  }
}

async function inspectProject(projectId = elements.projectSelect.value) {
  if (!projectId) {
    projectState.project = null;
    projectState.events = [];
    projectState.pendingPlan = null;
    projectState.approvedPlan = null;
    projectState.tasks = {};
    projectState.dispatches = {};
    projectState.results = {};
    projectState.reviews = {};
    projectState.integration = null;
    projectState.approvals = {};
    projectState.reconciliation = null;
    projectState.runtimeSummary = null;
    renderProjectState();
    return;
  }
  const response = await runtimeMessage("INSPECT_PROJECT", { projectId });
  if (response.ok === false) throw new Error(response.error || "Could not inspect project.");
  projectState.activeProjectId = response.activeProjectId || projectId;
  projectState.project = response.project;
  projectState.events = response.events || [];
  projectState.pendingPlan = response.pendingPlan || null;
  projectState.approvedPlan = response.approvedPlan || null;
  projectState.tasks = response.tasks || {};
  projectState.dispatches = response.dispatches || {};
  projectState.results = response.results || {};
  projectState.reviews = response.reviews || {};
  projectState.integration = response.integration || null;
  projectState.approvals = response.approvals || {};
  projectState.reconciliation = response.reconciliation || null;
  projectState.runtimeSummary = response.runtimeSummary || null;
  if (projectState.plannerPromptProjectId && projectState.plannerPromptProjectId !== projectId) {
    elements.plannerPromptOutput.value = "";
    projectState.plannerPromptProjectId = "";
  }
  renderProjectState();
}

async function createProjectDraft() {
  elements.projectMessage.textContent = "";
  const response = await runtimeMessage("CREATE_PROJECT", {
    project: {
      title: elements.projectTitle.value.trim(),
      goal: elements.projectGoal.value.trim(),
      repository: elements.projectRepository.value.trim() || elements.repository.value.trim(),
      plannerChatId: elements.projectPlannerChat.value || null,
      reviewerChatId: elements.projectReviewerChat.value || null,
      integratorChatId: elements.projectIntegratorChat.value || null,
      workerChatIds: projectWorkerIds(),
      circuitBreakerEnabled: !elements.disableCircuitBreaker.checked
    }
  });
  if (response.ok === false) throw new Error(response.error || "Could not create project.");
  projectState.projects = response.projects || [];
  projectState.activeProjectId = response.activeProjectId;
  projectState.project = response.project;
  projectState.events = [];
  elements.projectSelect.value = response.project.projectId;
  elements.projectMessage.textContent = `Created ${response.project.projectId}. No chats were dispatched.`;
  await inspectProject(response.project.projectId);
}

async function generatePlannerPrompt() {
  const projectId = projectState.project?.projectId || elements.projectSelect.value;
  if (!projectId) throw new Error("Choose a project first.");
  const response = await runtimeMessage("BUILD_PLANNER_PROMPT", { projectId });
  if (response.ok === false) throw new Error(response.error || "Could not generate planner prompt.");
  elements.plannerPromptOutput.value = response.prompt;
  projectState.plannerPromptProjectId = projectId;
  elements.projectMessage.textContent = `Planner revision ${response.revision} prompt generated. Copy it to the assigned planner chat; no chat was dispatched.`;
  renderProjectState();
}

async function validatePlannerResponse() {
  const projectId = projectState.project?.projectId || elements.projectSelect.value;
  if (!projectId) throw new Error("Choose a project first.");
  const output = elements.plannerResponseInput.value.trim();
  if (!output) throw new Error("Paste the planner envelope first.");
  const response = await runtimeMessage("SUBMIT_PLANNER_OUTPUT", { projectId, output });
  if (response.ok === false) throw new Error(response.error || "Planner output validation failed.");
  projectState.projects = response.projects || projectState.projects;
  projectState.project = response.project;
  projectState.pendingPlan = response.pendingPlan;
  projectState.approvedPlan = null;
  projectState.tasks = {};
  projectState.dispatches = {};
  projectState.runtimeSummary = null;
  elements.projectMessage.textContent = `Plan revision ${response.planSummary.revision} validated with ${response.planSummary.taskCount} tasks. No task records exist until approval.`;
  await inspectProject(projectId);
}

async function approvePendingProjectPlan() {
  const projectId = projectState.project?.projectId || elements.projectSelect.value;
  if (!projectId) throw new Error("Choose a project first.");
  const response = await runtimeMessage("APPROVE_PROJECT_PLAN", { projectId });
  if (response.ok === false) throw new Error(response.error || "Plan approval failed.");
  projectState.projects = response.projects || projectState.projects;
  projectState.project = response.project;
  projectState.pendingPlan = null;
  projectState.approvedPlan = response.approvedPlan;
  projectState.tasks = response.tasks || {};
  projectState.dispatches = {};
  projectState.runtimeSummary = null;
  elements.projectMessage.textContent = `Approved revision ${response.planSummary.revision}; ${Object.keys(projectState.tasks).length} task records created. Worker dispatch is still disabled.`;
  await inspectProject(projectId);
}

async function discardPendingProjectPlan() {
  const projectId = projectState.project?.projectId || elements.projectSelect.value;
  if (!projectId) throw new Error("Choose a project first.");
  const response = await runtimeMessage("DISCARD_PROJECT_PLAN", { projectId });
  if (response.ok === false) throw new Error(response.error || "Could not discard pending plan.");
  projectState.projects = response.projects || projectState.projects;
  projectState.project = response.project;
  projectState.pendingPlan = null;
  projectState.approvedPlan = response.approvedPlan || null;
  projectState.tasks = response.tasks || {};
  projectState.dispatches = response.dispatches || {};
  projectState.results = response.results || {};
  projectState.reviews = response.reviews || {};
  projectState.integration = response.integration || null;
  projectState.runtimeSummary = response.runtimeSummary || null;
  elements.projectMessage.textContent = "Pending plan discarded. No task records were created.";
  await inspectProject(projectId);
}

async function startProjectModeLocally() {
  const projectId = projectState.project?.projectId || elements.projectSelect.value;
  if (!projectId) throw new Error("Choose a project first.");
  const response = await runtimeMessage("START_PROJECT_MODE", { projectId });
  if (response.ok === false) throw new Error(response.error || "Could not start Project Mode.");
  elements.projectMessage.textContent = "Project started locally. No ChatGPT prompt was sent.";
  await inspectProject(projectId);
}

async function prepareWorkerAssignments() {
  const projectId = projectState.project?.projectId || elements.projectSelect.value;
  if (!projectId) throw new Error("Choose a project first.");
  const response = await runtimeMessage("PREPARE_PROJECT_ASSIGNMENTS", { projectId });
  if (response.ok === false) throw new Error(response.error || "Could not prepare worker assignments.");
  const assignments = response.assignments || [];
  if (assignments.length) elements.projectDispatchSelect.value = assignments[0].dispatchId;
  elements.projectMessage.textContent = assignments.length
    ? `Prepared ${assignments.length} local worker assignment${assignments.length === 1 ? "" : "s"}. No chats were messaged.`
    : "No new assignments were prepared; active leases or dependencies currently consume the available capacity.";
  await inspectProject(projectId);
  if (assignments.length && projectState.dispatches[assignments[0].dispatchId]) {
    elements.projectDispatchSelect.value = assignments[0].dispatchId;
    elements.projectDispatchPrompt.value = projectState.dispatches[assignments[0].dispatchId].prompt;
  }
}

async function recoverExpiredProjectLeases() {
  const projectId = projectState.project?.projectId || elements.projectSelect.value;
  if (!projectId) throw new Error("Choose a project first.");
  const response = await runtimeMessage("RECOVER_PROJECT_LEASES", { projectId });
  if (response.ok === false) throw new Error(response.error || "Could not recover project leases.");
  const count = (response.expiredDispatchIds || []).length;
  elements.projectMessage.textContent = count
    ? `Recovered ${count} expired worker lease${count === 1 ? "" : "s"}; eligible tasks returned to the queue.`
    : "No expired worker leases were found.";
  await inspectProject(projectId);
}

async function transitionProject(type) {
  const projectId = projectState.project?.projectId || elements.projectSelect.value;
  if (!projectId) return;
  const response = await runtimeMessage(type, { projectId });
  if (response.ok === false) throw new Error(response.error || "Project transition failed.");
  projectState.projects = response.projects || projectState.projects;
  projectState.project = response.project;
  projectState.activeProjectId = response.activeProjectId || projectId;
  elements.projectMessage.textContent = `${response.project.title} is now ${response.project.status}.`;
  await inspectProject(projectId);
}


async function dispatchPreparedAssignmentsToWeb() {
  const projectId = projectState.project?.projectId || elements.projectSelect.value;
  if (!projectId) throw new Error("Choose a project first.");
  if (!elements.projectModelVerified.checked) throw new Error("Verify the configured model in every assigned worker chat first.");
  const preparedIds = Object.values(projectState.dispatches).filter(dispatch => dispatch.status === "prepared").map(dispatch => dispatch.dispatchId);
  const response = await runtimeMessage("DISPATCH_PROJECT_ASSIGNMENTS", {
    projectId,
    dispatchIds: preparedIds,
    modelVerified: true
  });
  if (response.ok === false) throw new Error(response.error || "Could not dispatch Project Mode workers.");
  elements.projectMessage.textContent = `Opened ${response.started.length} managed worker chat${response.started.length === 1 ? "" : "s"}. Platform restrictions still stop the project.`;
  elements.projectModelVerified.checked = false;
  await inspectProject(projectId);
}

async function submitSelectedProjectResult() {
  const projectId = projectState.project?.projectId || elements.projectSelect.value;
  const dispatchId = elements.projectDispatchSelect.value;
  if (!projectId || !dispatchId) throw new Error("Choose a project dispatch first.");
  const output = elements.projectResultInput.value.trim();
  if (!output) throw new Error("Paste the exact worker result envelope first.");
  const response = await runtimeMessage("SUBMIT_PROJECT_TASK_RESULT", { projectId, dispatchId, output });
  if (response.ok === false) throw new Error(response.error || "Worker result validation failed.");
  elements.projectMessage.textContent = `${response.task.id} result stored with digest ${response.result.resultDigest}; independent review is required.`;
  elements.projectResultInput.value = "";
  await inspectProject(projectId);
}

async function generateSelectedReviewerPrompt() {
  const projectId = projectState.project?.projectId || elements.projectSelect.value;
  const dispatchId = elements.projectDispatchSelect.value;
  if (!projectId || !dispatchId) throw new Error("Choose a reviewed dispatch first.");
  const response = await runtimeMessage("BUILD_PROJECT_REVIEWER_PROMPT", { projectId, dispatchId });
  if (response.ok === false) throw new Error(response.error || "Could not generate reviewer prompt.");
  elements.projectReviewerPrompt.value = response.prompt;
  elements.projectMessage.textContent = `Reviewer prompt generated for ${response.task.id}. Copy it to the assigned reviewer chat.`;
}

async function submitSelectedProjectReview() {
  const projectId = projectState.project?.projectId || elements.projectSelect.value;
  const dispatchId = elements.projectDispatchSelect.value;
  if (!projectId || !dispatchId) throw new Error("Choose a dispatch first.");
  const output = elements.projectReviewInput.value.trim();
  if (!output) throw new Error("Paste the exact reviewer envelope first.");
  const response = await runtimeMessage("SUBMIT_PROJECT_REVIEW", { projectId, dispatchId, output });
  if (response.ok === false) throw new Error(response.error || "Reviewer decision validation failed.");
  elements.projectMessage.textContent = `${response.task.id}: ${response.review.decision}${response.integrationReady ? "; all tasks are ready for integration" : ""}.`;
  elements.projectReviewInput.value = "";
  elements.projectReviewerPrompt.value = "";
  await inspectProject(projectId);
}

async function generateProjectIntegratorPrompt() {
  const projectId = projectState.project?.projectId || elements.projectSelect.value;
  if (!projectId) throw new Error("Choose a project first.");
  const response = await runtimeMessage("BUILD_PROJECT_INTEGRATOR_PROMPT", { projectId });
  if (response.ok === false) throw new Error(response.error || "Could not generate integrator prompt.");
  elements.projectIntegratorPrompt.value = response.prompt;
  elements.projectMessage.textContent = "Integrator prompt generated. It forbids merging to the default branch or publishing.";
}

async function submitProjectIntegrationEvidence() {
  const projectId = projectState.project?.projectId || elements.projectSelect.value;
  const output = elements.projectIntegrationInput.value.trim();
  if (!projectId || !output) throw new Error("Choose a project and paste integration evidence first.");
  const response = await runtimeMessage("SUBMIT_PROJECT_INTEGRATION", { projectId, output });
  if (response.ok === false) throw new Error(response.error || "Integration validation failed.");
  elements.projectMessage.textContent = `${response.integration.pending.status} integration evidence stored; explicit completion approval is still required.`;
  await inspectProject(projectId);
}

async function approveProjectCompletion() {
  const projectId = projectState.project?.projectId || elements.projectSelect.value;
  if (!projectId) throw new Error("Choose a project first.");
  const response = await runtimeMessage("APPROVE_PROJECT_INTEGRATION", { projectId });
  if (response.ok === false) throw new Error(response.error || "Project completion approval failed.");
  elements.projectMessage.textContent = `${response.project.title} completed at ${response.integration.approved.commit}.`;
  await inspectProject(projectId);
}

async function discardProjectIntegrationEvidence() {
  const projectId = projectState.project?.projectId || elements.projectSelect.value;
  if (!projectId) throw new Error("Choose a project first.");
  const response = await runtimeMessage("DISCARD_PROJECT_INTEGRATION", { projectId });
  if (response.ok === false) throw new Error(response.error || "Could not discard integration evidence.");
  elements.projectIntegrationInput.value = "";
  elements.projectMessage.textContent = "Pending integration evidence discarded.";
  await inspectProject(projectId);
}


async function requestProjectIntegrationRetry() {
  const projectId = projectState.project?.projectId || elements.projectSelect.value;
  if (!projectId) throw new Error("Choose a project first.");
  const requiredChanges = elements.projectIntegrationRetryChanges.value.split(/\r?\n/).map(item => item.trim()).filter(Boolean);
  const response = await runtimeMessage("REQUEST_PROJECT_INTEGRATION_RETRY", { projectId, requiredChanges });
  if (response.ok === false) throw new Error(response.error || "Could not request an integration retry.");
  elements.projectIntegrationInput.value = "";
  elements.projectIntegratorPrompt.value = "";
  elements.projectMessage.textContent = `Integration retry requested; attempt ${Number(response.integration.activeAttempt || 0) + 1} can now be generated.`;
  await inspectProject(projectId);
}

async function requestExternalProjectApproval() {
  const projectId = projectState.project?.projectId || elements.projectSelect.value;
  if (!projectId) throw new Error("Choose a project first.");
  const approval = {
    action: elements.projectApprovalAction.value,
    target: elements.projectApprovalTarget.value.trim(),
    justification: elements.projectApprovalJustification.value.trim()
  };
  const response = await runtimeMessage("REQUEST_PROJECT_APPROVAL", { projectId, approval });
  if (response.ok === false) throw new Error(response.error || "Could not create the approval request.");
  elements.projectApprovalTarget.value = "";
  elements.projectApprovalJustification.value = "";
  elements.projectMessage.textContent = `Added pending approval ${response.approval.approvalId}. No external action was executed.`;
  await inspectProject(projectId);
  elements.projectApprovalSelect.value = response.approval.approvalId;
  renderProjectState();
}

async function decideExternalProjectApproval(decision) {
  const projectId = projectState.project?.projectId || elements.projectSelect.value;
  const approvalId = elements.projectApprovalSelect.value;
  if (!projectId || !approvalId) throw new Error("Choose a pending approval request first.");
  const response = await runtimeMessage("DECIDE_PROJECT_APPROVAL", {
    projectId,
    approvalId,
    decision,
    note: elements.projectApprovalDecisionNote.value.trim()
  });
  if (response.ok === false) throw new Error(response.error || "Could not decide the approval request.");
  elements.projectMessage.textContent = `${approvalId} was ${decision}. AutoPrompter did not execute the action.`;
  await inspectProject(projectId);
  elements.projectApprovalSelect.value = approvalId;
  renderProjectState();
}

async function generateProjectReconciliationPrompt() {
  const projectId = projectState.project?.projectId || elements.projectSelect.value;
  if (!projectId) throw new Error("Choose a project first.");
  const response = await runtimeMessage("BUILD_PROJECT_RECONCILIATION_PROMPT", { projectId });
  if (response.ok === false) throw new Error(response.error || "Could not generate the reconciliation prompt.");
  elements.projectReconciliationPrompt.value = response.prompt;
  elements.projectMessage.textContent = "Read-only reconciliation prompt generated. It does not change repository state.";
}

async function submitProjectReconciliationSnapshot() {
  const projectId = projectState.project?.projectId || elements.projectSelect.value;
  const output = elements.projectReconciliationInput.value.trim();
  if (!projectId || !output) throw new Error("Choose a project and paste a reconciliation envelope first.");
  const response = await runtimeMessage("SUBMIT_PROJECT_RECONCILIATION", { projectId, output });
  if (response.ok === false) throw new Error(response.error || "Repository reconciliation validation failed.");
  const latest = response.reconciliation.latest;
  elements.projectMessage.textContent = `Repository snapshot validated: ${latest.conflictCount} conflicts and ${latest.missingCount} missing artifacts.`;
  await inspectProject(projectId);
}

async function checkProjectSelectorHealth() {
  const response = await runtimeMessage("GET_PROJECT_SELECTOR_HEALTH");
  if (response.ok === false) throw new Error(response.error || "Selector health check failed.");
  elements.projectSelectorHealthOutput.textContent = JSON.stringify(response, null, 2);
  elements.projectMessage.textContent = `Checked ${response.tabs?.length || 0} open ChatGPT tab${response.tabs?.length === 1 ? "" : "s"}.`;
}

function configFor(chatId) {
  const value = chatConfigs[chatId];
  return value && typeof value === "object" ? value : {};
}

function effectiveSettings(chatId, globalSettings, mode = "work") {
  const config = configFor(chatId);
  const continuityMode = config.continuityMode || "inherit";
  const repository = String(config.repository || globalSettings.repository || "").trim();
  const continuityEnabled = mode === "initialize"
    ? Boolean(repository)
    : continuityMode === "enabled" ? true : continuityMode === "disabled" ? false : globalSettings.continuityEnabled;
  return {
    ...globalSettings,
    prompt: String(config.prompt || globalSettings.prompt).trim(),
    repository,
    handoffFile: String(config.handoffFile || globalSettings.handoffFile).trim(),
    pluginInstruction: String(config.pluginInstruction || globalSettings.pluginInstruction).trim(),
    continuityEnabled
  };
}

function readChatEditorConfig() {
  const existing = configFor(activeChatEditorId);
  const config = {
    prompt: elements.chatPrompt.value.trim(),
    continuityMode: elements.chatContinuityMode.value,
    repository: elements.chatRepository.value.trim(),
    handoffFile: elements.chatHandoffFile.value.trim(),
    pluginInstruction: elements.chatPluginInstruction.value.trim(),
    startInNewChat: existing.startInNewChat === true
  };
  for (const key of Object.keys(config)) if (!config[key] || config[key] === "inherit") delete config[key];
  return config;
}

function captureChatEditor({ persist = false, render = false } = {}) {
  if (loadingChatEditor || !activeChatEditorId) return Promise.resolve();
  const config = readChatEditorConfig();
  if (Object.keys(config).length) chatConfigs[activeChatEditorId] = config;
  else delete chatConfigs[activeChatEditorId];
  if (render) renderCatalog();
  if (persist) return persistChatConfigs();
  clearTimeout(chatConfigPersistTimer);
  chatConfigPersistTimer = setTimeout(() => persistChatConfigs().catch(() => {}), 250);
  return Promise.resolve();
}

function loadChatEditor() {
  const id = elements.chatConfigChat.value;
  const config = configFor(id);
  loadingChatEditor = true;
  activeChatEditorId = id;
  elements.chatPrompt.value = config.prompt || "";
  elements.chatContinuityMode.value = config.continuityMode || "inherit";
  elements.chatRepository.value = config.repository || "";
  elements.chatHandoffFile.value = config.handoffFile || "";
  elements.chatPluginInstruction.value = config.pluginInstruction || "";
  loadingChatEditor = false;
}

function refreshChatEditorOptions() {
  captureChatEditor();
  const selectedChats = catalog.filter(item => selectedIds.has(item.id));
  const nextKey = selectedChats.map(chat => `${chat.id}:${chat.title}`).join("|");
  elements.chatConfigPanel.hidden = selectedChats.length === 0;
  if (nextKey === editorOptionKey) return;
  editorOptionKey = nextKey;
  const previous = elements.chatConfigChat.value;
  elements.chatConfigChat.textContent = "";
  for (const chat of selectedChats) {
    const option = document.createElement("option");
    option.value = chat.id;
    option.textContent = chat.title;
    elements.chatConfigChat.append(option);
  }
  if ([...elements.chatConfigChat.options].some(option => option.value === previous)) elements.chatConfigChat.value = previous;
  loadChatEditor();
}

async function setStartInNewChat(chatId, enabled) {
  const config = { ...configFor(chatId) };
  if (enabled) config.startInNewChat = true;
  else delete config.startInNewChat;
  if (Object.keys(config).length) chatConfigs[chatId] = config;
  else delete chatConfigs[chatId];
  await persistChatConfigs();
  renderCatalog();
}

function renderProgressPanel() {
  const chats = Array.isArray(schedulerState?.chats) ? schedulerState.chats : [];
  elements.progressList.textContent = "";
  const completed = chats.filter(chat => chat.failed || chat.retired || chat.status === "Finished" || chat.status === "Initialized").length;
  const active = chats.filter(chat => chat.currentJobId && !chat.failed).length;
  elements.progressSummary.textContent = `${completed}/${chats.length} complete · ${active} active`;
  for (const chat of chats) {
    const row = document.createElement("div");
    row.className = "progress-row";
    const left = document.createElement("div");
    const title = document.createElement("div");
    title.className = "progress-title";
    title.title = chat.title;
    title.textContent = chat.title;
    const meta = document.createElement("small");
    meta.className = "progress-meta";
    const generation = Number(chat.generation || 0) + 1;
    const context = Number(chat.contextPercent || 0);
    meta.textContent = `${chat.status || "Queued"}${generation > 1 ? ` · chat ${generation}` : ""}${context ? ` · context≈${context.toFixed(1)}%` : ""}`;
    left.append(title, meta);
    const value = document.createElement("div");
    value.className = `progress-value${chat.failed ? " error" : ""}`;
    const limit = Number(chat.settings?.maxContinuations || schedulerState?.settings?.maxContinuations || DEFAULTS.maxContinuations);
    value.textContent = `${Number(chat.sentCount || 0)}/${limit}`;
    row.append(left, value);
    elements.progressList.append(row);
  }
}

function updateFieldAvailability() {
  const running = Boolean(schedulerState?.running);
  const continuity = elements.continuityEnabled.checked;
  const continuityFields = [elements.repository, elements.handoffFile, elements.pluginInstruction, elements.contextCapacityTokens, elements.contextThresholdPercent, elements.stallMinutes, elements.maxRollovers, elements.checkpointBeforePrompt, elements.checkpointAfterPrompt];
  for (const field of continuityFields) field.disabled = running || !continuity;
  for (const field of [elements.prompt, elements.delaySeconds, elements.maxContinuations, elements.notificationsEnabled, elements.notifyOnPromptDone, elements.disableCircuitBreaker, elements.continuityEnabled]) field.disabled = running;
  elements.notifyOnPromptDone.disabled = running || !elements.notificationsEnabled.checked;
  for (const field of [elements.chatConfigChat, elements.chatPrompt, elements.chatContinuityMode, elements.chatRepository, elements.chatHandoffFile, elements.chatPluginInstruction, elements.saveChatConfig, elements.clearChatConfig]) field.disabled = running || elements.chatConfigChat.options.length === 0;
}

function renderCatalog() {
  const running = Boolean(schedulerState?.running);
  elements.selectionControls.hidden = running;
  elements.progressPanel.hidden = !running;

  if (running) {
    renderProgressPanel();
  } else {
    const visible = visibleCatalog();
    elements.chatList.textContent = "";
    if (!visible.length) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = catalog.length ? "No chats match the filter." : "No chats loaded.";
      elements.chatList.append(empty);
    }

    for (const chat of visible) {
      const row = document.createElement("div");
      row.className = "chat-row";
      row.setAttribute("role", "option");
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = selectedIds.has(chat.id);
      checkbox.setAttribute("aria-label", `Select ${chat.title}`);
      checkbox.addEventListener("change", async () => {
        if (checkbox.checked) selectedIds.add(chat.id); else selectedIds.delete(chat.id);
        await persistSelection();
        renderCatalog();
      });

      const titleWrap = document.createElement("span");
      const title = document.createElement("span");
      title.className = "chat-title";
      title.title = chat.title;
      title.textContent = chat.title;
      titleWrap.append(title);
      const config = configFor(chat.id);
      const badges = [];
      if (Object.keys(config).some(key => key !== "startInNewChat")) badges.push("custom settings");
      if (config.startInNewChat) badges.push("new chat first");
      if (badges.length) {
        const badge = document.createElement("span");
        badge.className = config.startInNewChat ? "fresh-start-badge" : "configured-badge";
        badge.textContent = badges.join(" · ");
        titleWrap.append(document.createElement("br"), badge);
      }

      const freshStart = document.createElement("button");
      freshStart.type = "button";
      freshStart.className = `fresh-start-button${config.startInNewChat ? " active" : ""}`;
      freshStart.textContent = "↗";
      freshStart.title = config.startInNewChat
        ? "Start in the existing chat instead"
        : "Start this goal in a new chat when the run begins";
      freshStart.setAttribute("aria-label", freshStart.title);
      freshStart.setAttribute("aria-pressed", String(Boolean(config.startInNewChat)));
      freshStart.addEventListener("click", () => setStartInNewChat(chat.id, !config.startInNewChat).catch(error => renderStatus({ ok: false, error: error.message })));

      row.append(checkbox, titleWrap, freshStart);
      elements.chatList.append(row);
    }
  }

  elements.selectionSummary.textContent = running
    ? `${schedulerState?.chats?.length || 0} selected chats running`
    : `${selectedIds.size} selected · ${catalog.length} discovered · max ${MAX_CONCURRENT_CHATS} concurrent`;
  elements.start.disabled = running || selectedIds.size === 0;
  elements.initializeContinuity.disabled = running || selectedIds.size === 0;
  elements.stop.disabled = !running;
  elements.refresh.disabled = running;
  elements.selectAll.disabled = running;
  elements.selectNone.disabled = running;
  refreshChatEditorOptions();
  refreshProjectRoleOptions();
  updateFieldAvailability();
}

function renderStatus(state) {
  schedulerState = state || null;
  const running = Boolean(state?.running);
  if (running && !wasRunning) elements.progressPanel.open = true;
  wasRunning = running;
  const error = Boolean(state?.lastError) || state?.ok === false;
  elements.statusDot.className = `dot${running ? " running" : ""}${error ? " error" : ""}`;
  elements.statusText.textContent = state?.status || state?.error || "Stopped";
  const total = state?.chats?.reduce((sum, chat) => sum + Number(chat.sentCount || 0), 0) || 0;
  const target = state?.chats?.reduce((sum, chat) => sum + Number(chat.settings?.maxContinuations || state.settings?.maxContinuations || 0), 0) || 0;
  const handoffs = state?.handoffHistory?.length ? ` · ${state.handoffHistory.length} handoff${state.handoffHistory.length === 1 ? "" : "s"}` : "";
  elements.statusDetail.textContent = state?.lastError || state?.pausedReason || (target ? `${total} of ${target} prompts completed${handoffs} · v${state.version}` : `v${chrome.runtime.getManifest().version}`);
  renderCatalog();
}

async function saveSettings() {
  const settings = formSettings();
  fillSettings(settings);
  await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
  return settings;
}

async function refreshCatalog() {
  const tab = await activeTab();
  if (!tab?.id || !isChatGptUrl(tab.url)) throw new Error("Open ChatGPT in the active tab, then press Refresh.");
  let response;
  try { response = await chrome.tabs.sendMessage(tab.id, { type: "GET_CHAT_CATALOG" }); }
  catch { throw new Error("Reload the ChatGPT page once after installing the extension."); }
  const previousById = new Map(catalog.map(chat => [chat.id, chat]));
  const observed = Array.isArray(response?.chats) ? response.chats : [];
  const observedIds = new Set(observed.map(chat => chat.id));
  const now = Date.now();
  catalog = [
    ...observed.map((chat, index) => ({ ...previousById.get(chat.id), ...chat, sidebarIndex: index, lastSeenAt: now })),
    ...catalog.filter(chat => !observedIds.has(chat.id))
  ];
  await chrome.storage.local.set({ [CATALOG_KEY]: catalog });
  elements.catalogHint.textContent = `${response?.chats?.length || 0} chats found in current sidebar order (most recent first). Scroll the ChatGPT sidebar and refresh again to collect more.`;
  renderCatalog();
}

function selectedChats(settings, mode) {
  return catalog.filter(chat => selectedIds.has(chat.id)).map(chat => {
    const startInNewChat = mode === "work" && configFor(chat.id).startInNewChat === true;
    const effective = effectiveSettings(chat.id, settings, mode);
    if (startInNewChat && !effective.repository) effective.continuityEnabled = false;
    return { ...chat, startInNewChat, settings: effective };
  });
}

async function start(mode = "work") {
  try {
    await captureChatEditor({ persist: true });
    const settings = await saveSettings();
    const chats = selectedChats(settings, mode);
    if (chats.length > MAX_CONCURRENT_CHATS) throw new Error(`Select at most ${MAX_CONCURRENT_CHATS} chats for one concurrent run.`);
    if (mode === "work") {
      const missing = chats.filter(chat => chat.settings.continuityEnabled && !chat.settings.repository);
      if (missing.length) throw new Error(`Add a repository for: ${missing.map(chat => chat.title).join(", ")}`);
    }
    if (mode === "initialize") {
      const missing = chats.filter(chat => !chat.settings.repository);
      if (missing.length) throw new Error(`Add a repository for: ${missing.map(chat => chat.title).join(", ")}`);
    }
    renderStatus(await runtimeMessage("START_SCHEDULER", { chats, settings, mode }));
  } catch (error) {
    renderStatus({ ok: false, error: error.message, running: false });
  }
}

async function stop() {
  try { renderStatus(await runtimeMessage("STOP_SCHEDULER")); }
  catch (error) { renderStatus({ ok: false, error: error.message, running: false }); }
}

async function refreshState() {
  try { renderStatus(await runtimeMessage("GET_SCHEDULER_STATE")); }
  catch (error) { renderStatus({ ok: false, error: error.message, running: false }); }
}

async function saveChatEditor() {
  await captureChatEditor({ persist: true, render: true });
}

async function clearChatEditor() {
  const id = elements.chatConfigChat.value;
  if (!id) return;
  delete chatConfigs[id];
  await persistChatConfigs();
  activeChatEditorId = id;
  loadChatEditor();
  renderCatalog();
}

async function initialize() {
  const stored = await chrome.storage.local.get([SETTINGS_KEY, CATALOG_KEY, SELECTION_KEY, CHAT_CONFIGS_KEY]);
  fillSettings({ ...DEFAULTS, ...(stored[SETTINGS_KEY] || {}) });
  catalog = Array.isArray(stored[CATALOG_KEY]) ? stored[CATALOG_KEY] : [];
  selectedIds = new Set(Array.isArray(stored[SELECTION_KEY]) ? stored[SELECTION_KEY] : []);
  chatConfigs = stored[CHAT_CONFIGS_KEY] && typeof stored[CHAT_CONFIGS_KEY] === "object" ? stored[CHAT_CONFIGS_KEY] : {};
  renderCatalog();
  await refreshState();
  await refreshProjects();
}

elements.refresh.addEventListener("click", () => refreshCatalog().catch(error => renderStatus({ ok: false, error: error.message })));
elements.filter.addEventListener("input", renderCatalog);
elements.selectAll.addEventListener("click", async () => { for (const chat of visibleCatalog()) selectedIds.add(chat.id); await persistSelection(); renderCatalog(); });
elements.selectNone.addEventListener("click", async () => { selectedIds.clear(); await persistSelection(); renderCatalog(); });
elements.start.addEventListener("click", () => start("work"));
elements.initializeContinuity.addEventListener("click", () => start("initialize"));
elements.stop.addEventListener("click", stop);
elements.chatConfigChat.addEventListener("change", async () => {
  await captureChatEditor({ persist: true });
  loadChatEditor();
});
elements.saveChatConfig.addEventListener("click", () => saveChatEditor().catch(error => renderStatus({ ok: false, error: error.message })));
elements.clearChatConfig.addEventListener("click", () => clearChatEditor().catch(error => renderStatus({ ok: false, error: error.message })));
elements.continuityEnabled.addEventListener("change", () => { elements.continuityPanel.open = elements.continuityEnabled.checked; updateFieldAvailability(); saveSettings().catch(() => {}); });
elements.notificationsEnabled.addEventListener("change", () => { updateFieldAvailability(); saveSettings().catch(() => {}); });
elements.disableCircuitBreaker.addEventListener("change", () => saveSettings().catch(() => {}));
elements.createProject.addEventListener("click", () => createProjectDraft().catch(error => { elements.projectMessage.textContent = error.message; }));
elements.inspectProject.addEventListener("click", () => inspectProject().catch(error => { elements.projectMessage.textContent = error.message; }));
elements.projectSelect.addEventListener("change", () => inspectProject().catch(error => { elements.projectMessage.textContent = error.message; }));
elements.pauseProject.addEventListener("click", () => transitionProject("PAUSE_PROJECT").catch(error => { elements.projectMessage.textContent = error.message; }));
elements.resumeProject.addEventListener("click", () => transitionProject("RESUME_PROJECT").catch(error => { elements.projectMessage.textContent = error.message; }));
elements.cancelProject.addEventListener("click", () => transitionProject("CANCEL_PROJECT").catch(error => { elements.projectMessage.textContent = error.message; }));
elements.buildPlannerPrompt.addEventListener("click", () => generatePlannerPrompt().catch(error => { elements.projectMessage.textContent = error.message; }));
elements.validatePlannerOutput.addEventListener("click", () => validatePlannerResponse().catch(error => { elements.projectMessage.textContent = error.message; }));
elements.approveProjectPlan.addEventListener("click", () => approvePendingProjectPlan().catch(error => { elements.projectMessage.textContent = error.message; }));
elements.discardProjectPlan.addEventListener("click", () => discardPendingProjectPlan().catch(error => { elements.projectMessage.textContent = error.message; }));
elements.startProjectMode.addEventListener("click", () => startProjectModeLocally().catch(error => { elements.projectMessage.textContent = error.message; }));
elements.prepareProjectAssignments.addEventListener("click", () => prepareWorkerAssignments().catch(error => { elements.projectMessage.textContent = error.message; }));
elements.recoverProjectLeases.addEventListener("click", () => recoverExpiredProjectLeases().catch(error => { elements.projectMessage.textContent = error.message; }));
elements.projectDispatchSelect.addEventListener("change", () => {
  const dispatchId = elements.projectDispatchSelect.value;
  elements.projectDispatchPrompt.value = projectState.dispatches[dispatchId]?.prompt || "";
  const storedResult = projectState.results[dispatchId];
  if (storedResult) elements.projectResultInput.value = `AUTOPROMPTER_TASK_RESULT_BEGIN\n${JSON.stringify(storedResult, null, 2)}\nAUTOPROMPTER_TASK_RESULT_END`;
  renderProjectState();
});
elements.projectModelVerified.addEventListener("change", renderProjectState);
elements.dispatchProjectAssignments.addEventListener("click", () => dispatchPreparedAssignmentsToWeb().catch(error => { elements.projectMessage.textContent = error.message; }));
elements.submitProjectResult.addEventListener("click", () => submitSelectedProjectResult().catch(error => { elements.projectMessage.textContent = error.message; }));
elements.buildProjectReviewerPrompt.addEventListener("click", () => generateSelectedReviewerPrompt().catch(error => { elements.projectMessage.textContent = error.message; }));
elements.submitProjectReview.addEventListener("click", () => submitSelectedProjectReview().catch(error => { elements.projectMessage.textContent = error.message; }));
elements.buildProjectIntegratorPrompt.addEventListener("click", () => generateProjectIntegratorPrompt().catch(error => { elements.projectMessage.textContent = error.message; }));
elements.submitProjectIntegration.addEventListener("click", () => submitProjectIntegrationEvidence().catch(error => { elements.projectMessage.textContent = error.message; }));
elements.approveProjectIntegration.addEventListener("click", () => approveProjectCompletion().catch(error => { elements.projectMessage.textContent = error.message; }));
elements.discardProjectIntegration.addEventListener("click", () => discardProjectIntegrationEvidence().catch(error => { elements.projectMessage.textContent = error.message; }));
elements.requestProjectIntegrationRetry.addEventListener("click", () => requestProjectIntegrationRetry().catch(error => { elements.projectMessage.textContent = error.message; }));
elements.requestProjectApproval.addEventListener("click", () => requestExternalProjectApproval().catch(error => { elements.projectMessage.textContent = error.message; }));
elements.approveProjectAction.addEventListener("click", () => decideExternalProjectApproval("approved").catch(error => { elements.projectMessage.textContent = error.message; }));
elements.rejectProjectAction.addEventListener("click", () => decideExternalProjectApproval("rejected").catch(error => { elements.projectMessage.textContent = error.message; }));
elements.projectApprovalSelect.addEventListener("change", renderProjectState);
elements.buildProjectReconciliationPrompt.addEventListener("click", () => generateProjectReconciliationPrompt().catch(error => { elements.projectMessage.textContent = error.message; }));
elements.submitProjectReconciliation.addEventListener("click", () => submitProjectReconciliationSnapshot().catch(error => { elements.projectMessage.textContent = error.message; }));
elements.checkProjectSelectorHealth.addEventListener("click", () => checkProjectSelectorHealth().catch(error => { elements.projectMessage.textContent = error.message; }));
for (const input of [
  elements.projectResultInput, elements.projectReviewInput, elements.projectIntegrationInput,
  elements.projectApprovalTarget, elements.projectApprovalJustification, elements.projectReconciliationInput
]) input.addEventListener("input", renderProjectState);
elements.plannerResponseInput.addEventListener("input", renderProjectState);
for (const select of projectRoleSelects()) select.addEventListener("change", updateProjectWorkerHint);
for (const input of [elements.prompt, elements.delaySeconds, elements.maxContinuations, elements.notifyOnPromptDone, elements.repository, elements.handoffFile, elements.pluginInstruction, elements.contextCapacityTokens, elements.contextThresholdPercent, elements.stallMinutes, elements.maxRollovers, elements.checkpointBeforePrompt, elements.checkpointAfterPrompt]) input.addEventListener("change", () => saveSettings().catch(() => {}));
for (const input of [elements.chatPrompt, elements.chatContinuityMode, elements.chatRepository, elements.chatHandoffFile, elements.chatPluginInstruction]) {
  input.addEventListener(input.tagName === "SELECT" ? "change" : "input", () => captureChatEditor());
}

initialize().catch(error => renderStatus({ ok: false, error: error.message }));
const timer = setInterval(refreshState, 1000);
addEventListener("unload", () => clearInterval(timer));
