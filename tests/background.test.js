"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

global.chrome = {
  runtime: {
    onMessage: { addListener() {} },
    getManifest: () => ({ version: "2.1.0" }),
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
  buildSuccessorPrompt
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
  assert.equal(settings.delaySeconds, 2);
  assert.equal(settings.maxContinuations, 50);
  assert.equal(settings.contextThresholdPercent, 98);
  assert.equal(settings.stallMinutes, 5);
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
});

test("scheduler rotates among eligible selected chats", () => {
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
