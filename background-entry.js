"use strict";

importScripts("background.js", "planner-compiler.js");

if (!globalThis.AutoPrompterPlannerCompiler || !globalThis.AutoPrompterProjectStore) {
  throw new Error("AutoPrompter deterministic planner compiler failed to initialize.");
}

globalThis.AutoPrompterPlannerCompiler.install(globalThis.AutoPrompterProjectStore);
