"use strict";

importScripts("background.js", "planner-compiler.js");
importScripts("repository-bootstrap.js", "project-orchestrator.js");

if (!globalThis.AutoPrompterPlannerCompiler || !globalThis.AutoPrompterProjectStore || !globalThis.AutoPrompterRepositoryBootstrap || !globalThis.AutoPrompterProjectOrchestrator) {
  throw new Error("AutoPrompter deterministic Project Mode runtime failed to initialize.");
}

globalThis.AutoPrompterPlannerCompiler.install(globalThis.AutoPrompterProjectStore);
globalThis.AutoPrompterProjectOrchestrator.start();
