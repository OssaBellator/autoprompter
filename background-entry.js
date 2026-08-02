"use strict";

importScripts(
  "background.js",
  "background-project-api.js",
  "planner-compiler.js",
  "planner-fallback.js",
  "planner-no-repair.js",
  "project-auto-store.js",
  "project-admin.js"
);
importScripts(
  "repository-bootstrap.js",
  "repository-bootstrap-scope.js",
  "project-action-protocol.js",
  "project-orchestrator.js",
  "project-full-auto.js",
  "bootstrap-upgrade.js"
);

if (
  !globalThis.AutoPrompterBackgroundProjectApi
  || !globalThis.AutoPrompterPlannerCompiler
  || !globalThis.AutoPrompterPlannerFallback
  || !globalThis.AutoPrompterPlannerNoRepair
  || !globalThis.AutoPrompterProjectAutoStore
  || !globalThis.AutoPrompterProjectAdmin
  || !globalThis.AutoPrompterProjectStore
  || !globalThis.AutoPrompterRepositoryBootstrap
  || !globalThis.AutoPrompterRepositoryBootstrapScope
  || !globalThis.AutoPrompterProjectActionProtocol
  || !globalThis.AutoPrompterProjectOrchestrator
  || !globalThis.AutoPrompterProjectFullAuto
  || !globalThis.AutoPrompterBootstrapUpgrade
) {
  throw new Error("AutoPrompter full-auto Project Mode runtime failed to initialize.");
}

globalThis.AutoPrompterPlannerCompiler.install(globalThis.AutoPrompterProjectStore);
globalThis.AutoPrompterPlannerFallback.install(globalThis.AutoPrompterProjectStore);
globalThis.AutoPrompterPlannerNoRepair.install(globalThis.AutoPrompterProjectStore);
globalThis.AutoPrompterProjectAutoStore.install(globalThis.AutoPrompterProjectStore);
globalThis.AutoPrompterProjectAdmin.start();
globalThis.AutoPrompterProjectOrchestrator.start();
globalThis.AutoPrompterProjectFullAuto.start();
globalThis.AutoPrompterBootstrapUpgrade.start();
