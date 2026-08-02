"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Compat = require("../runtime-compat.js");

const popupHtml = fs.readFileSync(path.join(__dirname, "..", "popup.html"), "utf8");

function fakeChrome(initialMarker = null, version = "3.0.0") {
  const values = initialMarker ? { [Compat.RELOAD_MARKER_KEY]: initialMarker } : {};
  let reloadCount = 0;
  return {
    api: {
      runtime: {
        getManifest: () => ({ version }),
        reload: () => { reloadCount += 1; }
      },
      storage: {
        local: {
          get: async key => ({ [key]: values[key] }),
          set: async update => Object.assign(values, update),
          remove: async key => { delete values[key]; }
        }
      }
    },
    values,
    reloadCount: () => reloadCount
  };
}

test("popup loads the runtime compatibility gate before popup logic", () => {
  const compatibilityIndex = popupHtml.indexOf('<script src="runtime-compat.js"></script>');
  const popupIndex = popupHtml.indexOf('<script src="popup.js"></script>');
  assert.ok(compatibilityIndex >= 0);
  assert.ok(popupIndex > compatibilityIndex);
});

test("unknown project bootstrap probe triggers one automatic reload", async () => {
  const chrome = fakeChrome();
  const result = await Compat.probeProjectRuntime(
    chrome.api,
    async () => ({ ok: false, error: "Unknown AutoPrompter runtime command: GET_PROJECT_BOOTSTRAP" }),
    { now: () => 1000, suspendAfterReload: false }
  );
  const fingerprint = Compat.runtimeFingerprint(chrome.api);
  assert.equal(result.status, "reloading");
  assert.equal(chrome.reloadCount(), 1);
  assert.deepEqual(chrome.values[Compat.RELOAD_MARKER_KEY], {
    fingerprint,
    version: "3.0.0",
    build: Compat.RUNTIME_COMPATIBILITY_BUILD,
    at: 1000
  });
});

test("recent build fingerprint prevents a reload loop", async () => {
  const chrome = fakeChrome();
  const fingerprint = Compat.runtimeFingerprint(chrome.api);
  chrome.values[Compat.RELOAD_MARKER_KEY] = { fingerprint, at: 1000 };
  const result = await Compat.probeProjectRuntime(
    chrome.api,
    async () => ({ ok: false, error: "Unknown AutoPrompter runtime command: GET_PROJECT_BOOTSTRAP" }),
    { now: () => 2000, suspendAfterReload: false }
  );
  assert.equal(result.status, "mismatch");
  assert.equal(chrome.reloadCount(), 0);
  assert.match(Compat.runtimeMismatchResponse().error, /latest repository files/i);
});

test("legacy same-version marker does not suppress a new compatibility build", async () => {
  const chrome = fakeChrome({ version: "3.0.0", at: 1000 });
  const result = await Compat.probeProjectRuntime(
    chrome.api,
    async () => ({ ok: false, error: "Unknown AutoPrompter runtime command: GET_PROJECT_BOOTSTRAP" }),
    { now: () => 2000, suspendAfterReload: false }
  );
  assert.equal(result.status, "reloading");
  assert.equal(chrome.reloadCount(), 1);
});

test("compatible runtime clears the stale reload marker", async () => {
  const chrome = fakeChrome({ fingerprint: "old-build", at: 1000 });
  const result = await Compat.probeProjectRuntime(
    chrome.api,
    async () => ({ ok: true, bootstrap: null }),
    { now: () => 2000, suspendAfterReload: false }
  );
  assert.equal(result.status, "compatible");
  assert.equal(Compat.RELOAD_MARKER_KEY in chrome.values, false);
});

test("unknown START_PROJECT_BOOTSTRAP response triggers direct recovery", async () => {
  const chrome = fakeChrome();
  chrome.api.runtime.sendMessage = async message => {
    if (message.type === Compat.PROJECT_RUNTIME_PROBE) return { ok: true, bootstrap: null };
    return { ok: false, error: `Unknown AutoPrompter runtime command: ${message.type}` };
  };

  await Compat.installRuntimeCompatibilityGate(chrome.api, {
    now: () => 3000,
    suspendAfterReload: false
  });
  const response = await chrome.api.runtime.sendMessage({
    scope: Compat.MESSAGE_SCOPE,
    type: "START_PROJECT_BOOTSTRAP",
    projectId: "autoprompter"
  });

  assert.equal(chrome.reloadCount(), 1);
  assert.equal(response.ok, false);
  assert.match(response.error, /out of sync/i);
});

test("unknown non-project commands are not converted into compatibility failures", async () => {
  const chrome = fakeChrome();
  chrome.api.runtime.sendMessage = async message => {
    if (message.type === Compat.PROJECT_RUNTIME_PROBE) return { ok: true, bootstrap: null };
    return { ok: false, error: `Unknown AutoPrompter runtime command: ${message.type}` };
  };

  await Compat.installRuntimeCompatibilityGate(chrome.api, {
    now: () => 4000,
    suspendAfterReload: false
  });
  const response = await chrome.api.runtime.sendMessage({
    scope: Compat.MESSAGE_SCOPE,
    type: "START_SCHEDULER"
  });

  assert.equal(chrome.reloadCount(), 0);
  assert.match(response.error, /START_SCHEDULER/);
});
