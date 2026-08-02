"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const ProjectStore = require("../project-store.js");
const PlannerCompiler = require("../planner-compiler.js");
global.AutoPrompterProjectStore = ProjectStore;
global.AutoPrompterWorkerProtocol = require("../worker-protocol.js");
PlannerCompiler.install(ProjectStore);
require("../project-task-board.js");

const CLOCK_MS = Date.parse("2026-08-02T05:15:00.000Z");
const clock = () => CLOCK_MS;

function preparedStore() {
  let store = ProjectStore.createProject(ProjectStore.emptyStore(), {
    projectId: "fresh-dispatch",
    title: "Fresh dispatch",
    goal: "Open a fresh worker conversation for a branch task.",
    repository: "OssaBellator/autoprompter",
    maxConcurrentWorkers: 1
  }, clock).store;
  const projectId = store.activeProjectId;
  const output = [
    PlannerCompiler.PROPOSAL_BEGIN,
    JSON.stringify({
      schemaVersion: "1.0",
      summary: "One task.",
      tasks: [{
        key: "task",
        title: "Implement task",
        description: "Implement one branch task.",
        dependsOn: [],
        allowedPaths: ["src/**"],
        acceptance: ["The task is complete."],
        checks: []
      }]
    }),
    PlannerCompiler.PROPOSAL_END
  ].join("\n");
  store = ProjectStore.submitProjectPlannerOutput(store, projectId, output, clock).store;
  store = ProjectStore.approveProjectPlan(store, projectId, clock).store;
  store = ProjectStore.startProject(store, projectId, clock).store;
  const prepared = ProjectStore.prepareProjectDispatches(store, projectId, clock);
  return { store: prepared.store, projectId, dispatch: prepared.assignments[0] };
}

test("prepared branch tasks open a fresh ChatGPT URL and bind a managed tab", async () => {
  const prepared = preparedStore();
  const memory = {
    [ProjectStore.PROJECTS_KEY]: prepared.store,
    autoprompterScheduler: null
  };
  const opened = [];
  global.chrome = {
    storage: {
      local: {
        async get(keys) {
          if (typeof keys === "string") return { [keys]: memory[keys] };
          return Object.fromEntries((Array.isArray(keys) ? keys : Object.keys(keys || {})).map(key => [key, memory[key]]));
        },
        async set(values) {
          Object.assign(memory, values);
        }
      }
    },
    tabs: {
      async create(options) {
        opened.push(options);
        return { id: 77, ...options };
      },
      async remove() {}
    }
  };

  delete require.cache[require.resolve("../project-fresh-dispatch.js")];
  const FreshDispatch = require("../project-fresh-dispatch.js");
  const result = await FreshDispatch.dispatchPreparedAssignments(
    prepared.projectId,
    [prepared.dispatch.dispatchId],
    true
  );

  assert.equal(result.started.length, 1);
  assert.equal(opened.length, 1);
  assert.match(opened[0].url, /^https:\/\/chatgpt\.com\/\?autoprompter_fresh=/);
  assert.equal(opened[0].active, false);
  const storedDispatch = memory[ProjectStore.PROJECTS_KEY].dispatchesByProject[prepared.projectId][prepared.dispatch.dispatchId];
  assert.equal(storedDispatch.status, "dispatched");
  assert.equal(storedDispatch.workerTabId, 77);
});
