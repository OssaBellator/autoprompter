"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Recovery = require("../autocontinue-extended-thinking.js");

test("detects the complete extended-thinking platform notice only", () => {
  const notice = "Our systems are thinking a bit more about this request before responding. You can retry with a faster model for a quicker response, though it may be less capable of handling complex requests. Learn more";
  assert.equal(Recovery.isExtendedThinkingNotice(notice), true);
  assert.equal(Recovery.isExtendedThinkingNotice(`Notice: ${notice}`), true);
  assert.equal(Recovery.isExtendedThinkingNotice("The systems are thinking about a better design."), false);
});

test("the fourth consecutive extended-thinking notice starts a new chat", () => {
  assert.deepEqual(Recovery.nextAction(0), { count: 1, action: "retry_same_chat" });
  assert.deepEqual(Recovery.nextAction(1), { count: 2, action: "retry_same_chat" });
  assert.deepEqual(Recovery.nextAction(2), { count: 3, action: "retry_same_chat" });
  assert.deepEqual(Recovery.nextAction(3), { count: 4, action: "new_chat" });
  assert.equal(Recovery.MAX_SAME_CHAT_REPEATS, 3);
});
