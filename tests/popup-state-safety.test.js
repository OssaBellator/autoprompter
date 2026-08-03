"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Safety = require("../popup-state-safety.js");

test("normalizes missing scheduler settings and removes invalid chat rows", () => {
  const result = Safety.normalizeSchedulerResponse({
    ok: true,
    running: true,
    settings: undefined,
    chats: [
      null,
      undefined,
      { id: "chat-1", title: "", sentCount: "2", settings: undefined },
      { title: "missing id" }
    ],
    workerTabIds: [12, null, "13", 14]
  });

  assert.deepEqual(result.settings, {});
  assert.equal(result.chats.length, 1);
  assert.equal(result.chats[0].id, "chat-1");
  assert.equal(result.chats[0].title, "Untitled chat");
  assert.equal(result.chats[0].sentCount, 2);
  assert.deepEqual(result.chats[0].settings, {});
  assert.deepEqual(result.workerTabIds, [12, 14]);
});

test("inherits run settings into each valid popup chat", () => {
  const result = Safety.normalizeSchedulerResponse({
    running: true,
    settings: { prompt: "Continue", maxContinuations: 5 },
    chats: [{ id: "chat-2", settings: { maxContinuations: 8 } }]
  });

  assert.equal(result.chats[0].settings.prompt, "Continue");
  assert.equal(result.chats[0].settings.maxContinuations, 8);
});

test("leaves unrelated responses unchanged", () => {
  const response = { ok: true, settings: undefined };
  const result = Safety.normalizeSchedulerResponse(response);
  assert.notEqual(result, response);
  assert.deepEqual(result.settings, {});
  const unrelated = { ok: true, value: 42 };
  assert.equal(Safety.normalizeSchedulerResponse(unrelated), unrelated);
});

test("installed sendMessage wrapper normalizes promise scheduler responses", async () => {
  const runtime = {
    chrome: {
      runtime: {
        sendMessage(message) {
          return Promise.resolve({
            ok: true,
            running: true,
            settings: undefined,
            chats: [null, { id: "chat-3", settings: undefined }],
            echo: message.type
          });
        }
      }
    }
  };

  assert.equal(Safety.install(runtime), true);
  const response = await runtime.chrome.runtime.sendMessage({
    scope: Safety.SCOPE,
    type: "GET_SCHEDULER_STATE"
  });

  assert.equal(response.echo, "GET_SCHEDULER_STATE");
  assert.equal(response.chats.length, 1);
  assert.deepEqual(response.chats[0].settings, {});
  assert.equal(Safety.install(runtime), false);
});
