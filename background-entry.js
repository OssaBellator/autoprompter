"use strict";

importScripts(
  "background.js",
  "autocontinue-unlimited-retries.js",
  "project-github-bootstrap.js",
  "project-github-repair.js",
  "background-project-api.js",
  "planner-compiler.js",
  "planner-fallback.js",
  "planner-no-repair.js",
  "planner-parallel-policy.js",
  "project-fresh-capacity.js",
  "project-auto-store.js",
  "project-admin.js",
  "project-task-board.js",
  "project-github-workflow.js",
  "project-github-persistence.js",
  "project-fresh-dispatch.js",
  "project-github-dispatch.js",
  "project-auto-bootstrap.js",
  "project-plan-recovery.js"
);
importScripts(
  "project-orchestrator.js",
  "project-role-kick.js",
  "project-task-board-controller.js",
  "bootstrap-upgrade.js"
);

if (
  !globalThis.AutoPrompterUnlimitedConnectionRetries
  || !globalThis.AutoPrompterGitHubIssueBootstrap
  || !globalThis.AutoPrompterGitHubIssueRepair
  || !globalThis.AutoPrompterBackgroundProjectApi
  || !globalThis.AutoPrompterPlannerCompiler
  || !globalThis.AutoPrompterPlannerFallback
  || !globalThis.AutoPrompterPlannerNoRepair
  || !globalThis.AutoPrompterPlannerParallelPolicy
  || !globalThis.AutoPrompterProjectFreshCapacity
  || !globalThis.AutoPrompterProjectAutoStore
  || !globalThis.AutoPrompterProjectAdmin
  || !globalThis.AutoPrompterProjectTaskBoard
  || !globalThis.AutoPrompterGitHubIssueWorkflow
  || !globalThis.AutoPrompterGitHubIssuePersistence
  || !globalThis.AutoPrompterProjectFreshDispatch
  || !globalThis.AutoPrompterGitHubIssueDispatch
  || !globalThis.AutoPrompterProjectAutoBootstrap
  || !globalThis.AutoPrompterProjectPlanRecovery
  || !globalThis.AutoPrompterProjectStore
  || !globalThis.AutoPrompterProjectOrchestrator
  || !globalThis.AutoPrompterProjectRoleKick
  || !globalThis.AutoPrompterProjectTaskBoardController
  || !globalThis.AutoPrompterBootstrapUpgrade
) {
  throw new Error("AutoPrompter GitHub Issue Mode runtime failed to initialize.");
}

globalThis.AutoPrompterPlannerCompiler.install(globalThis.AutoPrompterProjectStore);
globalThis.AutoPrompterPlannerFallback.install(globalThis.AutoPrompterProjectStore);
globalThis.AutoPrompterPlannerNoRepair.install(globalThis.AutoPrompterProjectStore);
globalThis.AutoPrompterPlannerParallelPolicy.install(globalThis.AutoPrompterProjectStore);
globalThis.AutoPrompterProjectFreshCapacity.install(globalThis.AutoPrompterProjectStore);
globalThis.AutoPrompterProjectAutoStore.install(globalThis.AutoPrompterProjectStore);
globalThis.AutoPrompterProjectTaskBoard.install(globalThis.AutoPrompterProjectStore);
globalThis.AutoPrompterGitHubIssueWorkflow.install(globalThis.AutoPrompterProjectStore);
globalThis.AutoPrompterGitHubIssuePersistence.install(globalThis.AutoPrompterProjectStore);
globalThis.AutoPrompterGitHubIssueDispatch.install();
globalThis.AutoPrompterProjectAdmin.start();
globalThis.AutoPrompterProjectPlanRecovery.start();
globalThis.AutoPrompterProjectOrchestrator.start();
globalThis.AutoPrompterProjectRoleKick.start();
globalThis.AutoPrompterProjectTaskBoardController.start();
globalThis.AutoPrompterProjectAutoBootstrap.start();
globalThis.AutoPrompterBootstrapUpgrade.start();
