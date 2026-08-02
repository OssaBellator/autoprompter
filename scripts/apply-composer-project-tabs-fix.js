"use strict";

const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");

function read(file) {
  return fs.readFileSync(path.join(root, file), "utf8");
}

function write(file, content) {
  fs.writeFileSync(path.join(root, file), content);
}

function replaceOnce(content, before, after, label) {
  const first = content.indexOf(before);
  if (first < 0) throw new Error(`Missing patch anchor: ${label}`);
  if (content.indexOf(before, first + before.length) >= 0) throw new Error(`Patch anchor is not unique: ${label}`);
  return content.slice(0, first) + after + content.slice(first + before.length);
}

function replaceRegexOnce(content, pattern, replacement, label) {
  const matches = [...content.matchAll(new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`))];
  if (matches.length !== 1) throw new Error(`Expected one ${label} match, found ${matches.length}`);
  return content.replace(pattern, replacement);
}

function patchContentScript() {
  let source = read("content.js");

  source = replaceOnce(
    source,
    `  function normalizeText(value) {\n    return String(value || "").replace(/\\u00a0/g, " ").replace(/\\s+/g, " ").trim();\n  }\n`,
    `  function normalizeText(value) {\n    return String(value || "").replace(/\\u00a0/g, " ").replace(/\\s+/g, " ").trim();\n  }\n\n  function normalizeComposerText(value) {\n    return normalizeText(\n      String(value || "")\n        .normalize("NFC")\n        .replace(/[\\u200B-\\u200D\\u2060\\uFEFF]/g, "")\n    );\n  }\n`,
    "composer text normalizer"
  );

  source = replaceOnce(
    source,
    `  function composerText(element = composer()) {\n    if (!element) return "";\n    if ("value" in element) return normalizeText(element.value);\n    return normalizeText(element.innerText || element.textContent || "");\n  }\n`,
    `  function composerText(element = composer()) {\n    if (!element) return "";\n    if ("value" in element) return normalizeComposerText(element.value);\n    return normalizeComposerText(element.innerText || element.textContent || "");\n  }\n\n  function promptMatchesComposer(element, prompt) {\n    return Boolean(element && composerText(element) === normalizeComposerText(prompt));\n  }\n`,
    "composer text reader"
  );

  source = replaceOnce(
    source,
    `  function clearOwnedComposer(element, owner) {\n    if (!element?.isConnected || element.getAttribute(OWNERSHIP_ATTR) !== owner) return;\n    if ("value" in element) element.value = ""; else element.textContent = "";\n    element.removeAttribute(OWNERSHIP_ATTR);\n    element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward" }));\n  }\n\n  function submissionObserved(target, beforeUsers) {\n    return userCount() > beforeUsers || isGenerating() || composerText(target) === "";\n  }\n`,
    `  async function populateOwnedComposer({ target, prompt, owner, signal, status, settings, baseline }) {\n    const expected = normalizeComposerText(prompt);\n    let current = target;\n\n    for (let attempt = 0; attempt < 3; attempt += 1) {\n      if (!current?.isConnected) current = composer();\n      if (!current) current = await waitForEmptyComposer(signal, status, settings, baseline);\n\n      const existing = composerText(current);\n      if (existing && existing !== expected) {\n        throw new Error("The composer contains different text; the AutoPrompter prompt was not sent.");\n      }\n\n      current.setAttribute(OWNERSHIP_ATTR, owner);\n      if (existing !== expected) dispatchInput(current, prompt);\n      await sleep(150, signal);\n\n      const live = composer();\n      if (promptMatchesComposer(live, prompt)) {\n        live.setAttribute(OWNERSHIP_ATTR, owner);\n        return live;\n      }\n\n      const liveText = composerText(live);\n      if (liveText) {\n        throw new Error("The prompt was edited before submission; it was not sent.");\n      }\n\n      current = live;\n      if (attempt < 2) await status(`Composer refreshed; restoring prompt (${attempt + 2}/3)`);\n    }\n\n    throw new Error("ChatGPT repeatedly cleared the composer before submission.");\n  }\n\n  function validateOwnedComposer(target, owner, prompt) {\n    const live = composer();\n    if (!live) throw new Error("The composer was replaced before submission.");\n    if (!promptMatchesComposer(live, prompt)) {\n      throw new Error("The prompt was edited before submission; it was not sent.");\n    }\n    if (live.getAttribute(OWNERSHIP_ATTR) !== owner) live.setAttribute(OWNERSHIP_ATTR, owner);\n    return live;\n  }\n\n  function releaseOwnedComposer(element, owner) {\n    const live = element?.isConnected ? element : composer();\n    if (live?.getAttribute(OWNERSHIP_ATTR) === owner) live.removeAttribute(OWNERSHIP_ATTR);\n  }\n\n  function clearOwnedComposer(element, owner, prompt = "") {\n    const live = element?.isConnected ? element : composer();\n    if (!live || live.getAttribute(OWNERSHIP_ATTR) !== owner) return;\n    if (prompt && !promptMatchesComposer(live, prompt)) {\n      live.removeAttribute(OWNERSHIP_ATTR);\n      return;\n    }\n    if ("value" in live) live.value = ""; else live.textContent = "";\n    live.removeAttribute(OWNERSHIP_ATTR);\n    live.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "deleteContentBackward" }));\n  }\n\n  function submissionObserved(target, beforeUsers) {\n    const live = target?.isConnected ? target : composer();\n    return userCount() > beforeUsers || isGenerating() || !live || composerText(live) === "";\n  }\n`,
    "composer ownership helpers"
  );

  source = replaceRegexOnce(
    source,
    /    const owner = `\$\{Date\.now\(\)\}:\$\{Math\.random\(\)\.toString\(36\)\.slice\(2\)\}`;\n    target\.setAttribute\(OWNERSHIP_ATTR, owner\);\n    dispatchInput\(target, prompt\);\n\n    try \{\n      await status\("Preparing prompt"\);\n      const validateOwnership = \(\) => \{\n        if \(!target\.isConnected\) throw new Error\("The composer was replaced before submission\."\);\n        if \(target\.getAttribute\(OWNERSHIP_ATTR\) !== owner \|\| composerText\(target\) !== normalizeText\(prompt\)\) \{\n          throw new Error\("The prompt was edited before submission; it was not sent\."\);\n        \}\n      \};\n\n      const beforeUsers = userCount\(\);/,
    `    const owner = \`${'${Date.now()}'}:${'${Math.random().toString(36).slice(2)}'}\`;\n\n    try {\n      await status("Preparing prompt");\n      target = await populateOwnedComposer({\n        target, prompt, owner, signal, status, settings, baseline\n      });\n      const validateOwnership = () => {\n        target = validateOwnedComposer(target, owner, prompt);\n        return target;\n      };\n\n      const beforeUsers = userCount();`,
    "submitPrompt ownership block"
  );

  source = replaceOnce(
    source,
    `      target.removeAttribute(OWNERSHIP_ATTR);\n    } catch (error) {\n      clearOwnedComposer(target, owner);\n      throw error;\n    }\n`,
    `      releaseOwnedComposer(target, owner);\n    } catch (error) {\n      clearOwnedComposer(target, owner, prompt);\n      throw error;\n    }\n`,
    "submitPrompt ownership release"
  );

  source = replaceOnce(
    source,
    `      hashText,\n      normalizeText,\n      conversationInfo,`,
    `      hashText,\n      normalizeText,\n      normalizeComposerText,\n      promptMatchesComposer,\n      conversationInfo,`,
    "content exports"
  );

  write("content.js", source);
}

function patchPopupHtml() {
  let source = read("popup.html");

  source = replaceOnce(source, "<summary>Project Mode foundation</summary>", "<summary>Project Mode</summary>", "Project Mode summary");

  source = replaceOnce(
    source,
    `      <div class="details-body">\n        <p class="hint">Create durable project state, validate and approve a planner envelope, prepare bounded worker leases, and explicitly send selected assignments after manual model verification. Planner, reviewer, and integrator prompts remain manual.</p>\n\n        <div class="project-toolbar">`,
    `      <div class="details-body">\n        <div class="project-tabs" role="tablist" aria-label="Project Mode views">\n          <button id="projectExistingTab" class="project-tab active" type="button" role="tab" aria-selected="true" aria-controls="projectExistingPanel">Existing projects</button>\n          <button id="projectNewTab" class="project-tab" type="button" role="tab" aria-selected="false" aria-controls="projectNewPanel" tabindex="-1">New project</button>\n        </div>\n\n        <section id="projectExistingPanel" class="project-tab-panel" role="tabpanel" aria-labelledby="projectExistingTab">\n          <p class="hint">Select a saved project to inspect progress, retry bootstrap, manage assignments, review results, and approve integration.</p>\n\n        <div class="project-toolbar">`,
    "Project Mode tabs and existing panel"
  );

  source = replaceOnce(
    source,
    `        <label>\n          Project title\n          <input id="projectTitle" type="text" maxlength="160" placeholder="AutoPrompter Project Mode">\n        </label>`,
    `        </section>\n\n        <section id="projectNewPanel" class="project-tab-panel" role="tabpanel" aria-labelledby="projectNewTab" hidden>\n          <p class="hint">Create a new durable project. The selected chats become workers, while planner, reviewer, and integrator chats can be created automatically.</p>\n        <label>\n          Project title\n          <input id="projectTitle" type="text" maxlength="160" placeholder="AutoPrompter Project Mode">\n        </label>`,
    "new project panel start"
  );

  source = replaceOnce(
    source,
    `        <button id="createProject" class="primary project-create" type="button">Create and bootstrap project</button>\n        <p id="projectMessage" class="hint" aria-live="polite"></p>`,
    `        <button id="createProject" class="primary project-create" type="button">Create and bootstrap project</button>\n        </section>\n        <p id="projectMessage" class="hint project-message" aria-live="polite"></p>`,
    "new project panel end"
  );

  write("popup.html", source);
}

function patchPopupCss() {
  let source = read("popup.css");
  const styles = `\n\n.project-tabs {\n  display: grid;\n  grid-template-columns: 1fr 1fr;\n  gap: 4px;\n  margin: 8px 0 10px;\n  padding: 4px;\n  border: 1px solid color-mix(in srgb, CanvasText 14%, transparent);\n  border-radius: 9px;\n  background: color-mix(in srgb, CanvasText 4%, transparent);\n}\n.project-tab {\n  border: 0;\n  padding: 8px 10px;\n  background: transparent;\n  color: GrayText;\n}\n.project-tab.active {\n  background: Canvas;\n  color: CanvasText;\n  box-shadow: 0 1px 3px color-mix(in srgb, CanvasText 16%, transparent);\n}\n.project-tab-panel { min-width: 0; }\n.project-tab-panel > .hint:first-child { margin-top: 2px; }\n.project-message {\n  min-height: 15px;\n  padding-top: 2px;\n  overflow-wrap: anywhere;\n}\n`;
  if (source.includes(".project-tabs {")) throw new Error("Project tab styles already exist");
  source += styles;
  write("popup.css", source);
}

function patchPopupJs() {
  let source = read("popup.js");

  source = replaceOnce(
    source,
    `  "projectModePanel", "projectSelect", "inspectProject", "projectStatusCard", "projectStatusTitle",`,
    `  "projectModePanel", "projectExistingTab", "projectNewTab", "projectExistingPanel", "projectNewPanel",\n  "projectSelect", "inspectProject", "projectStatusCard", "projectStatusTitle",`,
    "project tab element IDs"
  );

  source = replaceOnce(
    source,
    `let wasRunning = false;\nlet projectState = {`,
    `let wasRunning = false;\nlet activeProjectTab = "existing";\nlet projectState = {`,
    "active Project Mode tab state"
  );

  source = replaceOnce(
    source,
    `function projectRoleSelects() {\n  return [elements.projectPlannerChat, elements.projectReviewerChat, elements.projectIntegratorChat];\n}\n`,
    `function setProjectTab(tab, { focus = false } = {}) {\n  const next = tab === "new" ? "new" : "existing";\n  activeProjectTab = next;\n  const existingActive = next === "existing";\n\n  elements.projectExistingTab.classList.toggle("active", existingActive);\n  elements.projectNewTab.classList.toggle("active", !existingActive);\n  elements.projectExistingTab.setAttribute("aria-selected", String(existingActive));\n  elements.projectNewTab.setAttribute("aria-selected", String(!existingActive));\n  elements.projectExistingTab.tabIndex = existingActive ? 0 : -1;\n  elements.projectNewTab.tabIndex = existingActive ? -1 : 0;\n  elements.projectExistingPanel.hidden = !existingActive;\n  elements.projectNewPanel.hidden = existingActive;\n  if (focus) (existingActive ? elements.projectExistingTab : elements.projectNewTab).focus();\n}\n\nfunction handleProjectTabKeydown(event) {\n  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;\n  event.preventDefault();\n  const next = event.key === "ArrowLeft" || event.key === "Home" ? "existing" : "new";\n  setProjectTab(next, { focus: true });\n}\n\nfunction projectRoleSelects() {\n  return [elements.projectPlannerChat, elements.projectReviewerChat, elements.projectIntegratorChat];\n}\n`,
    "Project Mode tab controller"
  );

  source = replaceOnce(
    source,
    `  projectState.projects = response.projects || [];\n  projectState.activeProjectId = response.activeProjectId || null;\n  if (inspectActive && projectState.activeProjectId) await inspectProject(projectState.activeProjectId);`,
    `  projectState.projects = response.projects || [];\n  projectState.activeProjectId = response.activeProjectId || null;\n  if (!projectState.projects.length && activeProjectTab === "existing") setProjectTab("new");\n  if (inspectActive && projectState.activeProjectId) await inspectProject(projectState.activeProjectId);`,
    "empty project tab selection"
  );

  source = replaceOnce(
    source,
    `  projectState.project = created.project;\n  projectState.events = [];\n  elements.projectMessage.textContent =`,
    `  projectState.project = created.project;\n  projectState.events = [];\n  setProjectTab("existing");\n  elements.projectMessage.textContent =`,
    "switch to existing project after creation"
  );

  source = replaceOnce(
    source,
    `  chatConfigs = stored[CHAT_CONFIGS_KEY] && typeof stored[CHAT_CONFIGS_KEY] === "object" ? stored[CHAT_CONFIGS_KEY] : {};\n  renderCatalog();`,
    `  chatConfigs = stored[CHAT_CONFIGS_KEY] && typeof stored[CHAT_CONFIGS_KEY] === "object" ? stored[CHAT_CONFIGS_KEY] : {};\n  setProjectTab("existing");\n  renderCatalog();`,
    "initialize Project Mode tabs"
  );

  source = replaceOnce(
    source,
    `elements.disableCircuitBreaker.addEventListener("change", () => saveSettings().catch(() => {}));\nelements.createProject.addEventListener`,
    `elements.disableCircuitBreaker.addEventListener("change", () => saveSettings().catch(() => {}));\nelements.projectExistingTab.addEventListener("click", () => setProjectTab("existing"));\nelements.projectNewTab.addEventListener("click", () => setProjectTab("new"));\nelements.projectExistingTab.addEventListener("keydown", handleProjectTabKeydown);\nelements.projectNewTab.addEventListener("keydown", handleProjectTabKeydown);\nelements.createProject.addEventListener`,
    "Project Mode tab listeners"
  );

  write("popup.js", source);
}

function writeRegressionTests() {
  const test = `"use strict";\n\nconst test = require("node:test");\nconst assert = require("node:assert/strict");\nconst fs = require("node:fs");\nconst path = require("node:path");\n\nconst root = path.join(__dirname, "..");\nconst contentJs = fs.readFileSync(path.join(root, "content.js"), "utf8");\nconst popupHtml = fs.readFileSync(path.join(root, "popup.html"), "utf8");\nconst popupCss = fs.readFileSync(path.join(root, "popup.css"), "utf8");\nconst popupJs = fs.readFileSync(path.join(root, "popup.js"), "utf8");\n\ntest("composer submission tolerates safe ChatGPT editor rerenders", () => {\n  assert.match(contentJs, /function normalizeComposerText/);\n  assert.match(contentJs, /[\\\\u200B-\\\\u200D\\\\u2060\\\\uFEFF]/);\n  assert.match(contentJs, /async function populateOwnedComposer/);\n  assert.match(contentJs, /function validateOwnedComposer/);\n  assert.match(contentJs, /Composer refreshed; restoring prompt/);\n  assert.match(contentJs, /clearOwnedComposer\\(target, owner, prompt\\)/);\n});\n\ntest("composer recovery stays fail-closed for different user text", () => {\n  assert.match(contentJs, /composer contains different text; the AutoPrompter prompt was not sent/);\n  assert.match(contentJs, /if \\(prompt && !promptMatchesComposer\\(live, prompt\\)\\)/);\n  assert.match(contentJs, /The prompt was edited before submission; it was not sent/);\n});\n\ntest("Project Mode separates existing and new project views", () => {\n  assert.match(popupHtml, /id="projectExistingTab"/);\n  assert.match(popupHtml, /id="projectNewTab"/);\n  assert.match(popupHtml, /id="projectExistingPanel"/);\n  assert.match(popupHtml, /id="projectNewPanel"[^>]*hidden/);\n  assert.match(popupCss, /\\.project-tabs/);\n  assert.match(popupJs, /function setProjectTab/);\n  assert.match(popupJs, /setProjectTab\\("existing"\\)/);\n  assert.match(popupJs, /setProjectTab\\("new"\\)/);\n});\n`;
  write("tests/project-composer-tabs.test.js", test);
}

patchContentScript();
patchPopupHtml();
patchPopupCss();
patchPopupJs();
writeRegressionTests();

console.log("Applied composer rerender recovery and Project Mode tab layout.");
