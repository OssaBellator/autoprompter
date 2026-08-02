"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

test("normal AutoContinue connection interruptions retry without a fixed ceiling", async () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "autocontinue-unlimited-retries.js"), "utf8");
  const state = {
    chats: [{
      title: "Long-running chat",
      connectionRetryCount: 999,
      retryPrompt: "",
      currentJobId: "job-1",
      status: "Working",
      lastError: ""
    }]
  };
  let saved = 0;
  let queued = 0;
  let originalCalls = 0;
  const context = {
    module: { exports: {} },
    structuredClone,
    console,
    interruptJob: async () => { originalCalls += 1; },
    loadState: async () => state,
    findChatIndexForMessage: () => 0,
    publicState: value => value,
    updateOverallStatus: () => {},
    saveState: async () => { saved += 1; },
    notify: async () => {},
    queueNextChatJob: async value => { queued += 1; return value; }
  };
  context.globalThis = context;
  context.self = context;
  vm.runInNewContext(source, context, { filename: "autocontinue-unlimited-retries.js" });
  context.module.exports.install();

  await context.interruptJob({
    kind: "connection_interrupted",
    message: "Connection interrupted.",
    jobId: "job-1"
  }, {});

  assert.equal(state.chats[0].connectionRetryCount, 1000);
  assert.equal(state.chats[0].retryPrompt, "Continue from where the response was interrupted. Do not repeat completed material.");
  assert.equal(state.chats[0].status, "Retrying interrupted response (1000)");
  assert.equal(saved, 1);
  assert.equal(queued, 1);
  assert.equal(originalCalls, 0);
  assert.doesNotMatch(source, /MAX_CONNECTION_RETRIES/);

  await context.interruptJob({ kind: "rate_limit", message: "Rate limit reached." }, {});
  assert.equal(originalCalls, 1);
});
