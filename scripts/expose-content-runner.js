"use strict";

const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const contentPath = path.join(root, "content.js");
const testPath = path.join(root, "tests", "project-orchestrator.test.js");

let content = fs.readFileSync(contentPath, "utf8");
const anchor = '  if (typeof module !== "undefined") {';
const bridge = [
  "  globalThis.AutoPrompterContentRunner = Object.freeze({",
  "    conversationInfo,",
  "    waitForCompletedAssistant,",
  "    submitPrompt",
  "  });",
  "",
  anchor
].join("\n");

if (content.includes("globalThis.AutoPrompterContentRunner = Object.freeze")) {
  throw new Error("Content runner bridge already exists.");
}
if (content.split(anchor).length - 1 !== 1) {
  throw new Error("Expected exactly one content runner insertion anchor.");
}
content = content.replace(anchor, bridge);
fs.writeFileSync(contentPath, content);

let testSource = fs.readFileSync(testPath, "utf8");
const testAnchor = '  const roleRunner = fs.readFileSync(path.join(root, "project-role-runner.js"), "utf8");';
const replacement = [
  testAnchor,
  '  const contentSource = fs.readFileSync(path.join(root, "content.js"), "utf8");'
].join("\n");
if (testSource.split(testAnchor).length - 1 !== 1) {
  throw new Error("Expected exactly one role runner source-test anchor.");
}
testSource = testSource.replace(testAnchor, replacement);
const assertionAnchor = '  assert.match(roleRunner, /RUN_PROJECT_ROLE_JOB/);';
const assertionReplacement = [
  assertionAnchor,
  '  assert.match(contentSource, /globalThis\\.AutoPrompterContentRunner = Object\\.freeze/);'
].join("\n");
if (testSource.split(assertionAnchor).length - 1 !== 1) {
  throw new Error("Expected exactly one role runner assertion anchor.");
}
testSource = testSource.replace(assertionAnchor, assertionReplacement);
fs.writeFileSync(testPath, testSource);

console.log("Exposed the guarded content runner for reviewer and integrator jobs.");
