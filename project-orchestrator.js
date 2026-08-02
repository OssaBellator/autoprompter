"use strict";

(function attachProjectOrchestrator(root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.AutoPrompterProjectOrchestrator = api;
})(typeof globalThis !== "undefined" ? globalThis : self, () => {
  const ROLE_JOBS_KEY = "autoprompterProjectRoleJobs";
  const CATALOG_KEY = "autoprompterChatCatalog";
  const SETTINGS_KEY = "autoprompterSettings";
  const ACTIVE_JOB_STATUSES = new Set(["opening", "dispatching", "running"]);
  const MAX_SEND_ATTEMPTS = 30;
  let started = false;
  let reconcileTimer = null;
  let operationQueue = Promise.resolve();

  function enqueue(operation) {
    operationQueue = operationQueue.catch(() => {}).then(operation);
    return operationQueue;
  }

  function clone(value) {
    return value == null ? value : structuredClone(value);
  }

  function roleJobId(candidate) {
    return candidate.kind === "review"
      ? `review:${candidate.projectId}:${candidate.dispatchId}`
      : `integration:${candidate.projectId}:${candidate.integrationKey || "ready"}`;
  }

  function activeJobFor(jobs, predicate) {
    return Object.values(jobs || {}).some(job => job && ACTIVE_JOB_STATUSES.has(job.status) && predicate(job));
  }

  function selectNextRoleJob(store, jobs = {}) {
    const projects = Object.values(store?.projects || {})
      .filter(project => project?.status === "running")
      .sort((a, b) => String(a.updatedAt).localeCompare(String(b.updatedAt)));

    for (const project of projects) {
      const projectId = project.projectId;
      const tasks = store.tasksByProject?.[projectId] || {};
      const dispatches = store.dispatchesByProject?.[projectId] || {};
      const results = store.resultsByProject?.[projectId] || {};
      const reviews = store.reviewsByProject?.[projectId] || {};
      const reviewerChatId = project.roles?.reviewerChatId;
      if (reviewerChatId && !activeJobFor(jobs, job => job.projectId === projectId && job.role === "reviewer")) {
        const reviewTask = Object.values(tasks).find(task => {
          const dispatchId = task?.lastResultDispatchId;
          return task?.status === "review" && dispatchId && dispatches[dispatchId] && results[dispatchId] && !reviews[dispatchId]
            && !jobs[`review:${projectId}:${dispatchId}`];
        });
        if (reviewTask) {
          return {
            kind: "review",
            role: "reviewer",
            projectId,
            roleChatId: reviewerChatId,
            dispatchId: reviewTask.lastResultDispatchId
          };
        }
      }

      const taskValues = Object.values(tasks);
      const integration = store.integrationsByProject?.[projectId] || null;
      const integrationReady = taskValues.length > 0 && taskValues.every(task => task.status === "accepted");
      const integrationBusy = activeJobFor(jobs, job => job.projectId === projectId && job.role === "integrator");
      if (integrationReady && project.roles?.integratorChatId && !integrationBusy && !integration?.pending && !integration?.approved) {
        const integrationKey = `${store.approvedPlansByProject?.[projectId]?.revision || 0}:${integration?.activeAttempt || 0}`;
        const jobId = `integration:${projectId}:${integrationKey}`;
        if (!jobs[jobId]) {
          return {
            kind: "integration",
            role: "integrator",
            projectId,
            roleChatId: project.roles.integratorChatId,
            integrationKey
          };
        }
      }
    }
    return null;
  }

  function normalizeSettings(raw = {}) {
    return {
      ...raw,
      delaySeconds: 0,
      continuityEnabled: false,
      checkpointBeforePrompt: false,
      checkpointAfterPrompt: false,
      circuitBreakerEnabled: raw.circuitBreakerEnabled !== false,
      stallMinutes: Math.max(5, Number(raw.stallMinutes) || 15),
      contextCapacityTokens: Math.max(16000, Number(raw.contextCapacityTokens) || 128000),
      contextThresholdPercent: Math.min(98, Math.max(50, Number(raw.contextThresholdPercent) || 90))
    };
  }

  async function loadJobs() {
    const stored = await chrome.storage.local.get(ROLE_JOBS_KEY);
    return stored?.[ROLE_JOBS_KEY] && typeof stored[ROLE_JOBS_KEY] === "object" ? stored[ROLE_JOBS_KEY] : {};
  }

  async function saveJobs(jobs) {
    await chrome.storage.local.set({ [ROLE_JOBS_KEY]: jobs });
  }

  async function loadStore() {
    const ProjectStore = globalThis.AutoPrompterProjectStore;
    if (!ProjectStore) throw new Error("Project store is unavailable.");
    const stored = await chrome.storage.local.get(ProjectStore.PROJECTS_KEY);
    return ProjectStore.migrateStore(stored?.[ProjectStore.PROJECTS_KEY]).store;
  }

  async function saveStore(store) {
    const ProjectStore = globalThis.AutoPrompterProjectStore;
    await chrome.storage.local.set({ [ProjectStore.PROJECTS_KEY]: store });
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async function sendRoleJob(tabId, message) {
    let lastError = null;
    for (let attempt = 0; attempt < MAX_SEND_ATTEMPTS; attempt += 1) {
      try {
        const response = await chrome.tabs.sendMessage(tabId, message);
        if (response?.ok) return response;
        lastError = new Error(response?.error || "Role runner did not accept the job.");
      } catch (error) {
        lastError = error;
      }
      await sleep(500);
    }
    throw new Error(`The ${message.role} chat did not become ready: ${lastError?.message || "unknown error"}`);
  }

  async function markJobFailed(jobId, error, tabId = null) {
    const jobs = await loadJobs();
    if (jobs[jobId]) {
      jobs[jobId].status = "failed";
      jobs[jobId].error = String(error || "Role job failed").slice(0, 2000);
      jobs[jobId].updatedAt = new Date().toISOString();
      jobs[jobId].tabId = null;
      await saveJobs(jobs);
    }
    if (Number.isInteger(tabId)) {
      try { await chrome.tabs.remove(tabId); } catch { /* already closed */ }
    }
  }

  async function dispatchCandidate(candidate) {
    const ProjectStore = globalThis.AutoPrompterProjectStore;
    let store = await loadStore();
    const jobs = await loadJobs();
    const jobId = roleJobId(candidate);
    if (jobs[jobId]) return false;
    const stored = await chrome.storage.local.get([CATALOG_KEY, SETTINGS_KEY]);
    const catalog = Array.isArray(stored[CATALOG_KEY]) ? stored[CATALOG_KEY] : [];
    const chat = catalog.find(item => item?.id === candidate.roleChatId);
    if (!chat?.url) return false;

    let prompt;
    let integrationId = null;
    if (candidate.kind === "review") {
      prompt = ProjectStore.buildProjectReviewerPrompt(store, candidate.projectId, candidate.dispatchId).prompt;
    } else {
      const built = ProjectStore.buildProjectIntegratorPrompt(store, candidate.projectId);
      store = built.store;
      prompt = built.prompt;
      integrationId = built.integrationId;
      await saveStore(store);
    }

    const now = new Date().toISOString();
    jobs[jobId] = {
      jobId,
      projectId: candidate.projectId,
      role: candidate.role,
      kind: candidate.kind,
      dispatchId: candidate.dispatchId || null,
      integrationId,
      roleChatId: candidate.roleChatId,
      status: "opening",
      error: "",
      tabId: null,
      createdAt: now,
      updatedAt: now
    };
    await saveJobs(jobs);

    let tab = null;
    try {
      tab = await chrome.tabs.create({ url: chat.url, active: false });
      jobs[jobId].tabId = tab.id;
      jobs[jobId].status = "dispatching";
      jobs[jobId].updatedAt = new Date().toISOString();
      await saveJobs(jobs);
      await sendRoleJob(tab.id, {
        type: "RUN_PROJECT_ROLE_JOB",
        jobId,
        projectId: candidate.projectId,
        role: candidate.role,
        kind: candidate.kind,
        dispatchId: candidate.dispatchId || null,
        integrationId,
        expectedConversationId: candidate.roleChatId,
        prompt,
        settings: normalizeSettings(stored[SETTINGS_KEY] || {})
      });
      jobs[jobId].status = "running";
      jobs[jobId].updatedAt = new Date().toISOString();
      await saveJobs(jobs);
      return true;
    } catch (error) {
      await markJobFailed(jobId, error?.message || String(error), tab?.id);
      return false;
    }
  }

  function scheduleReconcile(delay = 250) {
    clearTimeout(reconcileTimer);
    reconcileTimer = setTimeout(() => {
      reconcileTimer = null;
      enqueue(reconcile).catch(() => {});
    }, delay);
  }

  async function reconcile() {
    const store = await loadStore();
    const jobs = await loadJobs();
    const candidate = selectNextRoleJob(store, jobs);
    if (!candidate) return false;
    const dispatched = await dispatchCandidate(candidate);
    if (dispatched) scheduleReconcile(500);
    return dispatched;
  }

  async function handleRoleStatus(message, sender) {
    const jobs = await loadJobs();
    const job = jobs[message.jobId];
    if (!job || (Number.isInteger(job.tabId) && job.tabId !== sender?.tab?.id)) return { ok: false, error: "Stale role job status." };
    job.status = "running";
    job.lastStatus = String(message.status || "Working").slice(0, 500);
    job.updatedAt = new Date().toISOString();
    await saveJobs(jobs);
    return { ok: true };
  }

  async function handleRoleResult(message, sender) {
    const ProjectStore = globalThis.AutoPrompterProjectStore;
    const jobs = await loadJobs();
    const job = jobs[message.jobId];
    if (!job || job.projectId !== message.projectId || job.role !== message.role || job.kind !== message.kind) {
      throw new Error("Stale or mismatched Project Mode role result.");
    }
    if (Number.isInteger(job.tabId) && job.tabId !== sender?.tab?.id) throw new Error("Role result came from an unexpected tab.");

    let store = await loadStore();
    if (job.kind === "review") {
      const reviewed = ProjectStore.submitProjectReview(store, job.projectId, job.dispatchId, message.output);
      store = reviewed.store;
      try {
        const prepared = ProjectStore.prepareProjectDispatches(store, job.projectId);
        store = prepared.store;
      } catch {
        // No newly ready tasks or project is no longer dispatchable.
      }
    } else if (job.kind === "integration") {
      store = ProjectStore.submitProjectIntegrationOutput(store, job.projectId, message.output).store;
    } else {
      throw new Error(`Unsupported Project Mode role job: ${job.kind}`);
    }
    await saveStore(store);
    const tabId = job.tabId;
    delete jobs[message.jobId];
    await saveJobs(jobs);
    if (Number.isInteger(tabId)) {
      try { await chrome.tabs.remove(tabId); } catch { /* already closed */ }
    }
    scheduleReconcile(250);
    return { ok: true };
  }

  async function handleRoleError(message, sender) {
    const jobs = await loadJobs();
    const job = jobs[message.jobId];
    if (!job) return { ok: true };
    if (Number.isInteger(job.tabId) && job.tabId !== sender?.tab?.id) return { ok: false, error: "Role error came from an unexpected tab." };
    await markJobFailed(message.jobId, message.error || message.errorKind, job.tabId);
    return { ok: true };
  }

  function installRuntimeListener() {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      let operation = null;
      if (message?.type === "PROJECT_ROLE_STATUS") operation = () => handleRoleStatus(message, sender);
      else if (message?.type === "PROJECT_ROLE_RESULT") operation = () => handleRoleResult(message, sender);
      else if (message?.type === "PROJECT_ROLE_ERROR") operation = () => handleRoleError(message, sender);
      else if (message?.type === "GET_PROJECT_ROLE_AUTOMATION") operation = async () => ({ ok: true, jobs: clone(await loadJobs()) });
      else if (message?.type === "RETRY_PROJECT_ROLE_AUTOMATION") operation = async () => {
        const jobs = await loadJobs();
        for (const [jobId, job] of Object.entries(jobs)) if (job?.status === "failed") delete jobs[jobId];
        await saveJobs(jobs);
        scheduleReconcile(0);
        return { ok: true };
      };
      if (!operation) return false;
      enqueue(operation).then(result => sendResponse(result)).catch(error => sendResponse({ ok: false, error: error?.message || String(error) }));
      return true;
    });
  }

  function start() {
    if (started || typeof chrome === "undefined" || !chrome.storage?.local || !chrome.runtime?.onMessage) return false;
    started = true;
    installRuntimeListener();
    chrome.storage.onChanged.addListener((changes, area) => {
      const ProjectStore = globalThis.AutoPrompterProjectStore;
      if (area === "local" && (changes[ProjectStore?.PROJECTS_KEY] || changes[CATALOG_KEY])) scheduleReconcile(250);
    });
    chrome.tabs.onRemoved.addListener(tabId => {
      enqueue(async () => {
        const jobs = await loadJobs();
        const job = Object.values(jobs).find(item => item?.tabId === tabId && ACTIVE_JOB_STATUSES.has(item.status));
        if (job) await markJobFailed(job.jobId, "The managed role tab was closed before completion.");
      }).catch(() => {});
    });
    scheduleReconcile(0);
    return true;
  }

  return {
    ROLE_JOBS_KEY,
    ACTIVE_JOB_STATUSES: [...ACTIVE_JOB_STATUSES],
    roleJobId,
    selectNextRoleJob,
    normalizeSettings,
    start
  };
});
