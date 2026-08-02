"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const ParallelPolicy = require("../planner-parallel-policy.js");

test("planner prompts require real dependencies and multiple roots", () => {
  const fakeStore = {
    buildProjectPlannerPrompt() {
      return { prompt: "Base planner prompt", plannerProtocol: "test" };
    }
  };
  ParallelPolicy.install(fakeStore);
  const built = fakeStore.buildProjectPlannerPrompt();
  assert.match(built.prompt, /Parallel task graph rules:/);
  assert.match(built.prompt, /at least two root tasks/);
  assert.match(built.prompt, /Ordering in this response is not a dependency/);
  assert.equal((built.prompt.match(/Parallel task graph rules:/g) || []).length, 1);
});
