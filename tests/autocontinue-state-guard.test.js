"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Guard = require("../autocontinue-state-guard.js");
const Transient = require("../autocontinue-transient-thinking.js");
const Deferred = require("../autocontinue-deferred-dispatch.js");

function runtimeSettings(value = {}) {
  return {
    ...Guard.FALLBACK_SETTINGS,
    ...value,
    maxContinuations: Math.max(1, Number(value.maxContinuations || Guard.FALLBACK_SETTINGS.maxContinuations))
  };
}

function validChat(overrides = {}) {
  return {
    id: "chat-1",
    title: "Chat one",
    url: "https://chatgpt.com/c/chat-1",
    sentCount: 1,
    currentJobId: "job-1",
    workerTabId: 42,
    settings: { maxContinuations: 7 },
    ...overrides
  };
}

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

test("repairs sparse scheduler state and restores missing chat settings", () => {
  const runtime = { normalizeSettings: runtimeSettings };
  const result = Guard.repairSchedulerState({
    running: true,
    settings: { prompt: "Continue", maxContinuations: 4 },
    chats: [
      validChat({ settings: undefined }),
      null,
      undefined,
      { title: "Missing identity" }
    ],
    handoffHistory: [null, { id: "handoff" }]
  }, runtime);

  assert.equal(result.repaired, true);
  assert.equal(result.removedChats, 3);
  assert.equal(result.state.chats.length, 1);
  assert.equal(result.state.chats[0].id, "chat-1");
  assert.equal(result.state.chats[0].settings.prompt, "Continue");
  assert.equal(result.state.chats[0].settings.maxContinuations, 4);
  assert.deepEqual(result.state.handoffHistory, [{ id: "handoff" }]);
});

test("repairs pending successor and parent settings", () => {
  const runtime = { normalizeSettings: runtimeSettings };
  const result = Guard.repairSchedulerState({
    running: true,
    settings: { prompt: "Base", maxContinuations: 5 },
    chats: [validChat({
      pendingSuccessor: {
        prompt: "Start fresh",
        parentChat: { id: "chat-1", title: "Parent", url: "https://chatgpt.com/c/chat-1" }
      }
    })]
  }, runtime);

  const pending = result.state.chats[0].pendingSuccessor;
  assert.equal(pending.settings.prompt, "Base");
  assert.equal(pending.resumeSettings.maxContinuations, 7);
  assert.equal(pending.parentChat.settings.maxContinuations, 7);
  assert.equal(pending.parentChat.pendingSuccessor, null);
});

test("an invalid stored run stops cleanly instead of dereferencing a missing chat", () => {
  const result = Guard.repairSchedulerState({
    running: true,
    status: "Running",
    chats: [null]
  }, { normalizeSettings: runtimeSettings });

  assert.equal(result.state.running, false);
  assert.equal(result.state.chats.length, 0);
  assert.match(result.state.lastError, /did not contain a valid chat/i);
});

test("installed guard rejects stale continuation and successor ownership", async () => {
  let stored = {
    running: true,
    token: 9,
    settings: { prompt: "Continue", maxContinuations: 5 },
    chats: [validChat()]
  };
  const calls = [];
  const runtime = {
    normalizeSettings: runtimeSettings,
    async loadState() { return stored; },
    async saveState(value) { stored = value; calls.push(["save"]); },
    publicState(value) { return { running: Boolean(value?.running), error: value?.lastError || "" }; },
    async queueNextChatJob(_state, index) { calls.push(["queue", index]); return { queued: true }; },
    async beginSuccessor(_state, index, message) { calls.push(["successor", index, message.jobId]); return { successor: true }; }
  };

  assert.equal(Guard.install(runtime), true);
  const loaded = await runtime.loadState();
  assert.equal(loaded.chats[0].settings.maxContinuations, 7);

  const staleQueue = await runtime.queueNextChatJob(loaded, 4);
  assert.equal(staleQueue.running, true);
  assert.match(staleQueue.error, /stale continuation/i);
  assert.equal(calls.some(call => call[0] === "queue"), false);

  const missingSuccessor = await runtime.beginSuccessor(loaded, 5, { jobId: "job-1" });
  assert.match(missingSuccessor.error, /stale successor/i);
  assert.equal(calls.some(call => call[0] === "successor"), false);

  const wrongOwner = await runtime.beginSuccessor(loaded, 0, { jobId: "old-job" });
  assert.match(wrongOwner.error, /stale successor/i);
  assert.equal(calls.some(call => call[0] === "successor"), false);

  const validSuccessor = await runtime.beginSuccessor(loaded, 0, { jobId: "job-1" });
  assert.deepEqual(validSuccessor, { successor: true });
  assert.equal(calls.some(call => call[0] === "successor" && call[1] === 0), true);
});

test("sparse state survives thinking recovery and deferred successor dispatch", async () => {
  const queue = controlledQueue();
  const calls = [];
  let stored = {
    running: true,
    token: 12,
    settings: { prompt: "Continue", maxContinuations: 5 },
    chats: [null, validChat({
      id: "chat-2",
      chainId: "chat-2",
      url: "https://chatgpt.com/c/chat-2",
      currentJobId: "job-4",
      transientThinkingRepeatCount: 3,
      settings: undefined
    })]
  };
  const runtime = {
    chrome: { tabs: { async reload() {} } },
    normalizeSettings: runtimeSettings,
    enqueue: queue.enqueue,
    async loadState() { return stored; },
    async saveState(value) { stored = value; },
    publicState(value) { return { running: Boolean(value?.running), chats: value?.chats || [] }; },
    isChatEligible(_state, chat) { return Boolean(chat && !chat.failed && !chat.retired); },
    findChatIndexForMessage(state, message, sender) {
      return state?.chats?.findIndex(chat =>
        chat?.workerTabId === sender?.tab?.id && chat?.currentJobId === message?.jobId
      ) ?? -1;
    },
    updateOverallStatus() {},
    async queueNextChatJob() { calls.push(["queue"]); return {}; },
    async beginSuccessor(state, index, message) {
      calls.push(["successor", state.chats[index].settings, message.jobId]);
      return { successor: true };
    },
    async failChatWorker() { calls.push(["fail"]); return {}; },
    async interruptJob() { calls.push(["original-interrupt"]); return {}; },
    async finishJob() { return {}; },
    async successorCreated() { return {}; }
  };

  assert.equal(Guard.install(runtime), true);
  assert.equal(Transient.install(runtime), true);
  assert.ok(Deferred.install(runtime));

  const acknowledged = await runtime.interruptJob({
    kind: "stalled",
    message: "Thinking",
    token: 12,
    jobId: "job-4"
  }, { tab: { id: 42 } });

  assert.equal(acknowledged.running, true);
  assert.equal(calls.some(call => call[0] === "successor"), false);
  assert.equal(queue.pending.length, 1);

  await queue.pending.shift()();
  const successor = calls.find(call => call[0] === "successor");
  assert.ok(successor);
  assert.equal(successor[1].maxContinuations, 5);
  assert.equal(successor[2], "job-4");
  assert.equal(calls.some(call => call[0] === "original-interrupt"), false);
});
