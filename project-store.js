"use strict";

(function attachProjectStore(root, factory) {
  const plannerProtocol = root.AutoPrompterPlannerProtocol
    || (typeof require === "function" ? require("./planner-protocol.js") : null);
  const workerProtocol = root.AutoPrompterWorkerProtocol
    || (typeof require === "function" ? require("./worker-protocol.js") : null);
  const api = factory(plannerProtocol, workerProtocol);
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.AutoPrompterProjectStore = api;
})(typeof globalThis !== "undefined" ? globalThis : self, (PlannerProtocol, WorkerProtocol) => {
  const PROJECTS_KEY = "autoprompterProjects";
  const STORE_SCHEMA_VERSION = "1.2";
  const PROJECT_SCHEMA_VERSION = "1.0";
  const MAX_PROJECT_EVENTS = 200;
  const ACTIVE_STATUSES = new Set(["draft", "planning", "ready", "running"]);
  const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);
  const APPROVAL_ACTIONS = [
    "merge_to_default_branch",
    "delete_branch",
    "publish_release",
    "modify_workflow",
    "change_permissions",
    "external_side_effect"
  ];

  function clone(value) {
    return value == null ? value : structuredClone(value);
  }

  function nowIso(clock = Date.now) {
    return new Date(clock()).toISOString();
  }

  function clampInteger(value, fallback, min, max) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, Math.round(parsed)));
  }

  function normalizeRepository(value) {
    const raw = String(value || "").trim();
    if (!raw) return "";
    let candidate = raw;
    try {
      if (/^https?:\/\//i.test(raw)) {
        const url = new URL(raw);
        if (url.hostname !== "github.com" && url.hostname !== "www.github.com") return "";
        candidate = url.pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
      }
    } catch {
      return "";
    }
    return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(candidate) ? candidate : "";
  }

  function normalizeRelativePath(value, fallback = "AUTOPROMPTER_HANDOFF.md") {
    const path = String(value || fallback).trim().replace(/^\/+/, "");
    if (!path || path.includes("..") || path.includes("\0") || !/^[A-Za-z0-9_./-]+$/.test(path)) return fallback;
    return path.slice(0, 200);
  }

  function slugifyProjectId(value) {
    return String(value || "project")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "")
      .slice(0, 48) || "project";
  }

  function normalizeChatId(value) {
    const id = String(value || "").trim();
    return id ? id.slice(0, 200) : null;
  }

  function uniqueChatIds(values) {
    return [...new Set((Array.isArray(values) ? values : []).map(normalizeChatId).filter(Boolean))].slice(0, 12);
  }

  function defaultModelPolicy() {
    return {
      mode: "manual_verified",
      classes: {
        fast: { displayName: "User-selected fast ChatGPT model", requiresUserVerification: true },
        standard: { displayName: "User-selected general ChatGPT model", requiresUserVerification: true },
        deep: { displayName: "User-selected high-reasoning ChatGPT model", requiresUserVerification: true }
      }
    };
  }

  function emptyStore() {
    return {
      schemaVersion: STORE_SCHEMA_VERSION,
      activeProjectId: null,
      projects: {},
      resumeStatusByProject: {},
      pendingPlansByProject: {},
      approvedPlansByProject: {},
      tasksByProject: {},
      dispatchesByProject: {},
      events: []
    };
  }

  function normalizeStoredProject(project) {
    if (!project || typeof project !== "object") return null;
    const repository = normalizeRepository(project.repository?.slug);
    if (!repository) return null;
    const projectId = String(project.projectId || "").trim();
    if (!/^[a-z0-9][a-z0-9._-]{2,63}$/.test(projectId)) return null;
    const status = ["draft", "planning", "ready", "running", "paused", "completed", "failed", "cancelled"].includes(project.status)
      ? project.status
      : "draft";
    const roles = project.roles || {};
    const workerChatIds = uniqueChatIds(roles.workerChatIds);
    const roleIds = [roles.plannerChatId, roles.reviewerChatId, roles.integratorChatId].map(normalizeChatId);
    if (new Set(roleIds.filter(Boolean)).size !== roleIds.filter(Boolean).length) return null;
    const roleSet = new Set(roleIds.filter(Boolean));
    const filteredWorkers = workerChatIds.filter(id => !roleSet.has(id));
    const createdAt = String(project.createdAt || new Date(0).toISOString());
    const updatedAt = String(project.updatedAt || createdAt);
    return {
      schemaVersion: PROJECT_SCHEMA_VERSION,
      projectId,
      title: String(project.title || "Untitled project").trim().slice(0, 160) || "Untitled project",
      goal: String(project.goal || "").trim().slice(0, 12000),
      classification: ["one_off", "project", "large_project"].includes(project.classification) ? project.classification : "large_project",
      status,
      repository: {
        slug: repository,
        defaultBranch: String(project.repository?.defaultBranch || "main").trim().slice(0, 200) || "main",
        handoffFile: normalizeRelativePath(project.repository?.handoffFile)
      },
      roles: {
        plannerChatId: roleIds[0],
        reviewerChatId: roleIds[1],
        integratorChatId: roleIds[2],
        workerChatIds: filteredWorkers
      },
      scheduler: {
        maxConcurrentWorkers: clampInteger(project.scheduler?.maxConcurrentWorkers, Math.max(1, Math.min(3, filteredWorkers.length || 1)), 1, 12),
        readinessGraceMs: clampInteger(project.scheduler?.readinessGraceMs, 5000, 1000, 60000),
        leaseMinutes: clampInteger(project.scheduler?.leaseMinutes, 120, 5, 1440),
        revisionLimit: clampInteger(project.scheduler?.revisionLimit, 2, 0, 10),
        circuitBreakerEnabled: project.scheduler?.circuitBreakerEnabled !== false,
        approvalActions: [...new Set((Array.isArray(project.scheduler?.approvalActions)
          ? project.scheduler.approvalActions
          : APPROVAL_ACTIONS).filter(action => APPROVAL_ACTIONS.includes(action)))]
      },
      modelPolicy: clone(project.modelPolicy && typeof project.modelPolicy === "object" ? project.modelPolicy : defaultModelPolicy()),
      createdAt,
      updatedAt
    };
  }

  function migrateStore(raw) {
    if (!raw) return { store: emptyStore(), migrated: true };
    if ([STORE_SCHEMA_VERSION, "1.1", "1.0"].includes(raw.schemaVersion) && raw.projects && !Array.isArray(raw.projects)) {
      const store = emptyStore();
      for (const [id, project] of Object.entries(raw.projects)) {
        const normalized = normalizeStoredProject(project);
        if (normalized && normalized.projectId === id) store.projects[id] = normalized;
      }
      store.activeProjectId = store.projects[raw.activeProjectId] ? raw.activeProjectId : null;
      store.resumeStatusByProject = raw.resumeStatusByProject && typeof raw.resumeStatusByProject === "object"
        ? Object.fromEntries(Object.entries(raw.resumeStatusByProject).filter(([id, status]) => store.projects[id] && ACTIVE_STATUSES.has(status)))
        : {};
      if ([STORE_SCHEMA_VERSION, "1.1"].includes(raw.schemaVersion) && PlannerProtocol) {
        for (const [projectId, plan] of Object.entries(raw.pendingPlansByProject || {})) {
          const project = store.projects[projectId];
          if (!project) continue;
          try { store.pendingPlansByProject[projectId] = PlannerProtocol.validatePlan(plan, project, plan.revision); } catch { /* discard invalid stored plans */ }
        }
        for (const [projectId, plan] of Object.entries(raw.approvedPlansByProject || {})) {
          const project = store.projects[projectId];
          if (!project) continue;
          try { store.approvedPlansByProject[projectId] = PlannerProtocol.validatePlan(plan, project, plan.revision); } catch { /* discard invalid stored plans */ }
        }
        for (const [projectId, tasks] of Object.entries(raw.tasksByProject || {})) {
          if (store.projects[projectId] && tasks && typeof tasks === "object" && !Array.isArray(tasks)) store.tasksByProject[projectId] = clone(tasks);
        }
        if (raw.schemaVersion === STORE_SCHEMA_VERSION) {
          for (const [projectId, dispatches] of Object.entries(raw.dispatchesByProject || {})) {
            if (store.projects[projectId] && dispatches && typeof dispatches === "object" && !Array.isArray(dispatches)) {
              store.dispatchesByProject[projectId] = clone(dispatches);
            }
          }
        }
      }
      store.events = Array.isArray(raw.events) ? raw.events.slice(-MAX_PROJECT_EVENTS) : [];
      return { store, migrated: raw.schemaVersion !== STORE_SCHEMA_VERSION || JSON.stringify(store) !== JSON.stringify(raw) };
    }
    if (raw.schemaVersion === "0.1" && Array.isArray(raw.projects)) {
      const store = emptyStore();
      for (const project of raw.projects) {
        const normalized = normalizeStoredProject(project);
        if (normalized) store.projects[normalized.projectId] = normalized;
      }
      store.activeProjectId = store.projects[raw.activeProjectId] ? raw.activeProjectId : Object.keys(store.projects)[0] || null;
      return { store, migrated: true };
    }
    throw new Error(`Unsupported Project Mode store schema: ${String(raw.schemaVersion || "unknown")}`);
  }

  function appendEvent(store, type, projectId, at, detail = "") {
    store.events.push({
      id: `${at}:${type}:${projectId}:${store.events.length}`,
      type,
      projectId,
      at,
      detail: String(detail || "").slice(0, 500)
    });
    store.events = store.events.slice(-MAX_PROJECT_EVENTS);
  }

  function createProject(storeInput, input, clock = Date.now) {
    const store = clone(storeInput);
    const title = String(input?.title || "").trim().slice(0, 160);
    const goal = String(input?.goal || "").trim().slice(0, 12000);
    const repository = normalizeRepository(input?.repository);
    if (!title) throw new Error("Project title is required.");
    if (!goal) throw new Error("Project goal is required.");
    if (!repository) throw new Error("A valid GitHub repository is required.");

    const plannerChatId = normalizeChatId(input?.plannerChatId);
    const reviewerChatId = normalizeChatId(input?.reviewerChatId);
    const integratorChatId = normalizeChatId(input?.integratorChatId);
    const fixedRoles = [plannerChatId, reviewerChatId, integratorChatId].filter(Boolean);
    if (new Set(fixedRoles).size !== fixedRoles.length) throw new Error("Planner, reviewer, and integrator chats must be different.");
    const fixedRoleSet = new Set(fixedRoles);
    const workerChatIds = uniqueChatIds(input?.workerChatIds).filter(id => !fixedRoleSet.has(id));

    const baseId = slugifyProjectId(input?.projectId || title);
    let projectId = baseId;
    let suffix = 2;
    while (store.projects[projectId]) projectId = `${baseId.slice(0, 58)}-${suffix++}`;
    if (projectId.length < 3) projectId = `project-${Math.abs(clock()).toString(36).slice(-8)}`;
    const at = nowIso(clock);
    const project = normalizeStoredProject({
      schemaVersion: PROJECT_SCHEMA_VERSION,
      projectId,
      title,
      goal,
      classification: input?.classification || "large_project",
      status: "draft",
      repository: {
        slug: repository,
        defaultBranch: input?.defaultBranch || "main",
        handoffFile: input?.handoffFile || "AUTOPROMPTER_HANDOFF.md"
      },
      roles: { plannerChatId, reviewerChatId, integratorChatId, workerChatIds },
      scheduler: {
        maxConcurrentWorkers: input?.maxConcurrentWorkers || Math.max(1, Math.min(3, workerChatIds.length || 1)),
        readinessGraceMs: input?.readinessGraceMs || 5000,
        leaseMinutes: input?.leaseMinutes || 120,
        revisionLimit: input?.revisionLimit ?? 2,
        circuitBreakerEnabled: input?.circuitBreakerEnabled !== false,
        approvalActions: input?.approvalActions || APPROVAL_ACTIONS
      },
      modelPolicy: input?.modelPolicy || defaultModelPolicy(),
      createdAt: at,
      updatedAt: at
    });
    if (!project) throw new Error("Project could not be normalized.");
    store.projects[projectId] = project;
    store.activeProjectId = projectId;
    appendEvent(store, "project_created", projectId, at, "Project Mode draft created");
    return { store, project: clone(project) };
  }

  function requirePlannerProtocol() {
    if (!PlannerProtocol) throw new Error("Planner protocol is unavailable.");
    return PlannerProtocol;
  }

  function requireWorkerProtocol() {
    if (!WorkerProtocol) throw new Error("Worker protocol is unavailable.");
    return WorkerProtocol;
  }

  function taskDependenciesAccepted(tasks, task) {
    return task.dependencies.every(dependencyId => tasks[dependencyId]?.status === "accepted");
  }

  function reconcileTaskReadiness(tasks, at) {
    const unlocked = [];
    for (const task of Object.values(tasks || {})) {
      if (!task || ["leased", "running", "review", "revision_required", "accepted", "failed", "cancelled"].includes(task.status)) continue;
      const nextStatus = taskDependenciesAccepted(tasks, task) ? "ready" : "blocked";
      if (task.status !== nextStatus) {
        task.status = nextStatus;
        task.updatedAt = at;
        if (nextStatus === "ready") unlocked.push(task.id);
      }
    }
    return unlocked;
  }

  function orderedTaskIds(store, projectId) {
    const tasks = store.tasksByProject[projectId] || {};
    const planOrder = (store.approvedPlansByProject[projectId]?.tasks || []).map(task => task.id);
    const known = new Set(planOrder);
    return [...planOrder, ...Object.keys(tasks).filter(id => !known.has(id)).sort()];
  }

  function activeDispatchesForProject(store, projectId) {
    return requireWorkerProtocol().activeDispatches(store.dispatchesByProject[projectId] || {});
  }

  function reconcileProjectRuntimeMutable(store, projectId, clock = Date.now) {
    const project = store.projects[projectId];
    if (!project) return { changed: false, expiredDispatchIds: [], unlockedTaskIds: [] };
    const tasks = store.tasksByProject[projectId] || {};
    const dispatches = store.dispatchesByProject[projectId] || {};
    const at = nowIso(clock);
    const now = clock();
    const expiredDispatchIds = [];
    let changed = false;

    for (const task of Object.values(tasks)) {
      if (!["leased", "running"].includes(task?.status)) continue;
      if (!task.lease) {
        task.branch = null;
        task.status = taskDependenciesAccepted(tasks, task) ? "ready" : "blocked";
        task.updatedAt = at;
        changed = true;
        continue;
      }
      if (!requireWorkerProtocol().isLeaseExpired(task.lease, now)) continue;
      const dispatchId = task.lease.dispatchId;
      const dispatch = dispatches[dispatchId];
      if (dispatch && requireWorkerProtocol().ACTIVE_DISPATCH_STATUSES.includes(dispatch.status)) {
        dispatch.status = "expired";
        dispatch.expiredAt = at;
        dispatch.updatedAt = at;
      }
      task.lease = null;
      task.branch = null;
      task.status = taskDependenciesAccepted(tasks, task) ? "ready" : "blocked";
      task.updatedAt = at;
      expiredDispatchIds.push(dispatchId || task.id);
      changed = true;
    }

    for (const dispatch of Object.values(dispatches)) {
      if (!requireWorkerProtocol().ACTIVE_DISPATCH_STATUSES.includes(dispatch?.status)) continue;
      const task = tasks[dispatch.taskId];
      if (task?.lease?.dispatchId === dispatch.dispatchId && task.lease.workerChatId === dispatch.workerChatId) continue;
      dispatch.status = "expired";
      dispatch.expiredAt = at;
      dispatch.updatedAt = at;
      if (!expiredDispatchIds.includes(dispatch.dispatchId)) expiredDispatchIds.push(dispatch.dispatchId);
      changed = true;
    }

    const unlockedTaskIds = reconcileTaskReadiness(tasks, at);
    if (unlockedTaskIds.length) changed = true;
    if (changed) {
      store.tasksByProject[projectId] = tasks;
      store.dispatchesByProject[projectId] = dispatches;
      project.updatedAt = at;
      for (const dispatchId of expiredDispatchIds) {
        appendEvent(store, "worker_lease_expired", projectId, at, `Released expired dispatch ${dispatchId}`);
      }
      if (unlockedTaskIds.length) {
        appendEvent(store, "tasks_unblocked", projectId, at, `Ready tasks: ${unlockedTaskIds.join(", ")}`);
      }
    }
    return { changed, expiredDispatchIds, unlockedTaskIds };
  }

  function recoverAllProjectLeases(storeInput, clock = Date.now) {
    const store = clone(storeInput);
    let changed = false;
    const recovered = {};
    for (const projectId of Object.keys(store.projects)) {
      const result = reconcileProjectRuntimeMutable(store, projectId, clock);
      if (result.changed) {
        changed = true;
        recovered[projectId] = result;
      }
    }
    return { store, changed, recovered };
  }

  function startProject(storeInput, projectId, clock = Date.now) {
    const store = clone(storeInput);
    const { id, project } = selectedProject(store, projectId);
    if (project.status !== "ready") throw new Error("Only a ready project can be started.");
    if (!store.approvedPlansByProject[id] || !Object.keys(store.tasksByProject[id] || {}).length) {
      throw new Error("Approve a planner result before starting the project.");
    }
    if (!project.roles.workerChatIds.length) throw new Error("At least one worker chat is required before starting.");
    const at = nowIso(clock);
    project.status = "running";
    project.updatedAt = at;
    store.activeProjectId = id;
    appendEvent(store, "project_started", id, at, "Project entered local assignment-preparation mode; no chats were dispatched");
    return { store, project: clone(project) };
  }

  function prepareProjectDispatches(storeInput, projectId, clock = Date.now) {
    const store = clone(storeInput);
    const { id, project } = selectedProject(store, projectId);
    if (project.status !== "running") throw new Error("Start the ready project before preparing worker assignments.");
    const plan = store.approvedPlansByProject[id];
    const tasks = store.tasksByProject[id] || {};
    if (!plan || !Object.keys(tasks).length) throw new Error("No approved tasks are available for assignment.");

    reconcileProjectRuntimeMutable(store, id, clock);
    const workerProtocol = requireWorkerProtocol();
    const dispatches = store.dispatchesByProject[id] || {};
    const active = workerProtocol.activeDispatches(dispatches);
    const occupiedWorkers = new Set(active.map(dispatch => dispatch.workerChatId));
    const availableWorkers = project.roles.workerChatIds.filter(workerId => !occupiedWorkers.has(workerId));
    const remainingCapacity = Math.max(0, project.scheduler.maxConcurrentWorkers - active.length);
    const readyTasks = orderedTaskIds(store, id)
      .map(taskId => tasks[taskId])
      .filter(task => task?.status === "ready" && !task.lease);
    const assignmentCount = Math.min(remainingCapacity, availableWorkers.length, readyTasks.length);
    const at = nowIso(clock);
    const expiresAt = new Date(clock() + project.scheduler.leaseMinutes * 60_000).toISOString();
    const assignments = [];

    for (let index = 0; index < assignmentCount; index += 1) {
      const task = readyTasks[index];
      const workerChatId = availableWorkers[index];
      const attempt = Math.min(50, Number(task.attempt || 0) + 1);
      if (attempt <= Number(task.attempt || 0)) throw new Error(`${task.id} exceeded the maximum lease attempts.`);
      const dispatchId = workerProtocol.buildDispatchId({
        projectId: id,
        revision: plan.revision,
        taskId: task.id,
        attempt,
        workerChatId
      });
      const branch = workerProtocol.buildBranchName(id, task.id, attempt);
      if (dispatches[dispatchId]) throw new Error(`Dispatch ID collision for ${task.id}.`);
      const dispatch = {
        schemaVersion: workerProtocol.DISPATCH_SCHEMA_VERSION,
        dispatchId,
        projectId: id,
        planRevision: plan.revision,
        taskId: task.id,
        workerChatId,
        attempt,
        branch,
        status: "prepared",
        assignedAt: at,
        expiresAt,
        prompt: "",
        createdAt: at,
        updatedAt: at,
        expiredAt: null
      };
      dispatch.prompt = workerProtocol.buildWorkerPrompt(project, task, dispatch);
      dispatches[dispatchId] = dispatch;
      task.status = "leased";
      task.attempt = attempt;
      task.branch = branch;
      task.lease = { dispatchId, workerChatId, assignedAt: at, expiresAt, attempt };
      task.updatedAt = at;
      assignments.push(clone(dispatch));
      appendEvent(store, "worker_dispatch_prepared", id, at, `${dispatchId} assigned ${task.id} to ${workerChatId}; no chat was messaged`);
    }

    store.tasksByProject[id] = tasks;
    store.dispatchesByProject[id] = dispatches;
    if (assignments.length) project.updatedAt = at;
    store.activeProjectId = id;
    return {
      store,
      project: clone(project),
      tasks: clone(tasks),
      dispatches: clone(dispatches),
      assignments,
      runtimeSummary: workerProtocol.summarizeRuntime(project, tasks, dispatches)
    };
  }

  function recoverProjectLeases(storeInput, projectId, clock = Date.now) {
    const store = clone(storeInput);
    const { id, project } = selectedProject(store, projectId);
    const result = reconcileProjectRuntimeMutable(store, id, clock);
    store.activeProjectId = id;
    return {
      store,
      project: clone(project),
      tasks: clone(store.tasksByProject[id] || {}),
      dispatches: clone(store.dispatchesByProject[id] || {}),
      expiredDispatchIds: result.expiredDispatchIds,
      unlockedTaskIds: result.unlockedTaskIds,
      runtimeSummary: requireWorkerProtocol().summarizeRuntime(project, store.tasksByProject[id] || {}, store.dispatchesByProject[id] || {})
    };
  }

  function selectedProject(store, projectId = "") {
    const id = String(projectId || store.activeProjectId || "");
    const project = store.projects[id];
    if (!project) throw new Error("Project not found.");
    return { id, project };
  }

  function nextPlanRevision(store, projectId) {
    return Number(store.approvedPlansByProject[projectId]?.revision || 0) + 1;
  }

  function buildProjectPlannerPrompt(storeInput, projectId = "") {
    const store = clone(storeInput);
    const { id, project } = selectedProject(store, projectId);
    if (TERMINAL_STATUSES.has(project.status)) throw new Error(`Cannot plan a ${project.status} project.`);
    if (project.status === "paused") throw new Error("Resume the project before planning.");
    if (store.approvedPlansByProject[id] || Object.keys(store.tasksByProject[id] || {}).length) {
      throw new Error("This milestone supports only the first approved plan. Plan revisions are not enabled yet.");
    }
    const revision = nextPlanRevision(store, id);
    return { store, project: clone(project), revision, prompt: requirePlannerProtocol().buildPlannerPrompt(project, revision) };
  }

  function submitProjectPlannerOutput(storeInput, projectId, output, clock = Date.now) {
    const store = clone(storeInput);
    const { id, project } = selectedProject(store, projectId);
    if (TERMINAL_STATUSES.has(project.status)) throw new Error(`Cannot plan a ${project.status} project.`);
    if (project.status === "paused") throw new Error("Resume the project before submitting a plan.");
    if (store.approvedPlansByProject[id] || Object.keys(store.tasksByProject[id] || {}).length) {
      throw new Error("An approved plan already exists. Plan revisions are not enabled yet.");
    }
    const protocol = requirePlannerProtocol();
    const revision = nextPlanRevision(store, id);
    const plan = protocol.validatePlan(protocol.parsePlannerEnvelope(output), project, revision);
    const at = nowIso(clock);
    store.pendingPlansByProject[id] = plan;
    project.status = "planning";
    project.updatedAt = at;
    store.activeProjectId = id;
    appendEvent(store, "plan_validated", id, at, `Revision ${plan.revision} validated with ${plan.tasks.length} tasks; approval required`);
    return { store, project: clone(project), pendingPlan: clone(plan), summary: protocol.summarizePlan(plan) };
  }

  function approveProjectPlan(storeInput, projectId, clock = Date.now) {
    const store = clone(storeInput);
    const { id, project } = selectedProject(store, projectId);
    if (TERMINAL_STATUSES.has(project.status)) throw new Error(`Cannot approve a plan for a ${project.status} project.`);
    if (project.status === "paused") throw new Error("Resume the project before approving its plan.");
    const plan = store.pendingPlansByProject[id];
    if (!plan) throw new Error("No validated pending plan is available for approval.");
    if (store.approvedPlansByProject[id] || Object.keys(store.tasksByProject[id] || {}).length) {
      throw new Error("An approved plan or task records already exist.");
    }
    const protocol = requirePlannerProtocol();
    const canonical = protocol.validatePlan(plan, project, nextPlanRevision(store, id));
    const at = nowIso(clock);
    const tasks = protocol.buildTaskRecords(canonical, project, clock);
    store.approvedPlansByProject[id] = canonical;
    store.tasksByProject[id] = tasks;
    delete store.pendingPlansByProject[id];
    project.status = "ready";
    project.updatedAt = at;
    store.activeProjectId = id;
    appendEvent(store, "plan_approved", id, at, `Revision ${canonical.revision} approved; ${Object.keys(tasks).length} task records created`);
    return { store, project: clone(project), approvedPlan: clone(canonical), tasks: clone(tasks), summary: protocol.summarizePlan(canonical) };
  }

  function discardProjectPlan(storeInput, projectId, clock = Date.now) {
    const store = clone(storeInput);
    const { id, project } = selectedProject(store, projectId);
    if (!store.pendingPlansByProject[id]) throw new Error("No pending plan is available to discard.");
    delete store.pendingPlansByProject[id];
    if (project.status === "planning") project.status = "draft";
    const at = nowIso(clock);
    project.updatedAt = at;
    store.activeProjectId = id;
    appendEvent(store, "plan_discarded", id, at, "Pending planner output discarded before task creation");
    return { store, project: clone(project) };
  }

  function inspectProject(storeInput, projectId = "") {
    const store = clone(storeInput);
    const id = String(projectId || store.activeProjectId || "");
    const project = store.projects[id];
    if (!project) throw new Error("Project not found.");
    return {
      store,
      project: clone(project),
      events: store.events.filter(event => event.projectId === id),
      pendingPlan: clone(store.pendingPlansByProject[id] || null),
      approvedPlan: clone(store.approvedPlansByProject[id] || null),
      tasks: clone(store.tasksByProject[id] || {}),
      dispatches: clone(store.dispatchesByProject[id] || {}),
      runtimeSummary: requireWorkerProtocol().summarizeRuntime(project, store.tasksByProject[id] || {}, store.dispatchesByProject[id] || {})
    };
  }

  function transitionProject(storeInput, projectId, action, clock = Date.now) {
    const store = clone(storeInput);
    const id = String(projectId || store.activeProjectId || "");
    const project = store.projects[id];
    if (!project) throw new Error("Project not found.");
    const at = nowIso(clock);

    if (action === "pause") {
      if (!ACTIVE_STATUSES.has(project.status)) throw new Error(`Cannot pause a ${project.status} project.`);
      store.resumeStatusByProject[id] = project.status;
      project.status = "paused";
    } else if (action === "resume") {
      if (project.status !== "paused") throw new Error("Only a paused project can be resumed.");
      project.status = ACTIVE_STATUSES.has(store.resumeStatusByProject[id]) ? store.resumeStatusByProject[id] : "draft";
      delete store.resumeStatusByProject[id];
    } else if (action === "cancel") {
      if (TERMINAL_STATUSES.has(project.status)) throw new Error(`Cannot cancel a ${project.status} project.`);
      project.status = "cancelled";
      delete store.resumeStatusByProject[id];
      const tasks = store.tasksByProject[id] || {};
      const dispatches = store.dispatchesByProject[id] || {};
      for (const task of Object.values(tasks)) {
        if (!["accepted", "failed", "cancelled"].includes(task.status)) task.status = "cancelled";
        task.lease = null;
        task.updatedAt = at;
      }
      for (const dispatch of Object.values(dispatches)) {
        if (requireWorkerProtocol().ACTIVE_DISPATCH_STATUSES.includes(dispatch.status)) {
          dispatch.status = "cancelled";
          dispatch.updatedAt = at;
        }
      }
      store.tasksByProject[id] = tasks;
      store.dispatchesByProject[id] = dispatches;
    } else {
      throw new Error(`Unknown project transition: ${action}`);
    }

    project.updatedAt = at;
    store.activeProjectId = id;
    const eventType = action === "cancel" ? "project_cancelled" : `project_${action}d`;
    appendEvent(store, eventType, id, at, `Status changed to ${project.status}`);
    return { store, project: clone(project) };
  }

  function listProjects(storeInput) {
    const store = clone(storeInput);
    return Object.values(store.projects)
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
      .map(project => clone(project));
  }

  return {
    PROJECTS_KEY,
    STORE_SCHEMA_VERSION,
    PROJECT_SCHEMA_VERSION,
    APPROVAL_ACTIONS,
    emptyStore,
    migrateStore,
    normalizeRepository,
    normalizeRelativePath,
    normalizeStoredProject,
    createProject,
    inspectProject,
    transitionProject,
    listProjects,
    nextPlanRevision,
    buildProjectPlannerPrompt,
    submitProjectPlannerOutput,
    approveProjectPlan,
    discardProjectPlan,
    recoverAllProjectLeases,
    startProject,
    prepareProjectDispatches,
    recoverProjectLeases,
    activeDispatchesForProject
  };
});
