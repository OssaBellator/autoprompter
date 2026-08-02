"use strict";

importScripts(
  "background.js",
  "autocontinue-unlimited-retries.js",
  "autocontinue-extended-thinking.js",
  "project-mode-retirement.js"
);

if (
  !globalThis.AutoPrompterUnlimitedConnectionRetries
  || !globalThis.AutoPrompterExtendedThinkingRecovery
  || !globalThis.AutoPrompterProjectModeRetirement
) {
  throw new Error("AutoPrompter AutoContinue runtime failed to initialize.");
}

globalThis.AutoPrompterUnlimitedConnectionRetries.install();
globalThis.AutoPrompterExtendedThinkingRecovery.install();
globalThis.AutoPrompterProjectModeRetirement.retire().catch(() => {});
