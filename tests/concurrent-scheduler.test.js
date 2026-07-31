"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const sessionStore = {};
const localStore = {};
const tabs = new Map();
const sentMessages = [];
const createdTabs = [];
const removedTabs = [];
let nextTabId = 100;
let runtimeListener = null;

function clone(value) {
  return value == null ? value : structuredClone(value);
}

global.chrome = {
  runtime: {
    getManifest: () => ({ version: "2.5.0" }),
    onMessage: { addListener(listener) { runtimeListener = listener; } }
  },
  storage: {
    session: {
      async get(key) { return { [key]: clone(sessionStore[key]) }; },
      async set(values) { Object.assign(sessionStore, clone(values)); }
    },
    local: {
      async get(keys) {
        const result = {};
        for (const key of Array.isArray(keys) ? keys : [keys]) result[key] = clone(localStore[key]);
        return result;
      },
      async set(values) { Object.assign(localStore, clone(values)); }
    }
  },
  tabs: {
    async create(options) {
      const tab = { id: nextTabId++, url: options.url, status: "complete", active: Boolean(options.active) };
      tabs.set(tab.id, tab);
      createdTabs.push(tab.id);
      return clone(tab);
    },
    async update(tabId, changes) {
      const tab = tabs.get(tabId);
      if (!tab) throw new Error("missing tab");
      Object.assign(tab, changes, { status: "complete" });
      return clone(tab);
    },
    async get(tabId) {
      const tab = tabs.get(tabId);
      if (!tab) throw new Error("missing tab");
      return clone(tab);
    },
    async remove(tabId) {
      tabs.delete(tabId);
      removedTabs.push(tabId);
    },
    async sendMessage(tabId, message) {
      sentMessages.push({ tabId, message: clone(message) });
      return { ok: true };
    },
    onRemoved: { addListener() {} },
    onUpdated: { addListener() {} }
  },
  notifications: { async create() {} },
  action: {
    async setBadgeText() {},
    async setBadgeBackgroundColor() {}
  }
};

require("../background.js");

function resetHarness() {
  for (const key of Object.keys(sessionStore)) delete sessionStore[key];
  for (const key of Object.keys(localStore)) delete localStore[key];
  tabs.clear();
  sentMessages.length = 0;
  createdTabs.length = 0;
  removedTabs.length = 0;
  nextTabId = 100;
}

function dispatch(message, sender = {}) {
  return new Promise((resolve, reject) => {
    const handled = runtimeListener(message, sender, response => resolve(response));
    if (!handled) reject(new Error("message not handled"));
  });
}

test("selected chats run concurrently and the fastest chat advances independently", async () => {
  resetHarness();
  const chats = ["alpha", "beta", "gamma"].map(id => ({
    id,
    title: id,
    url: `https://chatgpt.com/c/${id}`,
    settings: { prompt: `continue ${id}`, maxContinuations: 2 }
  }));

  const started = await dispatch({
    scope: "AUTOPROMPTER_RUNTIME",
    type: "START_SCHEDULER",
    chats,
    settings: { delaySeconds: 5, maxContinuations: 2 },
    mode: "work"
  });

  assert.equal(started.ok, true);
  assert.equal(createdTabs.length, 3);
  assert.equal(started.workerTabIds.length, 3);
  assert.equal(new Set(started.workerTabIds).size, 3);
  assert.ok(started.chats.every(chat => chat.currentJobId && chat.status === "Loading"));

  for (const chat of started.chats) {
    await dispatch(
      { scope: "AUTOPROMPTER_RUNTIME", type: "CONTENT_READY" },
      { tab: { id: chat.workerTabId } }
    );
  }
  const firstJobs = sentMessages.filter(item => item.message.type === "RUN_CHAT_JOB");
  assert.equal(firstJobs.length, 3);
  assert.deepEqual(new Set(firstJobs.map(item => item.tabId)), new Set(started.workerTabIds));

  const before = clone(sessionStore.autoprompterScheduler);
  const fastest = before.chats[1];
  await dispatch({
    scope: "AUTOPROMPTER_RUNTIME",
    type: "JOB_DONE",
    token: before.token,
    jobId: fastest.currentJobId,
    contextEstimateTokens: 1234,
    contextPercent: 1.2
  }, { tab: { id: fastest.workerTabId } });

  const after = clone(sessionStore.autoprompterScheduler);
  assert.equal(after.chats[1].sentCount, 1);
  assert.notEqual(after.chats[1].currentJobId, fastest.currentJobId);
  assert.equal(after.chats[0].currentJobId, before.chats[0].currentJobId);
  assert.equal(after.chats[2].currentJobId, before.chats[2].currentJobId);

  const betaJobs = sentMessages.filter(item => item.tabId === fastest.workerTabId && item.message.type === "RUN_CHAT_JOB");
  assert.equal(betaJobs.length, 2);
  assert.equal(removedTabs.length, 0);
});


test("a selected legacy chat can start directly in a new conversation", async () => {
  resetHarness();
  const started = await dispatch({
    scope: "AUTOPROMPTER_RUNTIME",
    type: "START_SCHEDULER",
    chats: [{
      id: "legacy",
      title: "Legacy project",
      url: "https://chatgpt.com/c/legacy",
      startInNewChat: true,
      settings: { prompt: "Continue the legacy goal", maxContinuations: 2 }
    }],
    settings: { delaySeconds: 5, maxContinuations: 2 },
    mode: "work"
  });
  const chat = started.chats[0];
  assert.equal(tabs.get(chat.workerTabId).url, "https://chatgpt.com/");
  assert.equal(chat.pendingSuccessor.kind, "forced_start");

  await dispatch({ scope: "AUTOPROMPTER_RUNTIME", type: "CONTENT_READY" }, { tab: { id: chat.workerTabId } });
  const job = sentMessages.find(item => item.message.type === "RUN_SUCCESSOR_JOB");
  assert.ok(job);
  assert.match(job.message.prompt, /cannot access the previous chat transcript/i);
  assert.match(job.message.prompt, /Continue the legacy goal/);
  assert.equal(job.message.settings.checkpointAfterPrompt, false);
});

test("an unverified context-limit interruption opens a best-effort successor", async () => {
  resetHarness();
  const started = await dispatch({
    scope: "AUTOPROMPTER_RUNTIME",
    type: "START_SCHEDULER",
    chats: [{ id: "full", title: "Full chat", url: "https://chatgpt.com/c/full", settings: { prompt: "Continue", maxContinuations: 2 } }],
    settings: { delaySeconds: 5, maxContinuations: 2, continuityEnabled: false },
    mode: "work"
  });
  const before = clone(sessionStore.autoprompterScheduler);
  const chat = before.chats[0];
  await dispatch({
    scope: "AUTOPROMPTER_RUNTIME",
    type: "JOB_INTERRUPTED",
    token: before.token,
    jobId: chat.currentJobId,
    kind: "context_limit",
    message: "This conversation is too long."
  }, { tab: { id: chat.workerTabId } });
  const state = clone(sessionStore.autoprompterScheduler);
  assert.equal(state.running, true);
  assert.equal(state.chats[0].failed, false);
  assert.equal(state.chats[0].pendingSuccessor.kind, "best_effort");
  assert.equal(tabs.get(state.chats[0].workerTabId).url, "https://chatgpt.com/");
});
