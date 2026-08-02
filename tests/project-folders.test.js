"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Folders = require("../project-folders.js");

test("legacy execution projects migrate to chat folders without task state", () => {
  const legacy = {
    projects: {
      alpha: {
        projectId: "alpha",
        title: "Alpha",
        goal: "Ship the alpha release.",
        repository: { slug: "OssaBellator/autoprompter" },
        roles: {
          plannerChatId: "planner",
          reviewerChatId: "reviewer",
          integratorChatId: null,
          workerChatIds: ["worker-a", "worker-b", "worker-a"]
        },
        createdAt: "2026-08-01T00:00:00.000Z",
        updatedAt: "2026-08-02T00:00:00.000Z"
      }
    }
  };

  const store = Folders.migrateLegacyStore(null, legacy);
  assert.deepEqual(store.projects.alpha.chatIds, ["planner", "reviewer", "worker-a", "worker-b"]);
  assert.equal(store.projects.alpha.repository, "OssaBellator/autoprompter");
  assert.match(store.projects.alpha.notes, /Ship the alpha release/);
  assert.deepEqual(Object.keys(store.projects.alpha).sort(), [
    "chatIds",
    "createdAt",
    "id",
    "name",
    "notes",
    "repository",
    "updatedAt"
  ]);
});

test("project and per-chat notes are appended to the selected chat prompt", () => {
  const store = Folders.upsertProject(null, {
    name: "Release",
    repository: "OssaBellator/autoprompter",
    notes: "Keep backwards compatibility.",
    chatIds: ["chat-1"]
  }, () => "2026-08-02T00:00:00.000Z").store;
  const projectId = Object.keys(store.projects)[0];
  const message = Folders.enrichSchedulerMessage({
    type: "START_SCHEDULER",
    chats: [
      { id: "chat-1", settings: { prompt: "Continue.", repository: "" } },
      { id: "chat-2", settings: { prompt: "Continue.", repository: "" } }
    ]
  }, {
    projectStore: store,
    activeProjectId: projectId,
    chatNotes: { "chat-1": "The API contract is frozen.", "chat-2": "Independent note." }
  });

  assert.equal(message.chats[0].settings.repository, "OssaBellator/autoprompter");
  assert.match(message.chats[0].settings.prompt, /Project folder: Release/);
  assert.match(message.chats[0].settings.prompt, /Keep backwards compatibility/);
  assert.match(message.chats[0].settings.prompt, /The API contract is frozen/);
  assert.doesNotMatch(message.chats[1].settings.prompt, /Project folder: Release/);
  assert.match(message.chats[1].settings.prompt, /Independent note/);
});

test("context remains inside the scheduler prompt limit even with a long base prompt", () => {
  const prompt = Folders.appendContext(
    "x".repeat(12000),
    { name: "Long project", repository: "owner/repo", notes: "project-note ".repeat(600) },
    "chat-note ".repeat(600)
  );
  assert.ok(prompt.length <= Folders.MAX_PROMPT);
  assert.match(prompt, /AutoPrompter context for this chat/);
  assert.match(prompt, /Project folder: Long project/);
  assert.match(prompt, /Chat notes:/);
});

test("folder CRUD normalizes repositories and preserves chat order", () => {
  const created = Folders.upsertProject(null, {
    name: "Docs",
    repository: "https://github.com/openai/openai.git",
    notes: "Documentation work",
    chatIds: ["a", "b", "a"]
  }, () => "2026-08-02T00:00:00.000Z");
  assert.equal(created.project.repository, "openai/openai");
  assert.deepEqual(created.project.chatIds, ["a", "b"]);
  const deleted = Folders.deleteProject(created.store, created.project.id);
  assert.equal(Object.keys(deleted.projects).length, 0);
});
