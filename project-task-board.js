"use strict";

(function attachProjectTaskBoard(root, factory) {
  const projectStore = root.AutoPrompterProjectStore
    || (typeof require === "function" ? require("./project-store.js") : null);
  const workerProtocol = root.AutoPrompterWorkerProtocol
    || (typeof require === "function" ? require("./worker-protocol.js") : null);
  const api = factory(projectStore, workerProtocol);
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.AutoPrompterProjectTaskBoard = api;
})(typeof globalThis !== "undefined" ? globalThis : self, (ProjectStore, WorkerProtocol) => {
  const PATCH_FLAG = Symbol.for("autoprompter.projectTaskBoard.installed");
  const MODE = "fresh_chat_per_task";
  const MAX_EVENTS = 200;

  function clone(value) {
    return value == null ? value : structuredClone(value);
  }

  function nowIso(clock = Date.now) {
    return new Date(clock()).toISOString();
  }

  function addEvent(store, type, projectId, at, detail) {
    const events = Array.isArray(store.events) ? store.events : [];
    events.push({
      id: `${at}:${type}:${projectId}:${events.length}`,
      type,
      projectId,
      at,
      detail: String(detail || "").slice(0, 500)
    });
    store.events = events.slice(-MAX_EVENTS);
  }

  function freshWorkerId(projectId, taskId, attempt) {
    const fingerprint = WorkerProtocol.stableHash(`${projectId}|${taskId}|${attempt}|fresh-task-chat`);
    return `fresh-task-${fingerprint}`;
  }

  function orderedReadyTasks(store, projectId) {
    const tasks = store.tasksByProject?.[projectId] || {};
    const planOrder = (store.approvedPlansByProject?.[projectId]?.tasks || []).map(task => task.id);
    const known = new Set(planOrder);
    return [...planOrder, ...Object.keys(tasks).filter(id => !known.has(id)).sort()]
      .map(taskId => tasks[taskId])
      .filter(task => task?.status === "ready" && !task.lease);
  }

  function install(projectStore = ProjectStore) {
    if (!projectStore || !WorkerProtocol) throw new Error("AutoPrompter task-board dependencies are unavailable.");
    if (projectStore[PATCH_FLAG]) return projectStore[PATCH_FLAG];

    const originalCreateProject = projectStore.createProject.bind(projectStore);
    const originalStartProject = projectStore.startProject.bind(projectStore);
    const originalPrepareProjectDispatches = projectStore.prepareProjectDispatches.bind(projectStore);
    const originalRecoverProjectLeases = projectStore.recoverProjectLeases.bind(projectStore);
    const originalSummarizeProjectRuntime = projectStore.summarizeProjectRuntime.bind(projectStore);

    projectStore.createProject = function createTaskBoardProject(storeInput, input, clock = Date.now) {
      const requestedWorkers = Array.isArray(input?.workerChatIds) ? input.workerChatIds.length : 0;
      const maxConcurrentWorkers = Math.max(1, Math.min(6, Number(input?.maxConcurrentWorkers || requestedWorkers || 3)));
      return originalCreateProject(storeInput, {
        ...input,
        workerChatIds: [],
        maxConcurrentWorkers
      }, clock);
    };

    projectStore.startProject = function startTaskBoardProject(storeInput, projectId, clock = Date.now) {
      const store = clone(storeInput);
      const id = String(projectId || store.activeProjectId || "");
      const project = store.projects?.[id];
      if (!project) throw new Error("Project not found.");
      if (project.status !== "ready") throw new Error("Only a ready project can be started.");
      if (!store.approvedPlansByProject?.[id] || !Object.keys(store.tasksByProject?.[id] || {}).length) {
        throw new Error("Approve a planner result before starting the project.");
      }
      const at = nowIso(clock);
      project.status = "running";
      project.updatedAt = at;
      project.taskExecutionMode = MODE;
      store.activeProjectId = id;
      addEvent(store, "project_started", id, at, "Project task board started; each ready task receives a fresh ChatGPT conversation and branch");
      return { store, project: clone(project) };
    };

    projectStore.prepareProjectDispatches = function prepareFreshTaskDispatches(storeInput, projectId, clock = Date.now) {
      const recovered = originalRecoverProjectLeases(storeInput, projectId, clock);
      const store = recovered.store;
      const id = String(projectId || store.activeProjectId || "");
      const project = store.projects?.[id];
      if (!project) throw new Error("Project not found.");
      if (project.status !== "running") throw new Error("Start the ready project before preparing task branches.");
      const plan = store.approvedPlansByProject?.[id];
      const tasks = store.tasksByProject?.[id] || {};
      if (!plan || !Object.keys(tasks).length) throw new Error("No approved tasks are available for assignment.");

      const dispatches = store.dispatchesByProject?.[id] || {};
      const active = WorkerProtocol.activeDispatches(dispatches);
      const capacity = Math.max(1, Math.min(12, Number(project.scheduler?.maxConcurrentWorkers || 3)));
      const remainingCapacity = Math.max(0, capacity - active.length);
      const readyTasks = orderedReadyTasks(store, id);
      const assignmentCount = Math.min(remainingCapacity, readyTasks.length);
      const at = nowIso(clock);
      const expiresAt = new Date(clock() + Number(project.scheduler?.leaseMinutes || 120) * 60_000).toISOString();
      const assignments = [];

      for (let index = 0; index < assignmentCount; index += 1) {
        const task = readyTasks[index];
        const attempt = Math.min(50, Number(task.attempt || 0) + 1);
        if (attempt <= Number(task.attempt || 0)) throw new Error(`${task.id} exceeded the maximum task attempts.`);
        const workerChatId = freshWorkerId(id, task.id, attempt);
        const dispatchId = WorkerProtocol.buildDispatchId({
          projectId: id,
          revision: plan.revision,
          taskId: task.id,
          attempt,
          workerChatId
        });
        if (dispatches[dispatchId]) throw new Error(`Dispatch ID collision for ${task.id}.`);
        const branch = WorkerProtocol.buildBranchName(id, task.id, attempt);
        const dispatch = {
          schemaVersion: WorkerProtocol.DISPATCH_SCHEMA_VERSION,
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
          expiredAt: null,
          parentDispatchId: null,
          originalDispatchId: dispatchId,
          successorGeneration: 1,
          conversationId: null,
          freshRequestId: `project-task:${dispatchId}:${clock()}`,
          taskExecutionMode: MODE
        };
        dispatch.prompt = WorkerProtocol.buildWorkerPrompt(project, task, dispatch);
        dispatches[dispatchId] = dispatch;
        task.status = "leased";
        task.attempt = attempt;
        task.branch = branch;
        task.lease = { dispatchId, workerChatId, assignedAt: at, expiresAt, attempt };
        task.updatedAt = at;
        assignments.push(clone(dispatch));
        addEvent(store, "task_branch_prepared", id, at, `${task.id} -> ${branch} in a fresh worker chat`);
      }

      store.tasksByProject[id] = tasks;
      store.dispatchesByProject[id] = dispatches;
      project.taskExecutionMode = MODE;
      if (assignments.length) project.updatedAt = at;
      store.activeProjectId = id;
      return {
        store,
        project: clone(project),
        tasks: clone(tasks),
        dispatches: clone(dispatches),
        assignments,
        runtimeSummary: projectStore.summarizeProjectRuntime(store, id)
      };
    };

    projectStore.summarizeProjectRuntime = function summarizeTaskBoard(store, projectId) {
      const summary = originalSummarizeProjectRuntime(store, projectId);
      const project = store.projects?.[projectId];
      const capacity = Math.max(1, Math.min(12, Number(project?.scheduler?.maxConcurrentWorkers || 3)));
      return {
        ...summary,
        taskExecutionMode: MODE,
        workerCount: capacity,
        availableWorkerCount: Math.max(0, capacity - Number(summary.activeLeaseCount || 0))
      };
    };

    const installed = Object.freeze({
      mode: MODE,
      originalCreateProject,
      originalStartProject,
      originalPrepareProjectDispatches,
      originalSummarizeProjectRuntime
    });
    Object.defineProperty(projectStore, PATCH_FLAG, { value: installed, enumerable: false });
    return installed;
  }

  const installed = ProjectStore && WorkerProtocol ? install(ProjectStore) : null;
  return { MODE, freshWorkerId, orderedReadyTasks, install, installed };
});
