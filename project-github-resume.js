"use strict";

(function attachGitHubIssueResume(root, factory) {
  const projectStore = root.AutoPrompterProjectStore
    || (typeof require === "function" ? require("./project-store.js") : null);
  const backgroundApi = root.AutoPrompterBackgroundProjectApi || null;
  const api = factory(root, projectStore, backgroundApi);
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.AutoPrompterGitHubIssueResume = api;
})(typeof globalThis !== "undefined" ? globalThis : self, (root, ProjectStore, BackgroundApi) => {
  const MODE = "github_issues_and_pull_requests";
  const BOOTSTRAP_KEY = "autoprompterProjectBootstraps";
  const RESUME_SCOPE = "AUTOPROMPTER_GITHUB_RESUME";
  const RESUME_TYPE = "RESUME_PROJECT_STAGE";
  const PATCH_FLAG = Symbol.for("autoprompter.githubIssueResume.installed");
  let baseTransitionProjectState = null;

  function isIssueProject(project) {
    return Boolean(project && (project.githubWorkflowMode === MODE || project.taskExecutionMode === MODE));
  }

  function bootstrapCanResume(bootstrap) {
    return ["failed", "cancelled"].includes(String(bootstrap?.status || ""));
  }

  function resumedStatus(store, projectId) {
    const tasks = Object.values(store?.tasksByProject?.[projectId] || {});
    const approved = store?.approvedPlansByProject?.[projectId];
    if (tasks.length && approved) {
      return tasks.every(task => task?.status === "accepted") ? "completed" : "running";
    }
    if (store?.pendingPlansByProject?.[projectId]) return "planning";
    return "draft";
  }

  function appendResumeEvent(store, projectId, status, clock = Date.now) {
    const at = new Date(clock()).toISOString();
    const events = Array.isArray(store.events) ? store.events : [];
    events.push({
      id: `${at}:project_stage_resumed:${projectId}:${events.length}`,
      type: "project_stage_resumed",
      projectId,
      at,
      detail: `Resumed GitHub issue workflow at ${status}`
    });
    store.events = events.slice(-200);
    return at;
  }

  async function loadBootstraps() {
    if (typeof root.loadProjectBootstraps === "function") return root.loadProjectBootstraps();
    const stored = await root.chrome.storage.local.get(BOOTSTRAP_KEY);
    return stored?.[BOOTSTRAP_KEY] && typeof stored[BOOTSTRAP_KEY] === "object"
      ? stored[BOOTSTRAP_KEY]
      : {};
  }

  async function resumeProjectStage(projectId) {
    const store = await root.loadProjectStore();
    const project = store.projects?.[projectId];
    if (!isIssueProject(project)) return { stage: "project", started: false };
    const tasks = Object.keys(store.tasksByProject?.[projectId] || {});
    const approved = store.approvedPlansByProject?.[projectId];

    if (tasks.length && approved) {
      if (root.AutoPrompterProjectTaskBoardController?.reconcile) {
        await root.AutoPrompterProjectTaskBoardController.reconcile();
      }
      return { stage: "issue_workers", started: true, taskCount: tasks.length };
    }

    if (!BackgroundApi?.startProjectBootstrap) {
      throw new Error("GitHub issue stage recovery is unavailable.");
    }
    const result = await BackgroundApi.startProjectBootstrap(projectId);
    return {
      stage: store.pendingPlansByProject?.[projectId] ? "task_creation" : "issue_manifest",
      started: true,
      bootstrap: result?.bootstrap || null
    };
  }

  async function transitionGitHubProjectState(projectId, action = "resume") {
    if (action !== "resume") {
      if (typeof baseTransitionProjectState !== "function") throw new Error("Project transitions are unavailable.");
      return baseTransitionProjectState(projectId, action);
    }

    let store = await root.loadProjectStore();
    const project = store.projects?.[projectId];
    if (!project) throw new Error("Project not found.");
    if (!isIssueProject(project)) {
      if (typeof baseTransitionProjectState !== "function") throw new Error("Project transitions are unavailable.");
      return baseTransitionProjectState(projectId, action);
    }

    const bootstraps = await loadBootstraps();
    const bootstrap = bootstraps[projectId];
    let transitionResult;

    if (project.status === "paused") {
      if (typeof baseTransitionProjectState !== "function") throw new Error("Project transitions are unavailable.");
      transitionResult = await baseTransitionProjectState(projectId, action);
    } else if (bootstrapCanResume(bootstrap) || project.status === "failed") {
      const status = resumedStatus(store, projectId);
      const at = appendResumeEvent(store, projectId, status);
      project.status = status;
      project.updatedAt = at;
      store.activeProjectId = projectId;
      delete store.resumeStatusByProject[projectId];
      await root.saveProjectStore(store);
      transitionResult = {
        projectStoreVersion: store.schemaVersion,
        activeProjectId: projectId,
        projects: ProjectStore.listProjects(store),
        project: store.projects[projectId]
      };
    } else {
      if (typeof baseTransitionProjectState !== "function") throw new Error("Project transitions are unavailable.");
      return baseTransitionProjectState(projectId, action);
    }

    const resumed = await resumeProjectStage(projectId);
    store = await root.loadProjectStore();
    return {
      ...transitionResult,
      activeProjectId: projectId,
      projects: ProjectStore.listProjects(store),
      project: store.projects[projectId],
      resumed
    };
  }

  function startResumeListener() {
    if (!root.chrome?.runtime?.onMessage) return false;
    root.chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message?.scope !== RESUME_SCOPE || message?.type !== RESUME_TYPE) return false;
      transitionGitHubProjectState(String(message.projectId || ""), "resume")
        .then(result => sendResponse({ ok: true, ...result }))
        .catch(error => sendResponse({ ok: false, error: error?.message || String(error) }));
      return true;
    });
    return true;
  }

  function install() {
    if (root[PATCH_FLAG]) return root[PATCH_FLAG];
    if (
      !ProjectStore
      || typeof root.transitionProjectState !== "function"
      || typeof root.loadProjectStore !== "function"
      || typeof root.saveProjectStore !== "function"
    ) {
      throw new Error("GitHub issue resume dependencies are unavailable.");
    }

    baseTransitionProjectState = root.transitionProjectState;
    root.transitionProjectState = transitionGitHubProjectState;
    const listenerStarted = startResumeListener();

    const installed = { originalTransitionProjectState: baseTransitionProjectState, listenerStarted };
    Object.defineProperty(root, PATCH_FLAG, { value: installed, enumerable: false });
    return installed;
  }

  return {
    MODE,
    BOOTSTRAP_KEY,
    RESUME_SCOPE,
    RESUME_TYPE,
    isIssueProject,
    bootstrapCanResume,
    resumedStatus,
    appendResumeEvent,
    resumeProjectStage,
    transitionGitHubProjectState,
    startResumeListener,
    install
  };
});
