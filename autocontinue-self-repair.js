"use strict";

(function attachAutoContinueSelfRepair(root, factory) {
  const api = factory(root);
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.AutoPrompterSelfRepair = api;
})(typeof globalThis !== "undefined" ? globalThis : self, root => {
  const SELF_REPAIR_SCOPE = "AUTOPROMPTER_SELF_REPAIR";
  const SETTINGS_KEY = "autoprompterSelfRepairSettings";
  const STATE_KEY = "autoprompterSelfRepairState";
  const REPOSITORY = "OssaBellator/autoprompter";
  const SCHEMA_VERSION = "1.0";
  const MAX_HISTORY = 20;
  const DEFAULTS = Object.freeze({
    enabled: false,
    autoMerge: true,
    cooldownMinutes: 60,
    maxRepairsPerDay: 3
  });
  const ACTIVE_STATUSES = new Set(["opening", "running"]);
  const EXCLUDED_PATTERNS = [
    /stopped by user/i,
    /circuit breaker/i,
    /rate limit/i,
    /account restriction/i,
    /safety restriction/i,
    /managed ChatGPT tab was closed/i,
    /prompt was edited before submission/i,
    /composer contains different text/i
  ];
  let installed = false;

  function text(value, max = 4000) {
    return String(value || "").trim().slice(0, max);
  }

  function clampNumber(value, fallback, min, max) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, parsed));
  }

  function normalizeSettings(value = {}) {
    return {
      enabled: value.enabled === true,
      autoMerge: value.autoMerge !== false,
      cooldownMinutes: Math.round(clampNumber(value.cooldownMinutes, DEFAULTS.cooldownMinutes, 15, 1440)),
      maxRepairsPerDay: Math.round(clampNumber(value.maxRepairsPerDay, DEFAULTS.maxRepairsPerDay, 1, 10))
    };
  }

  function emptyState() {
    return { schemaVersion: SCHEMA_VERSION, activeJobId: null, jobs: [] };
  }

  function normalizeState(value) {
    const state = emptyState();
    if (!value || typeof value !== "object") return state;
    state.jobs = (Array.isArray(value.jobs) ? value.jobs : [])
      .filter(job => job && typeof job === "object" && job.jobId)
      .slice(-MAX_HISTORY);
    state.activeJobId = text(value.activeJobId, 160) || null;
    if (!state.jobs.some(job => job.jobId === state.activeJobId && ACTIVE_STATUSES.has(job.status))) {
      state.activeJobId = null;
    }
    return state;
  }

  function normalizeFingerprintText(value) {
    return text(value, 8000)
      .toLowerCase()
      .replace(/https?:\/\/\S+/g, "<url>")
      .replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, "<uuid>")
      .replace(/\b[0-9a-f]{32,64}\b/gi, "<sha>")
      .replace(/\b\d{2,}\b/g, "<n>")
      .replace(/\s+/g, " ")
      .trim();
  }

  function hashText(value) {
    let hash = 2166136261;
    const source = String(value || "");
    for (let index = 0; index < source.length; index += 1) {
      hash ^= source.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  }

  function fingerprintReport(report) {
    return hashText([
      normalizeFingerprintText(report?.source),
      normalizeFingerprintText(report?.kind),
      normalizeFingerprintText(report?.message)
    ].join("|"));
  }

  function shouldCaptureReport(report) {
    const message = text(report?.message, 4000);
    if (!message) return false;
    return !EXCLUDED_PATTERNS.some(pattern => pattern.test(message));
  }

  function sanitizeReport(report = {}) {
    const diagnostics = report.diagnostics && typeof report.diagnostics === "object"
      ? report.diagnostics
      : {};
    return {
      source: text(report.source || "runtime", 120),
      kind: text(report.kind || "runtime_error", 120),
      message: text(report.message, 4000),
      stack: text(report.stack, 6000),
      occurredAt: text(report.occurredAt, 80) || new Date().toISOString(),
      extensionVersion: text(report.extensionVersion, 40),
      diagnostics: {
        status: text(diagnostics.status, 200),
        sentCount: Number.isFinite(Number(diagnostics.sentCount)) ? Number(diagnostics.sentCount) : null,
        connectionRetryCount: Number.isFinite(Number(diagnostics.connectionRetryCount)) ? Number(diagnostics.connectionRetryCount) : null,
        generation: Number.isFinite(Number(diagnostics.generation)) ? Number(diagnostics.generation) : null,
        rolloverCount: Number.isFinite(Number(diagnostics.rolloverCount)) ? Number(diagnostics.rolloverCount) : null,
        contextPercent: Number.isFinite(Number(diagnostics.contextPercent)) ? Number(diagnostics.contextPercent) : null,
        continuityEnabled: diagnostics.continuityEnabled === true,
        browser: text(diagnostics.browser, 300)
      }
    };
  }

  function branchName(fingerprint, createdAt) {
    const date = String(createdAt || new Date().toISOString()).replace(/[^0-9]/g, "").slice(0, 14);
    return `autofix/${text(fingerprint, 24)}-${date}`;
  }

  function buildRepairPrompt(report, settings, metadata = {}) {
    const fingerprint = fingerprintReport(report);
    const createdAt = metadata.createdAt || new Date().toISOString();
    const branch = branchName(fingerprint, createdAt);
    const diagnosticJson = JSON.stringify(sanitizeReport(report), null, 2);
    const mergeInstruction = settings?.autoMerge
      ? "After the pull request checks pass, inspect the final diff and merge it with squash only when the change is narrowly scoped, tests are green, and no unresolved review concern remains. If any of those conditions are not met, leave the pull request open."
      : "Do not merge the pull request. Leave it open for manual review.";
    return [
      "You are the bounded AutoPrompter self-repair agent.",
      `Repository: ${REPOSITORY}`,
      "Base branch: main",
      `Required repair branch: ${branch}`,
      "Use a connected write-capable GitHub repository tool. The read-only GitHub connector is insufficient.",
      "Treat the repository and tests as the source of truth. You cannot access the user's local checkout or private ChatGPT transcripts.",
      "",
      "Technical failure report (sanitized; no conversation transcript or private notes are included):",
      diagnosticJson,
      "",
      "Required process:",
      "1. Inspect current main and identify the smallest reproducible extension defect consistent with the report.",
      "2. Add or strengthen a regression test before or with the fix.",
      `3. Create or update exactly ${branch}; do not commit directly to main.`,
      "4. Implement the smallest safe fix. Do not add permissions, secrets, telemetry, remote code, or unrelated refactors.",
      "5. Run npm test and npm run check. Record their exact outcomes.",
      "6. Open one pull request to main with root cause, fix, and validation details.",
      `7. ${mergeInstruction}`,
      "8. Do not modify GitHub Actions workflows, repository permissions, release credentials, or extension host permissions unless the failure directly proves such a change is necessary; in that case leave the PR open instead of merging.",
      "",
      "Return exactly one strict JSON envelope with no Markdown fences or prose outside it:",
      "AUTOPROMPTER_SELF_REPAIR_BEGIN",
      JSON.stringify({
        schemaVersion: "1.0",
        repository: REPOSITORY,
        fingerprint,
        status: "merged | pr_open | blocked",
        branch,
        pullRequestUrl: "https://github.com/OssaBellator/autoprompter/pull/<number> or null",
        mergeCommit: "40-character SHA when merged, otherwise null",
        summary: "concise diagnosis and fix summary",
        tests: ["npm test: passed or exact failure", "npm run check: passed or exact failure"],
        blocker: "null or the exact reason safe automated completion was impossible"
      }, null, 2),
      "AUTOPROMPTER_SELF_REPAIR_END"
    ].join("\n");
  }

  function extractLatestEnvelope(output) {
    const source = String(output || "");
    const begin = "AUTOPROMPTER_SELF_REPAIR_BEGIN";
    const end = "AUTOPROMPTER_SELF_REPAIR_END";
    const endIndex = source.lastIndexOf(end);
    if (endIndex < 0) throw new Error(`Self-repair result must contain ${end}.`);
    const beginIndex = source.lastIndexOf(begin, endIndex);
    if (beginIndex < 0) throw new Error(`Self-repair result must contain ${begin}.`);
    const jsonText = source.slice(beginIndex + begin.length, endIndex).trim();
    if (!jsonText) throw new Error("Self-repair result envelope is empty.");
    return JSON.parse(jsonText);
  }

  function parseRepairResult(output, expectedFingerprint = "") {
    const value = extractLatestEnvelope(output);
    if (value?.schemaVersion !== "1.0") throw new Error("Self-repair schemaVersion must be 1.0.");
    if (value?.repository !== REPOSITORY) throw new Error(`Self-repair repository must be ${REPOSITORY}.`);
    if (expectedFingerprint && value?.fingerprint !== expectedFingerprint) {
      throw new Error("Self-repair fingerprint does not match the captured failure.");
    }
    if (!["merged", "pr_open", "blocked"].includes(value?.status)) {
      throw new Error("Self-repair status must be merged, pr_open, or blocked.");
    }
    const pullRequestUrl = value.pullRequestUrl == null ? null : text(value.pullRequestUrl, 500);
    if (pullRequestUrl && !/^https:\/\/github\.com\/OssaBellator\/autoprompter\/pull\/\d+$/.test(pullRequestUrl)) {
      throw new Error("Self-repair pullRequestUrl does not belong to the configured repository.");
    }
    const mergeCommit = value.mergeCommit == null ? null : text(value.mergeCommit, 80);
    if (value.status === "merged") {
      if (!pullRequestUrl) throw new Error("A merged self-repair result requires pullRequestUrl.");
      if (!/^[0-9a-f]{40}$/i.test(mergeCommit || "")) throw new Error("A merged self-repair result requires a 40-character mergeCommit.");
    } else if (mergeCommit) {
      throw new Error("Only a merged self-repair result may include mergeCommit.");
    }
    if (value.status === "pr_open" && !pullRequestUrl) {
      throw new Error("An open self-repair result requires pullRequestUrl.");
    }
    return {
      schemaVersion: "1.0",
      repository: REPOSITORY,
      fingerprint: value.fingerprint,
      status: value.status,
      branch: text(value.branch, 300),
      pullRequestUrl,
      mergeCommit,
      summary: text(value.summary, 3000),
      tests: (Array.isArray(value.tests) ? value.tests : []).map(item => text(item, 1000)).filter(Boolean).slice(0, 20),
      blocker: value.blocker == null ? null : text(value.blocker, 3000)
    };
  }

  async function storageGet(key) {
    try { return await root.chrome.storage.local.get(key); } catch { return {}; }
  }

  async function loadSettings() {
    const stored = await storageGet(SETTINGS_KEY);
    return normalizeSettings(stored?.[SETTINGS_KEY]);
  }

  async function saveSettings(value) {
    const settings = normalizeSettings(value);
    await root.chrome.storage.local.set({ [SETTINGS_KEY]: settings });
    return settings;
  }

  async function loadState() {
    const stored = await storageGet(STATE_KEY);
    return normalizeState(stored?.[STATE_KEY]);
  }

  async function saveState(state) {
    const normalized = normalizeState(state);
    await root.chrome.storage.local.set({ [STATE_KEY]: normalized });
    return normalized;
  }

  async function notify(title, message) {
    try {
      await root.chrome.notifications.create(`autoprompter-self-repair-${Date.now()}`, {
        type: "basic",
        iconUrl: root.NOTIFICATION_ICON_DATA_URL,
        title: text(title, 120),
        message: text(message, 500),
        priority: 0
      });
    } catch {
      try {
        await root.chrome.action.setBadgeBackgroundColor({ color: "#8a3ffc" });
        await root.chrome.action.setBadgeText({ text: "R" });
      } catch { /* best effort */ }
    }
  }

  function reportFromChatFailure(state, index, error, source = "chat_worker") {
    const chat = state?.chats?.[index] || {};
    return sanitizeReport({
      source,
      kind: "runtime_error",
      message: error?.message || error,
      stack: error?.stack || "",
      extensionVersion: root.chrome?.runtime?.getManifest?.().version || "",
      diagnostics: {
        status: chat.status,
        sentCount: chat.sentCount,
        connectionRetryCount: chat.connectionRetryCount,
        generation: chat.generation,
        rolloverCount: chat.rolloverCount,
        contextPercent: chat.contextPercent,
        continuityEnabled: chat.settings?.continuityEnabled,
        browser: root.navigator?.userAgent || ""
      }
    });
  }

  function activeJob(state) {
    return state.jobs.find(job => job.jobId === state.activeJobId) || null;
  }

  function withinCooldown(job, fingerprint, cooldownMs, now) {
    if (job.fingerprint !== fingerprint) return false;
    const at = Date.parse(job.createdAt || "");
    return Number.isFinite(at) && now - at < cooldownMs;
  }

  async function maybeStartRepair(rawReport) {
    const settings = await loadSettings();
    const report = sanitizeReport(rawReport);
    if (!settings.enabled || !shouldCaptureReport(report)) return { started: false, reason: "disabled_or_excluded" };

    const state = await loadState();
    const current = activeJob(state);
    if (current && ACTIVE_STATUSES.has(current.status)) {
      current.duplicateCount = Number(current.duplicateCount || 0) + 1;
      current.updatedAt = new Date().toISOString();
      await saveState(state);
      return { started: false, reason: "active_repair" };
    }

    const now = Date.now();
    const fingerprint = fingerprintReport(report);
    const cooldownMs = settings.cooldownMinutes * 60_000;
    if (state.jobs.some(job => withinCooldown(job, fingerprint, cooldownMs, now))) {
      return { started: false, reason: "cooldown" };
    }
    const recentCount = state.jobs.filter(job => {
      const at = Date.parse(job.createdAt || "");
      return Number.isFinite(at) && now - at < 24 * 60 * 60_000 && job.status !== "suppressed";
    }).length;
    if (recentCount >= settings.maxRepairsPerDay) {
      await notify("AutoPrompter self-repair paused", "The daily automatic repair limit was reached. Review the error history in the popup.");
      return { started: false, reason: "daily_limit" };
    }

    const createdAt = new Date(now).toISOString();
    const jobId = `repair:${fingerprint}:${now}`;
    const job = {
      jobId,
      fingerprint,
      status: "opening",
      source: report.source,
      kind: report.kind,
      message: report.message,
      report,
      autoMerge: settings.autoMerge,
      branch: branchName(fingerprint, createdAt),
      createdAt,
      updatedAt: createdAt,
      tabId: null,
      promptSent: false,
      conversationId: null,
      conversationUrl: null,
      result: null,
      error: "",
      duplicateCount: 0
    };
    state.jobs = [...state.jobs, job].slice(-MAX_HISTORY);
    state.activeJobId = jobId;
    await saveState(state);

    try {
      const tab = await root.chrome.tabs.create({ url: "about:blank", active: false });
      job.tabId = tab.id;
      job.updatedAt = new Date().toISOString();
      await saveState(state);
      const url = typeof root.freshChatUrl === "function"
        ? root.freshChatUrl("self-repair", fingerprint, jobId)
        : `https://chatgpt.com/?autoprompter_self_repair=${encodeURIComponent(jobId)}`;
      await root.chrome.tabs.update(tab.id, { url, active: false });
      await notify("AutoPrompter self-repair started", `A temporary repair chat is diagnosing error ${fingerprint}.`);
      return { started: true, jobId };
    } catch (error) {
      job.status = "failed";
      job.error = text(error?.message || error, 3000);
      job.updatedAt = new Date().toISOString();
      state.activeJobId = null;
      await saveState(state);
      return { started: false, reason: "tab_creation_failed" };
    }
  }

  function repairJobSettings() {
    if (typeof root.normalizeSettings === "function") {
      return root.normalizeSettings({
        prompt: "Self-repair",
        delaySeconds: 5,
        maxContinuations: 1,
        notificationsEnabled: false,
        notifyOnPromptDone: false,
        circuitBreakerEnabled: true,
        continuityEnabled: false,
        repository: "",
        checkpointBeforePrompt: false,
        checkpointAfterPrompt: false,
        stallMinutes: 60,
        maxRollovers: 1
      });
    }
    return { delaySeconds: 5, stallMinutes: 60, circuitBreakerEnabled: true };
  }

  async function dispatchRepairJob(tabId) {
    const state = await loadState();
    const job = activeJob(state);
    if (!job || job.tabId !== tabId || job.promptSent || !ACTIVE_STATUSES.has(job.status)) return false;
    const settings = normalizeSettings({ ...DEFAULTS, autoMerge: job.autoMerge });
    job.promptSent = true;
    job.status = "running";
    job.updatedAt = new Date().toISOString();
    await saveState(state);
    try {
      await root.chrome.tabs.sendMessage(tabId, {
        type: "RUN_SELF_REPAIR_JOB",
        jobId: job.jobId,
        freshRequestId: job.jobId,
        prompt: buildRepairPrompt(job.report, settings, { createdAt: job.createdAt }),
        settings: repairJobSettings()
      });
      return true;
    } catch (error) {
      job.promptSent = false;
      job.status = "opening";
      job.error = text(error?.message || error, 1000);
      job.updatedAt = new Date().toISOString();
      await saveState(state);
      return false;
    }
  }

  async function finishRepair(message, sender) {
    const state = await loadState();
    const job = activeJob(state);
    if (!job || job.jobId !== message.jobId || job.tabId !== sender?.tab?.id) return { ignored: true };
    try {
      const result = parseRepairResult(message.output, job.fingerprint);
      job.status = result.status;
      job.result = result;
      job.conversationId = text(message.conversation?.id, 300) || null;
      job.conversationUrl = text(message.conversation?.url, 500) || null;
      job.error = "";
      job.updatedAt = new Date().toISOString();
      state.activeJobId = null;
      await saveState(state);
      try { await root.chrome.tabs.remove(job.tabId); } catch { /* best effort */ }
      if (result.status === "merged") {
        await notify("AutoPrompter fix merged", `Repair ${job.fingerprint} merged. Update the local checkout with git pull.`);
      } else if (result.status === "pr_open") {
        await notify("AutoPrompter repair PR opened", "The repair chat left a pull request open because automated merge conditions were not met.");
      } else {
        await notify("AutoPrompter self-repair blocked", result.blocker || "The repair chat could not complete safely.");
      }
      return { result };
    } catch (error) {
      job.status = "failed";
      job.error = `Invalid repair result: ${text(error?.message || error, 2500)}`;
      job.updatedAt = new Date().toISOString();
      state.activeJobId = null;
      await saveState(state);
      try { await root.chrome.tabs.remove(job.tabId); } catch { /* best effort */ }
      await notify("AutoPrompter self-repair failed", job.error);
      return { error: job.error };
    }
  }

  async function failRepair(message, sender) {
    const state = await loadState();
    const job = activeJob(state);
    if (!job || job.jobId !== message.jobId || job.tabId !== sender?.tab?.id) return { ignored: true };
    job.status = "failed";
    job.error = text(message.error || "The repair chat failed.", 3000);
    job.updatedAt = new Date().toISOString();
    state.activeJobId = null;
    await saveState(state);
    try { await root.chrome.tabs.remove(job.tabId); } catch { /* best effort */ }
    await notify("AutoPrompter self-repair failed", job.error);
    return { error: job.error };
  }

  async function updateRepairStatus(message, sender) {
    const state = await loadState();
    const job = activeJob(state);
    if (!job || job.jobId !== message.jobId || job.tabId !== sender?.tab?.id) return { ignored: true };
    job.statusMessage = text(message.status, 300);
    job.updatedAt = new Date().toISOString();
    await saveState(state);
    return { updated: true };
  }

  function publicStatus(state) {
    const normalized = normalizeState(state);
    return {
      activeJobId: normalized.activeJobId,
      jobs: normalized.jobs.slice().reverse().map(job => ({
        jobId: job.jobId,
        fingerprint: job.fingerprint,
        status: job.status,
        statusMessage: job.statusMessage || "",
        message: job.message,
        branch: job.branch,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
        duplicateCount: Number(job.duplicateCount || 0),
        result: job.result,
        error: job.error || ""
      }))
    };
  }

  function install() {
    if (installed || !root.chrome?.runtime?.onMessage || !root.chrome?.storage?.local) return installed;

    if (typeof root.failChatWorker === "function") {
      const originalFailChatWorker = root.failChatWorker;
      root.failChatWorker = async function failChatWorkerWithSelfRepair(state, index, error, closeWorker = true) {
        const report = reportFromChatFailure(state, index, error, "chat_worker");
        const result = await originalFailChatWorker(state, index, error, closeWorker);
        try { await maybeStartRepair(report); } catch { /* self-repair must not break AutoContinue */ }
        return result;
      };
    }

    if (typeof root.stopScheduler === "function") {
      const originalStopScheduler = root.stopScheduler;
      root.stopScheduler = async function stopSchedulerWithSelfRepair(reason, error, ...rest) {
        const result = await originalStopScheduler(reason, error, ...rest);
        if (error) {
          try {
            await maybeStartRepair(sanitizeReport({
              source: "scheduler_stop",
              kind: "runtime_error",
              message: `${text(reason, 500)}: ${text(error, 3500)}`,
              extensionVersion: root.chrome?.runtime?.getManifest?.().version || "",
              diagnostics: { browser: root.navigator?.userAgent || "" }
            }));
          } catch { /* best effort */ }
        }
        return result;
      };
    }

    root.chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message?.scope !== SELF_REPAIR_SCOPE) return false;
      const operation = async () => {
        switch (message.type) {
          case "SELF_REPAIR_CONTENT_READY":
            return { dispatched: await dispatchRepairJob(sender?.tab?.id) };
          case "SELF_REPAIR_STATUS":
            return updateRepairStatus(message, sender);
          case "SELF_REPAIR_RESULT":
            return finishRepair(message, sender);
          case "SELF_REPAIR_ERROR":
            return failRepair(message, sender);
          case "SELF_REPAIR_DIAGNOSTIC":
            return maybeStartRepair(sanitizeReport({
              ...message.report,
              extensionVersion: root.chrome?.runtime?.getManifest?.().version || "",
              diagnostics: {
                ...(message.report?.diagnostics || {}),
                browser: root.navigator?.userAgent || ""
              }
            }));
          case "GET_SELF_REPAIR_SETTINGS":
            return { settings: await loadSettings() };
          case "SAVE_SELF_REPAIR_SETTINGS":
            return { settings: await saveSettings(message.settings) };
          case "GET_SELF_REPAIR_STATUS":
            return publicStatus(await loadState());
          case "CLEAR_SELF_REPAIR_HISTORY": {
            const state = await loadState();
            const active = activeJob(state);
            const next = active ? { ...emptyState(), activeJobId: active.jobId, jobs: [active] } : emptyState();
            await saveState(next);
            return publicStatus(next);
          }
          default:
            throw new Error(`Unknown self-repair command: ${text(message.type, 160)}`);
        }
      };
      Promise.resolve(operation())
        .then(result => sendResponse({ ok: true, ...result }))
        .catch(error => sendResponse({ ok: false, error: text(error?.message || error, 3000) }));
      return true;
    });

    root.chrome.tabs?.onRemoved?.addListener(tabId => {
      Promise.resolve().then(async () => {
        const state = await loadState();
        const job = activeJob(state);
        if (!job || job.tabId !== tabId) return;
        job.status = "failed";
        job.error = "The temporary self-repair tab was closed before completion.";
        job.updatedAt = new Date().toISOString();
        state.activeJobId = null;
        await saveState(state);
      }).catch(() => {});
    });

    if (typeof root.addEventListener === "function") {
      root.addEventListener("error", event => {
        maybeStartRepair(sanitizeReport({
          source: "background_error",
          kind: "uncaught_error",
          message: event?.message || "Uncaught service-worker error",
          stack: event?.error?.stack || "",
          extensionVersion: root.chrome?.runtime?.getManifest?.().version || ""
        })).catch(() => {});
      });
      root.addEventListener("unhandledrejection", event => {
        maybeStartRepair(sanitizeReport({
          source: "background_rejection",
          kind: "unhandled_rejection",
          message: event?.reason?.message || event?.reason || "Unhandled service-worker rejection",
          stack: event?.reason?.stack || "",
          extensionVersion: root.chrome?.runtime?.getManifest?.().version || ""
        })).catch(() => {});
      });
    }

    installed = true;
    return true;
  }

  if (typeof importScripts === "function") install();

  return {
    SELF_REPAIR_SCOPE,
    SETTINGS_KEY,
    STATE_KEY,
    REPOSITORY,
    SCHEMA_VERSION,
    DEFAULTS,
    normalizeSettings,
    normalizeState,
    normalizeFingerprintText,
    hashText,
    fingerprintReport,
    shouldCaptureReport,
    sanitizeReport,
    branchName,
    buildRepairPrompt,
    extractLatestEnvelope,
    parseRepairResult,
    publicStatus,
    install
  };
});
