"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const Dispatch = require("../project-github-dispatch.js");

test("first issue attempts use fresh chats and revisions reuse the bound conversation", () => {
  const first = {
    projectId: "project",
    taskId: "task-issue-1",
    dispatchId: "dispatch-1",
    freshRequestId: "fresh-1",
    conversationId: null
  };
  const firstUrl = new URL(Dispatch.targetUrl(first));
  assert.equal(firstUrl.hostname, "chatgpt.com");
  assert.match(firstUrl.searchParams.get("autoprompter_fresh"), /fresh-1/);

  const revision = {
    ...first,
    dispatchId: "dispatch-2",
    freshRequestId: null,
    conversationId: "worker-conversation-123"
  };
  assert.equal(
    Dispatch.targetUrl(revision),
    "https://chatgpt.com/c/worker-conversation-123"
  );
});
