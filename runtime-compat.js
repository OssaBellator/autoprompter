"use strict";

(() => {
  const MESSAGE_SCOPE = "AUTOPROMPTER_RUNTIME";
  const PROJECT_RUNTIME_PROBE = "GET_PROJECT_BOOTSTRAP";
  const PROJECT_RUNTIME_PROBE_ID = "__autoprompter_runtime_probe__";
  const RELOAD_MARKER_KEY = "autoprompterRuntimeCompatibilityReload";
  const RELOAD_COOLDOWN_MS = 60_000;
  const GUARDED_PROJECT_COMMANDS = new Set([
    "CREATE_PROJECT",
    "START_PROJECT_BOOTSTRAP"
  ]);
  const RUNTIME_MISMATCH_MESSAGE = [
    "AutoPrompter's popup and background runtime are out of sync.",
    "The extension attempted one automatic reload.",
    "Open edge://extensions, reload AutoPrompter, then reopen this popup."
  ].join(" ");

  function messageArgument(args) {
    if (args?.[0] && typeof args[0] === "object") return args[0];
    if (args?.[1] && typeof args[1] === "object") return args[1];
    return null;
  }

  function isUnknownRuntimeCommand(response, command) {
    const error = String(response?.error || "");
    return response?.ok === false && error.includes(`Unknown AutoPrompter runtime command: ${command}`);
  }

  function shouldAttemptRuntimeReload(marker, manifestVersion, now = Date.now()) {
    if (!marker || typeof marker !== "object") return true;
    if (String(marker.version || "") !== String(manifestVersion || "unknown")) return true;
    return now - Number(marker.at || 0) > RELOAD_COOLDOWN_MS;
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
      return { status: "compatible" };
    }

    const manifestVersion = chromeApi?.runtime?.getManifest?.().version || "unknown";
    const now = typeof options.now === "function" ? options.now() : Date.now();
    const stored = storage ? await safeStorageGet(storage, RELOAD_MARKER_KEY) : {};
    const marker = stored?.[RELOAD_MARKER_KEY];

    if (shouldAttemptRuntimeReload(marker, manifestVersion, now) && typeof chromeApi?.runtime?.reload === "function") {
      if (storage) {
        await safeStorageSet(storage, {
          [RELOAD_MARKER_KEY]: { version: manifestVersion, at: now }
        });
      }
      chromeApi.runtime.reload();
      if (options.suspendAfterReload !== false) await new Promise(() => {});
      return { status: "reloading" };
    }

    return { status: "mismatch" };
  }

  function installRuntimeCompatibilityGate(chromeApi) {
    const runtime = chromeApi?.runtime;
    if (!runtime?.sendMessage) return Promise.resolve({ status: "unavailable" });

    const originalSendMessage = runtime.sendMessage.bind(runtime);
    let runtimeMismatch = false;
    const gate = probeProjectRuntime(chromeApi, originalSendMessage)
      .then(result => {
        runtimeMismatch = result?.status === "mismatch";
        return result;
      });

    runtime.sendMessage = (...args) => gate.then(async () => {
      const message = messageArgument(args);
      const isGuardedProjectCommand = message?.scope === MESSAGE_SCOPE && GUARDED_PROJECT_COMMANDS.has(message.type);
      if (runtimeMismatch && isGuardedProjectCommand) return runtimeMismatchResponse();

      const response = await originalSendMessage(...args);
      if (isGuardedProjectCommand && isUnknownRuntimeCommand(response, message.type)) {
        runtimeMismatch = true;
        return runtimeMismatchResponse();
      }
      return response;
    });

    return gate;
  }

  const exported = {
    MESSAGE_SCOPE,
    PROJECT_RUNTIME_PROBE,
    RELOAD_MARKER_KEY,
    RELOAD_COOLDOWN_MS,
    RUNTIME_MISMATCH_MESSAGE,
    isUnknownRuntimeCommand,
    shouldAttemptRuntimeReload,
    runtimeMismatchResponse,
    probeProjectRuntime,
    installRuntimeCompatibilityGate
  };

  if (typeof module === "object" && module.exports) {
    module.exports = exported;
  } else if (globalThis.chrome?.runtime?.sendMessage) {
    installRuntimeCompatibilityGate(globalThis.chrome);
  }
})();
