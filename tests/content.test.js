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
  matureGuardrail,
  shouldHandleInterruption,
  buildDurableWorkPrompt,
  buildInitializationPrompt,
  extractCheckpointMarker,
  extractHandoffMarker,
  getChatCatalog
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
  assert.equal(classifyGuardrailText("Thinking…").kind, "stalled");
  assert.equal(classifyGuardrailText("Generating...").kind, "stalled");
  assert.equal(classifyGuardrailText("Working").kind, "stalled");
  assert.equal(classifyGuardrailText("A warning | Thinking… | Another status").kind, "stalled");
  assert.equal(classifyGuardrailText("We detect suspicious activity.").kind, "account_restriction");
  assert.equal(classifyGuardrailText("Unusual Activity Detected").kind, "account_restriction");
  assert.equal(classifyGuardrailText("Unusual activity has been detected from your device. Try again later").kind, "account_restriction");
  assert.equal(classifyGuardrailText("Sorry, you have been blocked").kind, "account_restriction");
  assert.equal(classifyGuardrailText("We've temporarily restricted your access to O1 Pro mode as we review for potential abuse.").kind, "account_restriction");
  assert.equal(classifyGuardrailText("You have reached your usage limit. Try again in 2 hours.").kind, "rate_limit");
  assert.equal(classifyGuardrailText("This conversation is too long. Start a new chat to continue.").kind, "context_limit");
  assert.equal(classifyGuardrailText("Your request was blocked for safety.").kind, "safety_restriction");
  assert.equal(classifyGuardrailText("Your request was flagged as potentially violating our usage policy. Please try again with a different prompt.").kind, "safety_restriction");
  assert.equal(classifyGuardrailText("This content may violate our Terms of Use or usage policies.").kind, "safety_restriction");
  assert.equal(classifyGuardrailText("I was thinking about this one and then continued."), null);
  assert.equal(classifyGuardrailText("The generating function is working correctly."), null);
});

test("stall guardrails mature only after the configured timeout", () => {
  const notice = classifyGuardrailText("Thinking…");
  const seen = new Map();
  assert.equal(matureGuardrail(notice, { stallMinutes: 5 }, 1_000, seen), null);
  assert.equal(matureGuardrail(notice, { stallMinutes: 5 }, 300_999, seen), null);
  assert.equal(matureGuardrail(notice, { stallMinutes: 5 }, 301_000, seen).kind, "stalled");
});

test("durable work prompts require incremental repository commits", () => {
  const prompt = buildDurableWorkPrompt({
    continuityEnabled: true,
    repository: "owner/repo",
    handoffFile: "AUTOPROMPTER_HANDOFF.md",
    pluginInstruction: "Use the repository tool.",
    prompt: "Implement the next phase."
  });
  assert.match(prompt, /Commit each completed logical unit promptly/);
  assert.match(prompt, /Do not leave completed implementation only in chat text/);
  assert.match(prompt, /Implement the next phase/);
  assert.equal(buildDurableWorkPrompt({ continuityEnabled: false, prompt: "Continue" }), "Continue");
});

test("extracts verified continuity markers", () => {
  assert.equal(extractCheckpointMarker("AUTOPROMPTER_CHECKPOINT: abcdef123456"), "abcdef123456");
  assert.equal(extractHandoffMarker("AUTOPROMPTER_HANDOFF_READY: release/v2.1.0"), "release/v2.1.0");
  assert.equal(extractCheckpointMarker("AUTOPROMPTER_CHECKPOINT_FAILED: no tool"), "");
});


test("normal discussion of safeguards does not trip the circuit breaker", () => {
  const prose = "The implementation should account for rate limits, account restrictions, and safety blocks without bypassing them.";
  assert.equal(classifyGuardrailText(prose, "assistant"), null);
  assert.equal(classifyGuardrailText("Rate limits, account restrictions, and safety blocks stop the scheduler instead of opening another chat.", "notice"), null);
});

test("exact platform restriction messages still trip the circuit breaker", () => {
  assert.equal(classifyGuardrailText("Unusual Activity Detected", "notice").kind, "account_restriction");
  assert.equal(classifyGuardrailText("Too many requests.", "notice").kind, "rate_limit");
  assert.equal(classifyGuardrailText("Your request was blocked", "assistant").kind, "safety_restriction");
});

test("continuity initialization prompt creates and verifies durable state", () => {
  const prompt = buildInitializationPrompt({
    repository: "owner/project",
    handoffFile: "AUTOPROMPTER_HANDOFF.md",
    pluginInstruction: "Use Codex."
  });
  assert.match(prompt, /Create the continuity file if it does not exist/);
  assert.match(prompt, /AUTOPROMPTER_CHECKPOINT:/);
  assert.match(prompt, /Verify the commit exists remotely/);
});


test("automatic circuit breaker can be disabled without disabling continuity interruptions", () => {
  assert.equal(shouldHandleInterruption({ kind: "rate_limit" }, { circuitBreakerEnabled: true }), true);
  assert.equal(shouldHandleInterruption({ kind: "rate_limit" }, { circuitBreakerEnabled: false }), false);
  assert.equal(shouldHandleInterruption({ kind: "account_restriction" }, { circuitBreakerEnabled: false }), false);
  assert.equal(shouldHandleInterruption({ kind: "safety_restriction" }, { circuitBreakerEnabled: false }), false);
  assert.equal(shouldHandleInterruption({ kind: "context_limit" }, { circuitBreakerEnabled: false }), true);
  assert.equal(shouldHandleInterruption({ kind: "content_removed" }, { circuitBreakerEnabled: false }), true);
  assert.equal(shouldHandleInterruption({ kind: "stalled" }, { circuitBreakerEnabled: false }), true);
});


test("chat catalog preserves sidebar recency order", () => {
  const anchors = [
    { href: "https://chatgpt.com/c/recent", innerText: "Recent work", textContent: "Recent work", getAttribute: () => "" },
    { href: "https://chatgpt.com/c/older", innerText: "Older work", textContent: "Older work", getAttribute: () => "" }
  ];
  const originalQuery = document.querySelectorAll;
  const originalTitle = document.title;
  const originalHref = location.href;
  document.querySelectorAll = selector => selector.includes('/c/') ? anchors : [];
  document.title = "Recent work | ChatGPT";
  location.href = "https://chatgpt.com/c/recent";
  const chats = getChatCatalog();
  document.querySelectorAll = originalQuery;
  document.title = originalTitle;
  location.href = originalHref;
  assert.deepEqual(chats.slice(0, 2).map(chat => chat.id), ["recent", "older"]);
  assert.deepEqual(chats.slice(0, 2).map(chat => chat.sidebarIndex), [0, 1]);
});
