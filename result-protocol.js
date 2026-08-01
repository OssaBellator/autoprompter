"use strict";

(function attachResultProtocol(root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.AutoPrompterResultProtocol = api;
})(typeof globalThis !== "undefined" ? globalThis : self, () => {
  const RESULT_BEGIN = "AUTOPROMPTER_TASK_RESULT_BEGIN";
  const RESULT_END = "AUTOPROMPTER_TASK_RESULT_END";
  const RESULT_SCHEMA_VERSION = "1.0";
  const MAX_RESULT_OUTPUT_CHARS = 120000;
  const MAX_TESTS = 30;
  const ROOT_KEYS = [
    "schemaVersion", "projectId", "taskId", "dispatchId", "attempt", "status", "summary",
    "commit", "tests", "filesChanged", "risks", "followUpTaskSuggestions", "producedAt"
  ];
  const TEST_KEYS = ["command", "status", "summary"];
  const STATUSES = new Set(["completed", "blocked", "failed"]);
  const TEST_STATUSES = new Set(["passed", "failed", "not_run"]);

  function clone(value) {
    return value == null ? value : structuredClone(value);
  }

  function assert(condition, message) {
    if (!condition) throw new Error(message);
  }

  function assertExactKeys(value, expected, label) {
    assert(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object.`);
    const actual = Object.keys(value).sort();
    const wanted = [...expected].sort();
    assert(actual.length === wanted.length && actual.every((key, index) => key === wanted[index]), `${label} contains missing or unknown fields.`);
  }

  function assertString(value, label, min, max, pattern = null) {
    assert(typeof value === "string", `${label} must be a string.`);
    const trimmed = value.trim();
    assert(trimmed.length >= min && trimmed.length <= max, `${label} must be between ${min} and ${max} characters.`);
    if (pattern) assert(pattern.test(trimmed), `${label} has an invalid format.`);
    return trimmed;
  }

  function assertStringArray(value, label, { max = 100, itemMax = 2000, unique = false } = {}) {
    assert(Array.isArray(value), `${label} must be an array.`);
    assert(value.length <= max, `${label} contains too many items.`);
    const normalized = value.map((item, index) => assertString(item, `${label}[${index}]`, 1, itemMax));
    if (unique) assert(new Set(normalized).size === normalized.length, `${label} must not contain duplicates.`);
    return normalized;
  }

  function countMarker(text, marker) {
    return text.split(marker).length - 1;
  }

  function parseResultEnvelope(output) {
    const text = String(output || "").replace(/^\uFEFF/, "");
    assert(text.length > 0, "Worker result is empty.");
    assert(text.length <= MAX_RESULT_OUTPUT_CHARS, `Worker result exceeds ${MAX_RESULT_OUTPUT_CHARS} characters.`);
    assert(countMarker(text, RESULT_BEGIN) === 1, `Worker result must contain exactly one ${RESULT_BEGIN} marker.`);
    assert(countMarker(text, RESULT_END) === 1, `Worker result must contain exactly one ${RESULT_END} marker.`);
    const start = text.indexOf(RESULT_BEGIN);
    const end = text.indexOf(RESULT_END);
    assert(start < end, "Worker result markers are out of order.");
    assert(text.slice(0, start).trim() === "" && text.slice(end + RESULT_END.length).trim() === "", "Worker result must not contain prose outside its envelope.");
    const payload = text.slice(start + RESULT_BEGIN.length, end).trim();
    assert(payload.length > 0, "Worker result envelope is empty.");
    assert(!/^```/.test(payload) && !/```$/.test(payload), "Worker result JSON must not be wrapped in a code fence.");
    try {
      return JSON.parse(payload);
    } catch (error) {
      throw new Error(`Worker result envelope does not contain valid JSON: ${error.message}`);
    }
  }

  function canonicalIso(value, label) {
    const raw = assertString(value, label, 20, 40);
    const parsed = new Date(raw);
    assert(Number.isFinite(parsed.getTime()), `${label} must be a valid ISO-8601 timestamp.`);
    const canonical = parsed.toISOString();
    assert(raw === canonical || raw === canonical.replace(".000Z", "Z"), `${label} must be canonical ISO-8601.`);
    return raw;
  }

  function isSafeRelativePath(value) {
    if (typeof value !== "string") return false;
    const path = value.trim().replace(/\\/g, "/");
    if (!path || path.length > 300 || path.includes("\0") || path.startsWith("/") || /^[A-Za-z]:\//.test(path)) return false;
    return !path.split("/").some(segment => segment === "..");
  }

  function pathMatchesPattern(pathValue, patternValue) {
    const path = String(pathValue || "").replace(/\\/g, "/").replace(/^\.\//, "");
    const pattern = String(patternValue || "").replace(/\\/g, "/").replace(/^\.\//, "");
    if (!isSafeRelativePath(path) || !isSafeRelativePath(pattern)) return false;
    if (pattern.endsWith("/**")) {
      const prefix = pattern.slice(0, -3).replace(/\/$/, "");
      return path === prefix || path.startsWith(`${prefix}/`);
    }
    if (pattern.endsWith("/*")) {
      const prefix = pattern.slice(0, -2).replace(/\/$/, "");
      if (!path.startsWith(`${prefix}/`)) return false;
      return !path.slice(prefix.length + 1).includes("/");
    }
    return path === pattern || path.startsWith(`${pattern.replace(/\/$/, "")}/`);
  }

  function stableStringify(value) {
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
    if (value && typeof value === "object") {
      return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
    }
    return JSON.stringify(value);
  }

  function stableHash(value) {
    let hash = 0x811c9dc5;
    const text = typeof value === "string" ? value : stableStringify(value);
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash.toString(36).padStart(7, "0");
  }

  function validateResult(input, { project, task, dispatch }) {
    assertExactKeys(input, ROOT_KEYS, "Worker result");
    assert(input.schemaVersion === RESULT_SCHEMA_VERSION, `Worker result schemaVersion must be ${RESULT_SCHEMA_VERSION}.`);
    assert(input.projectId === project?.projectId, "Worker result projectId does not match the selected project.");
    assert(input.taskId === task?.id, "Worker result taskId does not match the leased task.");
    assert(input.dispatchId === dispatch?.dispatchId, "Worker result dispatchId does not match the active dispatch.");
    assert(Number.isInteger(input.attempt) && input.attempt === dispatch?.attempt && input.attempt === task?.attempt, "Worker result attempt does not match the active lease.");
    assert(STATUSES.has(input.status), "Worker result status is unsupported.");
    const summary = assertString(input.summary, "Worker result summary", 1, 12000);
    let commit = input.commit;
    assert(commit === null || typeof commit === "string", "Worker result commit must be a SHA or null.");
    if (typeof commit === "string") {
      commit = commit.trim();
      assert(/^[0-9a-f]{7,64}$/i.test(commit), "Worker result commit has an invalid format.");
    }
    if (input.status === "completed") assert(Boolean(commit), "A completed worker result must include a commit SHA.");

    assert(Array.isArray(input.tests) && input.tests.length <= MAX_TESTS, `Worker result tests must contain at most ${MAX_TESTS} entries.`);
    const seenCommands = new Set();
    const tests = input.tests.map((entry, index) => {
      assertExactKeys(entry, TEST_KEYS, `Worker result test ${index + 1}`);
      const command = assertString(entry.command, `Worker result test ${index + 1} command`, 1, 1000);
      assert(!seenCommands.has(command), `Worker result contains duplicate test evidence for ${command}.`);
      seenCommands.add(command);
      assert(TEST_STATUSES.has(entry.status), `${command} has an unsupported test status.`);
      return {
        command,
        status: entry.status,
        summary: assertString(entry.summary, `${command} summary`, 0, 4000)
      };
    });

    const requiredCommands = Array.isArray(task?.verificationCommands) ? task.verificationCommands : [];
    for (const command of requiredCommands) {
      const evidence = tests.find(entry => entry.command === command);
      assert(Boolean(evidence), `Worker result is missing verification evidence for: ${command}`);
      if (input.status === "completed") assert(evidence.status === "passed", `Completed worker result did not pass required verification: ${command}`);
    }

    const filesChanged = assertStringArray(input.filesChanged, "Worker result filesChanged", { max: 100, itemMax: 300, unique: true });
    for (const path of filesChanged) {
      assert(isSafeRelativePath(path), `Worker result contains an unsafe changed path: ${path}`);
      assert((task?.allowedPaths || []).some(pattern => pathMatchesPattern(path, pattern)), `Worker result changed a path outside the task allowlist: ${path}`);
    }

    const risks = assertStringArray(input.risks, "Worker result risks", { max: 50, itemMax: 2000 });
    const followUpTaskSuggestions = assertStringArray(input.followUpTaskSuggestions, "Worker result followUpTaskSuggestions", { max: 30, itemMax: 2000 });
    const producedAt = canonicalIso(input.producedAt, "Worker result producedAt");
    const result = {
      schemaVersion: RESULT_SCHEMA_VERSION,
      projectId: project.projectId,
      taskId: task.id,
      dispatchId: dispatch.dispatchId,
      attempt: input.attempt,
      status: input.status,
      summary,
      commit,
      tests,
      filesChanged,
      risks,
      followUpTaskSuggestions,
      producedAt
    };
    return { ...result, resultDigest: stableHash(result) };
  }

  function parseAndValidateResult(output, context) {
    return validateResult(parseResultEnvelope(output), context);
  }

  return {
    RESULT_BEGIN,
    RESULT_END,
    RESULT_SCHEMA_VERSION,
    MAX_RESULT_OUTPUT_CHARS,
    parseResultEnvelope,
    validateResult,
    parseAndValidateResult,
    isSafeRelativePath,
    pathMatchesPattern,
    stableHash,
    clone
  };
});
