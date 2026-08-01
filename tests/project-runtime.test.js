"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const sessionStore = {};
const localStore = {};
let runtimeListener = null;
let nextTabId = 100;
const tabsById = new Map();
const tabMessages = [];
const removedTabIds = [];

function clone(value) {
  return value == null ? value : structuredClone(value);
}

global.chrome = {
  runtime: {
    getManifest: () => ({ version: "3.0.0" }),
    onMessage: { addListener(listener) { runtimeListener = listener; } }
  },
  storage: {
    session: {
      async get(key) { return { [key]: clone(sessionStore[key]) }; },
      async set(values) { Object.assign(sessionStore, clone(values)); }
    },
    local: {
      async get(keys) {
        const result = {};
        for (const key of Array.isArray(keys) ? keys : [keys]) result[key] = clone(localStore[key]);
        return result;
      },
      async set(values) { Object.assign(localStore, clone(values)); }
    }
  },
  tabs: {
    async create(options = {}) {
      const tab = { id: nextTabId++, url: options.url || "about:blank", active: Boolean(options.active), status: "complete" };
      tabsById.set(tab.id, clone(tab));
      return clone(tab);
    },
    async update(tabId, changes = {}) {
      const tab = tabsById.get(tabId);
      if (!tab) throw new Error(`Unknown tab ${tabId}`);
      Object.assign(tab, clone(changes), { status: "complete" });
      tabsById.set(tabId, tab);
      return clone(tab);
    },
    async sendMessage(tabId, message) {
      if (!tabsById.has(tabId)) throw new Error(`Unknown tab ${tabId}`);
      tabMessages.push({ tabId, message: clone(message) });
      return { ok: true, jobId: message.jobId };
    },
    async get(tabId) {
      const tab = tabsById.get(tabId);
      if (!tab) throw new Error(`Unknown tab ${tabId}`);
      return clone(tab);
    },
    async remove(tabIds) {
      for (const tabId of Array.isArray(tabIds) ? tabIds : [tabIds]) {
        removedTabIds.push(tabId);
        tabsById.delete(tabId);
      }
    },
    async query() { return [...tabsById.values()].map(clone); },
    onRemoved: { addListener() {} },
    onUpdated: { addListener() {} }
  },
  notifications: {},
  action: {}
};

require("../background.js");

function resetHarness() {
  for (const key of Object.keys(sessionStore)) delete sessionStore[key];
  for (const key of Object.keys(localStore)) delete localStore[key];
  nextTabId = 100;
  tabsById.clear();
  tabMessages.length = 0;
  removedTabIds.length = 0;
}

function dispatch(type, extra = {}, sender = {}) {
  return new Promise((resolve, reject) => {
    const handled = runtimeListener(
      { scope: "AUTOPROMPTER_RUNTIME", type, ...extra },
      sender,
      response => resolve(response)
    );
    if (!handled) reject(new Error("message not handled"));
  });
}

function projectInput() {
  return {
    title: "Web-first Project Mode",
    goal: "Coordinate planner and worker chats without API inference.",
    repository: "OssaBellator/autoprompter",
    plannerChatId: "planner-chat",
    reviewerChatId: "reviewer-chat",
    integratorChatId: "integrator-chat",
    workerChatIds: ["worker-one", "worker-two"]
  };
}


function plannerOutput(projectId) {
  return `AUTOPROMPTER_PLAN_BEGIN\n${JSON.stringify({
    schemaVersion: "1.0",
    projectId,
    revision: 1,
    requiresMultipleAgents: true,
    rationale: "The project has separate implementation and test tasks.",
    phases: [{
      id: "phase-foundation",
      title: "Foundation",
      taskIds: ["task-store", "task-tests"],
      acceptanceCriteria: ["The phase passes validation."]
    }],
    tasks: [
      {
        id: "task-store",
        title: "Implement store",
        description: "Implement durable project storage.",
        dependencies: [],
        role: "implementation",
        difficulty: "medium",
        preferredModelClass: "standard",
        allowedPaths: ["project-store.js"],
        acceptanceCriteria: ["The store persists."],
        verificationCommands: ["npm test"]
      },
      {
        id: "task-tests",
        title: "Test store",
        description: "Add deterministic tests.",
        dependencies: ["task-store"],
        role: "testing",
        difficulty: "small",
        preferredModelClass: "fast",
        allowedPaths: ["tests/**"],
        acceptanceCriteria: ["Tests pass."],
        verificationCommands: ["npm test"]
      }
    ],
    criticalPath: ["task-store", "task-tests"],
    createdAt: "2026-07-31T05:00:00Z"
  })}\nAUTOPROMPTER_PLAN_END`;
}

test("GET_PROJECTS initializes and persists the current store schema", async () => {
  resetHarness();
  const response = await dispatch("GET_PROJECTS");
  assert.equal(response.ok, true);
  assert.equal(response.projectStoreVersion, "1.6");
  assert.deepEqual(response.projects, []);
  assert.equal(localStore.autoprompterProjects.schemaVersion, "1.6");
});

test("project lifecycle commands persist deterministic transitions", async () => {
  resetHarness();
  const created = await dispatch("CREATE_PROJECT", { project: projectInput() });
  assert.equal(created.ok, true);
  assert.equal(created.project.status, "draft");
  assert.equal(created.projects.length, 1);
  const projectId = created.project.projectId;

  const inspected = await dispatch("INSPECT_PROJECT", { projectId });
  assert.equal(inspected.project.projectId, projectId);
  assert.deepEqual(inspected.events.map(event => event.type), ["project_created"]);

  const paused = await dispatch("PAUSE_PROJECT", { projectId });
  assert.equal(paused.project.status, "paused");
  assert.equal(localStore.autoprompterProjects.projects[projectId].status, "paused");

  const resumed = await dispatch("RESUME_PROJECT", { projectId });
  assert.equal(resumed.project.status, "draft");

  const cancelled = await dispatch("CANCEL_PROJECT", { projectId });
  assert.equal(cancelled.project.status, "cancelled");
  const finalInspection = await dispatch("INSPECT_PROJECT", { projectId });
  assert.deepEqual(finalInspection.events.map(event => event.type), [
    "project_created",
    "project_paused",
    "project_resumed",
    "project_cancelled"
  ]);
});

test("invalid project commands fail without corrupting storage", async () => {
  resetHarness();
  const response = await dispatch("CREATE_PROJECT", {
    project: { ...projectInput(), repository: "not-a-repository" }
  });
  assert.equal(response.ok, false);
  assert.match(response.error, /valid GitHub repository/i);
  assert.deepEqual(localStore.autoprompterProjects.projects, {});
});


test("planner runtime validates pending output before explicit approval creates tasks", async () => {
  resetHarness();
  const created = await dispatch("CREATE_PROJECT", { project: projectInput() });
  const projectId = created.project.projectId;

  const prompt = await dispatch("BUILD_PLANNER_PROMPT", { projectId });
  assert.equal(prompt.ok, true);
  assert.equal(prompt.revision, 1);
  assert.match(prompt.prompt, /AUTOPROMPTER_PLAN_BEGIN/);

  const submitted = await dispatch("SUBMIT_PLANNER_OUTPUT", { projectId, output: plannerOutput(projectId) });
  assert.equal(submitted.ok, true);
  assert.equal(submitted.project.status, "planning");
  assert.equal(submitted.planSummary.taskCount, 2);
  assert.deepEqual(submitted.tasks, {});
  assert.deepEqual(localStore.autoprompterProjects.tasksByProject, {});

  const inspectedPending = await dispatch("INSPECT_PROJECT", { projectId });
  assert.equal(inspectedPending.pendingPlan.revision, 1);
  assert.equal(inspectedPending.approvedPlan, null);
  assert.deepEqual(inspectedPending.tasks, {});

  const approved = await dispatch("APPROVE_PROJECT_PLAN", { projectId });
  assert.equal(approved.ok, true);
  assert.equal(approved.project.status, "ready");
  assert.equal(approved.tasks["task-store"].status, "ready");
  assert.equal(approved.tasks["task-tests"].status, "blocked");

  const inspectedApproved = await dispatch("INSPECT_PROJECT", { projectId });
  assert.equal(inspectedApproved.pendingPlan, null);
  assert.equal(inspectedApproved.approvedPlan.revision, 1);
  assert.equal(Object.keys(inspectedApproved.tasks).length, 2);
});

test("planner output can be discarded without task creation", async () => {
  resetHarness();
  const created = await dispatch("CREATE_PROJECT", { project: projectInput() });
  const projectId = created.project.projectId;
  await dispatch("SUBMIT_PLANNER_OUTPUT", { projectId, output: plannerOutput(projectId) });
  const discarded = await dispatch("DISCARD_PROJECT_PLAN", { projectId });
  assert.equal(discarded.ok, true);
  assert.equal(discarded.project.status, "draft");
  assert.deepEqual(discarded.tasks, {});
});


test("worker assignment preparation is bounded, idempotent, and does not open tabs", async () => {
  resetHarness();
  const created = await dispatch("CREATE_PROJECT", { project: projectInput() });
  const projectId = created.project.projectId;
  await dispatch("SUBMIT_PLANNER_OUTPUT", { projectId, output: plannerOutput(projectId) });
  await dispatch("APPROVE_PROJECT_PLAN", { projectId });

  const started = await dispatch("START_PROJECT_MODE", { projectId });
  assert.equal(started.ok, true);
  assert.equal(started.project.status, "running");
  assert.deepEqual(started.dispatches, {});

  const prepared = await dispatch("PREPARE_PROJECT_ASSIGNMENTS", { projectId });
  assert.equal(prepared.ok, true);
  assert.equal(prepared.assignments.length, 1);
  assert.equal(prepared.assignments[0].taskId, "task-store");
  assert.equal(prepared.assignments[0].workerChatId, "worker-one");
  assert.match(prepared.assignments[0].prompt, /AUTOPROMPTER_TASK_RESULT_BEGIN/);
  assert.equal(prepared.runtimeSummary.activeLeaseCount, 1);

  const repeated = await dispatch("PREPARE_PROJECT_ASSIGNMENTS", { projectId });
  assert.equal(repeated.ok, true);
  assert.deepEqual(repeated.assignments, []);
  assert.equal(Object.keys(repeated.dispatches).length, 1);
});

test("service-worker load recovers expired leases after restart", async () => {
  resetHarness();
  const created = await dispatch("CREATE_PROJECT", { project: projectInput() });
  const projectId = created.project.projectId;
  await dispatch("SUBMIT_PLANNER_OUTPUT", { projectId, output: plannerOutput(projectId) });
  await dispatch("APPROVE_PROJECT_PLAN", { projectId });
  await dispatch("START_PROJECT_MODE", { projectId });
  const prepared = await dispatch("PREPARE_PROJECT_ASSIGNMENTS", { projectId });
  const dispatchId = prepared.assignments[0].dispatchId;

  localStore.autoprompterProjects.tasksByProject[projectId]["task-store"].lease.expiresAt = "2000-01-01T00:00:00.000Z";
  localStore.autoprompterProjects.dispatchesByProject[projectId][dispatchId].expiresAt = "2000-01-01T00:00:00.000Z";

  const projects = await dispatch("GET_PROJECTS");
  assert.equal(projects.ok, true);
  const inspected = await dispatch("INSPECT_PROJECT", { projectId });
  assert.equal(inspected.tasks["task-store"].status, "ready");
  assert.equal(inspected.tasks["task-store"].lease, null);
  assert.equal(inspected.dispatches[dispatchId].status, "expired");
  assert.equal(inspected.runtimeSummary.activeLeaseCount, 0);
});


test("autonomous bootstrap creates role chats, repairs malformed planner JSON, and approves the valid plan", async () => {
  resetHarness();
  const input = {
    ...projectInput(),
    plannerChatId: null,
    reviewerChatId: null,
    integratorChatId: null
  };
  const created = await dispatch("CREATE_PROJECT", { project: input });
  const projectId = created.project.projectId;

  const started = await dispatch("START_PROJECT_BOOTSTRAP", { projectId });
  assert.equal(started.ok, true);
  assert.equal(started.bootstrap.status, "running");
  assert.equal(tabsById.size, 3);

  const bootstraps = localStore.autoprompterProjectBootstraps;
  const bootstrap = bootstraps[projectId];
  const roleIds = {
    planner: "planner-auto",
    reviewer: "reviewer-auto",
    integrator: "integrator-auto"
  };

  async function readyAndLastMessage(role) {
    const roleState = localStore.autoprompterProjectBootstraps[projectId].roles[role];
    const response = await dispatch("CONTENT_READY", {
      conversation: roleState.chatId
        ? { id: roleState.chatId, url: `https://chatgpt.com/c/${roleState.chatId}` }
        : null
    }, { tab: { id: roleState.tabId } });
    assert.equal(response.ok, true);
    const sent = [...tabMessages].reverse().find(item => item.tabId === roleState.tabId);
    assert.ok(sent, `expected a bootstrap message for ${role}`);
    assert.equal(sent.message.type, "RUN_PROJECT_BOOTSTRAP_JOB");
    return sent;
  }

  for (const role of ["reviewer", "integrator"]) {
    const sent = await readyAndLastMessage(role);
    const result = await dispatch("PROJECT_BOOTSTRAP_RESULT", {
      projectId,
      role,
      stage: "role_init",
      jobId: sent.message.jobId,
      conversation: { id: roleIds[role], url: `https://chatgpt.com/c/${roleIds[role]}` },
      output: `AUTOPROMPTER_ROLE_READY: ${role}`
    }, { tab: { id: sent.tabId } });
    assert.equal(result.ok, true);
    assert.equal(result.bootstrap.roles[role].stage, "completed");
  }

  const plannerInit = await readyAndLastMessage("planner");
  const plannerReady = await dispatch("PROJECT_BOOTSTRAP_RESULT", {
    projectId,
    role: "planner",
    stage: "role_init",
    jobId: plannerInit.message.jobId,
    conversation: { id: roleIds.planner, url: `https://chatgpt.com/c/${roleIds.planner}` },
    output: "AUTOPROMPTER_ROLE_READY: planner"
  }, { tab: { id: plannerInit.tabId } });
  assert.equal(plannerReady.ok, true);
  assert.equal(plannerReady.bootstrap.roles.planner.stage, "planner_plan");

  const plannerPlan = await readyAndLastMessage("planner");
  const malformed = await dispatch("PROJECT_BOOTSTRAP_RESULT", {
    projectId,
    role: "planner",
    stage: "planner_plan",
    jobId: plannerPlan.message.jobId,
    conversation: { id: roleIds.planner, url: `https://chatgpt.com/c/${roleIds.planner}` },
    output: "AUTOPROMPTER_PLAN_BEGIN\n{\"schemaVersion\":\"1.0\",\"tasks\":[1 2]}\nAUTOPROMPTER_PLAN_END"
  }, { tab: { id: plannerPlan.tabId } });
  assert.equal(malformed.ok, true);
  assert.equal(malformed.retrying, true);
  assert.equal(malformed.bootstrap.repairAttempts, 1);
  assert.equal(malformed.bootstrap.roles.planner.stage, "planner_repair");
  assert.equal(localStore.autoprompterProjects.pendingPlansByProject[projectId], undefined);

  const repair = await readyAndLastMessage("planner");
  assert.match(repair.message.prompt, /JSON\.parse/);
  assert.match(repair.message.prompt, /no trailing commas/i);
  const repaired = await dispatch("PROJECT_BOOTSTRAP_RESULT", {
    projectId,
    role: "planner",
    stage: "planner_repair",
    jobId: repair.message.jobId,
    conversation: { id: roleIds.planner, url: `https://chatgpt.com/c/${roleIds.planner}` },
    output: plannerOutput(projectId)
  }, { tab: { id: repair.tabId } });
  assert.equal(repaired.ok, true);
  assert.equal(repaired.approved, true);
  assert.equal(repaired.bootstrap.status, "completed");
  assert.equal(repaired.bootstrap.planValidated, true);
  assert.equal(repaired.bootstrap.planApproved, true);
  assert.equal(repaired.bootstrap.assignmentCount, 1);

  const inspected = await dispatch("INSPECT_PROJECT", { projectId });
  assert.equal(inspected.project.status, "running");
  assert.equal(inspected.approvedPlan.revision, 1);
  assert.equal(inspected.pendingPlan, null);
  assert.equal(inspected.tasks["task-store"].status, "leased");
  assert.equal(inspected.dispatches[Object.keys(inspected.dispatches)[0]].status, "prepared");
  assert.equal(tabMessages.some(item => item.message.type === "RUN_PROJECT_TASK"), false);
  assert.equal(new Set(removedTabIds).size, 3);
});
