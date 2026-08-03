(() => {
  "use strict";

  const SCOPE = "AUTOPROMPTER_SELF_REPAIR";
  const INSTALL_FLAG = Symbol.for("autoprompter.selfRepairUi.installed");

  function send(type, payload = {}) {
    return chrome.runtime.sendMessage({ scope: SCOPE, type, ...payload });
  }

  function element(id) {
    return document.getElementById(id);
  }

  function panelMarkup() {
    return `
      <summary>Automatic extension self-repair</summary>
      <div class="details-body">
        <p class="hint">Captures sanitized AutoPrompter runtime failures and opens one temporary repair chat for <strong>OssaBellator/autoprompter</strong>. Conversation transcripts, project notes, and prompt contents are not included.</p>
        <label class="check-row">
          <input id="selfRepairEnabled" type="checkbox">
          <span>Automatically diagnose extension failures</span>
        </label>
        <label class="check-row nested">
          <input id="selfRepairAutoMerge" type="checkbox">
          <span>Allow merge only after tests, checks, and final diff review pass</span>
        </label>
        <div class="grid">
          <label>
            Duplicate cooldown (minutes)
            <input id="selfRepairCooldown" type="number" min="15" max="1440" step="15">
          </label>
          <label>
            Maximum repairs per day
            <input id="selfRepairDailyLimit" type="number" min="1" max="10" step="1">
          </label>
        </div>
        <p class="warning">The temporary chat needs a connected write-capable GitHub tool. Repository protections, plugin confirmations, failed tests, or uncertain changes leave a pull request open instead of merging it.</p>
        <div class="inline-actions">
          <button id="saveSelfRepairSettings" class="primary" type="button">Save settings</button>
          <button id="refreshSelfRepairStatus" class="compact" type="button">Refresh status</button>
          <button id="clearSelfRepairHistory" class="compact" type="button">Clear history</button>
        </div>
        <p id="selfRepairMessage" class="hint" aria-live="polite"></p>
        <div id="selfRepairStatus" class="self-repair-status"></div>
      </div>`;
  }

  function statusLabel(job) {
    const labels = {
      opening: "Opening repair chat",
      running: job.statusMessage || "Repair chat working",
      merged: "Merged — local git pull required",
      pr_open: "Pull request open",
      blocked: "Blocked",
      failed: "Failed"
    };
    return labels[job.status] || job.status;
  }

  function renderStatus(status) {
    const container = element("selfRepairStatus");
    if (!container) return;
    container.textContent = "";
    const jobs = Array.isArray(status?.jobs) ? status.jobs : [];
    if (!jobs.length) {
      const empty = document.createElement("p");
      empty.className = "hint";
      empty.textContent = "No captured repair attempts.";
      container.append(empty);
      return;
    }
    for (const job of jobs.slice(0, 8)) {
      const card = document.createElement("article");
      card.className = `self-repair-card self-repair-${job.status}`;
      const heading = document.createElement("div");
      heading.className = "self-repair-heading";
      const title = document.createElement("strong");
      title.textContent = `Error ${job.fingerprint}`;
      const state = document.createElement("span");
      state.className = "self-repair-badge";
      state.textContent = statusLabel(job);
      heading.append(title, state);
      const detail = document.createElement("p");
      detail.textContent = job.result?.summary || job.error || job.message || "No details recorded.";
      card.append(heading, detail);
      if (job.duplicateCount) {
        const duplicate = document.createElement("small");
        duplicate.textContent = `${job.duplicateCount} duplicate occurrence${job.duplicateCount === 1 ? "" : "s"} suppressed while this repair was active.`;
        card.append(duplicate);
      }
      if (job.result?.pullRequestUrl) {
        const link = document.createElement("a");
        link.href = job.result.pullRequestUrl;
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.textContent = job.status === "merged" ? "Open merged repair pull request" : "Open repair pull request";
        card.append(link);
      }
      if (job.result?.mergeCommit) {
        const commit = document.createElement("code");
        commit.textContent = job.result.mergeCommit;
        card.append(commit);
      }
      container.append(card);
    }
  }

  async function load() {
    const [settingsResponse, statusResponse] = await Promise.all([
      send("GET_SELF_REPAIR_SETTINGS"),
      send("GET_SELF_REPAIR_STATUS")
    ]);
    if (settingsResponse?.ok === false) throw new Error(settingsResponse.error || "Could not load self-repair settings.");
    const settings = settingsResponse?.settings || {};
    element("selfRepairEnabled").checked = settings.enabled === true;
    element("selfRepairAutoMerge").checked = settings.autoMerge !== false;
    element("selfRepairCooldown").value = Number(settings.cooldownMinutes || 60);
    element("selfRepairDailyLimit").value = Number(settings.maxRepairsPerDay || 3);
    renderStatus(statusResponse);
  }

  async function save() {
    const response = await send("SAVE_SELF_REPAIR_SETTINGS", {
      settings: {
        enabled: element("selfRepairEnabled").checked,
        autoMerge: element("selfRepairAutoMerge").checked,
        cooldownMinutes: Number(element("selfRepairCooldown").value),
        maxRepairsPerDay: Number(element("selfRepairDailyLimit").value)
      }
    });
    if (response?.ok === false) throw new Error(response.error || "Could not save self-repair settings.");
    element("selfRepairMessage").textContent = response.settings.enabled
      ? "Automatic self-repair is enabled. Only sanitized technical diagnostics are sent to temporary repair chats."
      : "Automatic self-repair is disabled.";
  }

  async function refresh() {
    const response = await send("GET_SELF_REPAIR_STATUS");
    if (response?.ok === false) throw new Error(response.error || "Could not refresh self-repair status.");
    renderStatus(response);
  }

  async function clearHistory() {
    const response = await send("CLEAR_SELF_REPAIR_HISTORY");
    if (response?.ok === false) throw new Error(response.error || "Could not clear self-repair history.");
    renderStatus(response);
    element("selfRepairMessage").textContent = response.activeJobId
      ? "Completed history cleared; the active repair was retained."
      : "Self-repair history cleared.";
  }

  function showError(error) {
    const target = element("selfRepairMessage");
    if (target) target.textContent = error?.message || String(error);
  }

  async function install() {
    if (globalThis[INSTALL_FLAG] || !document?.createElement) return false;
    Object.defineProperty(globalThis, INSTALL_FLAG, { value: true });
    const anchor = element("projectModePanel") || document.querySelector(".picker");
    if (!anchor) return false;
    const panel = document.createElement("details");
    panel.id = "selfRepairPanel";
    panel.className = "continuity self-repair-panel";
    panel.innerHTML = panelMarkup();
    anchor.before(panel);
    element("saveSelfRepairSettings").addEventListener("click", () => save().catch(showError));
    element("refreshSelfRepairStatus").addEventListener("click", () => refresh().catch(showError));
    element("clearSelfRepairHistory").addEventListener("click", () => clearHistory().catch(showError));
    await load();
    return true;
  }

  const start = () => install().catch(() => {});
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else setTimeout(start, 0);
})();
