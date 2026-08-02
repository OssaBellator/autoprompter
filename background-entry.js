"use strict";

importScripts("background.js", "planner-compiler.js");
importScripts("repository-bootstrap.js");

if (!globalThis.AutoPrompterPlannerCompiler || !globalThis.AutoPrompterProjectStore || !globalThis.AutoPrompterRepositoryBootstrap) {
  throw new Error("AutoPrompter deterministic Project Mode runtime failed to initialize.");
}

globalThis.AutoPrompterPlannerCompiler.install(globalThis.AutoPrompterProjectStore);
