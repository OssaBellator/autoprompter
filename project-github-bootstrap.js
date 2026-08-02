"use strict";

(function attachGitHubIssueBootstrap(root, factory) {
  const api = factory(root);
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.AutoPrompterGitHubIssueBootstrap = api;
})(typeof globalThis !== "undefined" ? globalThis : self, root => {
  const CATALOG_KEY = "autoprompterChatCatalog";
  const ROLE_KEYS = Object.freeze({ planner: "plannerChatId", reviewer: "reviewerChatId" });
  let installed = false;

  function rolePrompt(project, role) {
    const responsibility = role === "planner"
      ? "Use the connected write-capable GitHub plugin to inspect the repository, create the actual scoped GitHub issues requested by the planning prompt, and return only the verified issue manifest. Do not implement code or open pull requests."
      : "Act as the combined pull-request reviewer and merger. Inspect each assigned issue and pull request with the connected GitHub plugin. Merge only when ready; otherwise post actionable feedback and leave the pull request open for its persistent worker.";
    return [
      `You are the dedicated ${role === "reviewer" ? "pull-request reviewer and merger" : role} agent for AutoPrompter GitHub Issue Mode.`,
      `Project: ${project.title} (${project.projectId})`,
      `Repository: ${project.repository.slug}`,
      responsibility,
      "Use repository evidence and the exact structured envelopes requested by later prompts.",
      "Do not claim GitHub actions succeeded without verifying the resulting issue, pull request, comment, or merge on GitHub.",
      "Acknowledge initialization with exactly this single line and no other text:",
      `AUTOPROMPTER_ROLE_READY: ${role}`
    ].join("\n");
  }

  async function startBootstrap(projectId) {
    const scheduler = await root.loadState();
    if (scheduler?.running) throw new Error("Stop the normal AutoPrompter scheduler before creating Project Mode role chats.");
    let store = await root.loadProjectStore();
    const project = store.projects?.[projectId];
    if (!project) throw new Error("Project not found.");
    if (store.approvedPlansByProject?.[projectId] || Object.keys(store.tasksByProject?.[projectId] || {}).length) {
      throw new Error("This project already has GitHub issue records or approved work.");
    }
    const bootstraps = await root.loadProjectBootstraps();
    const existing = bootstraps[projectId];
    if (existing && ["starting", "running"].includes(existing.status)) {
      return { bootstrap: root.publicProjectBootstrap(existing), project };
    }

    const stored = await root.chrome.storage.local.get(CATALOG_KEY);
    const catalog = Array.isArray(stored[CATALOG_KEY]) ? stored[CATALOG_KEY] : [];
    const byId = new Map(catalog.map(chat => [chat.id, chat]));
    const roleNames = Object.keys(ROLE_KEYS);
    const tabs = await Promise.all(roleNames.map(() => root.chrome.tabs.create({ url: "about:blank", active: false })));
    const createdAt = new Date().toISOString();
    const roles = {};

    try {
      for (let index = 0; index < roleNames.length; index += 1) {
        const role = roleNames[index];
        const chatId = project.roles?.[ROLE_KEYS[role]] || null;
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
          prompt: rolePrompt(project, role),
          freshRequestId: `${projectId}:${role}:${Date.now()}:${index}`
        };
      }
    } catch (error) {
      await root.removeManagedTabs(tabs.map(tab => tab.id));
      throw error;
    }

    const bootstrap = {
      projectId,
      mode: "github_issues_and_pull_requests",
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
    project.githubWorkflowMode = "github_issues_and_pull_requests";
    project.roles.integratorChatId = null;
    project.updatedAt = createdAt;
    await root.saveProjectStore(store);
    await root.saveProjectBootstraps(bootstraps);

    try {
      await Promise.all(roleNames.map(async role => {
        const state = roles[role];
        const target = state.chatId
          ? byId.get(state.chatId).url
          : root.freshChatUrl(state.freshRequestId, projectId, role);
        await root.chrome.tabs.update(state.tabId, { url: target, active: false });
      }));
    } catch (error) {
      return root.failProjectBootstrap(projectId, "planner", `Could not open GitHub Issue Mode role chats: ${error?.message || String(error)}`);
    }

    bootstrap.status = "running";
    bootstrap.updatedAt = new Date().toISOString();
    await root.saveProjectBootstraps(bootstraps);
    return { project, bootstrap: root.publicProjectBootstrap(bootstrap) };
  }

  async function approveWhenReady(projectId, bootstraps) {
    const bootstrap = bootstraps?.[projectId];
    if (!bootstrap?.planValidated || bootstrap.planApproved) return false;
    if (bootstrap.roles?.reviewer?.stage !== "completed") return false;

    const ProjectStore = root.AutoPrompterProjectStore;
    let store = await root.loadProjectStore();
    const approved = ProjectStore.approveProjectPlan(store, projectId);
    const started = ProjectStore.startProject(approved.store, projectId);
    let finalStore = started.store;
    let assignments = [];
    try {
      const prepared = ProjectStore.prepareProjectDispatches(finalStore, projectId);
      finalStore = prepared.store;
      assignments = prepared.assignments || [];
    } catch {
      // A dependency-only issue plan may have no immediately ready issue.
    }
    await root.saveProjectStore(finalStore);

    bootstrap.planApproved = true;
    bootstrap.planSummary = approved.summary;
    bootstrap.assignmentCount = assignments.length;
    bootstrap.roles.planner.stage = "completed";
    bootstrap.roles.planner.status = `GitHub issues approved; ${assignments.length} issue worker${assignments.length === 1 ? "" : "s"} prepared`;
    bootstrap.roles.planner.error = "";
    bootstrap.roles.planner.jobDispatched = false;
    bootstrap.updatedAt = new Date().toISOString();
    await root.saveProjectBootstraps(bootstraps);
    await root.maybeCompleteProjectBootstrap(projectId, bootstraps);
    return true;
  }

  function install() {
    if (installed) return true;
    if (
      typeof root.startProjectBootstrapState !== "function"
      || typeof root.handleProjectBootstrapResult !== "function"
      || typeof root.loadProjectStore !== "function"
    ) return false;

    installed = true;
    const originalHandleResult = root.handleProjectBootstrapResult;
    root.buildProjectRolePrompt = rolePrompt;
    root.startProjectBootstrapState = startBootstrap;
    root.handleProjectBootstrapResult = async function handleGitHubBootstrapResult(message, sender) {
      const response = await originalHandleResult(message, sender);
      if (["role_init", "planner_plan", "planner_repair"].includes(message?.stage)) {
        const bootstraps = await root.loadProjectBootstraps();
        const approved = await approveWhenReady(message.projectId, bootstraps);
        if (approved) {
          return {
            ...response,
            approved: true,
            bootstrap: root.publicProjectBootstrap(bootstraps[message.projectId])
          };
        }
      }
      return response;
    };
    return true;
  }

  if (typeof importScripts === "function") install();

  return {
    CATALOG_KEY,
    ROLE_KEYS,
    rolePrompt,
    startBootstrap,
    approveWhenReady,
    install
  };
});