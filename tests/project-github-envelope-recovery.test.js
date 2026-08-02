"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const Recovery = require("../project-github-envelope-recovery.js");

function envelope(number) {
  return [
    Recovery.ISSUES_BEGIN,
    JSON.stringify({ number }),
    Recovery.ISSUES_END
  ].join("\n");
}

test("selects the newest complete GitHub issue manifest", () => {
  const first = envelope(1);
  const second = envelope(2);
  assert.equal(
    Recovery.extractLatestEnvelope(`setup prose\n${first}\nintermediate text\n${second}\ntrailing prose`),
    second
  );
});

test("does not recover an incomplete GitHub issue manifest", () => {
  assert.equal(Recovery.extractLatestEnvelope(`${Recovery.ISSUES_BEGIN}\n{"number":1}`), "");
  assert.equal(Recovery.extractLatestEnvelope(`${Recovery.ISSUES_END}\n${Recovery.ISSUES_BEGIN}`), "");
});

test("GitHub planner submission normalizes repeated manifests before strict validation", () => {
  let received = "";
  const store = {
    submitProjectPlannerOutput(_store, _projectId, output) {
      received = output;
      return { output };
    }
  };
  Recovery.install(store);
  const second = envelope(2);
  const state = {
    activeProjectId: "alpha",
    projects: {
      alpha: {
        projectId: "alpha",
        githubWorkflowMode: Recovery.MODE
      }
    }
  };

  const result = store.submitProjectPlannerOutput(state, "alpha", `${envelope(1)}\n${second}`);
  assert.equal(received, second);
  assert.equal(result.output, second);
});
