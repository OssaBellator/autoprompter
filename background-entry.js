"use strict";

importScripts(
  "background.js",
  "background-project-api.js",
  "planner-compiler.js",
  "planner-fallback.js",
  "planner-no-repair.js",
  "project-auto-store.js",
  "project-admin.js",
  "project-task-board.js",
  "project-fresh-dispatch.js",
  "project-auto-bootstrap.js"
);
importScripts(
  "project-orchestrator.js",
  "project-task-board-controller.js",
  "bootstrap-upgrade.js"
);

if (
  !globalThis.AutoPrompterBackgroundProjectApi
  || !globalThis.AutoPrompterPlannerCompiler
  || !globalThis.AutoPrompterPlannerFallback
  || !globalThis.AutoPrompterPlannerNoRepair
  || !globalThis.AutoPrompterProjectAutoStore
  || !globalThis.AutoPrompterProjectAdmin
  || !globalThis.AutoPrompterProjectTaskBoard
  || !globalThis.AutoPrompterProjectFreshDispatch
  || !globalThis.AutoPrompterProjectAutoBootstrap
  || !globalThis.AutoPrompterProjectStore
  || !globalThis.AutoPrompterProjectOrchestrator
  || !globalThis.AutoPrompterProjectTaskBoardController
  || !globalThis.AutoPrompterBootstrapUpgrade
) {
  throw new Error("AutoPrompter task-board Project Mode runtime failed to initialize.");
}

globalThis.AutoPrompterPlannerCompiler.install(globalThis.AutoPrompterProjectStore);
globalThis.AutoPrompterPlannerFallback.install(globalThis.AutoPrompterProjectStore);
globalThis.AutoPrompterPlannerNoRepair.install(globalThis.AutoPrompterProjectStore);
globalThis.AutoPrompterProjectAutoStore.install(globalThis.AutoPrompterProjectStore);
globalThis.AutoPrompterProjectTaskBoard.install(globalThis.AutoPrompterProjectStore);
globalThis.AutoPrompterProjectAdmin.start();
globalThis.AutoPrompterProjectOrchestrator.start();
globalThis.AutoPrompterProjectTaskBoardController.start();
globalThis.AutoPrompterProjectAutoBootstrap.start();
globalThis.AutoPrompterBootstrapUpgrade.start();