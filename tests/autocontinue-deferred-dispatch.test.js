"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const DeferredDispatch = require("../autocontinue-deferred-dispatch.js");

function fixture() {
  const events = [];
  const state = {
    running: true,
    token: 42,
    settings: { maxContinuations: 5 },
    chats: [{
      id: "chat-1",
      chainId: "chat-1",
      generation: 0,
      sentCount: 1,
      currentJobId: null,
      failed: false,
      retired: false,
      settings: { maxContinuations: 5 }
    }]
  };
  let operationQueue = Promise.resolve();
  let queueCalls = 0;
  const runtime = {
    enqueue(operation) {
      operationQueue = operationQueue.catch(() => {}).then(operation);
      return operationQueue;
    },
    async loadState() {
      return state;
    },
    publicState(value) {
      return { running: Boolean(value?.running) };
    },
    isChatEligible(value, chat) {
      const limit = Number(chat?.settings?.maxContinuations || value?.settings?.maxContinuations || 1);
      return Boolean(chat && !chat.failed && !chat.retired && Number(chat.sentCount || 0) < limit);
    },
    async queueNextChatJob(value, index) {
      queueCalls += 1;
      events.push("dispatch");
      value.chats[index].currentJobId = `next-${queueCalls}`;
      return { queued: true };
    }
  };
  for (const name of DeferredDispatch.TERMINAL_METHODS) {
    runtime[name] = async () => runtime.queueNextChatJob(state, 0);
  }

  function runTerminal(name, message = {}) {
    const operation = runtime.enqueue(() => runtime[name](message, {}));
    const acknowledgement = operation.then(result => {
      events.push("acknowledge");
      return result;
    });
    return acknowledgement;
  }

  return {
    runtime,
    state,
    events,
    runTerminal,
    drain: () => operationQueue,
    queueCalls: () => queueCalls
  };
}

test("successful completion is acknowledged before the next prompt is dispatched", async () => {
  const setup = fixture();
  assert.ok(DeferredDispatch.install(setup.runtime));

  const result = await setup.runTerminal("finishJob", { jobId: "first" });
  assert.deepEqual(result, { running: true });
  assert.equal(setup.queueCalls(), 0);
  assert.equal(setup.state.chats[0].currentJobId, null);

  await setup.drain();
  assert.equal(setup.queueCalls(), 1);
  assert.equal(setup.state.chats[0].currentJobId, "next-1");
  assert.deepEqual(setup.events, ["acknowledge", "dispatch"]);
});

test("recoverable interruption also acknowledges before retry dispatch", async () => {
  const setup = fixture();
  assert.ok(DeferredDispatch.install(setup.runtime));

  await setup.runTerminal("interruptJob", { jobId: "retry" });
  assert.equal(setup.queueCalls(), 0);
  await setup.drain();
  assert.equal(setup.queueCalls(), 1);
  assert.deepEqual(setup.events, ["acknowledge", "dispatch"]);
});

test("stale or already-queued state suppresses duplicate delayed dispatch", async () => {
  const setup = fixture();
  assert.ok(DeferredDispatch.install(setup.runtime));

  await setup.runTerminal("finishJob", { jobId: "first" });
  setup.state.chats[0].currentJobId = "already-queued";
  await setup.drain();
  assert.equal(setup.queueCalls(), 0);
  assert.deepEqual(setup.events, ["acknowledge"]);
});