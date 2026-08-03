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
    interruptJob() { calls.push("initial-interrupt"); return { initial: true }; },
    finishJob() { calls.push("initial-finish"); return { initial: true }; },
    updateJobStatus() { calls.push("initial-status"); return { initial: true }; },
    failJob() { calls.push("initial-fail"); return { initial: true }; },
    successorCreated() { calls.push("initial-successor"); return { initial: true }; }
  };
  return { runtime, listeners, calls, event };
}

function invoke(listener, message) {
  return new Promise(resolve => {
    const keepChannel = listener(message, { tab: { id: 42 } }, resolve);
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
  assert.equal(listeners.length, 1);

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

test("non-terminal messages continue through the original scheduler listener", () => {
  const { runtime, listeners } = createRuntime();
  Boundary.install(runtime);
  let received = null;
  runtime.chrome.runtime.onMessage.addListener(message => {
    received = message.type;
    return false;
  });
  Boundary.finalize(runtime);

  const result = listeners[0]({ scope: Boundary.SCOPE, type: "GET_SCHEDULER_STATE" }, {}, () => {});
  assert.equal(result, false);
  assert.equal(received, "GET_SCHEDULER_STATE");
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

test("all terminal command types map to their installed handlers", () => {
  const expected = {
    JOB_STATUS: "updateJobStatus",
    JOB_DONE: "finishJob",
    JOB_ERROR: "failJob",
    JOB_INTERRUPTED: "interruptJob",
    JOB_ROLLOVER: "interruptJob",
    SUCCESSOR_CREATED: "successorCreated"
  };
  assert.deepEqual(Boundary.terminalHandlers, expected);
});
