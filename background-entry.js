"use strict";

importScripts("background.js", "background-project-api.js", "planner-compiler.js", "planner-fallback.js");
importScripts(
  "repository-bootstrap.js",
  "project-action-protocol.js",
  "project-orchestrator.js",
  "project-full-auto.js",
  "bootstrap-upgrade.js"
);

if (
  !globalThis.AutoPrompterBackgroundProjectApi
  || !globalThis.AutoPrompterPlannerCompiler
  || !globalThis.AutoPrompterPlannerFallback
  || !globalThis.AutoPrompterProjectStore
  || !globalThis.AutoPrompterRepositoryBootstrap
  || !globalThis.AutoPrompterProjectActionProtocol
  || !globalThis.AutoPrompterProjectOrchestrator
  || !globalThis.AutoPrompterProjectFullAuto
  || !globalThis.AutoPrompterBootstrapUpgrade
) {
  throw new Error("AutoPrompter full-auto Project Mode runtime failed to initialize.");
}

globalThis.AutoPrompterPlannerCompiler.install(globalThis.AutoPrompterProjectStore);
globalThis.AutoPrompterPlannerFallback.install(globalThis.AutoPrompterProjectStore);
globalThis.AutoPrompterProjectOrchestrator.start();
globalThis.AutoPrompterProjectFullAuto.start();
globalThis.AutoPrompterBootstrapUpgrade.start();
