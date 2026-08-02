"use strict";

(() => {
  if (typeof chrome === "undefined" || !chrome.runtime?.onMessage || !chrome.runtime?.sendMessage) return;

  const originalAddListener = chrome.runtime.onMessage.addListener.bind(chrome.runtime.onMessage);
  const originalSendMessage = chrome.runtime.sendMessage.bind(chrome.runtime);
  const downstreamListeners = [];
  const activeJobs = new Map();

  chrome.runtime.onMessage.addListener = listener => {
    downstreamListeners.push(listener);
    return originalAddListener(listener);
  };

  function translatedMessage(payload) {
    const job = activeJobs.get(payload?.jobId);
    if (!job) return null;
    if (payload.type === "PROJECT_BOOTSTRAP_STATUS") {
      return {
        type: "PROJECT_ROLE_STATUS",
        projectId: job.projectId,
        jobId: job.jobId,
        role: job.role,
        kind: job.kind,
        status: payload.status
      };
    }
    if (payload.type === "PROJECT_BOOTSTRAP_RESULT") {
      return {
        type: "PROJECT_ROLE_RESULT",
        projectId: job.projectId,
        jobId: job.jobId,
        role: job.role,
        kind: job.kind,
        dispatchId: job.dispatchId || null,
        integrationId: job.integrationId || null,
        conversation: payload.conversation,
        output: payload.output,
        assistantSignature: payload.assistantSignature
      };
    }
    if (payload.type === "PROJECT_BOOTSTRAP_ERROR") {
      return {
        type: "PROJECT_ROLE_ERROR",
        projectId: job.projectId,
        jobId: job.jobId,
        role: job.role,
        kind: job.kind,
        dispatchId: job.dispatchId || null,
        integrationId: job.integrationId || null,
        errorKind: payload.kind || "runtime_error",
        error: payload.error || "Project role job failed."
      };
    }
    return null;
  }

  chrome.runtime.sendMessage = (payload, ...args) => {
    const translated = translatedMessage(payload);
    if (!translated) return originalSendMessage(payload, ...args);
    const terminal = translated.type === "PROJECT_ROLE_RESULT" || translated.type === "PROJECT_ROLE_ERROR";
    const result = originalSendMessage(translated, ...args);
    if (terminal) Promise.resolve(result).finally(() => activeJobs.delete(payload.jobId));
    return result;
  };

  function contentListener() {
    return downstreamListeners.find(listener => listener !== roleListener) || null;
  }

  function dispatchThroughGuardedRunner(message) {
    const listener = contentListener();
    if (!listener) throw new Error("The primary AutoPrompter content runner is not ready.");
    activeJobs.set(message.jobId, {
      jobId: message.jobId,
      projectId: message.projectId,
      role: message.role,
      kind: message.kind,
      dispatchId: message.dispatchId || null,
      integrationId: message.integrationId || null
    });
    const synthetic = {
      type: "RUN_PROJECT_BOOTSTRAP_JOB",
      jobId: message.jobId,
      projectId: message.projectId,
      role: message.role,
      stage: message.kind,
      prompt: message.prompt,
      expectedConversationId: message.expectedConversationId,
      freshRequestId: null,
      settings: message.settings
    };
    const accepted = listener(synthetic, {}, () => {});
    if (accepted === undefined) throw new Error("The guarded AutoPrompter content runner rejected the role job.");
  }

  function roleListener(message, _sender, sendResponse) {
    if (message?.type !== "RUN_PROJECT_ROLE_JOB") return false;
    if (activeJobs.has(message.jobId)) {
      sendResponse({ ok: true, jobId: message.jobId, duplicate: true });
      return false;
    }
    try {
      dispatchThroughGuardedRunner(message);
      sendResponse({ ok: true, jobId: message.jobId });
    } catch (error) {
      activeJobs.delete(message.jobId);
      sendResponse({ ok: false, error: error?.message || String(error) });
    }
    return false;
  }

  originalAddListener(roleListener);

  if (typeof module !== "undefined" && module.exports) {
    module.exports = { translatedMessage };
  }
})();
