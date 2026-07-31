"use strict";

(function attachProjectStore(root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.AutoPrompterProjectStore = api;
})(typeof globalThis !== "undefined" ? globalThis : self, () => {
  const PROJECTS_KEY = "autoprompterProjects";
  const STORE_SCHEMA_VERSION = "1.0";
  const PROJECT_SCHEMA_VERSION = "1.0";
  const MAX_PROJECT_EVENTS = 200;
  const ACTIVE_STATUSES = new Set(["draft", "planning", "ready", "running"]);
  const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled"]);
  const APPROVAL_ACTIONS = [
    "merge_to_default_branch",
    "publish_release",
    "modify_workflow",
    "change_permissions",
    "external_side_effect"
  ];

  function clone(value) {
    return value == null ? value : structuredClone(value);
  }

  function nowIso(clock = Date.now) {
    return new Date(clock()).toISOString();
  }

  function clampInteger(value, fallback, min, max) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, Math.round(parsed)));
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
    return /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(candidate) ? candidate : "";
  }

  function normalizeRelativePath(value, fallback = "AUTOPROMPTER_HANDOFF.md") {
    const path = String(value || fallback).trim().replace(/^\/+/, "");
    if (!path || path.includes("..") || path.includes("\0") || !/^[A-Za-z0-9_./-]+$/.test(path)) return fallback;
    return path.slice(0, 200);
  }

  function slugifyProjectId(value) {
    return String(value || "project")
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "")
      .slice(0, 48) || "project";
  }

  function normalizeChatId(value) {
    const id = String(value || "").trim();
    return id ? id.slice(0, 200) : null;
  }

  function uniqueChatIds(values) {
    return [...new Set((Array.isArray(values) ? values : []).map(normalizeChatId).filter(Boolean))].slice(0, 12);
  }

  function defaultModelPolicy() {
    return {
      mode: "manual_verified",
      classes: {
        fast: { displayName: "User-selected fast ChatGPT model", requiresUserVerification: true },
        standard: { displayName: "User-selected general ChatGPT model", requiresUserVerification: true },
        deep: { displayName: "User-selected high-reasoning ChatGPT model", requiresUserVerification: true }
      }
    };
  }

  function emptyStore() {
    return {
      schemaVersion: STORE_SCHEMA_VERSION,
      activeProjectId: null,
      projects: {},
      resumeStatusByProject: {},
      events: []
    };
  }

  function normalizeStoredProject(project) {
    if (!project || typeof project !== "object") return null;
    const repository = normalizeRepository(project.repository?.slug);
    if (!repository) return null;
    const projectId = String(project.projectId || "").trim();
    if (!/^[a-z0-9][a-z0-9._-]{2,63}$/.test(projectId)) return null;
    const status = ["draft", "planning", "ready", "running", "paused", "completed", "failed", "cancelled"].includes(project.status)
      ? project.status
      : "draft";
    const roles = project.roles || {};
    const workerChatIds = uniqueChatIds(roles.workerChatIds);
    const roleIds = [roles.plannerChatId, roles.reviewerChatId, roles.integratorChatId].map(normalizeChatId);
    if (new Set(roleIds.filter(Boolean)).size !== roleIds.filter(Boolean).length) return null;
    const roleSet = new Set(roleIds.filter(Boolean));
    const filteredWorkers = workerChatIds.filter(id => !roleSet.has(id));
    const createdAt = String(project.createdAt || new Date(0).toISOString());
    const updatedAt = String(project.updatedAt || createdAt);
    return {
      schemaVersion: PROJECT_SCHEMA_VERSION,
      projectId,
      title: String(project.title || "Untitled project").trim().slice(0, 160) || "Untitled project",
      goal: String(project.goal || "").trim().slice(0, 12000),
      classification: ["one_off", "project", "large_project"].includes(project.classification) ? project.classification : "large_project",
      status,
      repository: {
        slug: repository,
        defaultBranch: String(project.repository?.defaultBranch || "main").trim().slice(0, 200) || "main",
        handoffFile: normalizeRelativePath(project.repository?.handoffFile)
      },
      roles: {
        plannerChatId: roleIds[0],
        reviewerChatId: roleIds[1],
        integratorChatId: roleIds[2],
        workerChatIds: filteredWorkers
      },
      scheduler: {
        maxConcurrentWorkers: clampInteger(project.scheduler?.maxConcurrentWorkers, Math.max(1, Math.min(3, filteredWorkers.length || 1)), 1, 12),
        readinessGraceMs: clampInteger(project.scheduler?.readinessGraceMs, 5000, 1000, 60000),
        leaseMinutes: clampInteger(project.scheduler?.leaseMinutes, 120, 5, 1440),
        revisionLimit: clampInteger(project.scheduler?.revisionLimit, 2, 0, 10),
        circuitBreakerEnabled: project.scheduler?.circuitBreakerEnabled !== false,
        approvalActions: [...new Set((Array.isArray(project.scheduler?.approvalActions)
          ? project.scheduler.approvalActions
          : APPROVAL_ACTIONS).filter(action => APPROVAL_ACTIONS.includes(action)))]
      },
      modelPolicy: clone(project.modelPolicy && typeof project.modelPolicy === "object" ? project.modelPolicy : defaultModelPolicy()),
      createdAt,
      updatedAt
    };
  }

  function migrateStore(raw) {
    if (!raw) return { store: emptyStore(), migrated: true };
    if (raw.schemaVersion === STORE_SCHEMA_VERSION && raw.projects && !Array.isArray(raw.projects)) {
      const store = emptyStore();
      for (const [id, project] of Object.entries(raw.projects)) {
        const normalized = normalizeStoredProject(project);
        if (normalized && normalized.projectId === id) store.projects[id] = normalized;
      }
      store.activeProjectId = store.projects[raw.activeProjectId] ? raw.activeProjectId : null;
      store.resumeStatusByProject = raw.resumeStatusByProject && typeof raw.resumeStatusByProject === "object"
        ? Object.fromEntries(Object.entries(raw.resumeStatusByProject).filter(([id, status]) => store.projects[id] && ACTIVE_STATUSES.has(status)))
        : {};
      store.events = Array.isArray(raw.events) ? raw.events.slice(-MAX_PROJECT_EVENTS) : [];
      return { store, migrated: JSON.stringify(store) !== JSON.stringify(raw) };
    }
    if (raw.schemaVersion === "0.1" && Array.isArray(raw.projects)) {
      const store = emptyStore();
      for (const project of raw.projects) {
        const normalized = normalizeStoredProject(project);
        if (normalized) store.projects[normalized.projectId] = normalized;
      }
      store.activeProjectId = store.projects[raw.activeProjectId] ? raw.activeProjectId : Object.keys(store.projects)[0] || null;
      return { store, migrated: true };
    }
    throw new Error(`Unsupported Project Mode store schema: ${String(raw.schemaVersion || "unknown")}`);
  }

  function appendEvent(store, type, projectId, at, detail = "") {
    store.events.push({
      id: `${at}:${type}:${projectId}:${store.events.length}`,
      type,
      projectId,
      at,
      detail: String(detail || "").slice(0, 500)
    });
    store.events = store.events.slice(-MAX_PROJECT_EVENTS);
  }

  function createProject(storeInput, input, clock = Date.now) {
    const store = clone(storeInput);
    const title = String(input?.title || "").trim().slice(0, 160);
    const goal = String(input?.goal || "").trim().slice(0, 12000);
    const repository = normalizeRepository(input?.repository);
    if (!title) throw new Error("Project title is required.");
    if (!goal) throw new Error("Project goal is required.");
    if (!repository) throw new Error("A valid GitHub repository is required.");

    const plannerChatId = normalizeChatId(input?.plannerChatId);
    const reviewerChatId = normalizeChatId(input?.reviewerChatId);
    const integratorChatId = normalizeChatId(input?.integratorChatId);
    const fixedRoles = [plannerChatId, reviewerChatId, integratorChatId].filter(Boolean);
    if (new Set(fixedRoles).size !== fixedRoles.length) throw new Error("Planner, reviewer, and integrator chats must be different.");
    const fixedRoleSet = new Set(fixedRoles);
    const workerChatIds = uniqueChatIds(input?.workerChatIds).filter(id => !fixedRoleSet.has(id));

    const baseId = slugifyProjectId(input?.projectId || title);
    let projectId = baseId;
    let suffix = 2;
    while (store.projects[projectId]) projectId = `${baseId.slice(0, 58)}-${suffix++}`;
    if (projectId.length < 3) projectId = `project-${Math.abs(clock()).toString(36).slice(-8)}`;
    const at = nowIso(clock);
    const project = normalizeStoredProject({
      schemaVersion: PROJECT_SCHEMA_VERSION,
      projectId,
      title,
      goal,
      classification: input?.classification || "large_project",
      status: "draft",
      repository: {
        slug: repository,
        defaultBranch: input?.defaultBranch || "main",
        handoffFile: input?.handoffFile || "AUTOPROMPTER_HANDOFF.md"
      },
      roles: { plannerChatId, reviewerChatId, integratorChatId, workerChatIds },
      scheduler: {
        maxConcurrentWorkers: input?.maxConcurrentWorkers || Math.max(1, Math.min(3, workerChatIds.length || 1)),
        readinessGraceMs: input?.readinessGraceMs || 5000,
        leaseMinutes: input?.leaseMinutes || 120,
        revisionLimit: input?.revisionLimit ?? 2,
        circuitBreakerEnabled: input?.circuitBreakerEnabled !== false,
        approvalActions: input?.approvalActions || APPROVAL_ACTIONS
      },
      modelPolicy: input?.modelPolicy || defaultModelPolicy(),
      createdAt: at,
      updatedAt: at
    });
    if (!project) throw new Error("Project could not be normalized.");
    store.projects[projectId] = project;
    store.activeProjectId = projectId;
    appendEvent(store, "project_created", projectId, at, "Project Mode draft created");
    return { store, project: clone(project) };
  }

  function inspectProject(storeInput, projectId = "") {
    const store = clone(storeInput);
    const id = String(projectId || store.activeProjectId || "");
    const project = store.projects[id];
    if (!project) throw new Error("Project not found.");
    return { store, project: clone(project), events: store.events.filter(event => event.projectId === id) };
  }

  function transitionProject(storeInput, projectId, action, clock = Date.now) {
    const store = clone(storeInput);
    const id = String(projectId || store.activeProjectId || "");
    const project = store.projects[id];
    if (!project) throw new Error("Project not found.");
    const at = nowIso(clock);

    if (action === "pause") {
      if (!ACTIVE_STATUSES.has(project.status)) throw new Error(`Cannot pause a ${project.status} project.`);
      store.resumeStatusByProject[id] = project.status;
      project.status = "paused";
    } else if (action === "resume") {
      if (project.status !== "paused") throw new Error("Only a paused project can be resumed.");
      project.status = ACTIVE_STATUSES.has(store.resumeStatusByProject[id]) ? store.resumeStatusByProject[id] : "draft";
      delete store.resumeStatusByProject[id];
    } else if (action === "cancel") {
      if (TERMINAL_STATUSES.has(project.status)) throw new Error(`Cannot cancel a ${project.status} project.`);
      project.status = "cancelled";
      delete store.resumeStatusByProject[id];
    } else {
      throw new Error(`Unknown project transition: ${action}`);
    }

    project.updatedAt = at;
    store.activeProjectId = id;
    const eventType = action === "cancel" ? "project_cancelled" : `project_${action}d`;
    appendEvent(store, eventType, id, at, `Status changed to ${project.status}`);
    return { store, project: clone(project) };
  }

  function listProjects(storeInput) {
    const store = clone(storeInput);
    return Object.values(store.projects)
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
      .map(project => clone(project));
  }

  return {
    PROJECTS_KEY,
    STORE_SCHEMA_VERSION,
    PROJECT_SCHEMA_VERSION,
    APPROVAL_ACTIONS,
    emptyStore,
    migrateStore,
    normalizeRepository,
    normalizeRelativePath,
    normalizeStoredProject,
    createProject,
    inspectProject,
    transitionProject,
    listProjects
  };
});
