"use strict";

importScripts("autocontinue-runtime-boundary.js");
if (!globalThis.AutoPrompterRuntimeBoundary?.install()) {
  throw new Error("AutoPrompter could not install the runtime message boundary.");
}

importScripts("background.js");
globalThis.AutoPrompterRuntimeBoundary.finalize();

importScripts(
  "autocontinue-state-guard.js",
  "autocontinue-unlimited-retries.js",
  "autocontinue-extended-thinking.js",
  "autocontinue-transient-thinking.js",
  "autocontinue-deferred-dispatch.js",
  "autocontinue-self-repair.js"
);

if (
  !globalThis.AutoPrompterStateGuard
  || !globalThis.AutoPrompterUnlimitedConnectionRetries
  || !globalThis.AutoPrompterExtendedThinkingRecovery
  || !globalThis.AutoPrompterTransientThinkingRecovery
  || !globalThis.AutoPrompterDeferredDispatch
  || !globalThis.AutoPrompterSelfRepair
) {
  throw new Error("AutoPrompter AutoContinue runtime failed to initialize.");
}

globalThis.AutoPrompterStateGuard.install();
globalThis.AutoPrompterUnlimitedConnectionRetries.install();
globalThis.AutoPrompterExtendedThinkingRecovery.install();
globalThis.AutoPrompterTransientThinkingRecovery.install();
globalThis.AutoPrompterDeferredDispatch.install();
globalThis.AutoPrompterSelfRepair.install();
