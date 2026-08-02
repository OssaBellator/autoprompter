"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const Compat = require("../runtime-compat.js");

const popupHtml = fs.readFileSync(path.join(__dirname, "..", "popup.html"), "utf8");

function fakeChrome(initialMarker = null) {
  const values = initialMarker ? { [Compat.RELOAD_MARKER_KEY]: initialMarker } : {};
  let reloadCount = 0;
  return {
    api: {
      runtime: {
        getManifest: () => ({ version: "3.0.0" }),
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

test("unknown project bootstrap runtime triggers one automatic reload", async () => {
  const chrome = fakeChrome();
  const result = await Compat.probeProjectRuntime(
    chrome.api,
    async () => ({ ok: false, error: "Unknown AutoPrompter runtime command: GET_PROJECT_BOOTSTRAP" }),
    { now: () => 1000, suspendAfterReload: false }
  );
  assert.equal(result.status, "reloading");
  assert.equal(chrome.reloadCount(), 1);
  assert.deepEqual(chrome.values[Compat.RELOAD_MARKER_KEY], { version: "3.0.0", at: 1000 });
});

test("recent reload marker prevents a reload loop", async () => {
  const chrome = fakeChrome({ version: "3.0.0", at: 1000 });
  const result = await Compat.probeProjectRuntime(
    chrome.api,
    async () => ({ ok: false, error: "Unknown AutoPrompter runtime command: GET_PROJECT_BOOTSTRAP" }),
    { now: () => 2000, suspendAfterReload: false }
  );
  assert.equal(result.status, "mismatch");
  assert.equal(chrome.reloadCount(), 0);
  assert.match(Compat.runtimeMismatchResponse().error, /edge:\/\/extensions/);
});

test("compatible runtime clears the stale reload marker", async () => {
  const chrome = fakeChrome({ version: "3.0.0", at: 1000 });
  const result = await Compat.probeProjectRuntime(
    chrome.api,
    async () => ({ ok: true, bootstrap: null }),
    { now: () => 2000, suspendAfterReload: false }
  );
  assert.equal(result.status, "compatible");
  assert.equal(Compat.RELOAD_MARKER_KEY in chrome.values, false);
});
