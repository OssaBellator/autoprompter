"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const contentJs = fs.readFileSync(path.join(root, "content.js"), "utf8");
const popupHtml = fs.readFileSync(path.join(root, "popup.html"), "utf8");
const popupCss = fs.readFileSync(path.join(root, "popup.css"), "utf8");
const popupJs = fs.readFileSync(path.join(root, "popup.js"), "utf8");

test("composer submission tolerates safe ChatGPT editor rerenders", () => {
  assert.match(contentJs, /function normalizeComposerText/);
  assert.match(contentJs, /[\\u200B-\\u200D\\u2060\\uFEFF]/);
  assert.match(contentJs, /async function populateOwnedComposer/);
  assert.match(contentJs, /function validateOwnedComposer/);
  assert.match(contentJs, /Composer refreshed; restoring prompt/);
  assert.match(contentJs, /clearOwnedComposer\(target, owner, prompt\)/);
});

test("composer recovery stays fail-closed for different user text", () => {
  assert.match(contentJs, /composer contains different text; the AutoPrompter prompt was not sent/);
  assert.match(contentJs, /if \(prompt && !promptMatchesComposer\(live, prompt\)\)/);
  assert.match(contentJs, /The prompt was edited before submission; it was not sent/);
});

test("Project Mode separates existing and new project views", () => {
  assert.match(popupHtml, /id="projectExistingTab"/);
  assert.match(popupHtml, /id="projectNewTab"/);
  assert.match(popupHtml, /id="projectExistingPanel"/);
  assert.match(popupHtml, /id="projectNewPanel"[^>]*hidden/);
  assert.match(popupCss, /\.project-tabs/);
  assert.match(popupJs, /function setProjectTab/);
  assert.match(popupJs, /function handleProjectTabKeydown/);
  assert.match(popupJs, /ArrowLeft/);
  assert.match(popupJs, /ArrowRight/);
  assert.match(popupJs, /setProjectTab\("existing"\)/);
  assert.match(popupJs, /setProjectTab\("new"\)/);
});
