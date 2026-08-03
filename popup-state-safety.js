"use strict";

(function attachPopupStateSafety(root, factory) {
  const api = factory(root);
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.AutoPrompterPopupStateSafety = api;
})(typeof globalThis !== "undefined" ? globalThis : self, root => {
  const SCOPE = "AUTOPROMPTER_RUNTIME";
  const INSTALL_FLAG = Symbol.for("autoprompter.popupStateSafety.installed");

  function object(value) {
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  }

  function normalizeChat(value, fallbackSettings = {}) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const id = String(value.id || "").trim();
    if (!id) return null;
    return {
      ...value,
      id,
      title: String(value.title || "Untitled chat").trim() || "Untitled chat",
      sentCount: Number.isFinite(Number(value.sentCount)) ? Math.max(0, Number(value.sentCount)) : 0,
      failed: value.failed === true,
      retired: value.retired === true,
      status: String(value.status || "Queued"),
      currentJobId: value.currentJobId == null ? null : String(value.currentJobId),
      settings: { ...object(fallbackSettings), ...object(value.settings) }
    };
  }

  function normalizeSchedulerResponse(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return value;
    if (!("running" in value) && !("chats" in value) && !("settings" in value)) return value;
    const settings = object(value.settings);
    const chats = (Array.isArray(value.chats) ? value.chats : [])
      .map(chat => normalizeChat(chat, settings))
      .filter(Boolean);
    return {
      ...value,
      settings,
      chats,
      workerTabIds: Array.isArray(value.workerTabIds)
        ? value.workerTabIds.filter(Number.isInteger)
        : []
    };
  }

  function messageArgument(args) {
    return args.find(value => value && typeof value === "object" && !Array.isArray(value)) || null;
  }

  function install(runtime = root) {
    const api = runtime?.chrome?.runtime;
    if (!api?.sendMessage || api[INSTALL_FLAG]) return false;
    const originalSendMessage = api.sendMessage.bind(api);
    api.sendMessage = function safePopupSendMessage(...args) {
      const message = messageArgument(args);
      const result = originalSendMessage(...args);
      if (message?.scope !== SCOPE || !result || typeof result.then !== "function") return result;
      return result.then(normalizeSchedulerResponse);
    };
    Object.defineProperty(api, INSTALL_FLAG, { value: true });
    return true;
  }

  if (root.chrome?.runtime?.sendMessage) install();

  return {
    SCOPE,
    normalizeChat,
    normalizeSchedulerResponse,
    install
  };
});
