"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Recovery = require("../autocontinue-transient-thinking.js");
const Deferred = require("../autocontinue-deferred-dispatch.js");

function controlledQueue() {
  const pending = [];
  return {
    pending,
    enqueue(operation) {
      let resolvePromise;
      let rejectPromise;
      const promise = new Promise((resolve, reject) => {
        resolvePromise = resolve;
        rejectPromise = reject;
      });
      pending.push(async () => {
        try {
          const result = await operation();
          resolvePromise(result);
          return result;
        } catch (error) {
          rejectPromise(error);
          throw error;
        }
      });
      return promise;
    }
  };
}

test("recognizes only transient generation-status segments", () => {
  assert.equal(Recovery.isTransientThinkingStatus("Thinking"), true);
  assert.equal(Recovery.isTransientThinkingStatus("Notice: Thinking…"), true);
  assert.equal(Recovery.isTransientThinkingStatus("Thinking | 0:42"), true);
  assert.equal(Recovery.transientStatusName("Thinking | 0:42"), "Thinking");
  assert.equal(Recovery.isTransientThinkingStatus("Generating..."), true);
  assert.equal(Recovery.isTransientThinkingStatus("Working"), true);
  assert.equal(Recovery.isTransientThinkingStatus("Thinking through the implementation"), false);
  assert.equal(Recovery.isTransientThinkingStatus("Our systems are thinking a bit more about this request"), false);
});

test("acknowledges before reloading the same chat or starting a fresh chat", async () => {
  const calls = [];
  const queue = controlledQueue();
  const state = {
    running: true,
    token: 7,
    chats: [{
      id: "chat-2",
      chainId: "chat-2",
      title: "Second selected chat",
      workerTabId: 42,
      currentJobId: "job-1",
      jobDispatched: true,
      contentReady: true,
      initialJobPending: false,
      transientThinkingRepeatCount: 0,
      connectionRetryCount: 0,
      rolloverCount: 0,
      sentCount: 0,
      failed: false,
      retired: false,
      settings: { maxRollovers: 1, maxContinuations: 5 }
    }]
  };
  const sender = { tab: { id: 42 } };
  const runtime = {
    chrome: {
      tabs: {
        async reload(tabId) {
          calls.push(["reload", tabId]);
        }
      }
    },
    enqueue: queue.enqueue,
    async loadState() { return state; },
    async saveState() { calls.push(["save"]); },
    publicState(current) { return { running: Boolean(current?.running), status: current?.chats?.[0]?.status || "" }; },
    isChatEligible(_state, chat) { return !chat.failed && !chat.retired && Number(chat.sentCount || 0) < 5; },
    findChatIndexForMessage(current, message, currentSender) {
      return current.running
        && message.token === current.token
        && message.jobId === current.chats[0].currentJobId
        && currentSender.tab.id === current.chats[0].workerTabId
        ? 0
        : -1;
    },
    updateOverallStatus(_state, status) { calls.push(["status", status]); },
    async queueNextChatJob(_state, index) {
      calls.push(["queue", index]);
      return { queued: true };
    },
    async beginSuccessor(_state, index, message) {
      calls.push(["successor", index, message]);
      return { successor: true };
    },
    async failChatWorker(_state, index, error) {
      calls.push(["fail", index, error]);
      return { failed: true };
    },
    async interruptJob() {
      calls.push(["original-interrupt"]);
      return { original: true };
    },
    async finishJob() {
      calls.push(["original-finish"]);
      return { finished: true };
    },
    async successorCreated() {
      calls.push(["original-successor-created"]);
      return { created: true };
    }
  };

  assert.equal(Recovery.install(runtime), true);
  assert.ok(Deferred.install(runtime));

  const first = await runtime.interruptJob({
    kind: "stalled",
    message: "Thinking | 0:42",
    token: 7,
    jobId: "job-1"
  }, sender);

  assert.equal(first.running, true);
  assert.equal(state.chats[0].transientThinkingRepeatCount, 1);
  assert.equal(state.chats[0].contentReady, false);
  assert.equal(state.chats[0].forceReloadBeforeNext, true);
  assert.equal(calls.some(call => call[0] === "reload"), false);
  assert.equal(calls.some(call => call[0] === "queue"), false);
  assert.equal(queue.pending.length, 1);

  await queue.pending.shift()();
  assert.equal(calls.some(call => call[0] === "reload" && call[1] === 42), true);
  assert.equal(calls.some(call => call[0] === "queue"), true);
  assert.equal(calls.some(call => call[0] === "successor"), false);
  assert.equal(calls.some(call => call[0] === "original-interrupt"), false);

  calls.length = 0;
  state.chats[0].currentJobId = "job-4";
  state.chats[0].transientThinkingRepeatCount = 3;
  state.chats[0].contentReady = true;
  const fourth = await runtime.interruptJob({
    kind: "stalled",
    message: "Thinking",
    token: 7,
    jobId: "job-4"
  }, sender);

  assert.equal(fourth.running, true);
  assert.equal(calls.some(call => call[0] === "successor"), false);
  assert.equal(queue.pending.length, 1);

  await queue.pending.shift()();
  const successor = calls.find(call => call[0] === "successor");
  assert.equal(successor[2].forceFreshStart, true);
  assert.equal(successor[2].transientThinkingRecovery, true);
  assert.equal(state.chats[0].transientThinkingRepeatCount, 0);
  assert.equal(calls.some(call => call[0] === "reload"), false);
});

test("a different interruption resets the stale-status counter before delegation", async () => {
  const state = {
    running: true,
    token: 9,
    chats: [{ workerTabId: 18, currentJobId: "other", transientThinkingRepeatCount: 2 }]
  };
  let delegated = false;
  const runtime = {
    chrome: { tabs: { async reload() {} } },
    enqueue(operation) { return Promise.resolve().then(operation); },
    async loadState() { return state; },
    async saveState() {},
    publicState(current) { return current; },
    findChatIndexForMessage(current, message, sender) {
      return message.token === current.token
        && message.jobId === current.chats[0].currentJobId
        && sender.tab.id === current.chats[0].workerTabId
        ? 0
        : -1;
    },
    updateOverallStatus() {},
    async queueNextChatJob() {},
    async beginSuccessor() {},
    async failChatWorker() {},
    async interruptJob() { delegated = true; return { delegated: true }; },
    async finishJob() {}
  };

  assert.equal(Recovery.install(runtime), true);
  const result = await runtime.interruptJob({
    kind: "context_limit",
    message: "Maximum conversation length reached",
    token: 9,
    jobId: "other"
  }, { tab: { id: 18 } });

  assert.deepEqual(result, { delegated: true });
  assert.equal(state.chats[0].transientThinkingRepeatCount, 0);
  assert.equal(delegated, true);
});

test("a successful completion resets the stale-status counter", async () => {
  const state = {
    running: true,
    token: 3,
    chats: [{ workerTabId: 8, currentJobId: "done", transientThinkingRepeatCount: 2 }]
  };
  let originalFinished = false;
  const runtime = {
    chrome: { tabs: { async reload() {} } },
    enqueue(operation) { return Promise.resolve().then(operation); },
    async loadState() { return state; },
    async saveState() {},
    publicState(current) { return current; },
    findChatIndexForMessage(current, message, sender) {
      return message.token === current.token
        && message.jobId === current.chats[0].currentJobId
        && sender.tab.id === current.chats[0].workerTabId
        ? 0
        : -1;
    },
    updateOverallStatus() {},
    async queueNextChatJob() {},
    async beginSuccessor() {},
    async failChatWorker() {},
    async interruptJob() {},
    async finishJob() { originalFinished = true; return { finished: true }; }
  };

  assert.equal(Recovery.install(runtime), true);
  const result = await runtime.finishJob({ token: 3, jobId: "done" }, { tab: { id: 8 } });
  assert.deepEqual(result, { finished: true });
  assert.equal(state.chats[0].transientThinkingRepeatCount, 0);
  assert.equal(originalFinished, true);
});

test("the fourth bare status selects a fresh chat", () => {
  assert.deepEqual(Recovery.nextAction(0), { count: 1, action: "reload_same_chat" });
  assert.deepEqual(Recovery.nextAction(2), { count: 3, action: "reload_same_chat" });
  assert.deepEqual(Recovery.nextAction(3), { count: 4, action: "new_chat" });
  assert.equal(Recovery.MAX_SAME_CHAT_RELOADS, 3);
});
