"use strict";

(function attachAutoContinueRuntimeBoundary(root, factory) {
  const api = factory(root);
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.AutoPrompterRuntimeBoundary = api;
})(typeof globalThis !== "undefined" ? globalThis : self, root => {
  const SCOPE = "AUTOPROMPTER_RUNTIME";
  const installedRuntimes = new WeakSet();
  const terminalHandlers = Object.freeze({
    JOB_STATUS: "updateJobStatus",
    JOB_DONE: "finishJob",
    JOB_ERROR: "failJob",
    JOB_INTERRUPTED: "interruptJob",
    JOB_ROLLOVER: "interruptJob",
    SUCCESSOR_CREATED: "successorCreated"
  });

  function text(value) {
    return String(value == null ? "" : value).trim();
  }

  function runtimeHandler(runtime, message) {
    const name = terminalHandlers[message?.type];
    return name && typeof runtime?.[name] === "function" ? runtime[name] : null;
  }

  function install(runtime = root) {
    if (!runtime || (typeof runtime !== "object" && typeof runtime !== "function")) return false;
    if (installedRuntimes.has(runtime)) return true;
    const event = runtime.chrome?.runtime?.onMessage;
    if (!event || typeof event.addListener !== "function") return false;

    const originalAddListener = event.addListener.bind(event);
    const originalRemoveListener = typeof event.removeListener === "function"
      ? event.removeListener.bind(event)
      : null;
    const listenerMap = new WeakMap();

    event.addListener = function addRuntimeBoundaryListener(listener) {
      if (typeof listener !== "function") return originalAddListener(listener);
      const wrapped = function runtimeBoundaryListener(message, sender, sendResponse) {
        if (message?.scope !== SCOPE || !terminalHandlers[message?.type]) {
          return listener(message, sender, sendResponse);
        }
        const operation = async () => {
          const handler = runtimeHandler(runtime, message);
          if (!handler) throw new Error(`AutoPrompter terminal handler is unavailable: ${text(message.type) || "missing"}`);
          return handler(message, sender);
        };
        const queued = typeof runtime.enqueue === "function"
          ? runtime.enqueue(operation)
          : Promise.resolve().then(operation);
        Promise.resolve(queued)
          .then(result => sendResponse({ ok: true, ...(result && typeof result === "object" ? result : {}) }))
          .catch(error => sendResponse({ ok: false, error: text(error?.message || error) || "AutoPrompter terminal handler failed." }));
        return true;
      };
      listenerMap.set(listener, wrapped);
      return originalAddListener(wrapped);
    };

    if (originalRemoveListener) {
      event.removeListener = function removeRuntimeBoundaryListener(listener) {
        return originalRemoveListener(listenerMap.get(listener) || listener);
      };
    }

    runtime.__autoPrompterRestoreRuntimeListenerRegistration = () => {
      event.addListener = originalAddListener;
      if (originalRemoveListener) event.removeListener = originalRemoveListener;
      delete runtime.__autoPrompterRestoreRuntimeListenerRegistration;
    };
    installedRuntimes.add(runtime);
    return true;
  }

  function finalize(runtime = root) {
    const restore = runtime?.__autoPrompterRestoreRuntimeListenerRegistration;
    if (typeof restore === "function") restore();
    return true;
  }

  if (typeof importScripts === "function") install();

  return {
    SCOPE,
    terminalHandlers,
    runtimeHandler,
    install,
    finalize
  };
});
