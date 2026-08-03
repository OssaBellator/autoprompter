"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const Repair = require("../autocontinue-self-repair.js");

test("sanitized repair reports exclude prompts, transcripts, notes, and arbitrary diagnostics", () => {
  const report = Repair.sanitizeReport({
    source: "chat_worker",
    kind: "runtime_error",
    message: "Composer submission failed",
    stack: "Error: Composer submission failed\n at content.js:10",
    prompt: "private prompt",
    transcript: "private transcript",
    notes: "private notes",
    diagnostics: {
      status: "Waiting",
      sentCount: 2,
      connectionRetryCount: 4,
      generation: 1,
      rolloverCount: 0,
      contextPercent: 42.5,
      continuityEnabled: true,
      browser: "test-agent",
      arbitraryPrivateValue: "must not survive"
    }
  });

  assert.equal(report.message, "Composer submission failed");
  assert.equal(report.diagnostics.sentCount, 2);
  assert.equal(report.diagnostics.contextPercent, 42.5);
  assert.equal("prompt" in report, false);
  assert.equal("transcript" in report, false);
  assert.equal("notes" in report, false);
  assert.equal("arbitraryPrivateValue" in report.diagnostics, false);
});

test("failure fingerprints ignore volatile URLs, UUIDs, hashes, and large numbers", () => {
  const first = Repair.fingerprintReport({
    source: "content_error",
    kind: "runtime_error",
    message: "Failed at https://chatgpt.com/c/abc with 123456 and aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  });
  const second = Repair.fingerprintReport({
    source: "content_error",
    kind: "runtime_error",
    message: "Failed at https://chatgpt.com/c/xyz with 987654 and bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
  });
  assert.equal(first, second);
});

test("user stops and platform restrictions are excluded from automatic repair", () => {
  assert.equal(Repair.shouldCaptureReport({ message: "Stopped by user" }), false);
  assert.equal(Repair.shouldCaptureReport({ message: "Circuit breaker activated: rate limit" }), false);
  assert.equal(Repair.shouldCaptureReport({ message: "Account restriction detected" }), false);
  assert.equal(Repair.shouldCaptureReport({ message: "Safety restriction detected" }), false);
  assert.equal(Repair.shouldCaptureReport({ message: "The composer was replaced before submission" }), true);
});

test("repair prompt is repository-bounded and contains only sanitized diagnostics", () => {
  const prompt = Repair.buildRepairPrompt({
    source: "popup_error",
    kind: "runtime_error",
    message: "Could not start the scheduler",
    transcript: "never include this",
    diagnostics: { status: "Stopped", browser: "test" }
  }, { autoMerge: true }, { createdAt: "2026-08-03T12:00:00.000Z" });

  assert.match(prompt, /Repository: OssaBellator\/autoprompter/);
  assert.match(prompt, /Required repair branch: autofix\//);
  assert.match(prompt, /npm test/);
  assert.match(prompt, /npm run check/);
  assert.match(prompt, /AUTOPROMPTER_SELF_REPAIR_BEGIN/);
  assert.doesNotMatch(prompt, /never include this/);
  assert.doesNotMatch(prompt, /commit directly to main/i);
});

test("validates an open repair pull request envelope", () => {
  const fingerprint = "abc123";
  const output = [
    "AUTOPROMPTER_SELF_REPAIR_BEGIN",
    JSON.stringify({
      schemaVersion: "1.0",
      repository: "OssaBellator/autoprompter",
      fingerprint,
      status: "pr_open",
      branch: "autofix/abc123-20260803120000",
      pullRequestUrl: "https://github.com/OssaBellator/autoprompter/pull/50",
      mergeCommit: null,
      summary: "Added a regression and fixed the scheduler.",
      tests: ["npm test: passed", "npm run check: passed"],
      blocker: null
    }),
    "AUTOPROMPTER_SELF_REPAIR_END"
  ].join("\n");

  const result = Repair.parseRepairResult(output, fingerprint);
  assert.equal(result.status, "pr_open");
  assert.equal(result.pullRequestUrl, "https://github.com/OssaBellator/autoprompter/pull/50");
  assert.equal(result.mergeCommit, null);
});

test("merged repair envelopes require the exact repository, PR URL, and merge SHA", () => {
  const fingerprint = "merged123";
  const valid = [
    "AUTOPROMPTER_SELF_REPAIR_BEGIN",
    JSON.stringify({
      schemaVersion: "1.0",
      repository: "OssaBellator/autoprompter",
      fingerprint,
      status: "merged",
      branch: "autofix/merged123-20260803120000",
      pullRequestUrl: "https://github.com/OssaBellator/autoprompter/pull/51",
      mergeCommit: "0123456789abcdef0123456789abcdef01234567",
      summary: "Merged a bounded fix.",
      tests: ["npm test: passed"],
      blocker: null
    }),
    "AUTOPROMPTER_SELF_REPAIR_END"
  ].join("\n");
  assert.equal(Repair.parseRepairResult(valid, fingerprint).status, "merged");

  const wrongRepository = valid.replace("OssaBellator/autoprompter\",\"fingerprint", "someone/else\",\"fingerprint");
  assert.throws(() => Repair.parseRepairResult(wrongRepository, fingerprint), /repository/i);

  const missingSha = valid.replace("0123456789abcdef0123456789abcdef01234567", "");
  assert.throws(() => Repair.parseRepairResult(missingSha, fingerprint), /mergeCommit/);
});

test("self-repair settings are bounded and disabled by default", () => {
  assert.deepEqual(Repair.normalizeSettings({}), {
    enabled: false,
    autoMerge: true,
    cooldownMinutes: 60,
    maxRepairsPerDay: 3
  });
  assert.deepEqual(Repair.normalizeSettings({
    enabled: true,
    autoMerge: false,
    cooldownMinutes: 1,
    maxRepairsPerDay: 99
  }), {
    enabled: true,
    autoMerge: false,
    cooldownMinutes: 15,
    maxRepairsPerDay: 10
  });
});
