"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const source = fs.readFileSync(path.join(__dirname, "..", "project-role-runner.js"), "utf8");

function loadAdapter() {
  const registered = [];
  const sent = [];
  const onMessage = {
    addListener(listener) {
      registered.push(listener);
    }
  };
  const chrome = {
    runtime: {
      onMessage,
      sendMessage(payload) {
        sent.push(payload);
        return Promise.resolve({ ok: true });
      }
    }
  };
  const context = vm.createContext({ chrome, Promise, Map, Object, String, Error, console });
  vm.runInContext(source, context, { filename: "project-role-runner.js" });
  return { chrome, registered, sent };
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

test("reviewer jobs use the guarded bootstrap submitter and return on the role channel", async () => {
  const runtime = loadAdapter();
  let synthetic = null;
  runtime.chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type !== "RUN_PROJECT_BOOTSTRAP_JOB") return false;
    synthetic = message;
    sendResponse({ ok: true });
    runtime.chrome.runtime.sendMessage({
      type: "PROJECT_BOOTSTRAP_RESULT",
      jobId: message.jobId,
      output: "review output",
      assistantSignature: "signature",
      conversation: { id: "reviewer-chat", url: "https://chatgpt.com/c/reviewer-chat" }
    });
    return false;
  });

  const roleListener = runtime.registered[0];
  let response = null;
  roleListener({
    type: "RUN_PROJECT_ROLE_JOB",
    jobId: "review:project:dispatch-1",
    projectId: "project",
    role: "reviewer",
    kind: "review",
    dispatchId: "dispatch-1",
    expectedConversationId: "reviewer-chat",
    prompt: "review this result",
    settings: { continuityEnabled: false }
  }, {}, value => { response = value; });

  await new Promise(resolve => setImmediate(resolve));
  assert.equal(response.ok, true);
  assert.equal(synthetic.type, "RUN_PROJECT_BOOTSTRAP_JOB");
  assert.equal(synthetic.stage, "review");
  assert.equal(synthetic.expectedConversationId, "reviewer-chat");
  assert.deepEqual(plain(runtime.sent), [{
    type: "PROJECT_ROLE_RESULT",
    projectId: "project",
    jobId: "review:project:dispatch-1",
    role: "reviewer",
    kind: "review",
    dispatchId: "dispatch-1",
    integrationId: null,
    conversation: { id: "reviewer-chat", url: "https://chatgpt.com/c/reviewer-chat" },
    output: "review output",
    assistantSignature: "signature"
  }]);
});

test("role errors are translated and duplicate active jobs are not dispatched twice", async () => {
  const runtime = loadAdapter();
  let dispatchCount = 0;
  runtime.chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type !== "RUN_PROJECT_BOOTSTRAP_JOB") return false;
    dispatchCount += 1;
    sendResponse({ ok: true });
    return false;
  });
  const roleListener = runtime.registered[0];
  const job = {
    type: "RUN_PROJECT_ROLE_JOB",
    jobId: "integration:project:1:0",
    projectId: "project",
    role: "integrator",
    kind: "integration",
    integrationId: "integration-project-r1-a1",
    expectedConversationId: "integrator-chat",
    prompt: "integrate accepted tasks",
    settings: {}
  };
  const responses = [];
  roleListener(job, {}, value => responses.push(value));
  roleListener(job, {}, value => responses.push(value));

  runtime.chrome.runtime.sendMessage({
    type: "PROJECT_BOOTSTRAP_ERROR",
    jobId: job.jobId,
    kind: "runtime_error",
    error: "integration failed"
  });
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(dispatchCount, 1);
  assert.equal(responses[0].ok, true);
  assert.equal(responses[1].duplicate, true);
  assert.equal(runtime.sent[0].type, "PROJECT_ROLE_ERROR");
  assert.equal(runtime.sent[0].integrationId, job.integrationId);
  assert.equal(runtime.sent[0].error, "integration failed");
});
