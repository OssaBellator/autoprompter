"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

test("background project API coalesces concurrent bootstrap starts", async () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "background-project-api.js"), "utf8");
  let calls = 0;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const context = {
    Promise,
    Map,
    Error,
    String,
    startProjectBootstrapState: async projectId => {
      calls += 1;
      await gate;
      return { projectId };
    },
    dispatchPreparedProjectAssignmentsState: async () => ({ started: [] })
  };
  context.globalThis = context;
  vm.runInNewContext(source, context, { filename: "background-project-api.js" });

  const first = context.startProjectBootstrapState("alpha");
  const second = context.AutoPrompterBackgroundProjectApi.startProjectBootstrap("alpha");
  assert.equal(first, second);
  assert.equal(calls, 0);
  await Promise.resolve();
  assert.equal(calls, 1);
  assert.equal(context.AutoPrompterBackgroundProjectApi.bootstrapInFlight("alpha"), true);
  release();
  assert.deepEqual(await first, { projectId: "alpha" });
  assert.equal(context.AutoPrompterBackgroundProjectApi.bootstrapInFlight("alpha"), false);
});
