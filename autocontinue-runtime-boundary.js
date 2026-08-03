"use strict";

(function attachAutoContinueRuntimeBoundary(root, factory) {
  const api = factory(root);
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.AutoPrompterRuntimeBoundary = api;
})(typeof globalThis !== "undefined" ? globalThis : self, root => {
  const SCOPE = "AUTOPROMPTER_RUNTIME";
  const installedRuntimes = new WeakSet();
  const directHandlers = Object.freeze({
    JOB_STATUS: "updateJobStatus",
    JOB_DONE: "finishJob",
    JOB_ERROR: "failJob",
    JOB_INTERRUPTED: "interruptJob",
    JOB_ROLLOVER: "interruptJob",
    SUCCESSOR_CREATED: "successorCreated"
  });
  const boundaryCommands = new Set([
    "GET_SCHEDULER_STATE",
    "START_SCHEDULER",
    "STOP_SCHEDULER",
    "CONTENT_READY",
    ...Object.keys(directHandlers)
  ]);

  function text(value) {
    return String(value == null ? "" : value).trim();
  }

  function requiredFunction(runtime, name) {
    const value = runtime?.[name];
    if (typeof value !== "function") throw new Error(`AutoPrompter runtime function is unavailable: ${name}`);
    return value;
  }

  function runtimeHandler(runtime, message) {
    const name = directHandlers[message?.type];
    return name && typeof runtime?.[name] === "function" ? runtime[name] : null;
  }

  async function dispatch(runtime, message, sender) {
    switch (message?.type) {
      case "GET_SCHEDULER_STATE": {
        const state = await requiredFunction(runtime, "loadState")();
        return requiredFunction(runtime, "publicState")(state);
      }
      case "START_SCHEDULER":
        return requiredFunction(runtime, "startScheduler")(message.chats, message.settings, message.mode);
      case "STOP_SCHEDULER":
        return requiredFunction(runtime, "stopScheduler")("Stopped by user", "", true);
      case "CONTENT_READY": {
        const state = await requiredFunction(runtime, "loadState")();
        const index = requiredFunction(runtime, "findChatIndexByTab")(state, sender?.tab?.id);
        return state?.running && index >= 0
          ? requiredFunction(runtime, "markContentReady")(state, index)
          : requiredFunction(runtime, "publicState")(state);
      }
      default: {
        const handler = runtimeHandler(runtime, message);
        if (!handler) throw new Error(`AutoPrompter runtime handler is unavailable: ${text(message?.type) || "missing"}`);
        return handler(message, sender);
      }
    }
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

    const wrappedAddListener = function addRuntimeBoundaryListener(listener) {
      if (typeof listener !== "function") return originalAddListener(listener);
      const wrapped = function runtimeBoundaryListener(message, sender, sendResponse) {
        if (message?.scope !== SCOPE || !boundaryCommands.has(message?.type)) {
          return listener(message, sender, sendResponse);
        }
        const operation = () => dispatch(runtime, message, sender);
        const queued = typeof runtime.enqueue === "function"
          ? runtime.enqueue(operation)
          : Promise.resolve().then(operation);
        Promise.resolve(queued)
          .then(result => sendResponse({ ok: true, ...(result && typeof result === "object" ? result : {}) }))
          .catch(error => sendResponse({ ok: false, error: text(error?.message || error) || "AutoPrompter runtime command failed." }));
        return true;
      };
      listenerMap.set(listener, wrapped);
      return originalAddListener(wrapped);
    };

    const wrappedRemoveListener = originalRemoveListener
      ? function removeRuntimeBoundaryListener(listener) {
        return originalRemoveListener(listenerMap.get(listener) || listener);
      }
      : null;

    try {
      event.addListener = wrappedAddListener;
      if (wrappedRemoveListener) event.removeListener = wrappedRemoveListener;
    } catch {
      return false;
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
    directHandlers,
    boundaryCommands,
    runtimeHandler,
    dispatch,
    install,
    finalize
  };
});
