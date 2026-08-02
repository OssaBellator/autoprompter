"use strict";

(function attachProjectFullAuto(root, factory) {
  const api = factory(root);
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.AutoPrompterProjectFullAuto = api;
})(typeof globalThis !== "undefined" ? globalThis : self, root => {
  const MESSAGE_SCOPE = "AUTOPROMPTER_RUNTIME";
  const ACTION_JOBS_KEY = "autoprompterProjectActionJobs";
  const ROLE_JOBS_KEY = "autoprompterProjectRoleJobs";
  const CATALOG_KEY = "autoprompterChatCatalog";
  const SETTINGS_KEY = "autoprompterSettings";
  const ACTIVE = new Set(["opening", "dispatching", "running"]);
  const TERMINAL = new Set(["completed", "blocked", "failed"]);
  const MAX_ACTION_ATTEMPTS = 3;
  let started = false;
  let timer = null;
  let queue = Promise.resolve();

  function enqueue(operation) {
    queue = queue.catch(() => {}).then(operation);
    return queue;
  }

  function hash(value) {
    let result = 0x811c9dc5;
    for (const char of String(value || "")) {
      result ^= char.charCodeAt(0);
      result = Math.imul(result, 0x01000193) >>> 0;
    }
    return result.toString(36);
  }

  function actionId(projectId, action, target) {
    return `action:${projectId}:${action}:${hash(target)}`;
  }

  async function loadLocal(keys) {
    return chrome.storage.local.get(keys);
  }

  async function loadStore() {
    const ProjectStore = root.AutoPrompterProjectStore;
    if (!ProjectStore) throw new Error("Project store is unavailable.");
    const stored = await loadLocal(ProjectStore.PROJECTS_KEY);
    return ProjectStore.migrateStore(stored?.[ProjectStore.PROJECTS_KEY]).store;
  }

  async function saveStore(store) {
    const key = root.AutoPrompterProjectStore.PROJECTS_KEY;
    await chrome.storage.local.set({ [key]: store });
  }

  async function loadActionJobs() {
    const stored = await loadLocal(ACTION_JOBS_KEY);
    return stored?.[ACTION_JOBS_KEY] && typeof stored[ACTION_JOBS_KEY] === "object"
      ? stored[ACTION_JOBS_KEY]
      : {};
  }

  async function saveActionJobs(jobs) {
    await chrome.storage.local.set({ [ACTION_JOBS_KEY]: jobs });
  }

  function schedule(delay = 250) {
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      enqueue(reconcile).catch(() => {});
    }, delay);
  }

  async function invokeBackground(functionName, type, args) {
    if (typeof root[functionName] === "function") return root[functionName](...args);
    const response = await chrome.runtime.sendMessage({ scope: MESSAGE_SCOPE, type, ...args.at(-1) });
    if (!response || response.ok === false) throw new Error(response?.error || `${type} failed.`);
    return response;
  }

  async function advanceLocalLifecycle(store) {
    let changed = false;
    const ProjectStore = root.AutoPrompterProjectStore;
    for (const project of Object.values(store.projects || {})) {
      const id = project.projectId;
      if (project.status === "ready" && store.approvedPlansByProject?.[id] && Object.keys(store.tasksByProject?.[id] || {}).length) {
        const startedProject = ProjectStore.startProject(store, id);
        store = startedProject.store;
        changed = true;
      }
      const current = store.projects[id];
      if (current?.status === "running") {
        const tasks = Object.values(store.tasksByProject?.[id] || {});
        if (tasks.some(task => task.status === "ready")) {
          try {
            const prepared = ProjectStore.prepareProjectDispatches(store, id);
            store = prepared.store;
            changed = changed || Boolean(prepared.dispatches?.length || prepared.prepared?.length);
          } catch {
            // No worker capacity or no eligible tasks yet.
          }
        }
      }
      const integration = store.integrationsByProject?.[id];
      if (store.projects[id]?.status === "running" && integration?.pending?.status === "completed") {
        const approved = ProjectStore.approveProjectIntegration(store, id);
        store = approved.store;
        changed = true;
      }
    }
    if (changed) await saveStore(store);
    return store;
  }

  async function dispatchPreparedWorkers(store) {
    if (typeof root.dispatchPreparedProjectAssignmentsState !== "function") return;
    for (const project of Object.values(store.projects || {})) {
      if (project.status !== "running") continue;
      const preparedIds = Object.values(store.dispatchesByProject?.[project.projectId] || {})
        .filter(dispatch => dispatch.status === "prepared")
        .map(dispatch => dispatch.dispatchId);
      if (!preparedIds.length) continue;
      try {
        await root.dispatchPreparedProjectAssignmentsState(project.projectId, preparedIds, true);
      } catch {
        // Background state, ChatGPT availability, or the normal scheduler may temporarily block dispatch.
      }
    }
  }

  function approvalFor(store, projectId, action, target) {
    return Object.values(store.approvalsByProject?.[projectId] || {})
      .filter(item => item.action === action && item.target === target)
      .sort((a, b) => String(b.requestedAt).localeCompare(String(a.requestedAt)))[0] || null;
  }

  function ensureApprovedRequest(store, project, action, target, justification) {
    const ProjectStore = root.AutoPrompterProjectStore;
    let approval = approvalFor(store, project.projectId, action, target);
    if (!approval || ["rejected", "expired"].includes(approval.status)) {
      const requested = ProjectStore.requestProjectApproval(store, project.projectId, {
        action,
        target,
        justification
      });
      store = requested.store;
      approval = requested.approval;
    }
    if (approval.status === "pending") {
      const decided = ProjectStore.decideProjectApproval(
        store,
        project.projectId,
        approval.approvalId,
        "approved",
        "Approved automatically by the project's full-auto policy. Repository tools must still verify exact scope and evidence."
      );
      store = decided.store;
      approval = decided.approval;
    }
    return { store, approval };
  }

  function actionDefinitions(store, project) {
    const id = project.projectId;
    const plan = store.approvedPlansByProject?.[id];
    const integration = store.integrationsByProject?.[id];
    const definitions = [];
    if (plan) {
      definitions.push({
        action: "modify_workflow",
        target: root.AutoPrompterRepositoryBootstrap.WORKFLOW_PATH,
        justification: "Install or update the read-only AutoPrompter project manifest validation workflow.",
        ready: true,
        extra() {
          const bundle = root.AutoPrompterRepositoryBootstrap.buildRepositoryBootstrapBundle(project, plan);
          return `Apply this exact repository bootstrap bundle in a pull request, then merge it after its checks pass. Do not use pull_request_target or add secrets.\n${JSON.stringify(bundle.files, null, 2)}`;
        }
      });
      definitions.push({
        action: "change_permissions",
        target: `${project.repository.slug}:minimum-project-automation`,
        justification: "Ensure the connected repository app or MCP backend has only the minimum permissions required for project branches, pull requests, workflows, merges, and releases.",
        ready: true,
        extra() {
          return "Inspect the connected GitHub app, MCP app, or Codex repository permissions. Configure only repository-scoped contents, pull-request, workflow, and release permissions required by this project. Do not grant organization administration, secret access, billing access, or broader repositories. If permission changes require an unavailable user-interface confirmation, return blocked with the exact missing scopes.";
        }
      });
    }
    if (integration?.approved) {
      const commit = integration.approved.commit;
      definitions.push({
        action: "merge_to_default_branch",
        target: `${project.repository.slug}:${project.repository.defaultBranch}:${commit}`,
        justification: "Merge the independently reviewed and validated integration result to the configured default branch.",
        ready: true,
        extra() {
          return `Verify the integration commit ${commit}, required checks, reviews, conflicts, and repository protections. Merge through a pull request or merge queue into ${project.repository.defaultBranch}. Never force-push or bypass required checks.`;
        }
      });
      definitions.push({
        action: "publish_release",
        target: `${project.repository.slug}:automatic-release-after-${commit}`,
        justification: "Publish the repository's next release after the validated integration is merged.",
        ready: true,
        dependsOn: "merge_to_default_branch",
        extra() {
          return `After proving ${commit} is reachable from ${project.repository.defaultBranch}, derive the release version from repository metadata and release notes. Create the tag and GitHub release only when that version is not already published. Do not overwrite an existing tag or release.`;
        }
      });
    }
    return definitions;
  }

  function activeRoleForProject(roleJobs, projectId) {
    return Object.values(roleJobs || {}).some(job => job?.projectId === projectId && ACTIVE.has(job.status));
  }

  function terminalAction(jobs, projectId, action) {
    return Object.values(jobs || {}).find(job => job?.projectId === projectId && job.action === action && job.status === "completed") || null;
  }

  function selectActionCandidate(store, jobs, roleJobs) {
    const projects = Object.values(store.projects || {}).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    for (const project of projects) {
      if (activeRoleForProject(roleJobs, project.projectId)) continue;
      if (Object.values(jobs).some(job => job?.projectId === project.projectId && ACTIVE.has(job.status))) continue;
      for (const definition of actionDefinitions(store, project)) {
        if (!definition.ready) continue;
        if (definition.dependsOn && !terminalAction(jobs, project.projectId, definition.dependsOn)) continue;
        const id = actionId(project.projectId, definition.action, definition.target);
        const existing = jobs[id];
        if (existing?.status === "completed") continue;
        if (existing && existing.attempts >= MAX_ACTION_ATTEMPTS && TERMINAL.has(existing.status)) continue;
        if (existing?.retryAt && Date.parse(existing.retryAt) > Date.now()) continue;
        return { project, definition, actionId: id, existing };
      }
    }
    return null;
  }

  async function sendActionJob(tabId, message) {
    let lastError = null;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      try {
        const response = await chrome.tabs.sendMessage(tabId, message);
        if (response?.ok) return response;
        lastError = new Error(response?.error || "Action runner did not accept the job.");
      } catch (error) {
        lastError = error;
      }
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    throw new Error(`The repository action chat did not become ready: ${lastError?.message || "unknown error"}`);
  }

  async function dispatchAction(candidate, store, jobs) {
    const project = store.projects[candidate.project.projectId];
    const ensured = ensureApprovedRequest(
      store,
      project,
      candidate.definition.action,
      candidate.definition.target,
      candidate.definition.justification
    );
    store = ensured.store;
    await saveStore(store);
    const approval = ensured.approval;
    if (approval.status !== "approved") return false;

    const stored = await loadLocal([CATALOG_KEY, SETTINGS_KEY]);
    const catalog = Array.isArray(stored[CATALOG_KEY]) ? stored[CATALOG_KEY] : [];
    const chatId = project.roles?.integratorChatId;
    const chat = catalog.find(item => item?.id === chatId);
    if (!chat?.url) return false;

    const prompt = root.AutoPrompterProjectActionProtocol.buildPrompt({
      project,
      approval,
      actionId: candidate.actionId,
      extraInstructions: candidate.definition.extra()
    });
    const now = new Date().toISOString();
    const previousAttempts = Number(candidate.existing?.attempts || 0);
    jobs[candidate.actionId] = {
      actionId: candidate.actionId,
      projectId: project.projectId,
      approvalId: approval.approvalId,
      action: approval.action,
      target: approval.target,
      status: "opening",
      attempts: previousAttempts + 1,
      tabId: null,
      error: "",
      summary: "",
      evidence: null,
      createdAt: candidate.existing?.createdAt || now,
      updatedAt: now,
      retryAt: null
    };
    await saveActionJobs(jobs);

    let tab = null;
    try {
      tab = await chrome.tabs.create({ url: chat.url, active: false });
      jobs[candidate.actionId].tabId = tab.id;
      jobs[candidate.actionId].status = "dispatching";
      jobs[candidate.actionId].updatedAt = new Date().toISOString();
      await saveActionJobs(jobs);
      await sendActionJob(tab.id, {
        type: "RUN_PROJECT_ACTION_JOB",
        jobId: candidate.actionId,
        projectId: project.projectId,
        actionId: candidate.actionId,
        approvalId: approval.approvalId,
        action: approval.action,
        target: approval.target,
        role: "integrator",
        expectedConversationId: chatId,
        prompt,
        settings: {
          ...(stored[SETTINGS_KEY] || {}),
          delaySeconds: 0,
          continuityEnabled: false,
          checkpointBeforePrompt: false,
          checkpointAfterPrompt: false
        }
      });
      jobs[candidate.actionId].status = "running";
      jobs[candidate.actionId].updatedAt = new Date().toISOString();
      await saveActionJobs(jobs);
      return true;
    } catch (error) {
      jobs[candidate.actionId].status = "failed";
      jobs[candidate.actionId].error = error?.message || String(error);
      jobs[candidate.actionId].updatedAt = new Date().toISOString();
      jobs[candidate.actionId].retryAt = new Date(Date.now() + 5 * 60 * 1000 * jobs[candidate.actionId].attempts).toISOString();
      jobs[candidate.actionId].tabId = null;
      await saveActionJobs(jobs);
      if (Number.isInteger(tab?.id)) try { await chrome.tabs.remove(tab.id); } catch {}
      return false;
    }
  }

  async function reconcile() {
    let store = await loadStore();
    store = await advanceLocalLifecycle(store);
    await dispatchPreparedWorkers(store);
    const stored = await loadLocal(ROLE_JOBS_KEY);
    const roleJobs = stored?.[ROLE_JOBS_KEY] || {};
    const jobs = await loadActionJobs();
    const candidate = selectActionCandidate(store, jobs, roleJobs);
    if (candidate) await dispatchAction(candidate, store, jobs);
  }

  async function handleActionResult(message, sender) {
    const jobs = await loadActionJobs();
    const job = jobs[message.actionId || message.jobId];
    if (!job || (Number.isInteger(job.tabId) && job.tabId !== sender?.tab?.id)) throw new Error("Stale or mismatched repository action result.");
    const result = root.AutoPrompterProjectActionProtocol.validateResult(message.output, job);
    job.status = result.status;
    job.summary = result.summary;
    job.evidence = result.evidence;
    job.error = result.status === "failed" ? result.summary : "";
    job.updatedAt = new Date().toISOString();
    job.completedAt = result.completedAt;
    job.retryAt = result.status === "completed" || job.attempts >= MAX_ACTION_ATTEMPTS
      ? null
      : new Date(Date.now() + 5 * 60 * 1000 * job.attempts).toISOString();
    const tabId = job.tabId;
    job.tabId = null;
    jobs[job.actionId] = job;
    await saveActionJobs(jobs);
    if (Number.isInteger(tabId)) try { await chrome.tabs.remove(tabId); } catch {}
    schedule();
    return { ok: true, action: job };
  }

  async function handleActionError(message, sender) {
    const jobs = await loadActionJobs();
    const job = jobs[message.actionId || message.jobId];
    if (!job || (Number.isInteger(job.tabId) && job.tabId !== sender?.tab?.id)) throw new Error("Stale or mismatched repository action error.");
    const tabId = job.tabId;
    job.status = "failed";
    job.error = String(message.error || "Repository action failed.").slice(0, 2000);
    job.updatedAt = new Date().toISOString();
    job.retryAt = job.attempts >= MAX_ACTION_ATTEMPTS ? null : new Date(Date.now() + 5 * 60 * 1000 * job.attempts).toISOString();
    job.tabId = null;
    jobs[job.actionId] = job;
    await saveActionJobs(jobs);
    if (Number.isInteger(tabId)) try { await chrome.tabs.remove(tabId); } catch {}
    schedule();
    return { ok: true, action: job };
  }

  function start() {
    if (started || typeof chrome === "undefined") return;
    started = true;
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      if (changes[root.AutoPrompterProjectStore.PROJECTS_KEY] || changes[CATALOG_KEY] || changes[ROLE_JOBS_KEY] || changes[ACTION_JOBS_KEY]) schedule();
    });
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      if (message?.type === "PROJECT_ACTION_RESULT") {
        enqueue(() => handleActionResult(message, sender)).then(sendResponse).catch(error => sendResponse({ ok: false, error: error.message }));
        return true;
      }
      if (message?.type === "PROJECT_ACTION_ERROR") {
        enqueue(() => handleActionError(message, sender)).then(sendResponse).catch(error => sendResponse({ ok: false, error: error.message }));
        return true;
      }
      if (message?.scope === MESSAGE_SCOPE && message?.type === "GET_PROJECT_AUTOMATION") {
        Promise.all([loadActionJobs(), loadStore()]).then(([actions, store]) => sendResponse({ ok: true, actions, projects: store.projects })).catch(error => sendResponse({ ok: false, error: error.message }));
        return true;
      }
      if (message?.scope === MESSAGE_SCOPE && message?.type === "RETRY_PROJECT_AUTOMATION") {
        enqueue(async () => {
          const jobs = await loadActionJobs();
          for (const job of Object.values(jobs)) {
            if (job.projectId === message.projectId && ["failed", "blocked"].includes(job.status)) {
              job.retryAt = null;
              job.attempts = Math.min(job.attempts, MAX_ACTION_ATTEMPTS - 1);
            }
          }
          await saveActionJobs(jobs);
          schedule(0);
          return { ok: true };
        }).then(sendResponse).catch(error => sendResponse({ ok: false, error: error.message }));
        return true;
      }
      return false;
    });
    schedule(0);
  }

  return {
    ACTION_JOBS_KEY,
    actionId,
    actionDefinitions,
    selectActionCandidate,
    advanceLocalLifecycle,
    start
  };
});
