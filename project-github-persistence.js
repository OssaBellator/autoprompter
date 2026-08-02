"use strict";

(function attachGitHubIssuePersistence(root, factory) {
  const projectStore = root.AutoPrompterProjectStore
    || (typeof require === "function" ? require("./project-store.js") : null);
  const api = factory(projectStore);
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.AutoPrompterGitHubIssuePersistence = api;
})(typeof globalThis !== "undefined" ? globalThis : self, ProjectStore => {
  const PATCH_FLAG = Symbol.for("autoprompter.githubIssuePersistence.installed");
  const MODE = "github_issues_and_pull_requests";
  const ISSUE_METADATA_BEGIN = "AUTOPROMPTER_ISSUE_METADATA_BEGIN";

  function clone(value) {
    return value == null ? value : structuredClone(value);
  }

  function issueBackedTask(task) {
    return Boolean(
      task?.githubIssue?.number
      || String(task?.description || "").includes(ISSUE_METADATA_BEGIN)
      || /^task-issue-\d+$/i.test(String(task?.id || ""))
    );
  }

  function isIssueProject(store, projectId, rawProject = null) {
    if (rawProject?.githubWorkflowMode === MODE || rawProject?.taskExecutionMode === MODE) return true;
    const tasks = Object.values(store?.tasksByProject?.[projectId] || {});
    if (tasks.some(issueBackedTask)) return true;
    const project = store?.projects?.[projectId];
    return Boolean(project && !tasks.length && ["draft", "planning"].includes(project.status));
  }

  function markMode(store, raw = null) {
    let changed = false;
    for (const [projectId, project] of Object.entries(store?.projects || {})) {
      if (!isIssueProject(store, projectId, raw?.projects?.[projectId])) continue;
      if (project.githubWorkflowMode !== MODE) {
        project.githubWorkflowMode = MODE;
        changed = true;
      }
      if (project.taskExecutionMode !== MODE) {
        project.taskExecutionMode = MODE;
        changed = true;
      }
      if (project.roles?.integratorChatId !== null) {
        project.roles.integratorChatId = null;
        changed = true;
      }
    }
    return changed;
  }

  function dependenciesAccepted(tasks, task) {
    return (Array.isArray(task?.dependencies) ? task.dependencies : [])
      .every(dependencyId => tasks?.[dependencyId]?.status === "accepted");
  }

  function unlockMergedDependencies(store, projectId, clock = Date.now) {
    const tasks = store?.tasksByProject?.[projectId] || {};
    const at = new Date(clock()).toISOString();
    const unlocked = [];
    for (const task of Object.values(tasks)) {
      if (task?.status !== "blocked" || !dependenciesAccepted(tasks, task)) continue;
      task.status = "ready";
      task.updatedAt = at;
      unlocked.push(task.id);
    }
    if (unlocked.length) {
      const events = Array.isArray(store.events) ? store.events : [];
      events.push({
        id: `${at}:issues_unblocked:${projectId}:${events.length}`,
        type: "issues_unblocked",
        projectId,
        at,
        detail: `Ready after prerequisite pull request merges: ${unlocked.join(", ")}`.slice(0, 500)
      });
      store.events = events.slice(-200);
      if (store.projects?.[projectId]) store.projects[projectId].updatedAt = at;
    }
    return unlocked;
  }

  function bindIssueDispatchMode(prepared, projectId) {
    const tasks = prepared.store.tasksByProject?.[projectId] || {};
    const dispatches = prepared.store.dispatchesByProject?.[projectId] || {};
    for (const assignment of prepared.assignments || []) {
      const dispatch = dispatches[assignment.dispatchId];
      const task = dispatch && tasks[dispatch.taskId];
      if (!dispatch || !task) continue;
      if (task.workerConversationId) {
        dispatch.workerChatId = task.workerConversationId;
        dispatch.conversationId = task.workerConversationId;
        dispatch.freshRequestId = null;
        dispatch.successorGeneration = 0;
        if (task.lease) task.lease.workerChatId = task.workerConversationId;
      } else {
        dispatch.successorGeneration = Math.max(1, Number(dispatch.successorGeneration || 0));
        dispatch.originalDispatchId = dispatch.originalDispatchId || dispatch.dispatchId;
      }
    }
    prepared.tasks = clone(tasks);
    prepared.dispatches = clone(dispatches);
    prepared.assignments = (prepared.assignments || []).map(item => clone(dispatches[item.dispatchId] || item));
    prepared.prepared = clone(prepared.assignments);
    return prepared;
  }

  function install(projectStore = ProjectStore) {
    if (!projectStore?.migrateStore || !projectStore?.prepareProjectDispatches || !projectStore?.submitProjectReview) {
      throw new Error("GitHub issue persistence dependencies are unavailable.");
    }
    if (projectStore[PATCH_FLAG]) return projectStore[PATCH_FLAG];

    const originalMigrateStore = projectStore.migrateStore.bind(projectStore);
    const originalPrepareProjectDispatches = projectStore.prepareProjectDispatches.bind(projectStore);
    const originalSubmitProjectReview = projectStore.submitProjectReview.bind(projectStore);

    projectStore.migrateStore = function migratePersistentIssueMode(raw) {
      const migrated = originalMigrateStore(raw);
      const changed = markMode(migrated.store, raw);
      return { ...migrated, migrated: migrated.migrated || changed };
    };

    projectStore.prepareProjectDispatches = function preparePersistentIssueDispatches(...args) {
      const prepared = originalPrepareProjectDispatches(...args);
      const projectId = prepared?.project?.projectId;
      if (projectId && isIssueProject(prepared.store, projectId)) {
        prepared.project.githubWorkflowMode = MODE;
        prepared.project.taskExecutionMode = MODE;
        prepared.project.roles.integratorChatId = null;
        prepared.store.projects[projectId] = clone(prepared.project);
        bindIssueDispatchMode(prepared, projectId);
      }
      return prepared;
    };

    projectStore.submitProjectReview = function submitPersistentIssueReview(storeInput, projectId, dispatchId, output, clock = Date.now) {
      const reviewed = originalSubmitProjectReview(storeInput, projectId, dispatchId, output, clock);
      if (reviewed?.project?.githubWorkflowMode === MODE && reviewed.review?.decision === "merged") {
        const unlocked = unlockMergedDependencies(reviewed.store, reviewed.project.projectId, clock);
        if (unlocked.length) {
          reviewed.project = clone(reviewed.store.projects[reviewed.project.projectId]);
          reviewed.task = clone(reviewed.store.tasksByProject[reviewed.project.projectId]?.[reviewed.task.id]);
          reviewed.runtimeSummary = projectStore.summarizeProjectRuntime(reviewed.store, reviewed.project.projectId);
        }
      }
      return reviewed;
    };

    const installed = {
      mode: MODE,
      originalMigrateStore,
      originalPrepareProjectDispatches,
      originalSubmitProjectReview
    };
    Object.defineProperty(projectStore, PATCH_FLAG, { value: installed, enumerable: false });
    return installed;
  }

  return {
    MODE,
    issueBackedTask,
    isIssueProject,
    markMode,
    dependenciesAccepted,
    unlockMergedDependencies,
    bindIssueDispatchMode,
    install
  };
});