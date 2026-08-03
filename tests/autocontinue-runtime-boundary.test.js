"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Boundary = require("../autocontinue-runtime-boundary.js");

function createRuntime() {
  const listeners = [];
  const event = {
    addListener(listener) { listeners.push(listener); },
    removeListener(listener) {
      const index = listeners.indexOf(listener);
      if (index >= 0) listeners.splice(index, 1);
    }
  };
  const calls = [];
  const runtime = {
    chrome: { runtime: { onMessage: event } },
    enqueue(operation) { return Promise.resolve().then(operation); },
    async loadState() { calls.push("initial-load"); return { running: false, chats: [] }; },
    publicState(state) { calls.push("initial-public"); return state; },
    startScheduler() { calls.push("initial-start"); return { running: true }; },
    stopScheduler() { calls.push("initial-stop"); return { running: false }; },
    findChatIndexByTab() { return -1; },
    markContentReady() { calls.push("initial-ready"); return { ready: true }; },
    interruptJob() { calls.push("initial-interrupt"); return { initial: true }; },
    finishJob() { calls.push("initial-finish"); return { initial: true }; },
    updateJobStatus() { calls.push("initial-status"); return { initial: true }; },
    failJob() { calls.push("initial-fail"); return { initial: true }; },
    successorCreated() { calls.push("initial-successor"); return { initial: true }; }
  };
  return { runtime, listeners, calls, event };
}

function invoke(listener, message, sender = { tab: { id: 42 } }) {
  return new Promise(resolve => {
    const keepChannel = listener(message, sender, resolve);
    assert.equal(keepChannel, true);
  });
}

test("terminal messages resolve the final installed handler at message time", async () => {
  const { runtime, listeners, calls } = createRuntime();
  assert.equal(Boundary.install(runtime), true);

  let originalListenerCalls = 0;
  runtime.chrome.runtime.onMessage.addListener(() => {
    originalListenerCalls += 1;
    return false;
  });

  runtime.interruptJob = async message => {
    calls.push(["recovered-interrupt", message.message]);
    return { status: "Refreshing stale thinking state" };
  };
  Boundary.finalize(runtime);

  const response = await invoke(listeners[0], {
    scope: Boundary.SCOPE,
    type: "JOB_INTERRUPTED",
    kind: "stalled",
    message: "Thinking"
  });

  assert.equal(response.ok, true);
  assert.equal(response.status, "Refreshing stale thinking state");
  assert.deepEqual(calls, [["recovered-interrupt", "Thinking"]]);
  assert.equal(originalListenerCalls, 0);
});

test("scheduler state reads use the final guarded load and public functions", async () => {
  const { runtime, listeners, calls } = createRuntime();
  Boundary.install(runtime);
  let originalListenerCalls = 0;
  runtime.chrome.runtime.onMessage.addListener(() => {
    originalListenerCalls += 1;
    return false;
  });
  runtime.loadState = async () => {
    calls.push("guarded-load");
    return { running: true, chats: [{ id: "chat-1", settings: { maxContinuations: 5 } }] };
  };
  runtime.publicState = state => {
    calls.push("guarded-public");
    return { running: state.running, chats: state.chats };
  };
  Boundary.finalize(runtime);

  const response = await invoke(listeners[0], {
    scope: Boundary.SCOPE,
    type: "GET_SCHEDULER_STATE"
  }, {});

  assert.equal(response.ok, true);
  assert.equal(response.running, true);
  assert.equal(response.chats[0].settings.maxContinuations, 5);
  assert.deepEqual(calls, ["guarded-load", "guarded-public"]);
  assert.equal(originalListenerCalls, 0);
});

test("unknown runtime messages continue through the original scheduler listener", () => {
  const { runtime, listeners } = createRuntime();
  Boundary.install(runtime);
  let received = null;
  runtime.chrome.runtime.onMessage.addListener(message => {
    received = message.type;
    return false;
  });
  Boundary.finalize(runtime);

  const result = listeners[0]({ scope: Boundary.SCOPE, type: "UNKNOWN_COMMAND" }, {}, () => {});
  assert.equal(result, false);
  assert.equal(received, "UNKNOWN_COMMAND");
});

test("finalize prevents later listeners from being wrapped", () => {
  const { runtime, listeners } = createRuntime();
  Boundary.install(runtime);
  const schedulerListener = () => false;
  runtime.chrome.runtime.onMessage.addListener(schedulerListener);
  Boundary.finalize(runtime);
  const selfRepairListener = () => false;
  runtime.chrome.runtime.onMessage.addListener(selfRepairListener);

  assert.equal(listeners.length, 2);
  assert.notEqual(listeners[0], schedulerListener);
  assert.equal(listeners[1], selfRepairListener);
});

test("all direct terminal command types map to their installed handlers", () => {
  assert.deepEqual(Boundary.directHandlers, {
    JOB_STATUS: "updateJobStatus",
    JOB_DONE: "finishJob",
    JOB_ERROR: "failJob",
    JOB_INTERRUPTED: "interruptJob",
    JOB_ROLLOVER: "interruptJob",
    SUCCESSOR_CREATED: "successorCreated"
  });
  for (const type of [
    "GET_SCHEDULER_STATE",
    "START_SCHEDULER",
    "STOP_SCHEDULER",
    "CONTENT_READY",
    ...Object.keys(Boundary.directHandlers)
  ]) assert.equal(Boundary.boundaryCommands.has(type), true, type);
});
