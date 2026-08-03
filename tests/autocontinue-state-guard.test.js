"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Guard = require("../autocontinue-state-guard.js");

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
