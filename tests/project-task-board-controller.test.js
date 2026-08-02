"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

global.AutoPrompterProjectStore = require("../project-store.js");
const Controller = require("../project-task-board-controller.js");

test("task-board snapshots expose task branches and dependency states", () => {
  const store = {
    projects: {
      project: { projectId: "project", status: "running" }
    },
    approvedPlansByProject: {
      project: { tasks: [{ id: "task-one" }, { id: "task-two" }] }
    },
    tasksByProject: {
      project: {
        "task-one": {
          id: "task-one",
          title: "Task one",
          status: "accepted",
          dependencies: [],
          acceptedBranch: "agent/project/one-a1",
          acceptedCommit: "aaaaaaa",
          attempt: 1
        },
        "task-two": {
          id: "task-two",
          title: "Task two",
          status: "blocked",
          dependencies: ["task-one"],
          attempt: 0
        }
      }
    },
    dispatchesByProject: { project: {} }
  };
  const board = Controller.projectTaskBoard(store, "project");
  assert.equal(board.mode, "fresh_chat_per_task");
  assert.equal(board.tasks[0].branch, "agent/project/one-a1");
  assert.equal(board.tasks[0].commit, "aaaaaaa");
  assert.deepEqual(board.tasks[1].dependencies, ["task-one"]);
});

test("the service worker starts the task-only controller and omits repository action startup", () => {
  const root = path.join(__dirname, "..");
  const entry = fs.readFileSync(path.join(root, "background-entry.js"), "utf8");
  const ui = fs.readFileSync(path.join(root, "project-ui.js"), "utf8");
  assert.match(entry, /project-task-board\.js/);
  assert.match(entry, /project-fresh-dispatch\.js/);
  assert.match(entry, /AutoPrompterProjectTaskBoardController\.start\(\)/);
  assert.doesNotMatch(entry, /project-full-auto\.js/);
  assert.doesNotMatch(entry, /repository-bootstrap\.js/);
  assert.doesNotMatch(entry, /project-action-protocol\.js/);
  assert.match(ui, /Branch task board/);
  assert.match(ui, /Fresh chat per task/);
  assert.doesNotMatch(ui, /modify_workflow/);
  assert.doesNotMatch(ui, /Release publication/);
});
