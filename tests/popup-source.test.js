"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const popupJs = fs.readFileSync(path.join(root, "popup.js"), "utf8");
const popupHtml = fs.readFileSync(path.join(root, "popup.html"), "utf8");
const contentJs = fs.readFileSync(path.join(root, "content.js"), "utf8");

test("running view uses a selected-chat progress dropdown", () => {
  assert.match(popupHtml, /id="progressPanel"/);
  assert.match(popupHtml, /id="progressList"/);
  assert.match(popupJs, /selectionControls\.hidden = running/);
  assert.match(popupJs, /progressPanel\.hidden = !running/);
  assert.match(popupJs, /schedulerState\?\.chats/);
});

test("fresh-start control persists per-chat state", () => {
  assert.match(popupJs, /fresh-start-button/);
  assert.match(popupJs, /startInNewChat/);
  assert.match(popupJs, /persistChatConfigs\(\)/);
});

test("chat discovery preserves sidebar order instead of alphabetizing", () => {
  assert.doesNotMatch(contentJs, /getChatCatalog[\s\S]{0,1200}localeCompare/);
  assert.doesNotMatch(popupJs, /catalog\s*=\s*\[\.\.\.byId\.values\(\)\]\.sort/);
  assert.match(popupJs, /observed\.map\(\(chat, index\)/);
});


test("Project Mode foundation exposes lifecycle and approval-gated planner controls", () => {
  assert.match(popupHtml, /id="projectModePanel"/);
  assert.match(popupHtml, /id="createProject"/);
  assert.match(popupHtml, /does not dispatch planner, worker, reviewer, or integrator chats/);
  assert.match(popupJs, /runtimeMessage\("CREATE_PROJECT"/);
  assert.match(popupJs, /runtimeMessage\("INSPECT_PROJECT"/);
  assert.match(popupJs, /transitionProject\("PAUSE_PROJECT"\)/);
  assert.match(popupJs, /transitionProject\("RESUME_PROJECT"\)/);
  assert.match(popupJs, /transitionProject\("CANCEL_PROJECT"\)/);
  assert.match(popupHtml, /id="buildPlannerPrompt"/);
  assert.match(popupHtml, /id="plannerResponseInput"/);
  assert.match(popupHtml, /id="approveProjectPlan"/);
  assert.match(popupJs, /runtimeMessage\("BUILD_PLANNER_PROMPT"/);
  assert.match(popupJs, /runtimeMessage\("SUBMIT_PLANNER_OUTPUT"/);
  assert.match(popupJs, /runtimeMessage\("APPROVE_PROJECT_PLAN"/);
  assert.match(popupJs, /No task records exist until approval/);
});
