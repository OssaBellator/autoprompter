"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const popupJs = fs.readFileSync(path.join(root, "popup.js"), "utf8");
const popupHtml = fs.readFileSync(path.join(root, "popup.html"), "utf8");
const contentJs = fs.readFileSync(path.join(root, "content.js"), "utf8");
const backgroundJs = fs.readFileSync(path.join(root, "background.js"), "utf8");
const Store = require("../project-store.js");

global.chrome = {
  runtime: {
    onMessage: { addListener() {} },
    getManifest: () => ({ version: "3.0.0" }),
    getURL: value => `chrome-extension://test/${value}`
  },
  action: {},
  notifications: {},
  tabs: { onRemoved: { addListener() {} }, onUpdated: { addListener() {} } },
  storage: { session: {}, local: {} }
};

const {
  PROJECT_BOOTSTRAP_KEY,
  MAX_PROJECT_BOOTSTRAP_REPAIRS,
  MAX_ROLE_INIT_RETRIES,
  buildProjectRolePrompt,
  buildPlannerRepairPrompt,
  publicProjectBootstrap
} = require("../background.js");

function draft() {
  return Store.createProject(Store.emptyStore(), {
    title: "Autonomous project",
    goal: "Build a web-first multi-agent system.",
    repository: "OssaBellator/autoprompter",
    plannerChatId: null,
    reviewerChatId: null,
    integratorChatId: null,
    workerChatIds: ["worker-1", "worker-2"]
  }, () => Date.parse("2026-08-01T05:00:00.000Z"));
}

test("role chats can be bound after automatic conversation creation", () => {
  const created = draft();
  const planner = Store.bindProjectRoleChat(created.store, created.project.projectId, "planner", "planner-auto", () => Date.parse("2026-08-01T05:01:00.000Z"));
  assert.equal(planner.project.roles.plannerChatId, "planner-auto");
  assert.deepEqual(planner.project.roles.workerChatIds, ["worker-1", "worker-2"]);

  const workerRole = Store.bindProjectRoleChat(planner.store, created.project.projectId, "reviewer", "worker-1", () => Date.parse("2026-08-01T05:02:00.000Z"));
  assert.equal(workerRole.project.roles.reviewerChatId, "worker-1");
  assert.deepEqual(workerRole.project.roles.workerChatIds, ["worker-2"]);
  assert.throws(
    () => Store.bindProjectRoleChat(workerRole.store, created.project.projectId, "integrator", "planner-auto"),
    /must be different/i
  );
});

test("role initialization and planner repair prompts are bounded and explicit", () => {
  const project = draft().project;
  const rolePrompt = buildProjectRolePrompt(project, "planner");
  assert.match(rolePrompt, /AUTOPROMPTER_ROLE_READY: planner/);
  assert.match(rolePrompt, /subscription-backed|ChatGPT Web/i);
  assert.doesNotMatch(rolePrompt, /API key/i);

  const repair = buildPlannerRepairPrompt("Expected ',' after array element", 1);
  assert.match(repair, /JSON\.parse/);
  assert.match(repair, /no trailing commas/i);
  assert.match(repair, /complete corrected AUTOPROMPTER_PLAN_BEGIN/);
  assert.equal(MAX_PROJECT_BOOTSTRAP_REPAIRS, 3);
  assert.equal(MAX_ROLE_INIT_RETRIES, 2);
  assert.equal(PROJECT_BOOTSTRAP_KEY, "autoprompterProjectBootstraps");
});

test("public bootstrap state omits prompts and tab identifiers", () => {
  const visible = publicProjectBootstrap({
    projectId: "autonomous-project",
    status: "running",
    repairAttempts: 1,
    planValidated: true,
    planApproved: false,
    planSummary: { taskCount: 8 },
    assignmentCount: 0,
    roles: {
      planner: { chatId: "planner", tabId: 77, stage: "planner_repair", status: "Repairing", prompt: "secret prompt", retries: 1 }
    }
  });
  assert.equal(visible.roles.planner.chatId, "planner");
  assert.equal(visible.roles.planner.stage, "planner_repair");
  assert.equal("tabId" in visible.roles.planner, false);
  assert.equal("prompt" in visible.roles.planner, false);
  assert.equal(visible.planValidated, true);
});

test("project creation starts autonomous bootstrap and retains manual fallback controls", () => {
  assert.match(popupJs, /runtimeMessage\("START_PROJECT_BOOTSTRAP"/);
  assert.match(popupJs, /runtimeMessage\("GET_PROJECT_BOOTSTRAP"/);
  assert.match(popupJs, /runAutonomousProjectBootstrap/);
  assert.match(popupHtml, /id="bootstrapProject"/);
  assert.match(popupHtml, /Create and bootstrap project/);
  assert.match(popupJs, /Create automatically/);
  assert.match(popupHtml, /Generate planner prompt manually/);
});

test("content and background expose an asynchronous one-shot bootstrap pipeline", () => {
  assert.match(contentJs, /async function executeProjectBootstrapJob/);
  assert.match(contentJs, /RUN_PROJECT_BOOTSTRAP_JOB/);
  assert.match(contentJs, /PROJECT_BOOTSTRAP_RESULT/);
  assert.match(backgroundJs, /async function startProjectBootstrapState/);
  assert.match(backgroundJs, /ProjectStore\.submitProjectPlannerOutput/);
  assert.match(backgroundJs, /maybeApproveProjectBootstrapPlan/);
  assert.match(backgroundJs, /ProjectStore\.prepareProjectDispatches/);
  assert.match(backgroundJs, /bootstrap\.repairAttempts < MAX_PROJECT_BOOTSTRAP_REPAIRS/);
  assert.match(backgroundJs, /supportingRolesReady/);
});
