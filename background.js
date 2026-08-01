"use strict";

if (typeof importScripts === "function") importScripts("planner-protocol.js", "worker-protocol.js", "result-protocol.js", "reviewer-protocol.js", "integration-protocol.js", "approval-protocol.js", "reconciliation-protocol.js", "project-store.js");
const PlannerProtocol = globalThis.AutoPrompterPlannerProtocol || (typeof require === "function" ? require("./planner-protocol.js") : null);
const WorkerProtocol = globalThis.AutoPrompterWorkerProtocol || (typeof require === "function" ? require("./worker-protocol.js") : null);
const ResultProtocol = globalThis.AutoPrompterResultProtocol || (typeof require === "function" ? require("./result-protocol.js") : null);
const ReviewerProtocol = globalThis.AutoPrompterReviewerProtocol || (typeof require === "function" ? require("./reviewer-protocol.js") : null);
const IntegrationProtocol = globalThis.AutoPrompterIntegrationProtocol || (typeof require === "function" ? require("./integration-protocol.js") : null);
const ApprovalProtocol = globalThis.AutoPrompterApprovalProtocol || (typeof require === "function" ? require("./approval-protocol.js") : null);
const ReconciliationProtocol = globalThis.AutoPrompterReconciliationProtocol || (typeof require === "function" ? require("./reconciliation-protocol.js") : null);
const ProjectStore = globalThis.AutoPrompterProjectStore || (typeof require === "function" ? require("./project-store.js") : null);

const MESSAGE_SCOPE = "AUTOPROMPTER_RUNTIME";
const SESSION_KEY = "autoprompterScheduler";
const SETTINGS_KEY = "autoprompterSettings";
const CATALOG_KEY = "autoprompterChatCatalog";
const SELECTION_KEY = "autoprompterSelectedChatIds";
const CHAT_CONFIGS_KEY = "autoprompterChatConfigs";
const PROJECT_BOOTSTRAP_KEY = "autoprompterProjectBootstraps";
const MAX_PROJECT_BOOTSTRAP_REPAIRS = 3;
const MAX_ROLE_INIT_RETRIES = 2;
const NEW_CHAT_URL = "https://chatgpt.com/";
const CONNECTION_RETRY_PROMPT = "Continue from where the response was interrupted. Do not repeat completed material.";
const MAX_CONNECTION_RETRIES = 3;
const MAX_CONCURRENT_CHATS = 12;
const INITIAL_BATCH_GRACE_MS = 5000;
const NOTIFICATION_ICON_DATA_URL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAABPUlEQVR4nO2ZMQ7CQAwEF0QPL4UO3kDJT/kBVCehFChxfDeWbqfPaT34HKMczvfrRxNzpAPQWAAdgMYC6AA0FkAHoLEAOgCNBdABaCyADkBzyjjk/XxlHBPi8rjtev6w5+8wWfiSqIjwFahUvBTPExJQrfhGJNf0Q3CzgKq/fmNrPncAHYDGAugANCmb4JK929k/sodwegf0LL7H+dNfAQvIPrD3opR9fpchWH1b/MVXgA5AM72AsovQqDlSdhHqvVA1pr8CFpB9YNbdHTUDvAjRAWgsYOsDo15PUbbmcwdEHqraBZFc4Q6oJiGaZ9fX4ca0n8fXsFYO1VElhiB5nXAB9CxBBdDFS6CACsVLkIAqxUuAgErFS4MFVCteGiigYvHSIAFVi5cGbILVwRchGgugA9BYAB2AxgLoADRfdOpG+jsXCCIAAAAASUVORK5CYII=";

const DEFAULTS = Object.freeze({
  prompt: "Continue from where you left off. Do not repeat completed material.",
  delaySeconds: 10,
  maxContinuations: 5,
  notificationsEnabled: true,
  notifyOnPromptDone: true,
  circuitBreakerEnabled: true,
  continuityEnabled: false,
  repository: "",
  handoffFile: "AUTOPROMPTER_HANDOFF.md",
  pluginInstruction: "Use an action-capable repository plugin or Codex. The read-only GitHub app is not sufficient for commits.",
  contextCapacityTokens: 128000,
  contextThresholdPercent: 90,
  stallMinutes: 15,
  checkpointBeforePrompt: true,
  checkpointAfterPrompt: true,
  maxRollovers: 3
});

let operationQueue = Promise.resolve();
let projectStoreStartupChecked = false;
const initialBatchTimers = new Map();

function enqueue(operation) {
  operationQueue = operationQueue.catch(() => {}).then(operation);
  return operationQueue;
}

function clampNumber(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function normalizeRepository(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  let candidate = raw;
  try {
    if (/^https?:\/\//i.test(raw)) {
      const url = new URL(raw);
      if (url.hostname !== "github.com" && url.hostname !== "www.github.com") return "";
      candidate = url.pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
    }
  } catch {
    return "";
  }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(candidate)) return "";
  return candidate;
}

function normalizeHandoffFile(value) {
  const file = String(value || DEFAULTS.handoffFile).trim().replace(/^\/+/, "");
  if (!file || file.includes("..") || !/^[A-Za-z0-9_./-]+$/.test(file)) return DEFAULTS.handoffFile;
  return file.slice(0, 200);
}

function normalizeSettings(settings = {}) {
  const repository = normalizeRepository(settings.repository);
  return {
    prompt: typeof settings.prompt === "string" && settings.prompt.trim()
      ? settings.prompt.trim().slice(0, 12000)
      : DEFAULTS.prompt,
    delaySeconds: clampNumber(settings.delaySeconds, DEFAULTS.delaySeconds, 5, 120),
    maxContinuations: Math.round(
      clampNumber(settings.maxContinuations, DEFAULTS.maxContinuations, 1, 50)
    ),
    notificationsEnabled: settings.notificationsEnabled !== false,
    notifyOnPromptDone: settings.notifyOnPromptDone !== false,
    circuitBreakerEnabled: settings.circuitBreakerEnabled !== false,
    continuityEnabled: Boolean(settings.continuityEnabled && repository),
    repository,
    handoffFile: normalizeHandoffFile(settings.handoffFile),
    pluginInstruction: String(settings.pluginInstruction || DEFAULTS.pluginInstruction).trim().slice(0, 1000),
    contextCapacityTokens: Math.round(clampNumber(
      settings.contextCapacityTokens,
      DEFAULTS.contextCapacityTokens,
      16000,
      1000000
    )),
    contextThresholdPercent: clampNumber(
      settings.contextThresholdPercent,
      DEFAULTS.contextThresholdPercent,
      50,
      98
    ),
    stallMinutes: clampNumber(settings.stallMinutes, DEFAULTS.stallMinutes, 5, 180),
    checkpointBeforePrompt: settings.checkpointBeforePrompt !== false,
    checkpointAfterPrompt: settings.checkpointAfterPrompt !== false,
    maxRollovers: Math.round(clampNumber(settings.maxRollovers, DEFAULTS.maxRollovers, 1, 10))
  };
}

function normalizeConversationUrl(value) {
  try {
    const url = new URL(value);
    if (url.hostname !== "chatgpt.com" && url.hostname !== "chat.openai.com") return null;
    const match = url.pathname.match(/(?:^|\/)c\/([^/?#]+)/);
    if (!match) return null;
    return {
      id: decodeURIComponent(match[1]),
      url: `https://chatgpt.com/c/${encodeURIComponent(decodeURIComponent(match[1]))}`
    };
  } catch {
    return null;
  }
}

function freshChatUrl(token = "", chainId = "", jobId = "") {
  const url = new URL(NEW_CHAT_URL);
  url.searchParams.set("autoprompter_fresh", [token, chainId, jobId, Date.now()].filter(Boolean).join(":"));
  return url.href;
}

function isNewChatUrl(value) {
  try {
    const url = new URL(value);
    if (url.hostname !== "chatgpt.com" && url.hostname !== "chat.openai.com") return false;
    return !/(?:^|\/)c\/[^/?#]+/.test(url.pathname);
  } catch {
    return false;
  }
}

function normalizeChat(chat, baseSettings = DEFAULTS) {
  const normalized = normalizeConversationUrl(chat?.url || "");
  if (!normalized) return null;
  const suppliedId = String(chat?.id || normalized.id);
  if (suppliedId !== normalized.id) return null;
  return {
    id: normalized.id,
    title: String(chat?.title || "Untitled chat").trim().slice(0, 160) || "Untitled chat",
    url: normalized.url,
    sentCount: 0,
    status: "Queued",
    lastError: "",
    failed: false,
    retired: false,
    chainId: normalized.id,
    generation: 0,
    rolloverCount: 0,
    lastCheckpoint: "",
    contextEstimateTokens: 0,
    contextPercent: 0,
    workerTabId: null,
    currentJobId: null,
    pendingSuccessor: null,
    contentReady: false,
    jobDispatched: false,
    initialJobPending: false,
    startInNewChat: Boolean(chat?.startInNewChat),
    retryPrompt: "",
    connectionRetryCount: 0,
    settings: normalizeSettings({ ...baseSettings, ...(chat?.settings || {}) })
  };
}

function nextEligibleIndex(chats, currentIndex, maxContinuations) {
  if (!Array.isArray(chats) || chats.length === 0) return -1;
  for (let offset = 1; offset <= chats.length; offset += 1) {
    const index = (currentIndex + offset + chats.length) % chats.length;
    const chat = chats[index];
    const limit = Number(chat.settings?.maxContinuations || maxContinuations);
    if (!chat.failed && !chat.retired && Number(chat.sentCount || 0) < limit) return index;
  }
  return -1;
}

function buildSuccessorPrompt(settings, chat, checkpoint, reason) {
  const reasonText = String(reason || "the previous chat reached a continuity boundary").slice(0, 500);
  return [
    "Continue the same project goal from the previous chat.",
    `Repository: ${settings.repository}`,
    `Continuity file: ${settings.handoffFile}`,
    checkpoint ? `Last verified checkpoint: ${checkpoint}` : "Last verified checkpoint: not supplied",
    `Reason for rollover: ${reasonText}`,
    "",
    settings.pluginInstruction,
    "Read the repository and continuity file before taking action. Treat committed repository state as the source of truth.",
    "Verify the active branch, latest commit, completed work, remaining work, blockers, and next safe task.",
    "Do not reconstruct missing work from guesses and do not repeat completed tasks.",
    "Continue with the next unfinished task, then update the continuity file and commit completed work before finishing."
  ].filter(Boolean).join("\n");
}

function buildFreshStartPrompt(settings, chat, reason) {
  const repository = String(settings?.repository || "").trim();
  const handoffFile = String(settings?.handoffFile || DEFAULTS.handoffFile).trim();
  const workPrompt = String(settings?.prompt || DEFAULTS.prompt).trim();
  const reasonText = String(reason || "the previous conversation cannot safely continue").slice(0, 500);
  return [
    "Start a new conversation for a goal that was previously worked on in another ChatGPT chat.",
    `Previous chat title: ${chat?.title || "Untitled chat"}`,
    `Reason for starting fresh: ${reasonText}`,
    "You cannot access the previous chat transcript. Do not claim that you can, and do not invent missing prior decisions.",
    repository ? `Repository: ${repository}` : "Repository: not configured",
    repository ? `Continuity file: ${handoffFile}` : "Continuity file: not available",
    repository ? String(settings?.pluginInstruction || DEFAULTS.pluginInstruction).trim() : "",
    repository
      ? "Inspect the repository first. If the continuity file exists, use it. If it is missing, reconstruct only what the repository proves, create the continuity file, and commit it before continuing."
      : "No verified repository handoff is available. Use only the explicit work instruction below and ask for any essential missing facts instead of guessing.",
    "",
    "Work instruction:",
    workPrompt
  ].filter(Boolean).join("\n");
}

function chatLimit(state, chat) {
  return Number(chat?.settings?.maxContinuations || state?.settings?.maxContinuations || DEFAULTS.maxContinuations);
}

function isChatEligible(state, chat) {
  return Boolean(chat && !chat.failed && !chat.retired && Number(chat.sentCount || 0) < chatLimit(state, chat));
}

function eligibleChatIndexes(chats, maxContinuations = DEFAULTS.maxContinuations) {
  const state = { settings: { maxContinuations } };
  return (Array.isArray(chats) ? chats : [])
    .map((chat, index) => isChatEligible(state, chat) ? index : -1)
    .filter(index => index >= 0);
}

function findChatIndexByTab(state, tabId) {
  if (!Number.isInteger(tabId)) return -1;
  return state?.chats?.findIndex(chat => chat.workerTabId === tabId) ?? -1;
}

function findChatIndexForMessage(state, message, sender) {
  if (!state?.running || message?.token !== state.token) return -1;
  const index = findChatIndexByTab(state, sender?.tab?.id);
  if (index < 0) return -1;
  return state.chats[index].currentJobId === message.jobId ? index : -1;
}

function updateOverallStatus(state, recent = "") {
  const active = state.chats.filter(chat => Number.isInteger(chat.workerTabId) && chat.currentJobId).length;
  const finished = state.chats.filter(chat => !isChatEligible(state, chat)).length;
  const total = state.chats.length;
  state.status = recent || `Running ${active} chat${active === 1 ? "" : "s"} concurrently · ${finished}/${total} complete`;
}

function publicState(state) {
  const version = chrome.runtime.getManifest().version;
  if (!state) return {
    running: false,
    status: "Stopped",
    chats: [],
    workerTabIds: [],
    settings: { ...DEFAULTS },
    handoffHistory: [],
    version
  };

  return {
    running: Boolean(state.running),
    status: state.status || "Stopped",
    lastError: state.lastError || "",
    pausedReason: state.pausedReason || "",
    workerTabIds: (state.chats || []).map(chat => chat.workerTabId).filter(Number.isInteger),
    chats: Array.isArray(state.chats) ? state.chats : [],
    settings: normalizeSettings(state.settings),
    mode: state.mode || "work",
    startedAt: state.startedAt || null,
    handoffHistory: Array.isArray(state.handoffHistory) ? state.handoffHistory : [],
    version
  };
}

async function loadState() {
  const stored = await chrome.storage.session.get(SESSION_KEY);
  return stored?.[SESSION_KEY] || null;
}

async function saveState(state) {
  await chrome.storage.session.set({
    [SESSION_KEY]: { ...state, savedAt: Date.now() }
  });
}

async function loadProjectStore() {
  if (!ProjectStore) throw new Error("Project Mode store is unavailable.");
  const stored = await chrome.storage.local.get(ProjectStore.PROJECTS_KEY);
  const migrated = ProjectStore.migrateStore(stored?.[ProjectStore.PROJECTS_KEY]);
  const recovered = ProjectStore.recoverAllProjectLeases(migrated.store);
  let store = recovered.store;
  let changed = migrated.migrated || recovered.changed;
  if (!projectStoreStartupChecked) {
    projectStoreStartupChecked = true;
    for (const [projectId, project] of Object.entries(store.projects || {})) {
      const hasDurableArtifacts = Object.keys(store.resultsByProject?.[projectId] || {}).length
        || Object.values(store.tasksByProject?.[projectId] || {}).some(task => task.status === "accepted")
        || Boolean(store.integrationsByProject?.[projectId]);
      if (project.status === "running" && hasDurableArtifacts
          && (!project.lastReconciledAt || Date.parse(project.updatedAt) > Date.parse(project.lastReconciledAt))) {
        const marked = ProjectStore.markRepositoryReconciliationRequired(store, projectId, "Extension runtime restarted with durable task or integration artifacts");
        store = marked.store;
        changed = true;
      }
    }
  }
  if (changed) await saveProjectStore(store);
  return store;
}

async function saveProjectStore(store) {
  await chrome.storage.local.set({ [ProjectStore.PROJECTS_KEY]: store });
}

async function listProjectState() {
  const store = await loadProjectStore();
  return {
    projectStoreVersion: store.schemaVersion,
    activeProjectId: store.activeProjectId,
    projects: ProjectStore.listProjects(store)
  };
}

async function loadProjectBootstraps() {
  const stored = await chrome.storage.local.get(PROJECT_BOOTSTRAP_KEY);
  const value = stored?.[PROJECT_BOOTSTRAP_KEY];
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

async function saveProjectBootstraps(bootstraps) {
  await chrome.storage.local.set({ [PROJECT_BOOTSTRAP_KEY]: bootstraps });
}

function publicProjectBootstrap(bootstrap) {
  if (!bootstrap) return null;
  return {
    projectId: bootstrap.projectId,
    status: bootstrap.status,
    error: bootstrap.error || "",
    repairAttempts: Number(bootstrap.repairAttempts || 0),
    maxRepairAttempts: MAX_PROJECT_BOOTSTRAP_REPAIRS,
    planValidated: Boolean(bootstrap.planValidated),
    planApproved: Boolean(bootstrap.planApproved),
    planSummary: bootstrap.planSummary || null,
    assignmentCount: Number(bootstrap.assignmentCount || 0),
    createdAt: bootstrap.createdAt,
    updatedAt: bootstrap.updatedAt,
    roles: Object.fromEntries(Object.entries(bootstrap.roles || {}).map(([role, state]) => [role, {
      chatId: state.chatId || null,
      stage: state.stage,
      status: state.status || "",
      error: state.error || "",
      retries: Number(state.retries || 0)
    }]))
  };
}

function buildProjectRolePrompt(project, role) {
  const responsibilities = {
    planner: "Create bounded, machine-readable project plans. Do not implement tasks or invent repository state.",
    reviewer: "Independently evaluate worker evidence against task acceptance criteria. Do not accept unsupported claims.",
    integrator: "Integrate only independently accepted task results, report conflicts, and never merge or publish without explicit approval."
  };
  return [
    `You are the dedicated ${role} agent for AutoPrompter Project Mode.`,
    `Project: ${project.title} (${project.projectId})`,
    `Repository: ${project.repository.slug}`,
    responsibilities[role],
    "All inference remains in ChatGPT Web. Follow platform restrictions and do not rotate accounts, models, chats, or endpoints to evade limits.",
    "Use repository evidence and structured AutoPrompter envelopes when later prompts request them.",
    "Acknowledge initialization with exactly this single line and no other text:",
    `AUTOPROMPTER_ROLE_READY: ${role}`
  ].join("\n");
}

function buildPlannerRepairPrompt(error, attempt) {
  return [
    `Your previous AutoPrompter planner envelope failed validation on repair attempt ${attempt}.`,
    `Validation error: ${String(error || "Unknown planner validation error").slice(0, 2000)}`,
    "Correct your immediately previous plan. Return the complete corrected AUTOPROMPTER_PLAN_BEGIN / AUTOPROMPTER_PLAN_END envelope again.",
    "The content between the markers must be strict JSON parseable by JSON.parse: double-quoted keys and strings, escaped newlines, no comments, no trailing commas, and no Markdown fences.",
    "Preserve the required project ID and revision. Do not add prose outside the envelope."
  ].join("\n");
}

function findProjectBootstrapByTab(bootstraps, tabId) {
  if (!Number.isInteger(tabId)) return null;
  for (const [projectId, bootstrap] of Object.entries(bootstraps || {})) {
    for (const [role, state] of Object.entries(bootstrap.roles || {})) {
      if (state?.tabId === tabId && !["completed", "failed"].includes(state.stage)) {
        return { projectId, role, bootstrap, state };
      }
    }
  }
  return null;
}

async function saveBootstrapConversationToCatalog(project, role, conversation) {
  if (!conversation?.id || !conversation?.url) return;
  const stored = await chrome.storage.local.get(CATALOG_KEY);
  const catalog = Array.isArray(stored[CATALOG_KEY]) ? stored[CATALOG_KEY] : [];
  const item = {
    id: conversation.id,
    url: conversation.url,
    title: `${project.title} · ${role[0].toUpperCase()}${role.slice(1)}`
  };
  await chrome.storage.local.set({
    [CATALOG_KEY]: [item, ...catalog.filter(chat => chat.id !== item.id)].slice(0, 500)
  });
}

async function dispatchProjectBootstrapJob(projectId, role) {
  const bootstraps = await loadProjectBootstraps();
  const bootstrap = bootstraps[projectId];
  const state = bootstrap?.roles?.[role];
  if (!bootstrap || !state || !Number.isInteger(state.tabId) || state.jobDispatched || ["completed", "failed"].includes(state.stage)) {
    return false;
  }
  state.jobDispatched = true;
  state.status = `Submitting ${state.stage.replace(/_/g, " ")}`;
  state.jobId = `${projectId}:${role}:${state.stage}:${Date.now()}`;
  bootstrap.updatedAt = new Date().toISOString();
  await saveProjectBootstraps(bootstraps);
  const stored = await chrome.storage.local.get(SETTINGS_KEY);
  const settings = normalizeSettings({
    ...(stored[SETTINGS_KEY] || {}),
    continuityEnabled: false,
    delaySeconds: 5,
    checkpointBeforePrompt: false,
    checkpointAfterPrompt: false
  });
  try {
    await chrome.tabs.sendMessage(state.tabId, {
      type: "RUN_PROJECT_BOOTSTRAP_JOB",
      jobId: state.jobId,
      projectId,
      role,
      stage: state.stage,
      prompt: state.prompt,
      expectedConversationId: state.chatId || null,
      freshRequestId: state.freshRequestId,
      settings
    });
    return true;
  } catch (error) {
    state.jobDispatched = false;
    state.status = "Waiting for page readiness";
    state.error = error?.message || String(error);
    bootstrap.updatedAt = new Date().toISOString();
    await saveProjectBootstraps(bootstraps);
    return false;
  }
}

function scheduleProjectBootstrapDispatch(projectId, role, delay = 300) {
  setTimeout(() => enqueue(() => dispatchProjectBootstrapJob(projectId, role)).catch(() => {}), delay);
}

async function startProjectBootstrapState(projectId) {
  const scheduler = await loadState();
  if (scheduler?.running) throw new Error("Stop the normal AutoPrompter scheduler before creating Project Mode role chats.");
  let store = await loadProjectStore();
  const project = store.projects[projectId];
  if (!project) throw new Error("Project not found.");
  if (store.approvedPlansByProject[projectId] || Object.keys(store.tasksByProject[projectId] || {}).length) {
    throw new Error("This project already has an approved plan or task records.");
  }
  const bootstraps = await loadProjectBootstraps();
  const existing = bootstraps[projectId];
  if (existing && ["starting", "running"].includes(existing.status)) {
    return { bootstrap: publicProjectBootstrap(existing), project };
  }

  const stored = await chrome.storage.local.get(CATALOG_KEY);
  const catalog = Array.isArray(stored[CATALOG_KEY]) ? stored[CATALOG_KEY] : [];
  const byId = new Map(catalog.map(chat => [chat.id, chat]));
  const roleKeys = { planner: "plannerChatId", reviewer: "reviewerChatId", integrator: "integratorChatId" };
  const roleNames = Object.keys(roleKeys);
  const tabs = await Promise.all(roleNames.map(() => chrome.tabs.create({ url: "about:blank", active: false })));
  const createdAt = new Date().toISOString();
  const roles = {};
  try {
    for (let index = 0; index < roleNames.length; index += 1) {
      const role = roleNames[index];
      const chatId = project.roles[roleKeys[role]] || null;
      const catalogChat = chatId ? byId.get(chatId) : null;
      if (chatId && !catalogChat?.url) {
        throw new Error(`${role} chat ${chatId} is missing from the local catalog. Refresh the ChatGPT sidebar or choose Create automatically.`);
      }
      roles[role] = {
        role,
        chatId,
        tabId: tabs[index].id,
        stage: "role_init",
        status: "Opening role chat",
        error: "",
        retries: 0,
        jobDispatched: false,
        jobId: null,
        prompt: buildProjectRolePrompt(project, role),
        freshRequestId: `${projectId}:${role}:${Date.now()}:${index}`
      };
    }
  } catch (error) {
    await removeManagedTabs(tabs.map(tab => tab.id));
    throw error;
  }

  const bootstrap = {
    projectId,
    status: "starting",
    error: "",
    repairAttempts: 0,
    planValidated: false,
    planApproved: false,
    createdAt,
    updatedAt: createdAt,
    roles
  };
  bootstraps[projectId] = bootstrap;
  project.status = "planning";
  project.updatedAt = createdAt;
  await saveProjectStore(store);
  await saveProjectBootstraps(bootstraps);

  try {
    await Promise.all(roleNames.map(async role => {
      const state = roles[role];
      const target = state.chatId
        ? byId.get(state.chatId).url
        : freshChatUrl(state.freshRequestId, projectId, role);
      await chrome.tabs.update(state.tabId, { url: target, active: false });
    }));
  } catch (error) {
    return failProjectBootstrap(projectId, "planner", `Could not open Project Mode role chats: ${error?.message || String(error)}`);
  }
  bootstrap.status = "running";
  bootstrap.updatedAt = new Date().toISOString();
  await saveProjectBootstraps(bootstraps);
  return { project, bootstrap: publicProjectBootstrap(bootstrap) };
}

async function getProjectBootstrapState(projectId) {
  const bootstraps = await loadProjectBootstraps();
  return { bootstrap: publicProjectBootstrap(bootstraps[projectId]) };
}

async function updateProjectBootstrapStatus(message, sender) {
  const bootstraps = await loadProjectBootstraps();
  const bootstrap = bootstraps[message.projectId];
  const state = bootstrap?.roles?.[message.role];
  if (!bootstrap || !state || state.tabId !== sender?.tab?.id || state.jobId !== message.jobId || state.stage !== message.stage) {
    return { bootstrap: publicProjectBootstrap(bootstrap) };
  }
  state.status = String(message.status || "Working").slice(0, 300);
  bootstrap.updatedAt = new Date().toISOString();
  await saveProjectBootstraps(bootstraps);
  return { bootstrap: publicProjectBootstrap(bootstrap) };
}


async function failProjectBootstrap(projectId, role, error) {
  const bootstraps = await loadProjectBootstraps();
  const bootstrap = bootstraps[projectId];
  if (!bootstrap) return { bootstrap: null };
  bootstrap.status = "failed";
  bootstrap.error = String(error || "Project bootstrap failed.").slice(0, 2000);
  bootstrap.updatedAt = new Date().toISOString();
  if (bootstrap.roles?.[role]) {
    bootstrap.roles[role].stage = "failed";
    bootstrap.roles[role].status = "Failed";
    bootstrap.roles[role].error = bootstrap.error;
  }
  const tabIds = Object.values(bootstrap.roles || {}).map(state => state.tabId).filter(Number.isInteger);
  for (const state of Object.values(bootstrap.roles || {})) state.tabId = null;
  await saveProjectBootstraps(bootstraps);
  const store = await loadProjectStore();
  if (store.projects[projectId] && !store.approvedPlansByProject[projectId]) {
    delete store.pendingPlansByProject[projectId];
    store.projects[projectId].status = "draft";
    store.projects[projectId].updatedAt = new Date().toISOString();
    await saveProjectStore(store);
  }
  await removeManagedTabs(tabIds);
  return { bootstrap: publicProjectBootstrap(bootstrap) };
}

async function maybeCompleteProjectBootstrap(projectId, bootstraps) {
  const bootstrap = bootstraps[projectId];
  if (!bootstrap?.planApproved || !Object.values(bootstrap.roles || {}).every(state => state.stage === "completed")) {
    return false;
  }
  bootstrap.status = "completed";
  bootstrap.updatedAt = new Date().toISOString();
  const tabIds = Object.values(bootstrap.roles).map(state => state.tabId).filter(Number.isInteger);
  for (const state of Object.values(bootstrap.roles)) state.tabId = null;
  await saveProjectBootstraps(bootstraps);
  await removeManagedTabs(tabIds);
  return true;
}

async function maybeApproveProjectBootstrapPlan(projectId, bootstraps) {
  const bootstrap = bootstraps[projectId];
  if (!bootstrap?.planValidated || bootstrap.planApproved) return false;
  const supportingRolesReady = ["reviewer", "integrator"].every(role => bootstrap.roles?.[role]?.stage === "completed");
  if (!supportingRolesReady) return false;
  const store = await loadProjectStore();
  const approved = ProjectStore.approveProjectPlan(store, projectId);
  let finalStore = approved.store;
  let assignments = [];
  if (approved.project.roles.workerChatIds.length) {
    const started = ProjectStore.startProject(finalStore, projectId);
    const prepared = ProjectStore.prepareProjectDispatches(started.store, projectId);
    finalStore = prepared.store;
    assignments = prepared.assignments;
  }
  await saveProjectStore(finalStore);
  bootstrap.planApproved = true;
  bootstrap.planSummary = approved.summary;
  bootstrap.assignmentCount = assignments.length;
  bootstrap.roles.planner.stage = "completed";
  bootstrap.roles.planner.status = assignments.length
    ? `Plan approved; ${assignments.length} worker assignment${assignments.length === 1 ? "" : "s"} prepared`
    : `Plan revision ${approved.summary.revision} approved`;
  bootstrap.roles.planner.error = "";
  bootstrap.roles.planner.jobDispatched = false;
  bootstrap.updatedAt = new Date().toISOString();
  await saveProjectBootstraps(bootstraps);
  await maybeCompleteProjectBootstrap(projectId, bootstraps);
  return true;
}

async function handleProjectBootstrapResult(message, sender) {
  const bootstraps = await loadProjectBootstraps();
  const bootstrap = bootstraps[message.projectId];
  const roleState = bootstrap?.roles?.[message.role];
  if (!bootstrap || !roleState || roleState.tabId !== sender?.tab?.id || roleState.jobId !== message.jobId || roleState.stage !== message.stage) {
    throw new Error("Stale or mismatched Project Mode bootstrap result.");
  }
  const conversation = message.conversation;
  if (!conversation?.id || !conversation?.url) {
    return failProjectBootstrap(message.projectId, message.role, "ChatGPT did not expose a verified conversation ID for the role chat.");
  }
  let store = await loadProjectStore();
  const project = store.projects[message.projectId];
  if (!project) return failProjectBootstrap(message.projectId, message.role, "Project not found while recording bootstrap output.");

  if (message.stage === "role_init") {
    const marker = `AUTOPROMPTER_ROLE_READY: ${message.role}`;
    const hasMarker = String(message.output || "")
      .split(/\r?\n/)
      .some(line => line.trim().toLowerCase() === marker.toLowerCase());
    if (!hasMarker) {
      if (roleState.retries < MAX_ROLE_INIT_RETRIES) {
        roleState.retries += 1;
        roleState.jobDispatched = false;
        roleState.status = `Retrying role initialization (${roleState.retries}/${MAX_ROLE_INIT_RETRIES})`;
        roleState.prompt = `${buildProjectRolePrompt(project, message.role)}\nYour previous response did not contain the exact acknowledgement. Return only the required line.`;
        bootstrap.updatedAt = new Date().toISOString();
        await saveProjectBootstraps(bootstraps);
        scheduleProjectBootstrapDispatch(message.projectId, message.role);
        return { bootstrap: publicProjectBootstrap(bootstrap), retrying: true };
      }
      return failProjectBootstrap(message.projectId, message.role, `The ${message.role} chat did not return its required role-ready marker.`);
    }
    const bound = ProjectStore.bindProjectRoleChat(store, message.projectId, message.role, conversation.id);
    store = bound.store;
    await saveProjectStore(store);
    await saveBootstrapConversationToCatalog(bound.project, message.role, conversation);
    roleState.chatId = conversation.id;
    roleState.error = "";
    roleState.jobDispatched = false;
    if (message.role === "planner") {
      const planned = ProjectStore.buildProjectPlannerPrompt(store, message.projectId);
      roleState.stage = "planner_plan";
      roleState.status = "Preparing planner prompt";
      roleState.prompt = planned.prompt;
      bootstrap.updatedAt = new Date().toISOString();
      await saveProjectBootstraps(bootstraps);
      scheduleProjectBootstrapDispatch(message.projectId, message.role);
    } else {
      roleState.stage = "completed";
      roleState.status = "Role initialized";
      const tabId = roleState.tabId;
      roleState.tabId = null;
      bootstrap.updatedAt = new Date().toISOString();
      await saveProjectBootstraps(bootstraps);
      await removeManagedTab(tabId);
      await maybeApproveProjectBootstrapPlan(message.projectId, bootstraps);
      await maybeCompleteProjectBootstrap(message.projectId, bootstraps);
    }
    return { bootstrap: publicProjectBootstrap(bootstrap), roleChatId: conversation.id };
  }

  if (["planner_plan", "planner_repair"].includes(message.stage)) {
    try {
      const submitted = ProjectStore.submitProjectPlannerOutput(store, message.projectId, message.output);
      await saveProjectStore(submitted.store);
      roleState.stage = "planner_validated";
      roleState.status = `Plan revision ${submitted.summary.revision} validated; waiting for role initialization`;
      roleState.error = "";
      roleState.jobDispatched = false;
      bootstrap.planValidated = true;
      bootstrap.planSummary = submitted.summary;
      bootstrap.updatedAt = new Date().toISOString();
      await saveProjectBootstraps(bootstraps);
      const approved = await maybeApproveProjectBootstrapPlan(message.projectId, bootstraps);
      return { bootstrap: publicProjectBootstrap(bootstrap), planSummary: submitted.summary, approved };
    } catch (error) {
      if (bootstrap.repairAttempts < MAX_PROJECT_BOOTSTRAP_REPAIRS) {
        bootstrap.repairAttempts += 1;
        roleState.stage = "planner_repair";
        roleState.status = `Repairing planner JSON (${bootstrap.repairAttempts}/${MAX_PROJECT_BOOTSTRAP_REPAIRS})`;
        roleState.error = error?.message || String(error);
        roleState.prompt = buildPlannerRepairPrompt(roleState.error, bootstrap.repairAttempts);
        roleState.jobDispatched = false;
        bootstrap.updatedAt = new Date().toISOString();
        await saveProjectBootstraps(bootstraps);
        scheduleProjectBootstrapDispatch(message.projectId, message.role);
        return { bootstrap: publicProjectBootstrap(bootstrap), retrying: true, error: roleState.error };
      }
      return failProjectBootstrap(
        message.projectId,
        message.role,
        `Planner validation failed after ${MAX_PROJECT_BOOTSTRAP_REPAIRS} repairs: ${error?.message || String(error)}`
      );
    }
  }
  throw new Error(`Unsupported Project Mode bootstrap stage: ${message.stage}`);
}

async function handleProjectBootstrapError(message, sender) {
  const bootstraps = await loadProjectBootstraps();
  const bootstrap = bootstraps[message.projectId];
  const roleState = bootstrap?.roles?.[message.role];
  if (!bootstrap || !roleState || roleState.tabId !== sender?.tab?.id || roleState.jobId !== message.jobId) {
    return { bootstrap: publicProjectBootstrap(bootstrap) };
  }
  if (["connection_interrupted", "extended_thinking_retry"].includes(message.kind) && roleState.retries < 3) {
    roleState.retries += 1;
    roleState.jobDispatched = false;
    roleState.status = `Retrying interrupted bootstrap (${roleState.retries}/3)`;
    roleState.prompt = message.stage === "role_init"
      ? roleState.prompt
      : "Continue from where the response was interrupted. Return the complete required AutoPrompter envelope again with no prose outside it.";
    bootstrap.updatedAt = new Date().toISOString();
    await saveProjectBootstraps(bootstraps);
    scheduleProjectBootstrapDispatch(message.projectId, message.role);
    return { bootstrap: publicProjectBootstrap(bootstrap), retrying: true };
  }
  return failProjectBootstrap(message.projectId, message.role, message.error || message.kind || "Project bootstrap failed.");
}

async function createProjectState(input) {
  const store = await loadProjectStore();
  const result = ProjectStore.createProject(store, input);
  await saveProjectStore(result.store);
  return {
    projectStoreVersion: result.store.schemaVersion,
    activeProjectId: result.store.activeProjectId,
    projects: ProjectStore.listProjects(result.store),
    project: result.project
  };
}

async function inspectProjectState(projectId) {
  const store = await loadProjectStore();
  const result = ProjectStore.inspectProject(store, projectId);
  if (result.store.activeProjectId !== result.project.projectId) {
    result.store.activeProjectId = result.project.projectId;
    await saveProjectStore(result.store);
  }
  return {
    projectStoreVersion: result.store.schemaVersion,
    activeProjectId: result.store.activeProjectId,
    project: result.project,
    events: result.events,
    pendingPlan: result.pendingPlan,
    approvedPlan: result.approvedPlan,
    tasks: result.tasks,
    dispatches: result.dispatches,
    results: result.results,
    reviews: result.reviews,
    integration: result.integration,
    approvals: result.approvals,
    reconciliation: result.reconciliation,
    runtimeSummary: result.runtimeSummary
  };
}

async function transitionProjectState(projectId, action) {
  const store = await loadProjectStore();
  const tabIds = action === "cancel"
    ? Object.values(store.dispatchesByProject[projectId] || {}).map(dispatch => dispatch.workerTabId).filter(Number.isInteger)
    : [];
  if (action === "cancel") {
    const bootstraps = await loadProjectBootstraps();
    const bootstrap = bootstraps[projectId];
    if (bootstrap && ["starting", "running"].includes(bootstrap.status)) {
      bootstrap.status = "cancelled";
      bootstrap.error = "Cancelled by user";
      bootstrap.updatedAt = new Date().toISOString();
      for (const state of Object.values(bootstrap.roles || {})) {
        if (Number.isInteger(state.tabId)) tabIds.push(state.tabId);
        state.tabId = null;
        if (!['completed', 'failed'].includes(state.stage)) state.stage = "failed";
      }
      await saveProjectBootstraps(bootstraps);
    }
  }
  const result = ProjectStore.transitionProject(store, projectId, action);
  await saveProjectStore(result.store);
  if (tabIds.length) await removeManagedTabs([...new Set(tabIds)]);
  return {
    projectStoreVersion: result.store.schemaVersion,
    activeProjectId: result.store.activeProjectId,
    projects: ProjectStore.listProjects(result.store),
    project: result.project
  };
}

async function buildPlannerPromptState(projectId) {
  const store = await loadProjectStore();
  const result = ProjectStore.buildProjectPlannerPrompt(store, projectId);
  return {
    projectStoreVersion: result.store.schemaVersion,
    activeProjectId: result.project.projectId,
    project: result.project,
    revision: result.revision,
    prompt: result.prompt
  };
}

async function submitPlannerOutputState(projectId, output) {
  const store = await loadProjectStore();
  const result = ProjectStore.submitProjectPlannerOutput(store, projectId, output);
  await saveProjectStore(result.store);
  return {
    projectStoreVersion: result.store.schemaVersion,
    activeProjectId: result.store.activeProjectId,
    projects: ProjectStore.listProjects(result.store),
    project: result.project,
    pendingPlan: result.pendingPlan,
    planSummary: result.summary,
    tasks: {}
  };
}

async function approvePlannerPlanState(projectId) {
  const store = await loadProjectStore();
  const result = ProjectStore.approveProjectPlan(store, projectId);
  await saveProjectStore(result.store);
  return {
    projectStoreVersion: result.store.schemaVersion,
    activeProjectId: result.store.activeProjectId,
    projects: ProjectStore.listProjects(result.store),
    project: result.project,
    pendingPlan: null,
    approvedPlan: result.approvedPlan,
    planSummary: result.summary,
    tasks: result.tasks
  };
}

async function discardPlannerPlanState(projectId) {
  const store = await loadProjectStore();
  const result = ProjectStore.discardProjectPlan(store, projectId);
  await saveProjectStore(result.store);
  return {
    projectStoreVersion: result.store.schemaVersion,
    activeProjectId: result.store.activeProjectId,
    projects: ProjectStore.listProjects(result.store),
    project: result.project,
    pendingPlan: null,
    approvedPlan: result.store.approvedPlansByProject[projectId] || null,
    tasks: result.store.tasksByProject[projectId] || {}
  };
}

async function startProjectModeState(projectId) {
  const store = await loadProjectStore();
  const result = ProjectStore.startProject(store, projectId);
  await saveProjectStore(result.store);
  const inspected = ProjectStore.inspectProject(result.store, projectId);
  return {
    projectStoreVersion: result.store.schemaVersion,
    activeProjectId: result.store.activeProjectId,
    projects: ProjectStore.listProjects(result.store),
    project: result.project,
    tasks: inspected.tasks,
    dispatches: inspected.dispatches,
    runtimeSummary: inspected.runtimeSummary
  };
}

async function prepareProjectAssignmentsState(projectId) {
  const store = await loadProjectStore();
  const result = ProjectStore.prepareProjectDispatches(store, projectId);
  await saveProjectStore(result.store);
  return {
    projectStoreVersion: result.store.schemaVersion,
    activeProjectId: result.store.activeProjectId,
    projects: ProjectStore.listProjects(result.store),
    project: result.project,
    tasks: result.tasks,
    dispatches: result.dispatches,
    assignments: result.assignments,
    runtimeSummary: result.runtimeSummary
  };
}

async function recoverProjectLeasesState(projectId) {
  const store = await loadProjectStore();
  const result = ProjectStore.recoverProjectLeases(store, projectId);
  await saveProjectStore(result.store);
  return {
    projectStoreVersion: result.store.schemaVersion,
    activeProjectId: result.store.activeProjectId,
    projects: ProjectStore.listProjects(result.store),
    project: result.project,
    tasks: result.tasks,
    dispatches: result.dispatches,
    expiredDispatchIds: result.expiredDispatchIds,
    unlockedTaskIds: result.unlockedTaskIds,
    runtimeSummary: result.runtimeSummary
  };
}


async function submitProjectTaskResultState(projectId, dispatchId, output) {
  const store = await loadProjectStore();
  const result = ProjectStore.submitProjectTaskResult(store, projectId, dispatchId, output);
  await saveProjectStore(result.store);
  return {
    projectStoreVersion: result.store.schemaVersion,
    activeProjectId: result.store.activeProjectId,
    projects: ProjectStore.listProjects(result.store),
    project: result.project,
    task: result.task,
    dispatch: result.dispatch,
    result: result.result,
    runtimeSummary: result.runtimeSummary
  };
}

async function buildProjectReviewerPromptState(projectId, dispatchId) {
  const store = await loadProjectStore();
  const result = ProjectStore.buildProjectReviewerPrompt(store, projectId, dispatchId);
  return { project: result.project, task: result.task, dispatch: result.dispatch, result: result.result, prompt: result.prompt };
}

async function submitProjectReviewState(projectId, dispatchId, output) {
  const store = await loadProjectStore();
  const result = ProjectStore.submitProjectReview(store, projectId, dispatchId, output);
  await saveProjectStore(result.store);
  return {
    projectStoreVersion: result.store.schemaVersion,
    activeProjectId: result.store.activeProjectId,
    projects: ProjectStore.listProjects(result.store),
    project: result.project,
    task: result.task,
    dispatch: result.dispatch,
    review: result.review,
    integrationReady: result.integrationReady,
    runtimeSummary: result.runtimeSummary
  };
}

async function buildProjectIntegratorPromptState(projectId) {
  const store = await loadProjectStore();
  const result = ProjectStore.buildProjectIntegratorPrompt(store, projectId);
  await saveProjectStore(result.store);
  return { project: result.project, prompt: result.prompt, integrationId: result.integrationId, integrationAttempt: result.integrationAttempt, integration: result.integration };
}

async function submitProjectIntegrationState(projectId, output) {
  const store = await loadProjectStore();
  const result = ProjectStore.submitProjectIntegrationOutput(store, projectId, output);
  await saveProjectStore(result.store);
  return {
    projectStoreVersion: result.store.schemaVersion,
    activeProjectId: result.store.activeProjectId,
    projects: ProjectStore.listProjects(result.store),
    project: result.project,
    integration: result.integration,
    runtimeSummary: result.runtimeSummary
  };
}

async function approveProjectIntegrationState(projectId) {
  const store = await loadProjectStore();
  const result = ProjectStore.approveProjectIntegration(store, projectId);
  await saveProjectStore(result.store);
  return {
    projectStoreVersion: result.store.schemaVersion,
    activeProjectId: result.store.activeProjectId,
    projects: ProjectStore.listProjects(result.store),
    project: result.project,
    integration: result.integration,
    runtimeSummary: result.runtimeSummary
  };
}

async function discardProjectIntegrationState(projectId) {
  const store = await loadProjectStore();
  const result = ProjectStore.discardProjectIntegration(store, projectId);
  await saveProjectStore(result.store);
  return {
    projectStoreVersion: result.store.schemaVersion,
    activeProjectId: result.store.activeProjectId,
    projects: ProjectStore.listProjects(result.store),
    project: result.project,
    integration: result.integration,
    runtimeSummary: result.runtimeSummary
  };
}

async function requestProjectIntegrationRetryState(projectId, requiredChanges) {
  const store = await loadProjectStore();
  const result = ProjectStore.requestProjectIntegrationRetry(store, projectId, requiredChanges);
  await saveProjectStore(result.store);
  return { project: result.project, integration: result.integration, runtimeSummary: result.runtimeSummary };
}

async function requestProjectApprovalState(projectId, approval) {
  const store = await loadProjectStore();
  const result = ProjectStore.requestProjectApproval(store, projectId, approval);
  await saveProjectStore(result.store);
  return { project: result.project, approval: result.approval, approvals: result.approvals, runtimeSummary: result.runtimeSummary };
}

async function decideProjectApprovalState(projectId, approvalId, decision, note) {
  const store = await loadProjectStore();
  const result = ProjectStore.decideProjectApproval(store, projectId, approvalId, decision, note);
  await saveProjectStore(result.store);
  return { project: result.project, approval: result.approval, approvals: result.approvals, runtimeSummary: result.runtimeSummary };
}

async function buildProjectReconciliationPromptState(projectId) {
  const store = await loadProjectStore();
  const result = ProjectStore.buildProjectReconciliationPrompt(store, projectId);
  return { project: result.project, prompt: result.prompt };
}

async function submitProjectReconciliationState(projectId, output) {
  const store = await loadProjectStore();
  const result = ProjectStore.submitProjectReconciliation(store, projectId, output);
  await saveProjectStore(result.store);
  return { project: result.project, reconciliation: result.reconciliation, runtimeSummary: result.runtimeSummary };
}

async function getProjectSelectorHealthState() {
  const tabs = await chrome.tabs.query({ url: ["https://chatgpt.com/*", "https://chat.openai.com/*"] });
  const results = [];
  for (const tab of tabs) {
    try {
      const health = await chrome.tabs.sendMessage(tab.id, { type: "GET_SELECTOR_HEALTH" });
      results.push({ tabId: tab.id, title: tab.title || "ChatGPT", url: tab.url, ...health });
    } catch (error) {
      results.push({ tabId: tab.id, title: tab.title || "ChatGPT", url: tab.url, ok: false, status: "unavailable", error: error?.message || String(error) });
    }
  }
  return { checkedAt: new Date().toISOString(), tabs: results };
}

function findProjectDispatchByTab(store, tabId) {
  for (const [projectId, dispatches] of Object.entries(store.dispatchesByProject || {})) {
    for (const dispatch of Object.values(dispatches || {})) {
      if (dispatch?.workerTabId === tabId && ["dispatched", "running"].includes(dispatch.status)) return { projectId, dispatch };
    }
  }
  return null;
}

async function dispatchPreparedProjectAssignmentsState(projectId, dispatchIds, modelVerified) {
  if (modelVerified !== true) throw new Error("Verify the configured ChatGPT model in every worker chat before dispatching.");
  const scheduler = await loadState();
  if (scheduler?.running) throw new Error("Stop the normal AutoPrompter scheduler before dispatching Project Mode workers.");
  let store = await loadProjectStore();
  const project = store.projects[projectId];
  if (!project || project.status !== "running") throw new Error("Project must be running before web dispatch.");
  const wanted = new Set(Array.isArray(dispatchIds) ? dispatchIds : []);
  const prepared = Object.values(store.dispatchesByProject[projectId] || {})
    .filter(dispatch => dispatch.status === "prepared" && (!wanted.size || wanted.has(dispatch.dispatchId)));
  if (!prepared.length) throw new Error("No prepared assignments are available for web dispatch.");
  const stored = await chrome.storage.local.get([CATALOG_KEY, SETTINGS_KEY]);
  const catalog = Array.isArray(stored[CATALOG_KEY]) ? stored[CATALOG_KEY] : [];
  const byId = new Map(catalog.map(chat => [chat.id, chat]));
  const settings = normalizeSettings({ ...(stored[SETTINGS_KEY] || {}), continuityEnabled: false, delaySeconds: 5 });
  const started = [];
  for (const dispatch of prepared) {
    const chat = byId.get(dispatch.workerChatId);
    if (!chat?.url) throw new Error(`Worker chat ${dispatch.workerChatId} is missing from the local catalog. Refresh the ChatGPT sidebar first.`);
    const tab = await chrome.tabs.create({ url: chat.url, active: false });
    try {
      const marked = ProjectStore.markProjectDispatchStarted(store, projectId, dispatch.dispatchId, tab.id);
      store = marked.store;
      await saveProjectStore(store);
      started.push(marked.dispatch);
    } catch (error) {
      await removeManagedTab(tab.id);
      throw error;
    }
  }
  return {
    projectStoreVersion: store.schemaVersion,
    activeProjectId: store.activeProjectId,
    projects: ProjectStore.listProjects(store),
    project: store.projects[projectId],
    started,
    runtimeSummary: ProjectStore.summarizeProjectRuntime(store, projectId)
  };
}

async function handleProjectTaskStatus(message) {
  const store = await loadProjectStore();
  const result = ProjectStore.updateProjectDispatchStatus(store, message.projectId, message.dispatchId, message.status);
  await saveProjectStore(result.store);
  return { ok: true };
}

async function handleProjectTaskResult(message, sender) {
  const result = await submitProjectTaskResultState(message.projectId, message.dispatchId, message.output);
  await removeManagedTab(sender?.tab?.id || result.dispatch.workerTabId);
  return result;
}

async function handleProjectSuccessorTaskResult(message, sender) {
  let store = await loadProjectStore();
  const bound = ProjectStore.bindProjectSuccessorConversation(store, message.projectId, message.dispatchId, message.conversation?.id);
  store = bound.store;
  const result = ProjectStore.submitProjectTaskResult(store, message.projectId, message.dispatchId, message.output);
  await saveProjectStore(result.store);
  await removeManagedTab(sender?.tab?.id || result.dispatch.workerTabId);
  return {
    project: result.project,
    task: result.task,
    dispatch: result.dispatch,
    result: result.result,
    runtimeSummary: result.runtimeSummary
  };
}

async function failProjectDispatch(message, sender) {
  let store = await loadProjectStore();
  if (message.kind === "context_limit") {
    try {
      const prepared = ProjectStore.createProjectDispatchSuccessor(store, message.projectId, message.dispatchId, message.error || message.kind);
      store = prepared.store;
      await removeManagedTab(sender?.tab?.id);
      const tab = await chrome.tabs.create({
        url: freshChatUrl(prepared.successor.freshRequestId, prepared.successor.originalDispatchId, prepared.successor.dispatchId),
        active: false
      });
      const started = ProjectStore.markProjectDispatchStarted(store, message.projectId, prepared.successor.dispatchId, tab.id);
      await saveProjectStore(started.store);
      return { ok: true, successorDispatchId: prepared.successor.dispatchId, successorGeneration: prepared.successor.successorGeneration };
    } catch (error) {
      const current = store.dispatchesByProject?.[message.projectId]?.[message.dispatchId];
      if (current && ["dispatched", "running", "prepared"].includes(current.status)) {
        store = ProjectStore.markProjectDispatchTransportError(store, message.projectId, message.dispatchId, error?.message || String(error)).store;
      }
      await removeManagedTab(sender?.tab?.id);
      await saveProjectStore(store);
      return { ok: false, error: error?.message || String(error) };
    }
  }
  const failed = ProjectStore.markProjectDispatchTransportError(store, message.projectId, message.dispatchId, message.error || message.kind || "Project worker failed");
  store = failed.store;
  if (["rate_limit", "account_restriction", "safety_restriction"].includes(message.kind) && store.projects[message.projectId]?.status === "running") {
    const activeTabs = Object.values(store.dispatchesByProject[message.projectId] || {}).map(dispatch => dispatch.workerTabId).filter(Number.isInteger);
    for (const dispatch of Object.values(store.dispatchesByProject[message.projectId] || {})) {
      if (["dispatched", "running"].includes(dispatch.status)) {
        store = ProjectStore.markProjectDispatchTransportError(store, message.projectId, dispatch.dispatchId, message.error || message.kind).store;
      }
    }
    store = ProjectStore.transitionProject(store, message.projectId, "pause").store;
    await removeManagedTabs(activeTabs);
  } else {
    await removeManagedTab(sender?.tab?.id);
  }
  await saveProjectStore(store);
  return { ok: true };
}

async function notify(state, title, message, idSuffix = "event") {
  if (!state?.settings?.notificationsEnabled) return;
  const notificationId = `autoprompter-${idSuffix}-${Date.now()}`;
  try {
    await chrome.notifications.create(notificationId, {
      type: "basic",
      iconUrl: NOTIFICATION_ICON_DATA_URL,
      title: String(title).slice(0, 120),
      message: String(message).slice(0, 500),
      priority: 0
    });
  } catch {
    try {
      await chrome.action.setBadgeBackgroundColor({ color: "#b42318" });
      await chrome.action.setBadgeText({ text: "!" });
    } catch {
      // Notifications and badges are best-effort.
    }
  }
}

async function clearBadge() {
  try { await chrome.action.setBadgeText({ text: "" }); } catch { /* best-effort */ }
}

async function removeManagedTab(tabId) {
  if (!Number.isInteger(tabId)) return;
  try {
    await chrome.tabs.remove(tabId);
  } catch {
    // The user may already have closed the tab.
  }
}

async function removeManagedTabs(tabIds) {
  await Promise.all([...new Set((tabIds || []).filter(Number.isInteger))].map(removeManagedTab));
}

async function stopScheduler(reason = "Stopped", error = "", closeWorkers = true, notifyUser = false) {
  const state = await loadState();
  if (!state) return publicState(null);
  clearInitialBatchTimer(state.token);

  const tabIds = (state.chats || []).map(chat => chat.workerTabId).filter(Number.isInteger);
  const stopped = {
    ...state,
    running: false,
    token: Number(state.token || 0) + 1,
    status: reason,
    lastError: error,
    pausedReason: error || reason,
    chats: (state.chats || []).map(chat => ({
      ...chat,
      workerTabId: null,
      currentJobId: null,
      pendingSuccessor: null,
      contentReady: false,
      jobDispatched: false,
      initialJobPending: false,
      status: chat.status === "Finished" || chat.status === "Initialized" || chat.retired || chat.failed
        ? chat.status
        : "Stopped"
    }))
  };
  await saveState(stopped);

  await Promise.all(tabIds.map(async tabId => {
    try {
      await chrome.tabs.sendMessage(tabId, { type: "CANCEL_CHAT_JOB", token: stopped.token });
    } catch {
      // A worker may be navigating or already closed.
    }
  }));
  if (closeWorkers) await removeManagedTabs(tabIds);

  if (notifyUser) await notify(stopped, "AutoPrompter stopped", error || reason, "stopped");
  return publicState(stopped);
}

async function saveSuccessorToCatalog(chat, parentId = "") {
  const stored = await chrome.storage.local.get([CATALOG_KEY, SELECTION_KEY, CHAT_CONFIGS_KEY]);
  const catalog = Array.isArray(stored[CATALOG_KEY]) ? stored[CATALOG_KEY] : [];
  const successorEntry = { id: chat.id, title: chat.title, url: chat.url, lastSeenAt: Date.now() };
  const nextCatalog = [successorEntry, ...catalog.filter(item => item.id !== chat.id)];
  const selected = new Set(Array.isArray(stored[SELECTION_KEY]) ? stored[SELECTION_KEY] : []);
  if (parentId) selected.delete(parentId);
  selected.add(chat.id);
  const configs = stored[CHAT_CONFIGS_KEY] && typeof stored[CHAT_CONFIGS_KEY] === "object"
    ? { ...stored[CHAT_CONFIGS_KEY] }
    : {};
  if (parentId && configs[parentId] && !configs[chat.id]) {
    const inherited = { ...configs[parentId] };
    delete inherited.startInNewChat;
    if (Object.keys(inherited).length) configs[chat.id] = inherited;
  }
  await chrome.storage.local.set({
    [CATALOG_KEY]: nextCatalog,
    [SELECTION_KEY]: [...selected],
    [CHAT_CONFIGS_KEY]: configs
  });
}

async function sendChatJob(state, index, { initialBatch = false, batchPrepared = false } = {}) {
  const chat = state?.chats?.[index];
  if (!state?.running || !chat || !Number.isInteger(chat.workerTabId) || !chat.currentJobId) return false;
  if (!batchPrepared && chat.jobDispatched) return false;

  if (!batchPrepared) {
    chat.jobDispatched = true;
    await saveState(state);
  }

  let tab;
  try {
    tab = await chrome.tabs.get(chat.workerTabId);
  } catch {
    if (batchPrepared) chat.jobDispatched = false;
    await failChatWorker(state, index, "The managed ChatGPT tab was closed.", false);
    return false;
  }

  try {
    if (chat.pendingSuccessor) {
      const successorSettings = chat.pendingSuccessor.settings || chat.settings || state.settings;
      await chrome.tabs.sendMessage(chat.workerTabId, {
        type: "RUN_SUCCESSOR_JOB",
        token: state.token,
        jobId: chat.currentJobId,
        parentChat: chat.pendingSuccessor.parentChat,
        parentConversationId: chat.pendingSuccessor.parentChat?.id || chat.id,
        freshRequestId: chat.pendingSuccessor.freshRequestId || chat.currentJobId,
        settings: initialBatch ? { ...successorSettings, delaySeconds: 0 } : successorSettings,
        prompt: chat.pendingSuccessor.prompt,
        checkpoint: chat.pendingSuccessor.checkpoint,
        reason: chat.pendingSuccessor.reason,
        initialBatch
      });
      return true;
    }

    const current = normalizeConversationUrl(tab.url || "");
    if (!current || current.id !== chat.id) {
      chat.jobDispatched = false;
      if (!batchPrepared) await saveState(state);
      return false;
    }

    const baseSettings = chat.settings || state.settings;
    const jobSettings = chat.retryPrompt
      ? { ...baseSettings, prompt: chat.retryPrompt, checkpointBeforePrompt: false, checkpointAfterPrompt: false }
      : baseSettings;
    await chrome.tabs.sendMessage(chat.workerTabId, {
      type: "RUN_CHAT_JOB",
      token: state.token,
      jobId: chat.currentJobId,
      chat: { ...chat },
      settings: initialBatch ? { ...jobSettings, delaySeconds: 0 } : jobSettings,
      mode: chat.retryPrompt ? "connection_retry" : (state.mode || "work"),
      initialBatch
    });
    return true;
  } catch {
    chat.jobDispatched = false;
    if (!batchPrepared) await saveState(state);
    return false;
  }
}

function clearInitialBatchTimer(token) {
  const handle = initialBatchTimers.get(token);
  if (handle) clearTimeout(handle);
  initialBatchTimers.delete(token);
}

function scheduleInitialBatchFallback(token) {
  clearInitialBatchTimer(token);
  const handle = setTimeout(() => {
    initialBatchTimers.delete(token);
    enqueue(async () => {
      const state = await loadState();
      if (!state?.running || state.token !== token || state.initialBatchReleased) return;
      await releaseInitialBatch(state, true);
    }).catch(() => {});
  }, INITIAL_BATCH_GRACE_MS);
  if (typeof handle?.unref === "function") handle.unref();
  initialBatchTimers.set(token, handle);
}

async function releaseInitialBatch(state, force = false) {
  if (!state?.running || state.initialBatchReleased) return publicState(state);
  const pendingIndexes = state.chats
    .map((chat, index) => chat.initialJobPending && chat.currentJobId && !chat.failed ? index : -1)
    .filter(index => index >= 0);
  const readyIndexes = pendingIndexes.filter(index => state.chats[index].contentReady);

  if (!force && readyIndexes.length < pendingIndexes.length) {
    state.status = `Preparing concurrent start ${readyIndexes.length}/${pendingIndexes.length}`;
    await saveState(state);
    return publicState(state);
  }
  if (readyIndexes.length === 0) return publicState(state);

  state.initialBatchReleased = true;
  clearInitialBatchTimer(state.token);
  for (const index of readyIndexes) {
    state.chats[index].jobDispatched = true;
    state.chats[index].status = "Starting together";
  }
  updateOverallStatus(state, `Submitting ${readyIndexes.length} initial prompts together`);
  await saveState(state);

  const results = await Promise.all(readyIndexes.map(index =>
    sendChatJob(state, index, { initialBatch: true, batchPrepared: true })
  ));
  for (let offset = 0; offset < readyIndexes.length; offset += 1) {
    const chat = state.chats[readyIndexes[offset]];
    if (results[offset]) {
      chat.initialJobPending = false;
    } else {
      chat.jobDispatched = false;
      chat.status = "Waiting for page readiness";
    }
  }
  await saveState(state);
  return publicState(state);
}

async function markContentReady(state, index) {
  const chat = state?.chats?.[index];
  if (!state?.running || !chat) return publicState(state);
  chat.contentReady = true;

  if (chat.initialJobPending && !state.initialBatchReleased) {
    return releaseInitialBatch(state, Date.now() >= Number(state.initialBatchDeadline || 0));
  }

  const initialBatch = Boolean(chat.initialJobPending);
  const sent = await sendChatJob(state, index, { initialBatch });
  if (sent && initialBatch) {
    chat.initialJobPending = false;
    await saveState(state);
  }
  return publicState(state);
}

async function maybeFinishScheduler(state) {
  if (!state?.running) return publicState(state);
  if (state.chats.some(chat => isChatEligible(state, chat))) {
    updateOverallStatus(state);
    await saveState(state);
    return publicState(state);
  }

  const tabIds = state.chats.map(chat => chat.workerTabId).filter(Number.isInteger);
  clearInitialBatchTimer(state.token);
  state.running = false;
  state.status = state.chats.some(chat => chat.failed) ? "Finished with errors" : "Finished";
  state.chats = state.chats.map(chat => ({
    ...chat,
    workerTabId: null,
    currentJobId: null,
    pendingSuccessor: null,
    contentReady: false,
    jobDispatched: false,
    initialJobPending: false,
    status: chat.failed ? "Error" : (chat.retired ? chat.status : (state.mode === "initialize" ? "Initialized" : "Finished"))
  }));
  await saveState(state);
  await removeManagedTabs(tabIds);
  await notify(state, "AutoPrompter finished", state.status, "finished");
  return publicState(state);
}

async function failChatWorker(state, index, error, closeWorker = true) {
  const chat = state?.chats?.[index];
  if (!chat) return publicState(state);
  const tabId = chat.workerTabId;
  chat.failed = true;
  chat.status = "Error";
  chat.lastError = String(error || "The chat job failed.").slice(0, 500);
  chat.workerTabId = null;
  chat.currentJobId = null;
  chat.pendingSuccessor = null;
  chat.contentReady = false;
  chat.jobDispatched = false;
  chat.initialJobPending = false;
  state.lastError = `${chat.title}: ${chat.lastError}`;
  updateOverallStatus(state, `${chat.title}: Error`);
  await saveState(state);
  if (closeWorker) await removeManagedTab(tabId);
  await notify(state, `AutoPrompter error: ${chat.title}`, chat.lastError, `error-${chat.id}`);
  return maybeFinishScheduler(state);
}

async function queueNextChatJob(state, index) {
  const chat = state?.chats?.[index];
  if (!state?.running || !isChatEligible(state, chat)) return maybeFinishScheduler(state);

  const jobNumber = Number(chat.sentCount || 0) + 1;
  chat.currentJobId = `${state.token}:${chat.chainId}:${jobNumber}:${Date.now()}`;
  chat.pendingSuccessor = null;
  chat.jobDispatched = false;
  chat.initialJobPending = false;
  chat.status = "Loading";
  chat.lastError = "";
  state.lastError = "";
  state.pausedReason = "";
  updateOverallStatus(state, `${chat.title}: Loading next prompt`);
  await saveState(state);

  let tab = null;
  if (Number.isInteger(chat.workerTabId)) {
    try { tab = await chrome.tabs.get(chat.workerTabId); } catch { tab = null; }
  }
  if (!tab) {
    try {
      tab = await chrome.tabs.create({ url: "about:blank", active: false });
      chat.workerTabId = tab.id;
      chat.contentReady = false;
      await saveState(state);
    } catch (error) {
      return failChatWorker(state, index, `Could not create a managed ChatGPT tab: ${error.message}`, false);
    }
  }

  const current = normalizeConversationUrl(tab.url || "");
  if (current?.id === chat.id && tab.status === "complete" && chat.contentReady) {
    await sendChatJob(state, index);
    return publicState(state);
  }

  if (current?.id === chat.id && tab.status === "complete") {
    chat.status = "Waiting for page readiness";
    await saveState(state);
    return publicState(state);
  }

  try {
    chat.contentReady = false;
    await chrome.tabs.update(chat.workerTabId, { url: chat.url, active: false });
    await saveState(state);
  } catch (error) {
    return failChatWorker(state, index, `Could not open ${chat.title}: ${error.message}`);
  }
  return publicState(state);
}

async function launchAllWorkers(state) {
  const indexes = eligibleChatIndexes(state.chats, state.settings.maxContinuations);
  for (const index of indexes) {
    const chat = state.chats[index];
    chat.lastError = "";
    chat.contentReady = false;
    chat.jobDispatched = false;
    chat.initialJobPending = true;
    if (state.mode === "work" && chat.startInNewChat) {
      const reason = "This chat was marked to start in a new conversation before work begins.";
      chat.currentJobId = `${state.token}:fresh:${chat.chainId}:1:${Date.now()}:${index}`;
      const resumeSettings = chat.settings || state.settings;
      chat.pendingSuccessor = {
        parentChat: { ...chat, startInNewChat: false, pendingSuccessor: null },
        checkpoint: "",
        reason,
        prompt: buildFreshStartPrompt(resumeSettings, chat, reason),
        settings: { ...resumeSettings, checkpointAfterPrompt: false },
        resumeSettings,
        kind: "forced_start",
        verified: false,
        freshRequestId: `${state.token}:${chat.chainId}:${Date.now()}:${index}`
      };
      chat.status = "Opening new chat";
    } else {
      chat.currentJobId = `${state.token}:${chat.chainId}:1:${Date.now()}:${index}`;
      chat.pendingSuccessor = null;
      chat.status = "Opening worker";
    }
  }
  updateOverallStatus(state, `Opening ${indexes.length} chats concurrently`);
  await saveState(state);

  const createResults = await Promise.allSettled(indexes.map(() => chrome.tabs.create({ url: "about:blank", active: false })));
  for (let offset = 0; offset < indexes.length; offset += 1) {
    const index = indexes[offset];
    const result = createResults[offset];
    if (result.status === "fulfilled" && Number.isInteger(result.value?.id)) {
      state.chats[index].workerTabId = result.value.id;
      state.chats[index].status = "Loading";
    } else {
      state.chats[index].failed = true;
      state.chats[index].status = "Error";
      state.chats[index].lastError = `Could not create a managed ChatGPT tab: ${result.reason?.message || result.reason || "unknown error"}`;
      state.chats[index].currentJobId = null;
      state.chats[index].initialJobPending = false;
    }
  }
  updateOverallStatus(state);
  await saveState(state);

  const navigations = indexes
    .filter(index => Number.isInteger(state.chats[index].workerTabId))
    .map(async index => {
      const chat = state.chats[index];
      try {
        const targetUrl = chat.pendingSuccessor
          ? freshChatUrl(state.token, chat.chainId, chat.pendingSuccessor.freshRequestId || chat.currentJobId)
          : chat.url;
        await chrome.tabs.update(chat.workerTabId, { url: targetUrl, active: false });
      } catch (error) {
        const tabId = chat.workerTabId;
        chat.workerTabId = null;
        chat.currentJobId = null;
        chat.initialJobPending = false;
        chat.failed = true;
        chat.status = "Error";
        chat.lastError = `Could not open ${chat.title}: ${error.message}`;
        await removeManagedTab(tabId);
      }
    });
  await Promise.all(navigations);
  updateOverallStatus(state);
  await saveState(state);
  scheduleInitialBatchFallback(state.token);

  for (const chat of state.chats.filter(item => item.failed && item.lastError)) {
    await notify(state, `AutoPrompter error: ${chat.title}`, chat.lastError, `launch-${chat.id}`);
  }
  return maybeFinishScheduler(state);
}

async function startScheduler(chats, settings, mode = "work") {
  const normalizedSettings = normalizeSettings(settings);
  const normalizedChats = [];
  const seen = new Set();
  for (const chat of Array.isArray(chats) ? chats : []) {
    const normalized = normalizeChat(chat, normalizedSettings);
    if (!normalized || seen.has(normalized.id)) continue;
    if (chat?.settings?.continuityEnabled && !normalized.settings.repository) {
      throw new Error(`Repository continuity requires a valid GitHub owner/repository value for ${normalized.title}.`);
    }
    seen.add(normalized.id);
    normalizedChats.push(normalized);
  }
  if (normalizedChats.length === 0) throw new Error("Select at least one ChatGPT conversation.");
  if (normalizedChats.length > MAX_CONCURRENT_CHATS) {
    throw new Error(`Select at most ${MAX_CONCURRENT_CHATS} chats for one concurrent run.`);
  }

  const normalizedMode = mode === "initialize" ? "initialize" : "work";
  if (normalizedMode === "initialize") {
    for (const chat of normalizedChats) {
      if (!chat.settings.continuityEnabled || !chat.settings.repository) {
        throw new Error(`Continuity initialization requires a valid repository for ${chat.title}.`);
      }
      chat.settings.maxContinuations = 1;
    }
  }

  const previous = await loadState();
  if (previous?.running) await stopScheduler("Restarted", "", true);

  const state = {
    running: true,
    token: Math.max(Date.now(), Number(previous?.token || 0) + 2),
    status: "Starting concurrent workers",
    lastError: "",
    pausedReason: "",
    settings: normalizedSettings,
    mode: normalizedMode,
    chats: normalizedChats,
    handoffHistory: [],
    initialBatchReleased: false,
    initialBatchDeadline: Date.now() + INITIAL_BATCH_GRACE_MS,
    startedAt: Date.now()
  };
  await clearBadge();
  await saveState(state);
  return launchAllWorkers(state);
}

async function updateJobStatus(message, sender) {
  const state = await loadState();
  const index = findChatIndexForMessage(state, message, sender);
  if (index < 0) return publicState(state);
  const chat = state.chats[index];
  chat.status = String(message.status || "Working").slice(0, 160);
  if (Number.isFinite(message.contextEstimateTokens)) chat.contextEstimateTokens = Math.round(message.contextEstimateTokens);
  if (Number.isFinite(message.contextPercent)) chat.contextPercent = Math.round(message.contextPercent * 10) / 10;
  updateOverallStatus(state, `${chat.title}: ${chat.status}`);
  await saveState(state);
  return publicState(state);
}

async function finishJob(message, sender) {
  const state = await loadState();
  const index = findChatIndexForMessage(state, message, sender);
  if (index < 0) return publicState(state);
  const chat = state.chats[index];
  chat.sentCount = Number(chat.sentCount || 0) + 1;
  chat.currentJobId = null;
  chat.jobDispatched = false;
  chat.lastError = "";
  chat.retryPrompt = "";
  chat.connectionRetryCount = 0;
  if (message.checkpoint) chat.lastCheckpoint = String(message.checkpoint).slice(0, 200);
  if (Number.isFinite(message.contextEstimateTokens)) chat.contextEstimateTokens = Math.round(message.contextEstimateTokens);
  if (Number.isFinite(message.contextPercent)) chat.contextPercent = Math.round(message.contextPercent * 10) / 10;

  const completed = Boolean(message.initialized) || !isChatEligible(state, chat);
  chat.status = message.initialized ? "Initialized" : (completed ? "Finished" : "Queued");
  updateOverallStatus(state, `${chat.title}: ${chat.status}`);
  await saveState(state);

  if (state.settings.notifyOnPromptDone) {
    await notify(
      state,
      message.initialized ? `Continuity initialized: ${chat.title}` : `Prompt completed: ${chat.title}`,
      `${chat.sentCount}/${chatLimit(state, chat)}${chat.lastCheckpoint ? ` · checkpoint ${chat.lastCheckpoint}` : ""}`,
      `prompt-${chat.id}`
    );
  }

  if (completed) {
    const tabId = chat.workerTabId;
    chat.workerTabId = null;
    await saveState(state);
    await removeManagedTab(tabId);
    return maybeFinishScheduler(state);
  }
  return queueNextChatJob(state, index);
}

async function failJob(message, sender) {
  const state = await loadState();
  const index = findChatIndexForMessage(state, message, sender);
  if (index < 0) return publicState(state);
  return failChatWorker(state, index, message.error || "The chat job failed.");
}

async function beginSuccessor(state, index, message) {
  const chat = state.chats[index];
  const chatSettings = chat.settings || state.settings;
  const checkpoint = String(message.checkpoint || chat.lastCheckpoint || "").slice(0, 200);
  const reason = String(message.reason || message.message || "Continuity rollover requested.").slice(0, 500);
  const rolloverCount = Number(chat.rolloverCount || 0) + 1;
  const kind = String(message.kind || "unknown");
  const verified = Boolean(chatSettings.continuityEnabled && chatSettings.repository && checkpoint);
  const bestEffortAllowed = Boolean(message.forceFreshStart || kind === "context_limit");

  if (!verified && !bestEffortAllowed) {
    return failChatWorker(state, index, `Continuity handoff required: ${reason}`);
  }
  if (rolloverCount > chatSettings.maxRollovers) {
    return failChatWorker(state, index, `The chat reached the configured limit of ${chatSettings.maxRollovers} successor chats.`);
  }

  chat.status = verified ? "Creating verified successor" : "Creating best-effort successor";
  chat.lastCheckpoint = checkpoint;
  chat.rolloverCount = rolloverCount;
  chat.currentJobId = `${state.token}:successor:${chat.chainId}:${rolloverCount}:${Date.now()}`;
  chat.contentReady = false;
  chat.jobDispatched = false;
  chat.initialJobPending = false;
  chat.pendingSuccessor = {
    parentChat: { ...chat, startInNewChat: false, pendingSuccessor: null },
    checkpoint,
    reason,
    prompt: verified
      ? buildSuccessorPrompt(chatSettings, chat, checkpoint, reason)
      : buildFreshStartPrompt(chatSettings, chat, reason),
    settings: verified ? chatSettings : { ...chatSettings, checkpointAfterPrompt: false },
    resumeSettings: chatSettings,
    kind: verified ? "verified_handoff" : "best_effort",
    verified,
    freshRequestId: `${state.token}:${chat.chainId}:${rolloverCount}:${Date.now()}`
  };
  updateOverallStatus(state, `${chat.status} for ${chat.title}`);
  await saveState(state);
  await notify(
    state,
    verified ? `Creating successor: ${chat.title}` : `Creating fresh chat: ${chat.title}`,
    verified ? `${reason} · checkpoint ${checkpoint}` : `${reason} · no verified handoff was available`,
    `rollover-${chat.id}`
  );

  let tab = null;
  if (Number.isInteger(chat.workerTabId)) {
    try { tab = await chrome.tabs.get(chat.workerTabId); } catch { tab = null; }
  }
  if (!tab) {
    try {
      tab = await chrome.tabs.create({ url: "about:blank", active: false });
      chat.workerTabId = tab.id;
      chat.contentReady = false;
      await saveState(state);
    } catch (error) {
      return failChatWorker(state, index, `Could not create a successor tab: ${error.message}`, false);
    }
  }
  try {
    await chrome.tabs.update(chat.workerTabId, {
      url: freshChatUrl(state.token, chat.chainId, chat.pendingSuccessor?.freshRequestId || chat.currentJobId),
      active: false
    });
  } catch (error) {
    return failChatWorker(state, index, `Could not open a new ChatGPT conversation: ${error.message}`);
  }
  return publicState(state);
}

async function interruptJob(message, sender) {
  const state = await loadState();
  const index = findChatIndexForMessage(state, message, sender);
  if (index < 0) return publicState(state);
  const chat = state.chats[index];

  if (message.checkpoint) chat.lastCheckpoint = String(message.checkpoint).slice(0, 200);
  if (Number.isFinite(message.contextEstimateTokens)) chat.contextEstimateTokens = Math.round(message.contextEstimateTokens);
  if (Number.isFinite(message.contextPercent)) chat.contextPercent = Math.round(message.contextPercent * 10) / 10;
  const kind = String(message.kind || "unknown");
  const reason = String(message.message || "ChatGPT interrupted the job.").slice(0, 500);

  if (kind === "connection_interrupted") {
    const retries = Number(chat.connectionRetryCount || 0) + 1;
    if (retries > MAX_CONNECTION_RETRIES) {
      return failChatWorker(state, index, `The response connection was interrupted ${MAX_CONNECTION_RETRIES} times in a row.`);
    }
    chat.connectionRetryCount = retries;
    chat.retryPrompt = CONNECTION_RETRY_PROMPT;
    chat.currentJobId = null;
    chat.status = `Retrying interrupted response (${retries}/${MAX_CONNECTION_RETRIES})`;
    chat.lastError = reason;
    updateOverallStatus(state, `${chat.title}: ${chat.status}`);
    await saveState(state);
    await notify(state, `Retrying interrupted response: ${chat.title}`, reason, `connection-${chat.id}`);
    return queueNextChatJob(state, index);
  }

  if (["context_limit", "stalled", "content_removed"].includes(kind)) {
    return beginSuccessor(state, index, { ...message, kind, reason });
  }

  // A restriction in any managed tab stops the entire concurrent run unless the
  // user has disabled heuristic circuit-breaker detection in settings.
  if (["rate_limit", "account_restriction", "safety_restriction"].includes(kind)) {
    return stopScheduler("Circuit breaker activated", `${chat.title}: ${reason}`, true, true);
  }

  return failChatWorker(state, index, `Manual review required: ${reason}`);
}

async function successorCreated(message, sender) {
  const state = await loadState();
  const index = findChatIndexForMessage(state, message, sender);
  if (index < 0) return publicState(state);
  const current = state.chats[index];
  if (!current.pendingSuccessor) return publicState(state);

  const info = normalizeConversationUrl(message.conversation?.url || "");
  if (!info || info.id !== message.conversation?.id) {
    return failChatWorker(state, index, "The new ChatGPT conversation URL could not be verified.");
  }

  const pending = current.pendingSuccessor;
  if (info.id === pending.parentChat?.id) {
    return failChatWorker(state, index, "ChatGPT reopened the original conversation instead of creating a new one.");
  }
  const parent = pending.parentChat;
  const successor = {
    ...parent,
    id: info.id,
    url: info.url,
    title: `${parent.title} · continued ${Number(parent.generation || 0) + 1}`.slice(0, 160),
    sentCount: Number(parent.sentCount || 0) + 1,
    status: "Queued",
    lastError: "",
    failed: false,
    retired: false,
    generation: Number(parent.generation || 0) + 1,
    rolloverCount: Number(parent.rolloverCount || 0),
    lastCheckpoint: String(message.checkpoint || pending.checkpoint || "").slice(0, 200),
    contextEstimateTokens: Number(message.contextEstimateTokens || 0),
    contextPercent: Number(message.contextPercent || 0),
    workerTabId: current.workerTabId,
    currentJobId: null,
    pendingSuccessor: null,
    contentReady: true,
    jobDispatched: false,
    initialJobPending: false,
    startInNewChat: false,
    retryPrompt: "",
    connectionRetryCount: 0,
    settings: pending.resumeSettings || current.settings || parent.settings || state.settings
  };

  state.handoffHistory = [...(state.handoffHistory || []), {
    id: parent.id,
    title: parent.title,
    url: parent.url,
    successorId: successor.id,
    checkpoint: pending.checkpoint,
    reason: pending.reason,
    kind: pending.kind || "successor",
    verified: Boolean(pending.verified),
    at: Date.now()
  }].slice(-50);
  state.chats[index] = successor;
  updateOverallStatus(state, `Successor created for ${parent.title}`);
  await saveState(state);
  await saveSuccessorToCatalog(successor, parent.id);
  const successorDetail = successor.lastCheckpoint
    ? `${successor.title} · checkpoint ${successor.lastCheckpoint}`
    : `${successor.title} · best-effort fresh start`;
  await notify(state, "Successor chat ready", successorDetail, `successor-${successor.id}`);

  if (!isChatEligible(state, successor)) {
    const tabId = successor.workerTabId;
    successor.workerTabId = null;
    successor.status = "Finished";
    await saveState(state);
    await removeManagedTab(tabId);
    return maybeFinishScheduler(state);
  }
  return queueNextChatJob(state, index);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.scope !== MESSAGE_SCOPE) return false;

  const operation = async () => {
    switch (message.type) {
      case "GET_SCHEDULER_STATE":
        return publicState(await loadState());
      case "START_SCHEDULER":
        return startScheduler(message.chats, message.settings, message.mode);
      case "STOP_SCHEDULER":
        return stopScheduler("Stopped by user", "", true);
      case "GET_PROJECTS":
        return listProjectState();
      case "CREATE_PROJECT":
        return createProjectState(message.project);
      case "START_PROJECT_BOOTSTRAP":
        return startProjectBootstrapState(message.projectId);
      case "GET_PROJECT_BOOTSTRAP":
        return getProjectBootstrapState(message.projectId);
      case "PROJECT_BOOTSTRAP_STATUS":
        return updateProjectBootstrapStatus(message, sender);
      case "PROJECT_BOOTSTRAP_RESULT":
        return handleProjectBootstrapResult(message, sender);
      case "PROJECT_BOOTSTRAP_ERROR":
        return handleProjectBootstrapError(message, sender);
      case "INSPECT_PROJECT":
        return inspectProjectState(message.projectId);
      case "PAUSE_PROJECT":
        return transitionProjectState(message.projectId, "pause");
      case "RESUME_PROJECT":
        return transitionProjectState(message.projectId, "resume");
      case "CANCEL_PROJECT":
        return transitionProjectState(message.projectId, "cancel");
      case "BUILD_PLANNER_PROMPT":
        return buildPlannerPromptState(message.projectId);
      case "SUBMIT_PLANNER_OUTPUT":
        return submitPlannerOutputState(message.projectId, message.output);
      case "APPROVE_PROJECT_PLAN":
        return approvePlannerPlanState(message.projectId);
      case "DISCARD_PROJECT_PLAN":
        return discardPlannerPlanState(message.projectId);
      case "START_PROJECT_MODE":
        return startProjectModeState(message.projectId);
      case "PREPARE_PROJECT_ASSIGNMENTS":
        return prepareProjectAssignmentsState(message.projectId);
      case "RECOVER_PROJECT_LEASES":
        return recoverProjectLeasesState(message.projectId);
      case "SUBMIT_PROJECT_TASK_RESULT":
        return submitProjectTaskResultState(message.projectId, message.dispatchId, message.output);
      case "BUILD_PROJECT_REVIEWER_PROMPT":
        return buildProjectReviewerPromptState(message.projectId, message.dispatchId);
      case "SUBMIT_PROJECT_REVIEW":
        return submitProjectReviewState(message.projectId, message.dispatchId, message.output);
      case "BUILD_PROJECT_INTEGRATOR_PROMPT":
        return buildProjectIntegratorPromptState(message.projectId);
      case "SUBMIT_PROJECT_INTEGRATION":
        return submitProjectIntegrationState(message.projectId, message.output);
      case "APPROVE_PROJECT_INTEGRATION":
        return approveProjectIntegrationState(message.projectId);
      case "DISCARD_PROJECT_INTEGRATION":
        return discardProjectIntegrationState(message.projectId);
      case "REQUEST_PROJECT_INTEGRATION_RETRY":
        return requestProjectIntegrationRetryState(message.projectId, message.requiredChanges);
      case "REQUEST_PROJECT_APPROVAL":
        return requestProjectApprovalState(message.projectId, message.approval);
      case "DECIDE_PROJECT_APPROVAL":
        return decideProjectApprovalState(message.projectId, message.approvalId, message.decision, message.note);
      case "BUILD_PROJECT_RECONCILIATION_PROMPT":
        return buildProjectReconciliationPromptState(message.projectId);
      case "SUBMIT_PROJECT_RECONCILIATION":
        return submitProjectReconciliationState(message.projectId, message.output);
      case "GET_PROJECT_SELECTOR_HEALTH":
        return getProjectSelectorHealthState();
      case "DISPATCH_PROJECT_ASSIGNMENTS":
        return dispatchPreparedProjectAssignmentsState(message.projectId, message.dispatchIds, message.modelVerified);
      case "PROJECT_TASK_STATUS":
        return handleProjectTaskStatus(message);
      case "PROJECT_TASK_RESULT":
        return handleProjectTaskResult(message, sender);
      case "PROJECT_SUCCESSOR_TASK_RESULT":
        return handleProjectSuccessorTaskResult(message, sender);
      case "PROJECT_TASK_INTERRUPTED":
      case "PROJECT_TASK_ERROR":
        return failProjectDispatch(message, sender);
      case "CONTENT_READY": {
        const bootstraps = await loadProjectBootstraps();
        const projectBootstrap = findProjectBootstrapByTab(bootstraps, sender.tab?.id);
        if (projectBootstrap) {
          await dispatchProjectBootstrapJob(projectBootstrap.projectId, projectBootstrap.role);
          return { ok: true, projectBootstrap: publicProjectBootstrap(projectBootstrap.bootstrap) };
        }
        const projectStore = await loadProjectStore();
        const projectWorker = findProjectDispatchByTab(projectStore, sender.tab?.id);
        if (projectWorker) {
          const project = projectStore.projects[projectWorker.projectId];
          const conversationId = message.conversation?.id;
          const isSuccessor = Number(projectWorker.dispatch.successorGeneration || 0) > 0;
          if (!isSuccessor && conversationId !== (projectWorker.dispatch.conversationId || projectWorker.dispatch.workerChatId)) {
            await failProjectDispatch({
              projectId: projectWorker.projectId,
              dispatchId: projectWorker.dispatch.dispatchId,
              error: "The managed tab opened a different worker conversation."
            }, sender);
            return { ok: false };
          }
          const stored = await chrome.storage.local.get(SETTINGS_KEY);
          const settings = normalizeSettings({ ...(stored[SETTINGS_KEY] || {}), continuityEnabled: false, delaySeconds: 5 });
          await chrome.tabs.sendMessage(sender.tab.id, {
            type: isSuccessor ? "RUN_PROJECT_SUCCESSOR_TASK" : "RUN_PROJECT_TASK",
            jobId: projectWorker.dispatch.dispatchId,
            projectId: projectWorker.projectId,
            dispatchId: projectWorker.dispatch.dispatchId,
            workerChatId: projectWorker.dispatch.workerChatId,
            parentConversationId: projectWorker.dispatch.workerChatId,
            freshRequestId: projectWorker.dispatch.freshRequestId,
            prompt: projectWorker.dispatch.prompt,
            settings,
            project: { title: project.title, repository: project.repository }
          });
          return { ok: true, projectDispatchId: projectWorker.dispatch.dispatchId, successor: isSuccessor };
        }
        const state = await loadState();
        const index = findChatIndexByTab(state, sender.tab?.id);
        if (state?.running && index >= 0) return markContentReady(state, index);
        return publicState(state);
      }
      case "JOB_STATUS":
        return updateJobStatus(message, sender);
      case "JOB_DONE":
        return finishJob(message, sender);
      case "JOB_ERROR":
        return failJob(message, sender);
      case "JOB_INTERRUPTED":
      case "JOB_ROLLOVER":
        return interruptJob(message, sender);
      case "SUCCESSOR_CREATED":
        return successorCreated(message, sender);
      default:
        throw new Error(`Unknown AutoPrompter runtime command: ${String(message.type || "missing")}`);
    }
  };

  enqueue(operation)
    .then(result => sendResponse({ ok: true, ...result }))
    .catch(error => sendResponse({ ok: false, error: error.message }));
  return true;
});

chrome.tabs.onRemoved.addListener(tabId => {
  enqueue(async () => {
    const bootstraps = await loadProjectBootstraps();
    const bootstrapWorker = findProjectBootstrapByTab(bootstraps, tabId);
    if (bootstrapWorker) {
      await failProjectBootstrap(
        bootstrapWorker.projectId,
        bootstrapWorker.role,
        `The managed ${bootstrapWorker.role} bootstrap tab was closed.`
      );
      return;
    }
    const state = await loadState();
    const index = findChatIndexByTab(state, tabId);
    if (state?.running && index >= 0) {
      state.chats[index].workerTabId = null;
      await failChatWorker(state, index, "The managed ChatGPT tab was closed.", false);
    }
  }).catch(() => {});
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status !== "complete") return;
  enqueue(async () => {
    const state = await loadState();
    const index = findChatIndexByTab(state, tabId);
    if (state?.running && index >= 0 && state.chats[index].contentReady) {
      const initialBatch = Boolean(state.chats[index].initialJobPending);
      if (state.initialBatchReleased || !initialBatch) await sendChatJob(state, index, { initialBatch });
    }
  }).catch(() => {});
});

if (typeof module !== "undefined") {
  module.exports = {
    DEFAULTS,
    MAX_CONCURRENT_CHATS,
    normalizeSettings,
    normalizeRepository,
    normalizeHandoffFile,
    normalizeConversationUrl,
    isNewChatUrl,
    freshChatUrl,
    normalizeChat,
    nextEligibleIndex,
    eligibleChatIndexes,
    isChatEligible,
    buildSuccessorPrompt,
    buildFreshStartPrompt,
    CONNECTION_RETRY_PROMPT,
    MAX_CONNECTION_RETRIES,
    INITIAL_BATCH_GRACE_MS,
    PROJECT_BOOTSTRAP_KEY,
    MAX_PROJECT_BOOTSTRAP_REPAIRS,
    MAX_ROLE_INIT_RETRIES,
    buildProjectRolePrompt,
    buildPlannerRepairPrompt,
    publicProjectBootstrap,
    PlannerProtocol,
    WorkerProtocol,
    ResultProtocol,
    ReviewerProtocol,
    IntegrationProtocol,
    ProjectStore
  };
}
