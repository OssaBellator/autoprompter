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
    const actionChannel = job.channel === "action";
    if (payload.type === "PROJECT_BOOTSTRAP_STATUS") {
      return actionChannel ? {
        type: "PROJECT_ACTION_STATUS",
        projectId: job.projectId,
        jobId: job.jobId,
        actionId: job.actionId,
        approvalId: job.approvalId,
        action: job.action,
        target: job.target,
        status: payload.status
      } : {
        type: "PROJECT_ROLE_STATUS",
        projectId: job.projectId,
        jobId: job.jobId,
        role: job.role,
        kind: job.kind,
        status: payload.status
      };
    }
    if (payload.type === "PROJECT_BOOTSTRAP_RESULT") {
      return actionChannel ? {
        type: "PROJECT_ACTION_RESULT",
        projectId: job.projectId,
        jobId: job.jobId,
        actionId: job.actionId,
        approvalId: job.approvalId,
        action: job.action,
        target: job.target,
        conversation: payload.conversation,
        output: payload.output,
        assistantSignature: payload.assistantSignature
      } : {
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
      return actionChannel ? {
        type: "PROJECT_ACTION_ERROR",
        projectId: job.projectId,
        jobId: job.jobId,
        actionId: job.actionId,
        approvalId: job.approvalId,
        action: job.action,
        target: job.target,
        errorKind: payload.kind || "runtime_error",
        error: payload.error || "Repository action job failed."
      } : {
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
    const terminal = ["PROJECT_ROLE_RESULT", "PROJECT_ROLE_ERROR", "PROJECT_ACTION_RESULT", "PROJECT_ACTION_ERROR"].includes(translated.type);
    const result = originalSendMessage(translated, ...args);
    if (terminal) Promise.resolve(result).finally(() => activeJobs.delete(payload.jobId));
    return result;
  };

  function contentListener() {
    return downstreamListeners.find(listener => listener !== adapterListener) || null;
  }

  function dispatchThroughGuardedRunner(message, channel) {
    const listener = contentListener();
    if (!listener) throw new Error("The primary AutoPrompter content runner is not ready.");
    activeJobs.set(message.jobId, channel === "action" ? {
      channel,
      jobId: message.jobId,
      projectId: message.projectId,
      actionId: message.actionId,
      approvalId: message.approvalId,
      action: message.action,
      target: message.target
    } : {
      channel,
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
      role: message.role || "integrator",
      stage: channel === "action" ? "repository_action" : message.kind,
      prompt: message.prompt,
      expectedConversationId: message.expectedConversationId,
      freshRequestId: null,
      settings: message.settings
    };
    const accepted = listener(synthetic, {}, () => {});
    if (accepted === undefined) throw new Error("The guarded AutoPrompter content runner rejected the managed job.");
  }

  function adapterListener(message, _sender, sendResponse) {
    const channel = message?.type === "RUN_PROJECT_ACTION_JOB"
      ? "action"
      : message?.type === "RUN_PROJECT_ROLE_JOB" ? "role" : null;
    if (!channel) return false;
    if (activeJobs.has(message.jobId)) {
      sendResponse({ ok: true, jobId: message.jobId, duplicate: true });
      return false;
    }
    try {
      dispatchThroughGuardedRunner(message, channel);
      sendResponse({ ok: true, jobId: message.jobId });
    } catch (error) {
      activeJobs.delete(message.jobId);
      sendResponse({ ok: false, error: error?.message || String(error) });
    }
    return false;
  }

  originalAddListener(adapterListener);

  if (typeof module !== "undefined" && module.exports) {
    module.exports = { translatedMessage };
  }
})();
