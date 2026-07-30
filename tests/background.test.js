"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

// Minimal extension stubs allow loading the service-worker module in Node.
global.chrome = {
  runtime: { onMessage: { addListener() {} }, getManifest: () => ({ version: "2.0.0" }) },
  tabs: { onRemoved: { addListener() {} }, onUpdated: { addListener() {} } },
  storage: { session: {} }
};

const {
  DEFAULTS,
  normalizeSettings,
  normalizeConversationUrl,
  normalizeChat,
  nextEligibleIndex
} = require("../background.js");

test("normalizes settings and clamps limits", () => {
  assert.deepEqual(normalizeSettings({ prompt: "  go  ", delaySeconds: 0, maxContinuations: 99 }), {
    prompt: "go",
    delaySeconds: 0.5,
    maxContinuations: 50
  });
  assert.equal(normalizeSettings({}).prompt, DEFAULTS.prompt);
});

test("accepts only ChatGPT conversation URLs", () => {
  assert.deepEqual(normalizeConversationUrl("https://chatgpt.com/c/abc-123?x=1"), {
    id: "abc-123",
    url: "https://chatgpt.com/c/abc-123"
  });
  assert.equal(normalizeConversationUrl("https://example.com/c/abc"), null);
  assert.equal(normalizeConversationUrl("https://chatgpt.com/"), null);
});

test("normalizes chat metadata", () => {
  assert.deepEqual(normalizeChat({ id: "abc", title: "  Project  ", url: "https://chat.openai.com/c/abc" }), {
    id: "abc",
    title: "Project",
    url: "https://chatgpt.com/c/abc",
    sentCount: 0,
    status: "Queued",
    lastError: "",
    failed: false
  });
});

test("scheduler rotates among eligible selected chats", () => {
  const chats = [
    { sentCount: 2, failed: false },
    { sentCount: 0, failed: true },
    { sentCount: 1, failed: false }
  ];
  assert.equal(nextEligibleIndex(chats, 0, 2), 2);
  chats[2].sentCount = 2;
  assert.equal(nextEligibleIndex(chats, 2, 2), -1);
});
