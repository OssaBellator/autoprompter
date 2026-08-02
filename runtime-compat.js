"use strict";

(() => {
  const MESSAGE_SCOPE = "AUTOPROMPTER_RUNTIME";
  const PROJECT_RUNTIME_PROBE = "GET_PROJECT_BOOTSTRAP";
  const PROJECT_RUNTIME_PROBE_ID = "__autoprompter_runtime_probe__";
  const RUNTIME_COMPATIBILITY_BUILD = "project-bootstrap-runtime-v3";
  const RELOAD_MARKER_KEY = "autoprompterRuntimeCompatibilityReload";
  const RELOAD_COOLDOWN_MS = 60_000;
  const RUNTIME_MISMATCH_MESSAGE = [
    "AutoPrompter's popup and background runtime are out of sync.",
    "The extension attempted one automatic reload.",
    "Update the unpacked extension from the latest repository files, open edge://extensions, press Reload, then refresh open ChatGPT tabs."
  ].join(" ");

  function messageArgument(args) {
    if (args?.[0] && typeof args[0] === "object") return args[0];
    if (args?.[1] && typeof args[1] === "object") return args[1];
    return null;
  }

  function isProjectRuntimeCommand(command) {
    const type = String(command || "");
    return type.includes("PROJECT") || type.includes("PLANNER");
  }

  function isUnknownRuntimeCommand(response, command) {
    const error = String(response?.error || "");
    return response?.ok === false && error.includes(`Unknown AutoPrompter runtime command: ${command}`);
  }

  function runtimeFingerprint(chromeApi) {
    const version = chromeApi?.runtime?.getManifest?.().version || "unknown";
    return `${version}:${RUNTIME_COMPATIBILITY_BUILD}`;
  }

  function shouldAttemptRuntimeReload(marker, fingerprint, now = Date.now()) {
    if (!marker || typeof marker !== "object") return true;
    if (String(marker.fingerprint || "") !== String(fingerprint || "unknown")) return true;
    const attemptedAt = Number(marker.at || 0);
    return !Number.isFinite(attemptedAt) || now - attemptedAt > RELOAD_COOLDOWN_MS;
  }

  function runtimeMismatchResponse() {
    return { ok: false, error: RUNTIME_MISMATCH_MESSAGE };
  }

  async function safeStorageGet(storage, key) {
    try { return await storage.get(key); } catch { return {}; }
  }

  async function safeStorageSet(storage, value) {
    try { await storage.set(value); } catch { /* best effort */ }
  }

  async function safeStorageRemove(storage, key) {
    try { await storage.remove(key); } catch { /* best effort */ }
  }

  async function attemptRuntimeReload(chromeApi, options = {}) {
    const storage = chromeApi?.storage?.local;
    const fingerprint = runtimeFingerprint(chromeApi);
    const version = chromeApi?.runtime?.getManifest?.().version || "unknown";
    const now = typeof options.now === "function" ? options.now() : Date.now();
    const stored = storage ? await safeStorageGet(storage, RELOAD_MARKER_KEY) : {};
    const marker = stored?.[RELOAD_MARKER_KEY];

    if (shouldAttemptRuntimeReload(marker, fingerprint, now) && typeof chromeApi?.runtime?.reload === "function") {
      if (storage) {
        await safeStorageSet(storage, {
          [RELOAD_MARKER_KEY]: {
            fingerprint,
            version,
            build: RUNTIME_COMPATIBILITY_BUILD,
            at: now
          }
        });
      }
      chromeApi.runtime.reload();
      if (options.suspendAfterReload !== false) await new Promise(() => {});
      return { status: "reloading", fingerprint };
    }

    return { status: "mismatch", fingerprint };
  }

  async function probeProjectRuntime(chromeApi, sendMessage, options = {}) {
    let response;
    try {
      response = await sendMessage({
        scope: MESSAGE_SCOPE,
        type: PROJECT_RUNTIME_PROBE,
        projectId: PROJECT_RUNTIME_PROBE_ID
      });
    } catch {
      return { status: "unavailable" };
    }

    const storage = chromeApi?.storage?.local;
    if (!isUnknownRuntimeCommand(response, PROJECT_RUNTIME_PROBE)) {
      if (storage) await safeStorageRemove(storage, RELOAD_MARKER_KEY);
      return { status: "compatible", fingerprint: runtimeFingerprint(chromeApi) };
    }

    return attemptRuntimeReload(chromeApi, options);
  }

  function installRuntimeCompatibilityGate(chromeApi, options = {}) {
    const runtime = chromeApi?.runtime;
    if (!runtime?.sendMessage) return Promise.resolve({ status: "unavailable" });

    const originalSendMessage = runtime.sendMessage.bind(runtime);
    let runtimeMismatch = false;
    const gate = probeProjectRuntime(chromeApi, originalSendMessage, options)
      .then(result => {
        runtimeMismatch = result?.status === "mismatch";
        return result;
      });

    runtime.sendMessage = (...args) => gate.then(async () => {
      const message = messageArgument(args);
      const isProjectCommand = message?.scope === MESSAGE_SCOPE && isProjectRuntimeCommand(message.type);

      if (runtimeMismatch && isProjectCommand) {
        await attemptRuntimeReload(chromeApi, options);
        return runtimeMismatchResponse();
      }

      const response = await originalSendMessage(...args);
      if (isProjectCommand && isUnknownRuntimeCommand(response, message.type)) {
        runtimeMismatch = true;
        await attemptRuntimeReload(chromeApi, options);
        return runtimeMismatchResponse();
      }
      return response;
    });

    return gate;
  }

  function loadProjectUi(chromeApi, documentApi = globalThis.document) {
    if (!documentApi?.createElement || documentApi.getElementById("autoprompterProjectUiLoader")) return false;
    const script = documentApi.createElement("script");
    script.id = "autoprompterProjectUiLoader";
    script.src = chromeApi.runtime.getURL("project-ui.js");
    script.defer = true;
    (documentApi.head || documentApi.documentElement).append(script);
    return true;
  }

  const exported = {
    MESSAGE_SCOPE,
    PROJECT_RUNTIME_PROBE,
    RELOAD_MARKER_KEY,
    RELOAD_COOLDOWN_MS,
    RUNTIME_COMPATIBILITY_BUILD,
    RUNTIME_MISMATCH_MESSAGE,
    isProjectRuntimeCommand,
    isUnknownRuntimeCommand,
    runtimeFingerprint,
    shouldAttemptRuntimeReload,
    runtimeMismatchResponse,
    attemptRuntimeReload,
    probeProjectRuntime,
    installRuntimeCompatibilityGate,
    loadProjectUi
  };

  if (typeof module === "object" && module.exports) {
    module.exports = exported;
  } else if (globalThis.chrome?.runtime?.sendMessage) {
    installRuntimeCompatibilityGate(globalThis.chrome);
    loadProjectUi(globalThis.chrome);
  }
})();
