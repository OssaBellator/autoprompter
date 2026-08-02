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
    addListener(listener) { registered.push(listener); }
  };
  const chrome = {
    runtime: {
      onMessage,
      sendMessage(payload) {
        sent.push(JSON.parse(JSON.stringify(payload)));
        return Promise.resolve({ ok: true });
      }
    }
  };
  const context = vm.createContext({ chrome, Promise, Map, Object, String, Error, console });
  vm.runInContext(source, context, { filename: "project-role-runner.js" });
  return { chrome, registered, sent };
}

test("repository actions reuse the guarded bootstrap submitter and return on a distinct action channel", async () => {
  const runtime = loadAdapter();
  let synthetic = null;
  runtime.chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type !== "RUN_PROJECT_BOOTSTRAP_JOB") return false;
    synthetic = JSON.parse(JSON.stringify(message));
    sendResponse({ ok: true });
    runtime.chrome.runtime.sendMessage({
      type: "PROJECT_BOOTSTRAP_RESULT",
      jobId: message.jobId,
      output: "action output",
      assistantSignature: "signature",
      conversation: { id: "integrator-chat", url: "https://chatgpt.com/c/integrator-chat" }
    });
    return false;
  });

  const listener = runtime.registered[0];
  let response = null;
  listener({
    type: "RUN_PROJECT_ACTION_JOB",
    jobId: "action:project:merge",
    projectId: "project",
    actionId: "action:project:merge",
    approvalId: "approval-merge",
    action: "merge_to_default_branch",
    target: "owner/repository:main:abc123",
    role: "integrator",
    expectedConversationId: "integrator-chat",
    prompt: "perform the approved merge",
    settings: {}
  }, {}, value => { response = value; });

  await new Promise(resolve => setImmediate(resolve));
  assert.equal(response.ok, true);
  assert.equal(synthetic.type, "RUN_PROJECT_BOOTSTRAP_JOB");
  assert.equal(synthetic.stage, "repository_action");
  assert.equal(synthetic.expectedConversationId, "integrator-chat");
  assert.deepEqual(runtime.sent, [{
    type: "PROJECT_ACTION_RESULT",
    projectId: "project",
    jobId: "action:project:merge",
    actionId: "action:project:merge",
    approvalId: "approval-merge",
    action: "merge_to_default_branch",
    target: "owner/repository:main:abc123",
    conversation: { id: "integrator-chat", url: "https://chatgpt.com/c/integrator-chat" },
    output: "action output",
    assistantSignature: "signature"
  }]);
});

test("active action jobs are idempotent and action errors remain separate from role errors", async () => {
  const runtime = loadAdapter();
  let dispatchCount = 0;
  runtime.chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type !== "RUN_PROJECT_BOOTSTRAP_JOB") return false;
    dispatchCount += 1;
    sendResponse({ ok: true });
    return false;
  });
  const listener = runtime.registered[0];
  const job = {
    type: "RUN_PROJECT_ACTION_JOB",
    jobId: "action:project:release",
    projectId: "project",
    actionId: "action:project:release",
    approvalId: "approval-release",
    action: "publish_release",
    target: "owner/repository:auto-release",
    role: "integrator",
    expectedConversationId: "integrator-chat",
    prompt: "publish the release",
    settings: {}
  };
  const responses = [];
  listener(job, {}, value => responses.push(value));
  listener(job, {}, value => responses.push(value));
  runtime.chrome.runtime.sendMessage({
    type: "PROJECT_BOOTSTRAP_ERROR",
    jobId: job.jobId,
    kind: "runtime_error",
    error: "plugin unavailable"
  });
  await new Promise(resolve => setImmediate(resolve));

  assert.equal(dispatchCount, 1);
  assert.equal(responses[0].ok, true);
  assert.equal(responses[1].duplicate, true);
  assert.equal(runtime.sent[0].type, "PROJECT_ACTION_ERROR");
  assert.equal(runtime.sent[0].action, "publish_release");
  assert.equal(runtime.sent[0].error, "plugin unavailable");
});
