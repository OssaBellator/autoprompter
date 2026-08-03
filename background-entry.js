"use strict";

importScripts(
  "background.js",
  "autocontinue-unlimited-retries.js",
  "autocontinue-extended-thinking.js",
  "autocontinue-deferred-dispatch.js",
  "project-mode-retirement.js"
);

if (
  !globalThis.AutoPrompterUnlimitedConnectionRetries
  || !globalThis.AutoPrompterExtendedThinkingRecovery
  || !globalThis.AutoPrompterDeferredDispatch
  || !globalThis.AutoPrompterProjectModeRetirement
) {
  throw new Error("AutoPrompter AutoContinue runtime failed to initialize.");
}

globalThis.AutoPrompterUnlimitedConnectionRetries.install();
globalThis.AutoPrompterExtendedThinkingRecovery.install();
globalThis.AutoPrompterDeferredDispatch.install();
globalThis.AutoPrompterProjectModeRetirement.retire().catch(() => {});
