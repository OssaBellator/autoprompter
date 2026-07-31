"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

global.chrome = {
  runtime: {
    onMessage: { addListener() {} },
    getManifest: () => ({ version: "2.8.0" }),
    getURL: value => `chrome-extension://test/${value}`
  },
  action: {},
  notifications: {},
  tabs: { onRemoved: { addListener() {} }, onUpdated: { addListener() {} } },
  storage: { session: {}, local: {} }
};

const {
  DEFAULTS,
  normalizeSettings,
  normalizeRepository,
  normalizeHandoffFile,
  normalizeConversationUrl,
  isNewChatUrl,
  normalizeChat,
  nextEligibleIndex,
  eligibleChatIndexes,
  isChatEligible,
  MAX_CONCURRENT_CHATS,
  buildSuccessorPrompt,
  buildFreshStartPrompt,
  INITIAL_BATCH_GRACE_MS
} = require("../background.js");

test("normalizes settings and clamps limits", () => {
  const settings = normalizeSettings({
    prompt: "  go  ",
    delaySeconds: 0,
    maxContinuations: 99,
    contextThresholdPercent: 101,
    stallMinutes: 1
  });
  assert.equal(settings.prompt, "go");
  assert.equal(settings.delaySeconds, 5);
  assert.equal(settings.maxContinuations, 50);
  assert.equal(settings.contextThresholdPercent, 98);
  assert.equal(settings.stallMinutes, 5);
  assert.equal(settings.circuitBreakerEnabled, true);
  assert.equal(normalizeSettings({ circuitBreakerEnabled: false }).circuitBreakerEnabled, false);
  assert.equal(normalizeSettings({}).prompt, DEFAULTS.prompt);
});

test("normalizes GitHub repositories and continuity paths", () => {
  assert.equal(normalizeRepository("OssaBellator/autoprompter"), "OssaBellator/autoprompter");
  assert.equal(normalizeRepository("https://github.com/OssaBellator/autoprompter.git"), "OssaBellator/autoprompter");
  assert.equal(normalizeRepository("https://example.com/owner/repo"), "");
  assert.equal(normalizeHandoffFile("docs/HANDOFF.md"), "docs/HANDOFF.md");
  assert.equal(normalizeHandoffFile("../secret"), DEFAULTS.handoffFile);
});

test("continuity is disabled without a valid repository", () => {
  assert.equal(normalizeSettings({ continuityEnabled: true, repository: "bad" }).continuityEnabled, false);
  assert.equal(normalizeSettings({ continuityEnabled: true, repository: "owner/repo" }).continuityEnabled, true);
});

test("accepts only ChatGPT conversation URLs", () => {
  assert.deepEqual(normalizeConversationUrl("https://chatgpt.com/c/abc-123?x=1"), {
    id: "abc-123",
    url: "https://chatgpt.com/c/abc-123"
  });
  assert.equal(normalizeConversationUrl("https://example.com/c/abc"), null);
  assert.equal(normalizeConversationUrl("https://chatgpt.com/"), null);
  assert.equal(isNewChatUrl("https://chatgpt.com/"), true);
  assert.equal(isNewChatUrl("https://chatgpt.com/c/abc"), false);
});

test("normalizes chat metadata with continuity state", () => {
  const chat = normalizeChat({ id: "abc", title: "  Project  ", url: "https://chat.openai.com/c/abc" });
  assert.equal(chat.id, "abc");
  assert.equal(chat.title, "Project");
  assert.equal(chat.chainId, "abc");
  assert.equal(chat.generation, 0);
  assert.equal(chat.retired, false);
  assert.equal(chat.lastCheckpoint, "");
  assert.equal(chat.startInNewChat, false);
  assert.equal(normalizeChat({ id: "fresh", url: "https://chatgpt.com/c/fresh", startInNewChat: true }).startInNewChat, true);
  assert.equal(chat.contentReady, false);
  assert.equal(chat.jobDispatched, false);
  assert.equal(chat.initialJobPending, false);
  assert.equal(INITIAL_BATCH_GRACE_MS, 5000);
});

test("legacy eligibility helper still skips completed chats", () => {
  const chats = [
    { sentCount: 2, failed: false, retired: false },
    { sentCount: 0, failed: true, retired: false },
    { sentCount: 1, failed: false, retired: false },
    { sentCount: 0, failed: false, retired: true }
  ];
  assert.equal(nextEligibleIndex(chats, 0, 2), 2);
  chats[2].sentCount = 2;
  assert.equal(nextEligibleIndex(chats, 2, 2), -1);
});

test("successor prompt anchors work to repository state", () => {
  const prompt = buildSuccessorPrompt(
    normalizeSettings({ continuityEnabled: true, repository: "owner/repo" }),
    { title: "Project" },
    "abc1234",
    "context threshold reached"
  );
  assert.match(prompt, /Repository: owner\/repo/);
  assert.match(prompt, /AUTOPROMPTER_HANDOFF\.md/);
  assert.match(prompt, /abc1234/);
  assert.match(prompt, /source of truth/);
});


test("chat-specific settings override global prompt and repository", () => {
  const chat = normalizeChat({
    id: "abc",
    url: "https://chatgpt.com/c/abc",
    title: "Configured",
    settings: { prompt: "Per chat", repository: "other/repo", continuityEnabled: true }
  }, { prompt: "Global", repository: "owner/repo", continuityEnabled: true });
  assert.equal(chat.settings.prompt, "Per chat");
  assert.equal(chat.settings.repository, "other/repo");
  assert.equal(chat.settings.continuityEnabled, true);
});

test("scheduler eligibility respects per-chat work limits", () => {
  const chats = [
    { failed: false, retired: false, sentCount: 1, settings: { maxContinuations: 1 } },
    { failed: false, retired: false, sentCount: 1, settings: { maxContinuations: 2 } }
  ];
  assert.equal(nextEligibleIndex(chats, -1, 5), 1);
});


test("concurrent scheduler selects every eligible chat at once", () => {
  const chats = [
    { sentCount: 0, failed: false, retired: false, settings: { maxContinuations: 2 } },
    { sentCount: 1, failed: false, retired: false, settings: { maxContinuations: 2 } },
    { sentCount: 2, failed: false, retired: false, settings: { maxContinuations: 2 } },
    { sentCount: 0, failed: true, retired: false, settings: { maxContinuations: 2 } }
  ];
  assert.deepEqual(eligibleChatIndexes(chats, 2), [0, 1]);
  assert.equal(isChatEligible({ settings: { maxContinuations: 2 } }, chats[0]), true);
  assert.equal(isChatEligible({ settings: { maxContinuations: 2 } }, chats[2]), false);
  assert.equal(MAX_CONCURRENT_CHATS, 12);
});


test("fresh-start prompt is explicit about missing legacy context", () => {
  const prompt = buildFreshStartPrompt(
    normalizeSettings({ prompt: "Continue the unfinished implementation", repository: "owner/repo", continuityEnabled: true }),
    { title: "Legacy project" },
    "The previous chat reached its context limit"
  );
  assert.match(prompt, /cannot access the previous chat transcript/i);
  assert.match(prompt, /Repository: owner\/repo/);
  assert.match(prompt, /Continue the unfinished implementation/);
  assert.match(prompt, /create the continuity file/i);
});

test("fresh-chat URLs include a unique navigation marker", () => {
  const { freshChatUrl, CONNECTION_RETRY_PROMPT, MAX_CONNECTION_RETRIES } = require("../background.js");
  const url = new URL(freshChatUrl("token", "chain", "job"));
  assert.equal(url.origin, "https://chatgpt.com");
  assert.equal(url.pathname, "/");
  assert.match(url.searchParams.get("autoprompter_fresh"), /token:chain:job/);
  assert.match(CONNECTION_RETRY_PROMPT, /response was interrupted/i);
  assert.equal(MAX_CONNECTION_RETRIES, 3);
});
