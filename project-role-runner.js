"use strict";

(() => {
  const bridge = globalThis.AutoPrompterContentRunner;
  if (!bridge || typeof chrome === "undefined" || !chrome.runtime?.onMessage) return;

  let activeRoleJob = null;

  function runtimeMessage(payload) {
    return chrome.runtime.sendMessage(payload);
  }

  async function executeRoleJob(message, controller) {
    const signal = controller.signal;
    const status = value => runtimeMessage({
      type: "PROJECT_ROLE_STATUS",
      projectId: message.projectId,
      jobId: message.jobId,
      role: message.role,
      kind: message.kind,
      status: String(value || "Working").slice(0, 300)
    });

    try {
      const current = bridge.conversationInfo();
      if (!current || current.id !== message.expectedConversationId) {
        throw new Error(`The managed ${message.role} tab opened a different conversation.`);
      }
      await status(`Waiting for the ${message.role} chat`);
      const baseline = await bridge.waitForCompletedAssistant({
        signal,
        settings: message.settings,
        status
      });
      const completed = await bridge.submitPrompt({
        prompt: message.prompt,
        signal,
        status,
        settings: message.settings,
        baseline,
        expectedConversationId: message.expectedConversationId,
        delaySeconds: 0
      });
      const response = await runtimeMessage({
        type: "PROJECT_ROLE_RESULT",
        projectId: message.projectId,
        jobId: message.jobId,
        role: message.role,
        kind: message.kind,
        dispatchId: message.dispatchId || null,
        integrationId: message.integrationId || null,
        output: completed.text,
        assistantSignature: completed.signature
      });
      if (!response || response.ok === false) {
        throw new Error(response?.error || `${message.role} result could not be recorded.`);
      }
    } catch (error) {
      if (error?.name === "AbortError") return;
      await runtimeMessage({
        type: "PROJECT_ROLE_ERROR",
        projectId: message.projectId,
        jobId: message.jobId,
        role: message.role,
        kind: message.kind,
        dispatchId: message.dispatchId || null,
        integrationId: message.integrationId || null,
        errorKind: error?.kind || "runtime_error",
        error: error?.message || String(error)
      });
    }
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "RUN_PROJECT_ROLE_JOB") return false;
    if (activeRoleJob?.jobId === message.jobId) {
      sendResponse({ ok: true, jobId: message.jobId, duplicate: true });
      return false;
    }
    activeRoleJob?.controller.abort();
    const controller = new AbortController();
    activeRoleJob = { jobId: message.jobId, controller };
    executeRoleJob(message, controller).finally(() => {
      if (activeRoleJob?.jobId === message.jobId) activeRoleJob = null;
    });
    sendResponse({ ok: true, jobId: message.jobId });
    return false;
  });
})();
