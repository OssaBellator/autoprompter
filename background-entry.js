"use strict";

importScripts(
  "autocontinue-runtime-boundary.js",
  "background.js",
  "autocontinue-state-guard.js",
  "autocontinue-unlimited-retries.js",
  "autocontinue-extended-thinking.js",
  "autocontinue-transient-thinking.js",
  "autocontinue-deferred-dispatch.js",
  "autocontinue-self-repair.js"
);

if (
  !globalThis.AutoPrompterRuntimeBoundary
  || !globalThis.AutoPrompterStateGuard
  || !globalThis.AutoPrompterUnlimitedConnectionRetries
  || !globalThis.AutoPrompterExtendedThinkingRecovery
  || !globalThis.AutoPrompterTransientThinkingRecovery
  || !globalThis.AutoPrompterDeferredDispatch
  || !globalThis.AutoPrompterSelfRepair
) {
  throw new Error("AutoPrompter AutoContinue runtime failed to initialize.");
}

globalThis.AutoPrompterRuntimeBoundary.finalize();
globalThis.AutoPrompterStateGuard.install();
globalThis.AutoPrompterUnlimitedConnectionRetries.install();
globalThis.AutoPrompterExtendedThinkingRecovery.install();
globalThis.AutoPrompterTransientThinkingRecovery.install();
globalThis.AutoPrompterDeferredDispatch.install();
globalThis.AutoPrompterSelfRepair.install();
