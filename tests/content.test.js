"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

global.location = { href: "https://chatgpt.com/c/demo", pathname: "/c/demo" };
global.addEventListener = () => {};
global.setInterval = () => 0;
global.chrome = {
  runtime: {
    sendMessage: () => Promise.resolve(null),
    onMessage: { addListener() {} }
  }
};
global.document = { querySelectorAll: () => [], title: "" };

const {
  conversationInfo,
  snapshotChanged,
  normalizeText,
  hashText,
  estimateTokensFromText,
  shouldRolloverContext,
  classifyGuardrailText,
  extractCheckpointMarker,
  extractHandoffMarker
} = require("../content.js");

test("conversation IDs are extracted from chat routes", () => {
  assert.deepEqual(conversationInfo("https://chatgpt.com/c/a%20b?x=1"), { id: "a b", url: "https://chatgpt.com/c/a%20b" });
  assert.equal(conversationInfo("https://chatgpt.com/"), null);
});

test("normalizes, hashes, and estimates response text consistently", () => {
  assert.equal(normalizeText(" a\u00a0  b "), "a b");
  assert.equal(hashText("same"), hashText("same"));
  assert.notEqual(hashText("same"), hashText("different"));
  assert.ok(estimateTokensFromText("one two three four") >= 5);
});

test("same-turn replacement counts as a new response", () => {
  const before = { count: 4, identity: "turn-4", signature: "old" };
  assert.equal(snapshotChanged(before, { ...before, signature: "new" }), true);
  assert.equal(snapshotChanged(before, { ...before }), false);
});

test("context rollover uses configured capacity and threshold", () => {
  assert.equal(shouldRolloverContext(90000, 100000, 90), true);
  assert.equal(shouldRolloverContext(89999, 100000, 90), false);
  assert.equal(shouldRolloverContext(90000, 0, 90), false);
});

test("classifies circuit-breaker and rollover notices", () => {
  assert.equal(classifyGuardrailText("System is thinking about this one").kind, "stalled");
  assert.equal(classifyGuardrailText("You have reached your usage limit. Try again in 2 hours.").kind, "rate_limit");
  assert.equal(classifyGuardrailText("This conversation is too long. Start a new chat to continue.").kind, "context_limit");
  assert.equal(classifyGuardrailText("Your request was blocked for safety.").kind, "safety_restriction");
});

test("extracts verified continuity markers", () => {
  assert.equal(extractCheckpointMarker("AUTOPROMPTER_CHECKPOINT: abcdef123456"), "abcdef123456");
  assert.equal(extractHandoffMarker("AUTOPROMPTER_HANDOFF_READY: release/v2.1.0"), "release/v2.1.0");
  assert.equal(extractCheckpointMarker("AUTOPROMPTER_CHECKPOINT_FAILED: no tool"), "");
});
