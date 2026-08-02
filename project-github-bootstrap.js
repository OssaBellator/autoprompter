"use strict";

(function attachGitHubIssueBootstrap(root, factory) {
  const api = factory(root);
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.AutoPrompterGitHubIssueBootstrap = api;
})(typeof globalThis !== "undefined" ? globalThis : self, root => {
  const CATALOG_KEY = "autoprompterChatCatalog";
  const ROLE_KEYS = Object.freeze({ planner: "plannerChatId", reviewer: "reviewerChatId" });
  const INITIALIZED_PLANNER_STAGES = new Set(["planner_plan", "planner_repair", "planner_validated", "completed"]);
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

  function conversationUrl(chatId) {
    const id = String(chatId || "").trim();
    return id ? `https://chatgpt.com/c/${encodeURIComponent(id)}` : "";
  }

  function roleWasInitialized(existing, role) {
    const state = existing?.roles?.[role];
    if (!state) return false;
    if (role === "reviewer") return state.stage === "completed";
    return INITIALIZED_PLANNER_STAGES.has(state.stage)
      || Boolean(existing.planValidated)
      || Number(existing.repairAttempts || 0) > 0;
  }

  function shouldRecoverIssueManifest(existing, project) {
    return Boolean(
      project?.roles?.plannerChatId
      && existing
      && (
        ["failed", "cancelled"].includes(existing.status)
        || Number(existing.repairAttempts || 0) > 0
        || roleWasInitialized(existing, "planner")
      )
    );
  }

  function recoveryPlannerPrompt(project, normalPrompt) {
    const adjusted = String(normalPrompt || "")
      .replace(
        "Use the connected write-capable GitHub plugin/tool to inspect the repository and create the actual GitHub issues before answering.",
        "Use the connected write-capable GitHub plugin/tool to inspect the repository and the issues that already exist for this project before answering."
      )
      .replace(
        "Create one issue for every independently executable unit of work.",
        "Ensure one existing issue represents every independently executable unit of work."
      );
    return [
      "Resume the existing AutoPrompter GitHub issue-planning stage. Do not initialize or acknowledge the planner role again.",
      "The previous run may already have created the required GitHub issues. Search the repository's current issues first and reuse the exact existing issue numbers and URLs.",
      "Do not create duplicate issues. Create an issue only when an equivalent scoped issue does not already exist, and create only the missing issue.",
      "Return the newest verified issue manifest requested below. Do not repeat an older manifest and do not include prose outside the envelope.",
      adjusted
    ].join("\n\n");
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
    const createdAt = new Date().toISOString();
    const pendingPlan = store.pendingPlansByProject?.[projectId] || null;
    const recoverManifest = shouldRecoverIssueManifest(existing, project);
    const roles = {};
    const createdTabs = [];

    try {
      for (let index = 0; index < roleNames.length; index += 1) {
        const role = roleNames[index];
        const chatId = project.roles?.[ROLE_KEYS[role]] || null;
        const initialized = roleWasInitialized(existing, role);

        if (role === "reviewer" && initialized && chatId) {
          roles[role] = {
            role,
            chatId,
            tabId: null,
            stage: "completed",
            status: "Existing reviewer/merger role reused",
            error: "",
            retries: 0,
            jobDispatched: false,
            jobId: null,
            prompt: "",
            freshRequestId: null
          };
          continue;
        }

        if (role === "planner" && pendingPlan && initialized && chatId) {
          roles[role] = {
            role,
            chatId,
            tabId: null,
            stage: "planner_validated",
            status: "Validated issue manifest recovered; creating task records",
            error: "",
            retries: 0,
            jobDispatched: false,
            jobId: null,
            prompt: "",
            freshRequestId: null
          };
          continue;
        }

        const tab = await root.chrome.tabs.create({ url: "about:blank", active: false });
        createdTabs.push(tab.id);
        let stage = "role_init";
        let prompt = rolePrompt(project, role);
        if (role === "planner" && initialized && chatId) {
          const planned = root.AutoPrompterProjectStore.buildProjectPlannerPrompt(store, projectId);
          stage = "planner_plan";
          prompt = recoverManifest ? recoveryPlannerPrompt(project, planned.prompt) : planned.prompt;
        }
        roles[role] = {
          role,
          chatId,
          tabId: tab.id,
          stage,
          status: stage === "role_init" ? "Opening role chat" : "Recovering existing GitHub issue manifest",
          error: "",
          retries: 0,
          jobDispatched: false,
          jobId: null,
          prompt,
          freshRequestId: chatId ? null : `${projectId}:${role}:${Date.now()}:${index}`
        };
      }
    } catch (error) {
      await root.removeManagedTabs(createdTabs);
      throw error;
    }

    const bootstrap = {
      projectId,
      mode: "github_issues_and_pull_requests",
      status: "starting",
      error: "",
      repairAttempts: 0,
      planValidated: Boolean(pendingPlan),
      planApproved: false,
      resumedFromStatus: existing?.status || null,
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
        if (!Number.isInteger(state.tabId)) return;
        const target = state.chatId
          ? (byId.get(state.chatId)?.url || conversationUrl(state.chatId))
          : root.freshChatUrl(state.freshRequestId, projectId, role);
        await root.chrome.tabs.update(state.tabId, { url: target, active: false });
      }));
    } catch (error) {
      return root.failProjectBootstrap(projectId, "planner", `Could not open GitHub Issue Mode role chats: ${error?.message || String(error)}`);
    }

    bootstrap.status = "running";
    bootstrap.updatedAt = new Date().toISOString();
    await root.saveProjectBootstraps(bootstraps);
    if (bootstrap.planValidated) await approveWhenReady(projectId, bootstraps);
    return { project: (await root.loadProjectStore()).projects[projectId], bootstrap: root.publicProjectBootstrap(bootstrap) };
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
    INITIALIZED_PLANNER_STAGES: [...INITIALIZED_PLANNER_STAGES],
    rolePrompt,
    conversationUrl,
    roleWasInitialized,
    shouldRecoverIssueManifest,
    recoveryPlannerPrompt,
    startBootstrap,
    approveWhenReady,
    install
  };
});
