"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Recovery = require("../autocontinue-transient-thinking.js");

test("treats Thinking error variants as transient generation states", () => {
  assert.equal(Recovery.isTransientThinkingStatus("Thinking error"), true);
  assert.equal(Recovery.isTransientThinkingStatus("Thinking… error"), true);
  assert.equal(Recovery.isTransientThinkingStatus("Generating failed"), true);
  assert.equal(Recovery.isTransientThinkingStatus("Working stuck | 0:42"), true);
});

test("does not broaden matching to ordinary error descriptions", () => {
  assert.equal(Recovery.isTransientThinkingStatus("Thinking through an error"), false);
  assert.equal(Recovery.isTransientThinkingStatus("The worker failed while thinking"), false);
});
