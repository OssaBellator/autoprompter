"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

// The script is an IIFE; a small browser-shaped environment exposes its pure exports.
global.location = { href: "https://chatgpt.com/c/demo", pathname: "/c/demo" };
global.addEventListener = () => {};
global.setInterval = () => 0;
global.chrome = {
  runtime: {
    sendMessage: () => Promise.resolve(null),
    onMessage: { addListener() {} }
  }
};
global.document = { querySelectorAll: () => [] };

const { conversationInfo, snapshotChanged, normalizeText, hashText } = require("../content.js");

test("conversation IDs are extracted from chat routes", () => {
  assert.deepEqual(conversationInfo("https://chatgpt.com/c/a%20b?x=1"), { id: "a b", url: "https://chatgpt.com/c/a%20b" });
  assert.equal(conversationInfo("https://chatgpt.com/"), null);
});

test("normalizes and hashes response text consistently", () => {
  assert.equal(normalizeText(" a\u00a0  b "), "a b");
  assert.equal(hashText("same"), hashText("same"));
  assert.notEqual(hashText("same"), hashText("different"));
});

test("same-turn replacement counts as a new response", () => {
  const before = { count: 4, identity: "turn-4", signature: "old" };
  assert.equal(snapshotChanged(before, { ...before, signature: "new" }), true);
  assert.equal(snapshotChanged(before, { ...before }), false);
});
