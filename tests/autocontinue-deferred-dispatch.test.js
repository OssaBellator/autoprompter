"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

function loadModuleWithRoot(root) {
  const modulePath = require.resolve("../autocontinue-deferred-dispatch.js");
  delete require.cache[modulePath];
  const previous = globalThis.AutoPrompterDeferredDispatch;
  Object.assign(globalThis, root);
  const api = require(modulePath);
  if (previous === undefined) delete globalThis.AutoPrompterDeferredDispatch;
  else globalThis.AutoPrompterDeferredDispatch = previous;
  return api;
}

function fixture() {
  const timers = [];
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
  let queueCalls = 0;
  const root = {
    setTimeout(callback) {
      timers.push(callback);
      return timers.length;
    },
    enqueue(operation) {
      return Promise.resolve().then(operation);
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
      value.chats[index].currentJobId = `next-${queueCalls}`;
      return { queued: true };
    }
  };
  for (const name of ["finishJob", "interruptJob", "successorCreated"]) {
    root[name] = async () => root.queueNextChatJob(state, 0);
  }
  return { root, state, timers, queueCalls: () => queueCalls };
}

async function flushScheduled(timers) {
  assert.equal(timers.length, 1);
  timers.shift()();
  await new Promise(resolve => setImmediate(resolve));
}

test("successful completion is acknowledged before the next prompt is dispatched", async () => {
  const setup = fixture();
  const api = loadModuleWithRoot(setup.root);
  assert.ok(api.install());

  const result = await globalThis.finishJob({ jobId: "first" }, {});
  assert.deepEqual(result, { running: true });
  assert.equal(setup.queueCalls(), 0);
  assert.equal(setup.state.chats[0].currentJobId, null);

  await flushScheduled(setup.timers);
  assert.equal(setup.queueCalls(), 1);
  assert.equal(setup.state.chats[0].currentJobId, "next-1");
});

test("recoverable interruption also waits for its acknowledgement before retrying", async () => {
  const setup = fixture();
  const api = loadModuleWithRoot(setup.root);
  assert.ok(api.install());

  await globalThis.interruptJob({ jobId: "retry" }, {});
  assert.equal(setup.queueCalls(), 0);
  await flushScheduled(setup.timers);
  assert.equal(setup.queueCalls(), 1);
});

test("stale or already-queued state suppresses duplicate delayed dispatch", async () => {
  const setup = fixture();
  const api = loadModuleWithRoot(setup.root);
  assert.ok(api.install());

  await globalThis.finishJob({ jobId: "first" }, {});
  setup.state.chats[0].currentJobId = "already-queued";
  await flushScheduled(setup.timers);
  assert.equal(setup.queueCalls(), 0);
});