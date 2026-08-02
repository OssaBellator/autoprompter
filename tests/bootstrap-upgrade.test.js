"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const BootstrapUpgrade = require("../bootstrap-upgrade.js");

test("legacy planner repair bootstraps are detected without invalidating healthy bootstrap state", () => {
  assert.equal(BootstrapUpgrade.isLegacyRepair({
    repairAttempts: 3,
    roles: { planner: { stage: "planner_repair", status: "Repairing planner JSON" } }
  }), true);
  assert.equal(BootstrapUpgrade.isLegacyRepair({
    repairAttempts: 0,
    roles: { planner: { stage: "planner_plan", status: "Waiting for planner", prompt: "AUTOPROMPTER_PLAN_BEGIN" } }
  }), true);
  assert.equal(BootstrapUpgrade.isLegacyRepair({
    repairAttempts: 0,
    roles: { planner: { stage: "planner", status: "Planning", prompt: "AUTOPROMPTER_PROPOSAL_BEGIN" } }
  }), false);
});

test("upgrade removes legacy repair records and restarts them through the background bridge", async () => {
  const originalChrome = global.chrome;
  const originalApi = global.AutoPrompterBackgroundProjectApi;
  const writes = [];
  const restarted = [];
  global.chrome = {
    storage: {
      local: {
        async get() {
          return {
            autoprompterProjectBootstraps: {
              legacy: { repairAttempts: 2, roles: { planner: { stage: "planner_repair" } } },
              healthy: { repairAttempts: 0, roles: { planner: { stage: "planner" } } }
            },
            autoprompterBootstrapProtocolUpgrade: "old"
          };
        },
        async set(value) { writes.push(value); }
      }
    }
  };
  global.AutoPrompterBackgroundProjectApi = {
    async startProjectBootstrap(projectId) { restarted.push(projectId); }
  };

  delete require.cache[require.resolve("../bootstrap-upgrade.js")];
  const upgrade = require("../bootstrap-upgrade.js");
  const result = await upgrade.run();
  await new Promise(resolve => setTimeout(resolve, 300));

  assert.deepEqual(result.reset, ["legacy"]);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].autoprompterProjectBootstraps.legacy, undefined);
  assert.ok(writes[0].autoprompterProjectBootstraps.healthy);
  assert.deepEqual(restarted, ["legacy"]);

  global.chrome = originalChrome;
  global.AutoPrompterBackgroundProjectApi = originalApi;
});
