"use strict";

(function attachGitHubIssueWorkflow(root, factory) {
  const projectStore = root.AutoPrompterProjectStore
    || (typeof require === "function" ? require("./project-store.js") : null);
  const resultProtocol = root.AutoPrompterResultProtocol
    || (typeof require === "function" ? require("./result-protocol.js") : null);
  const api = factory(projectStore, resultProtocol);
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.AutoPrompterGitHubIssueWorkflow = api;
})(typeof globalThis !== "undefined" ? globalThis : self, (ProjectStore, ResultProtocol) => {
  const PATCH_FLAG = Symbol.for("autoprompter.githubIssueWorkflow.installed");
  const MODE = "github_issues_and_pull_requests";
  const ISSUES_BEGIN = "AUTOPROMPTER_ISSUES_BEGIN";
  const ISSUES_END = "AUTOPROMPTER_ISSUES_END";
  const ISSUE_METADATA_BEGIN = "AUTOPROMPTER_ISSUE_METADATA_BEGIN";
  const ISSUE_METADATA_END = "AUTOPROMPTER_ISSUE_METADATA_END";
  const ISSUE_WORK_BEGIN = "AUTOPROMPTER_ISSUE_WORK_BEGIN";
  const ISSUE_WORK_END = "AUTOPROMPTER_ISSUE_WORK_END";
  const PR_REVIEW_BEGIN = "AUTOPROMPTER_PR_REVIEW_BEGIN";
  const PR_REVIEW_END = "AUTOPROMPTER_PR_REVIEW_END";
  const PROPOSAL_BEGIN = "AUTOPROMPTER_PROPOSAL_BEGIN";
  const PROPOSAL_END = "AUTOPROMPTER_PROPOSAL_END";
  const MAX_ISSUES = 24;

  function clone(value) {
    return value == null ? value : structuredClone(value);
  }

  function nowIso(clock = Date.now) {
    return new Date(clock()).toISOString();
  }

  function assert(condition, message) {
    if (!condition) throw new Error(message);
  }

  function exactKeys(value, keys, label) {
    assert(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object.`);
    const actual = Object.keys(value).sort();
    const expected = [...keys].sort();
    assert(actual.length === expected.length && actual.every((key, index) => key === expected[index]), `${label} contains missing or unknown fields.`);
  }

  function string(value, label, min = 1, max = 12000) {
    assert(typeof value === "string", `${label} must be a string.`);
    const normalized = value.trim();
    assert(normalized.length >= min && normalized.length <= max, `${label} must be between ${min} and ${max} characters.`);
    return normalized;
  }

  function stringArray(value, label, max = 50, itemMax = 2000) {
    assert(Array.isArray(value), `${label} must be an array.`);
    assert(value.length <= max, `${label} contains too many items.`);
    return value.map((item, index) => string(item, `${label}[${index}]`, 1, itemMax));
  }

  function canonicalIso(value, label) {
    const raw = string(value, label, 20, 40);
    const parsed = new Date(raw);
    assert(Number.isFinite(parsed.getTime()), `${label} must be a valid ISO-8601 timestamp.`);
    return parsed.toISOString();
  }

  function parseEnvelope(output, begin, end, label) {
    const text = String(output || "").replace(/^\uFEFF/, "");
    assert(text.split(begin).length - 1 === 1, `${label} must contain exactly one ${begin} marker.`);
    assert(text.split(end).length - 1 === 1, `${label} must contain exactly one ${end} marker.`);
    const start = text.indexOf(begin);
    const finish = text.indexOf(end);
    assert(start >= 0 && start < finish, `${label} markers are missing or out of order.`);
    assert(!text.slice(0, start).trim() && !text.slice(finish + end.length).trim(), `${label} must not contain prose outside its envelope.`);
    const payload = text.slice(start + begin.length, finish).trim();
    assert(payload && !payload.startsWith("```"), `${label} JSON must not use a Markdown fence.`);
    try {
      return JSON.parse(payload);
    } catch (error) {
      throw new Error(`${label} does not contain valid JSON: ${error.message}`);
    }
  }

  function repositoryIssueUrl(repository, issueNumber, value) {
    const url = new URL(string(value, "Issue URL", 10, 1000));
    assert(url.protocol === "https:" && url.hostname === "github.com", "Issue URL must use https://github.com.");
    const expected = `/${repository}/issues/${issueNumber}`.toLowerCase();
    assert(url.pathname.replace(/\/$/, "").toLowerCase() === expected, `Issue URL must identify ${repository}#${issueNumber}.`);
    return `https://github.com/${repository}/issues/${issueNumber}`;
  }

  function repositoryPullUrl(repository, pullNumber, value) {
    const url = new URL(string(value, "Pull request URL", 10, 1000));
    assert(url.protocol === "https:" && url.hostname === "github.com", "Pull request URL must use https://github.com.");
    const expected = `/${repository}/pull/${pullNumber}`.toLowerCase();
    assert(url.pathname.replace(/\/$/, "").toLowerCase() === expected, `Pull request URL must identify ${repository}#${pullNumber}.`);
    return `https://github.com/${repository}/pull/${pullNumber}`;
  }

  function safePath(value) {
    const path = String(value || "").trim().replace(/\\/g, "/").replace(/^\.\//, "");
    if (!path || path.length > 300 || path.includes("\0") || path.startsWith("/") || /^[A-Za-z]:\//.test(path)) return "";
    if (path.split("/").some(segment => segment === "..")) return "";
    return path;
  }

  function safeCommand(value) {
    const command = String(value || "").trim();
    if (!command || command.length > 1000 || /[\r\n\0]/.test(command)) return "";
    if (/(?:^|\s)(?:sudo\s+|rm\s+-rf\b|git\s+reset\s+--hard\b|git\s+push\s+--force\b|curl\b[^|]*\|\s*(?:sh|bash)\b|wget\b[^|]*\|\s*(?:sh|bash)\b)/i.test(command)) return "";
    return command;
  }

  function normalizeIssue(raw, repository) {
    exactKeys(raw, [
      "number", "url", "title", "body", "dependsOnIssueNumbers", "allowedPaths",
      "acceptanceCriteria", "verificationCommands", "labels"
    ], "GitHub issue");
    assert(Number.isInteger(raw.number) && raw.number > 0, "Issue number must be a positive integer.");
    const number = raw.number;
    const allowedPaths = stringArray(raw.allowedPaths, `Issue #${number} allowedPaths`, 50, 300)
      .map(safePath)
      .filter(Boolean);
    const verificationCommands = stringArray(raw.verificationCommands, `Issue #${number} verificationCommands`, 20, 1000)
      .map(safeCommand)
      .filter(Boolean);
    const dependsOnIssueNumbers = raw.dependsOnIssueNumbers;
    assert(Array.isArray(dependsOnIssueNumbers) && dependsOnIssueNumbers.every(item => Number.isInteger(item) && item > 0), `Issue #${number} dependencies must be positive issue numbers.`);
    return {
      number,
      url: repositoryIssueUrl(repository, number, raw.url),
      title: string(raw.title, `Issue #${number} title`, 1, 200),
      body: string(raw.body, `Issue #${number} body`, 1, 12000),
      dependsOnIssueNumbers: [...new Set(dependsOnIssueNumbers)],
      allowedPaths: allowedPaths.length ? [...new Set(allowedPaths)] : ["**/*"],
      acceptanceCriteria: stringArray(raw.acceptanceCriteria, `Issue #${number} acceptanceCriteria`, 30, 1000),
      verificationCommands: [...new Set(verificationCommands)],
      labels: [...new Set(stringArray(raw.labels, `Issue #${number} labels`, 20, 100))]
    };
  }

  function parseIssueManifest(output, project) {
    const input = parseEnvelope(output, ISSUES_BEGIN, ISSUES_END, "Planner issue manifest");
    exactKeys(input, ["schemaVersion", "projectId", "repository", "issues", "createdAt"], "Planner issue manifest");
    assert(input.schemaVersion === "1.0", "Planner issue manifest schemaVersion must be 1.0.");
    assert(input.projectId === project.projectId, "Planner issue manifest projectId does not match.");
    assert(input.repository === project.repository.slug, "Planner issue manifest repository does not match.");
    assert(Array.isArray(input.issues) && input.issues.length > 0 && input.issues.length <= MAX_ISSUES, `Planner must create between 1 and ${MAX_ISSUES} issues.`);
    const issues = input.issues.map(issue => normalizeIssue(issue, project.repository.slug));
    const numbers = new Set(issues.map(issue => issue.number));
    assert(numbers.size === issues.length, "Planner issue numbers must be unique.");
    for (const issue of issues) {
      assert(!issue.dependsOnIssueNumbers.includes(issue.number), `Issue #${issue.number} cannot depend on itself.`);
      for (const dependency of issue.dependsOnIssueNumbers) {
        assert(numbers.has(dependency), `Issue #${issue.number} references unknown dependency #${dependency}.`);
      }
    }
    return {
      schemaVersion: "1.0",
      projectId: project.projectId,
      repository: project.repository.slug,
      issues,
      createdAt: canonicalIso(input.createdAt, "Planner issue manifest createdAt")
    };
  }

  function issueMetadataBlock(issue) {
    return [
      ISSUE_METADATA_BEGIN,
      JSON.stringify(issue),
      ISSUE_METADATA_END
    ].join("\n");
  }

  function manifestProposal(manifest) {
    return {
      schemaVersion: "1.0",
      summary: `GitHub issue plan containing ${manifest.issues.length} repository issue${manifest.issues.length === 1 ? "" : "s"}.`,
      tasks: manifest.issues.map(issue => ({
        key: `issue-${issue.number}`,
        title: `#${issue.number} ${issue.title}`,
        description: [
          `Implement GitHub issue #${issue.number}: ${issue.url}`,
          issueMetadataBlock(issue),
          issue.body
        ].join("\n\n").slice(0, 12000),
        dependsOn: issue.dependsOnIssueNumbers.map(number => `issue-${number}`),
        role: "implementation",
        difficulty: "medium",
        modelClass: "standard",
        allowedPaths: issue.allowedPaths,
        acceptance: issue.acceptanceCriteria.length
          ? issue.acceptanceCriteria
          : [`GitHub issue #${issue.number} is implemented in a reviewed and merged pull request.`],
        checks: issue.verificationCommands
      }))
    };
  }

  function issueFromTask(task) {
    if (task?.githubIssue?.number) return clone(task.githubIssue);
    const description = String(task?.description || "");
    const start = description.indexOf(ISSUE_METADATA_BEGIN);
    const end = description.indexOf(ISSUE_METADATA_END);
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(description.slice(start + ISSUE_METADATA_BEGIN.length, end).trim());
      } catch {
        // Fall through to the task ID fallback.
      }
    }
    const match = String(task?.id || "").match(/issue-(\d+)/i);
    return match ? { number: Number(match[1]), url: "", title: task.title || task.id } : null;
  }

  function issueBranch(issue, task) {
    const slug = String(issue?.title || task?.title || "work")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "work";
    return `autoprompter/issue-${issue.number}-${slug}`.slice(0, 180);
  }

  function buildIssuePlannerPrompt(project, revision) {
    return [
      "You are the planner for AutoPrompter GitHub Issue Mode.",
      `Project: ${project.title} (${project.projectId})`,
      `Goal: ${project.goal}`,
      `Repository: ${project.repository.slug}`,
      `Default branch: ${project.repository.defaultBranch}`,
      `Planning revision: ${revision}`,
      "",
      "Use the connected write-capable GitHub plugin/tool to inspect the repository and create the actual GitHub issues before answering.",
      "Create one issue for every independently executable unit of work. Each issue must contain bounded scope, acceptance criteria, relevant paths, and verification commands.",
      "Use dependencies only when an issue literally cannot begin until another issue's pull request has merged. Ordering in your answer is not a dependency.",
      "Avoid overlapping implementation scope between independent issues. Do not implement code, create branches, or open pull requests yourself.",
      "After the issues exist, return their verified GitHub numbers and URLs in exactly one envelope with no prose outside it.",
      ISSUES_BEGIN,
      JSON.stringify({
        schemaVersion: "1.0",
        projectId: project.projectId,
        repository: project.repository.slug,
        issues: [{
          number: 123,
          url: `https://github.com/${project.repository.slug}/issues/123`,
          title: "Bounded issue title",
          body: "Full issue body already created on GitHub",
          dependsOnIssueNumbers: [],
          allowedPaths: ["src/**"],
          acceptanceCriteria: ["Observable completion criterion"],
          verificationCommands: ["npm test"],
          labels: ["autoprompter"]
        }],
        createdAt: "canonical ISO-8601 timestamp"
      }, null, 2),
      ISSUES_END
    ].join("\n");
  }

  function buildIssueWorkerPrompt(project, task, dispatch) {
    const issue = issueFromTask(task);
    assert(issue?.number, `Task ${task?.id || "unknown"} does not contain a verified GitHub issue.`);
    const pullRequest = task.pullRequest || null;
    const changes = Array.isArray(task.requiredChanges) ? task.requiredChanges : [];
    const tests = Array.isArray(task.verificationCommands) && task.verificationCommands.length
      ? task.verificationCommands.map(command => `- ${command}`)
      : ["- Run the repository's relevant existing checks and report what ran."];
    return [
      "You are the persistent implementation agent assigned to one GitHub issue.",
      "Use the connected write-capable GitHub plugin/tool. The GitHub issue and pull request are the durable source of truth.",
      "",
      `Project: ${project.title} (${project.projectId})`,
      `Repository: ${project.repository.slug}`,
      `Default branch: ${project.repository.defaultBranch}`,
      `Issue: #${issue.number} ${issue.url}`,
      `Task ID: ${task.id}`,
      `Dispatch ID: ${dispatch.dispatchId}`,
      `Attempt: ${dispatch.attempt}`,
      `Working branch: ${dispatch.branch}`,
      pullRequest ? `Existing pull request: #${pullRequest.number} ${pullRequest.url}` : "Existing pull request: none",
      "",
      "Read the GitHub issue and current repository state before changing anything.",
      pullRequest
        ? "Continue the existing pull request. Read all review comments, make the requested changes on the same branch, rerun relevant checks, and push updates. Do not create a duplicate pull request."
        : "Create the assigned branch from the latest default branch, implement only this issue, commit and push reviewable work, then open a pull request that references and closes the issue.",
      "Do not merge the pull request. The separate review/merge agent owns that decision.",
      "Continue using tools until the pull request is open and remotely verifiable. Return blocked only when the required GitHub write operation truly cannot be performed.",
      "",
      "Reviewer feedback to address",
      ...(changes.length ? changes.map(item => `- ${item}`) : ["- None"]),
      "",
      "Required checks",
      ...tests,
      "",
      "Return exactly one JSON envelope with no prose outside it:",
      ISSUE_WORK_BEGIN,
      JSON.stringify({
        schemaVersion: "1.0",
        projectId: project.projectId,
        taskId: task.id,
        dispatchId: dispatch.dispatchId,
        issueNumber: issue.number,
        status: "pull_request_opened | blocked | failed",
        summary: "concise implementation or blocker summary",
        pullRequest: {
          number: 456,
          url: `https://github.com/${project.repository.slug}/pull/456`,
          branch: dispatch.branch,
          headSha: "full commit SHA",
          baseBranch: project.repository.defaultBranch,
          state: "open"
        },
        tests: [{ command: "command", status: "passed | failed | not_run", summary: "evidence" }],
        filesChanged: ["relative/path"],
        risks: ["remaining risk"],
        producedAt: "canonical ISO-8601 timestamp"
      }, null, 2),
      ISSUE_WORK_END
    ].join("\n");
  }

  function parseIssueWorkerResult(output, context) {
    const input = parseEnvelope(output, ISSUE_WORK_BEGIN, ISSUE_WORK_END, "Issue worker result");
    exactKeys(input, [
      "schemaVersion", "projectId", "taskId", "dispatchId", "issueNumber", "status", "summary",
      "pullRequest", "tests", "filesChanged", "risks", "producedAt"
    ], "Issue worker result");
    assert(input.schemaVersion === "1.0", "Issue worker result schemaVersion must be 1.0.");
    assert(input.projectId === context.project.projectId, "Issue worker result projectId does not match.");
    assert(input.taskId === context.task.id, "Issue worker result taskId does not match.");
    assert(input.dispatchId === context.dispatch.dispatchId, "Issue worker result dispatchId does not match.");
    const issue = issueFromTask(context.task);
    assert(input.issueNumber === issue?.number, "Issue worker result issueNumber does not match.");
    assert(["pull_request_opened", "blocked", "failed"].includes(input.status), "Issue worker result status is unsupported.");
    const tests = input.tests;
    assert(Array.isArray(tests) && tests.length <= 30, "Issue worker result tests must be an array with at most 30 entries.");
    const normalizedTests = tests.map((entry, index) => {
      exactKeys(entry, ["command", "status", "summary"], `Issue worker test ${index + 1}`);
      assert(["passed", "failed", "not_run"].includes(entry.status), `Issue worker test ${index + 1} status is unsupported.`);
      return {
        command: string(entry.command, `Issue worker test ${index + 1} command`, 1, 1000),
        status: entry.status,
        summary: string(entry.summary, `Issue worker test ${index + 1} summary`, 0, 4000)
      };
    });
    let pullRequest = null;
    if (input.status === "pull_request_opened") {
      exactKeys(input.pullRequest, ["number", "url", "branch", "headSha", "baseBranch", "state"], "Issue worker pull request");
      assert(Number.isInteger(input.pullRequest.number) && input.pullRequest.number > 0, "Pull request number must be a positive integer.");
      assert(input.pullRequest.state === "open", "Worker pull request must be open.");
      assert(/^[0-9a-f]{7,64}$/i.test(String(input.pullRequest.headSha || "")), "Pull request headSha is invalid.");
      pullRequest = {
        number: input.pullRequest.number,
        url: repositoryPullUrl(context.project.repository.slug, input.pullRequest.number, input.pullRequest.url),
        branch: string(input.pullRequest.branch, "Pull request branch", 1, 200),
        headSha: input.pullRequest.headSha,
        baseBranch: string(input.pullRequest.baseBranch, "Pull request baseBranch", 1, 200),
        state: "open"
      };
      assert(pullRequest.baseBranch === context.project.repository.defaultBranch, "Pull request base branch does not match the project default branch.");
    } else {
      assert(input.pullRequest === null, "Blocked or failed issue work must use pullRequest: null.");
    }
    const result = {
      schemaVersion: "1.0",
      projectId: context.project.projectId,
      taskId: context.task.id,
      dispatchId: context.dispatch.dispatchId,
      attempt: context.dispatch.attempt,
      issueNumber: input.issueNumber,
      status: input.status,
      summary: string(input.summary, "Issue worker result summary", 1, 12000),
      commit: pullRequest?.headSha || null,
      pullRequest,
      tests: normalizedTests,
      filesChanged: stringArray(input.filesChanged, "Issue worker result filesChanged", 100, 300),
      risks: stringArray(input.risks, "Issue worker result risks", 50, 2000),
      producedAt: canonicalIso(input.producedAt, "Issue worker result producedAt")
    };
    return { ...result, resultDigest: ResultProtocol.stableHash(result) };
  }

  function buildPullReviewPrompt(project, task, dispatch, result) {
    const issue = issueFromTask(task);
    const pull = result.pullRequest;
    assert(issue?.number && pull?.number, "An open issue pull request is required before review.");
    return [
      "You are the combined pull-request reviewer and integrator for AutoPrompter GitHub Issue Mode.",
      "Use the connected write-capable GitHub plugin/tool to inspect the issue, pull request, diff, commits, review comments, and checks.",
      "You are authorized by this project run to merge this exact pull request into the configured default branch only when it is ready.",
      "",
      `Project: ${project.title} (${project.projectId})`,
      `Repository: ${project.repository.slug}`,
      `Default branch: ${project.repository.defaultBranch}`,
      `Issue: #${issue.number} ${issue.url}`,
      `Pull request: #${pull.number} ${pull.url}`,
      `Expected branch: ${pull.branch}`,
      `Expected head: ${pull.headSha}`,
      `Dispatch ID: ${dispatch.dispatchId}`,
      "",
      "Evaluate the implementation against the GitHub issue, acceptance criteria, repository conventions, and required checks.",
      "If ready: merge the pull request, verify the merged commit on the default branch, and verify that the issue is closed. Prefer squash merge unless the repository explicitly requires another method.",
      "If not ready: do not merge or close the pull request. Post precise actionable feedback on GitHub and return the same feedback so the persistent issue worker can continue in its existing chat.",
      "Do not implement fixes yourself and do not review or merge any different pull request.",
      "",
      "Task acceptance criteria",
      ...(task.acceptanceCriteria || []).map((criterion, index) => `${index + 1}. ${criterion}`),
      "",
      "Worker evidence",
      JSON.stringify(result, null, 2),
      "",
      "Return exactly one JSON envelope with no prose outside it:",
      PR_REVIEW_BEGIN,
      JSON.stringify({
        schemaVersion: "1.0",
        projectId: project.projectId,
        taskId: task.id,
        dispatchId: dispatch.dispatchId,
        issueNumber: issue.number,
        pullRequestNumber: pull.number,
        decision: "merged | changes_requested | blocked",
        summary: "concise evidence-based decision",
        feedback: ["actionable change already posted to the pull request"],
        mergeCommit: "full merged commit SHA or null",
        issueClosed: true,
        reviewedAt: "canonical ISO-8601 timestamp"
      }, null, 2),
      PR_REVIEW_END
    ].join("\n");
  }

  function parsePullReview(output, context) {
    const input = parseEnvelope(output, PR_REVIEW_BEGIN, PR_REVIEW_END, "Pull request review result");
    exactKeys(input, [
      "schemaVersion", "projectId", "taskId", "dispatchId", "issueNumber", "pullRequestNumber",
      "decision", "summary", "feedback", "mergeCommit", "issueClosed", "reviewedAt"
    ], "Pull request review result");
    assert(input.schemaVersion === "1.0", "Pull request review schemaVersion must be 1.0.");
    assert(input.projectId === context.project.projectId, "Pull request review projectId does not match.");
    assert(input.taskId === context.task.id, "Pull request review taskId does not match.");
    assert(input.dispatchId === context.dispatch.dispatchId, "Pull request review dispatchId does not match.");
    assert(input.issueNumber === context.result.issueNumber, "Pull request review issueNumber does not match.");
    assert(input.pullRequestNumber === context.result.pullRequest?.number, "Pull request review pullRequestNumber does not match.");
    assert(["merged", "changes_requested", "blocked"].includes(input.decision), "Pull request review decision is unsupported.");
    const feedback = stringArray(input.feedback, "Pull request review feedback", 30, 2000);
    let mergeCommit = input.mergeCommit;
    assert(mergeCommit === null || typeof mergeCommit === "string", "Pull request review mergeCommit must be a SHA or null.");
    if (typeof mergeCommit === "string") {
      mergeCommit = mergeCommit.trim();
      assert(/^[0-9a-f]{7,64}$/i.test(mergeCommit), "Pull request review mergeCommit is invalid.");
    }
    if (input.decision === "merged") {
      assert(Boolean(mergeCommit), "Merged review requires a merge commit.");
      assert(input.issueClosed === true, "Merged review must verify that the issue is closed.");
      assert(feedback.length === 0, "Merged review cannot include required feedback.");
    } else {
      assert(mergeCommit === null, "Unmerged review must use mergeCommit: null.");
      assert(input.issueClosed === false, "Unmerged review must leave the issue open.");
      assert(feedback.length > 0, "Unmerged review requires actionable feedback.");
    }
    return {
      schemaVersion: "1.0",
      projectId: context.project.projectId,
      taskId: context.task.id,
      dispatchId: context.dispatch.dispatchId,
      issueNumber: input.issueNumber,
      pullRequestNumber: input.pullRequestNumber,
      decision: input.decision,
      summary: string(input.summary, "Pull request review summary", 1, 12000),
      feedback,
      mergeCommit,
      issueClosed: input.issueClosed,
      reviewedAt: canonicalIso(input.reviewedAt, "Pull request review reviewedAt")
    };
  }

  function addEvent(store, type, projectId, detail, clock = Date.now) {
    const at = nowIso(clock);
    const events = Array.isArray(store.events) ? store.events : [];
    events.push({ id: `${at}:${type}:${projectId}:${events.length}`, type, projectId, at, detail: String(detail || "").slice(0, 500) });
    store.events = events.slice(-200);
    return at;
  }

  function install(projectStore = ProjectStore) {
    if (!projectStore || !ResultProtocol) throw new Error("GitHub issue workflow dependencies are unavailable.");
    if (projectStore[PATCH_FLAG]) return projectStore[PATCH_FLAG];

    const originalCreateProject = projectStore.createProject.bind(projectStore);
    const originalMigrateStore = projectStore.migrateStore.bind(projectStore);
    const originalBuildPlannerPrompt = projectStore.buildProjectPlannerPrompt.bind(projectStore);
    const originalSubmitPlannerOutput = projectStore.submitProjectPlannerOutput.bind(projectStore);
    const originalApproveProjectPlan = projectStore.approveProjectPlan.bind(projectStore);
    const originalPrepareProjectDispatches = projectStore.prepareProjectDispatches.bind(projectStore);
    const originalSummarizeProjectRuntime = projectStore.summarizeProjectRuntime.bind(projectStore);

    projectStore.createProject = function createGitHubIssueProject(storeInput, input = {}, clock = Date.now) {
      const created = originalCreateProject(storeInput, {
        ...input,
        integratorChatId: null,
        workerChatIds: [],
        maxConcurrentWorkers: input.maxConcurrentWorkers || 4,
        revisionLimit: 10
      }, clock);
      created.project.githubWorkflowMode = MODE;
      created.project.taskExecutionMode = MODE;
      created.project.roles.integratorChatId = null;
      created.store.projects[created.project.projectId] = clone(created.project);
      return created;
    };

    projectStore.migrateStore = function migrateGitHubIssueProjects(raw) {
      const migrated = originalMigrateStore(raw);
      for (const project of Object.values(migrated.store.projects || {})) {
        const hasTasks = Object.keys(migrated.store.tasksByProject?.[project.projectId] || {}).length > 0;
        if (!hasTasks && ["draft", "planning"].includes(project.status)) {
          project.githubWorkflowMode = MODE;
          project.taskExecutionMode = MODE;
          project.roles.integratorChatId = null;
        }
      }
      return migrated;
    };

    projectStore.buildProjectPlannerPrompt = function buildGitHubIssuePlannerPrompt(storeInput, projectId = "") {
      const built = originalBuildPlannerPrompt(storeInput, projectId);
      return { ...built, prompt: buildIssuePlannerPrompt(built.project, built.revision), plannerProtocol: "github-issues-v1" };
    };

    projectStore.submitProjectPlannerOutput = function submitGitHubIssuePlannerOutput(storeInput, projectId, output, clock = Date.now) {
      const id = String(projectId || storeInput?.activeProjectId || "");
      const project = storeInput?.projects?.[id];
      if (!project || project.githubWorkflowMode !== MODE) return originalSubmitPlannerOutput(storeInput, projectId, output, clock);
      const manifest = parseIssueManifest(output, project);
      const proposalEnvelope = [PROPOSAL_BEGIN, JSON.stringify(manifestProposal(manifest)), PROPOSAL_END].join("\n");
      const submitted = originalSubmitPlannerOutput(storeInput, projectId, proposalEnvelope, clock);
      return {
        ...submitted,
        issueManifest: manifest,
        plannerCompilation: {
          mode: "github-issues",
          diagnosticCount: 0,
          diagnostics: []
        }
      };
    };

    projectStore.approveProjectPlan = function approveGitHubIssuePlan(storeInput, projectId, clock = Date.now) {
      const approved = originalApproveProjectPlan(storeInput, projectId, clock);
      if (approved.project.githubWorkflowMode !== MODE) return approved;
      const tasks = approved.store.tasksByProject[approved.project.projectId] || {};
      for (const task of Object.values(tasks)) {
        const issue = issueFromTask(task);
        if (!issue?.number) throw new Error(`${task.id} does not contain a verified GitHub issue.`);
        task.githubIssue = issue;
        task.workflowState = "issue_open";
        task.workerConversationId = task.workerConversationId || null;
        task.pullRequest = task.pullRequest || null;
        task.mergeCommit = task.mergeCommit || null;
      }
      approved.store.tasksByProject[approved.project.projectId] = tasks;
      approved.tasks = clone(tasks);
      approved.project.taskExecutionMode = MODE;
      approved.store.projects[approved.project.projectId] = clone(approved.project);
      return approved;
    };

    projectStore.prepareProjectDispatches = function prepareGitHubIssueDispatches(storeInput, projectId, clock = Date.now) {
      const prepared = originalPrepareProjectDispatches(storeInput, projectId, clock);
      if (prepared.project.githubWorkflowMode !== MODE) return prepared;
      const tasks = prepared.store.tasksByProject[prepared.project.projectId] || {};
      const dispatches = prepared.store.dispatchesByProject[prepared.project.projectId] || {};
      const assignmentIds = (prepared.assignments || []).map(item => item.dispatchId);
      for (const dispatchId of assignmentIds) {
        const dispatch = dispatches[dispatchId];
        const task = dispatch && tasks[dispatch.taskId];
        const issue = issueFromTask(task);
        if (!dispatch || !task || !issue?.number) continue;
        const branch = task.pullRequest?.branch || task.branch || issueBranch(issue, task);
        dispatch.branch = branch;
        dispatch.issueNumber = issue.number;
        dispatch.issueUrl = issue.url;
        dispatch.taskExecutionMode = MODE;
        if (task.workerConversationId) {
          dispatch.workerChatId = task.workerConversationId;
          dispatch.conversationId = task.workerConversationId;
          dispatch.successorGeneration = 0;
          dispatch.freshRequestId = null;
          task.lease.workerChatId = task.workerConversationId;
        }
        dispatch.prompt = buildIssueWorkerPrompt(prepared.project, task, dispatch);
        task.branch = branch;
        task.githubIssue = issue;
      }
      prepared.store.tasksByProject[prepared.project.projectId] = tasks;
      prepared.store.dispatchesByProject[prepared.project.projectId] = dispatches;
      prepared.tasks = clone(tasks);
      prepared.dispatches = clone(dispatches);
      prepared.assignments = assignmentIds.map(id => clone(dispatches[id]));
      prepared.prepared = clone(prepared.assignments);
      return prepared;
    };

    projectStore.submitProjectTaskResult = function submitGitHubIssueWorkerResult(storeInput, projectId, dispatchId, output, clock = Date.now) {
      const store = clone(storeInput);
      const id = String(projectId || store.activeProjectId || "");
      const project = store.projects?.[id];
      if (!project || project.githubWorkflowMode !== MODE) {
        throw new Error("GitHub issue worker results are available only in GitHub Issue Mode.");
      }
      if (project.status !== "running") throw new Error("Issue work can be submitted only while the project is running.");
      const dispatch = store.dispatchesByProject?.[id]?.[dispatchId];
      const task = dispatch && store.tasksByProject?.[id]?.[dispatch.taskId];
      if (!dispatch || !task) throw new Error("Issue worker dispatch not found.");
      if (!["prepared", "dispatched", "running", "review"].includes(dispatch.status)) throw new Error(`Cannot submit issue work for a ${dispatch.status} dispatch.`);
      const result = parseIssueWorkerResult(output, { project, task, dispatch });
      const results = store.resultsByProject[id] || {};
      if (results[dispatchId]) {
        if (results[dispatchId].resultDigest !== result.resultDigest) throw new Error("A conflicting issue worker result already exists.");
        return { store, project: clone(project), task: clone(task), dispatch: clone(dispatch), result: clone(results[dispatchId]), runtimeSummary: projectStore.summarizeProjectRuntime(store, id) };
      }
      const at = addEvent(store, result.status === "pull_request_opened" ? "pull_request_opened" : "issue_worker_failed", id, `${task.id}: ${result.summary}`, clock);
      results[dispatchId] = result;
      store.resultsByProject[id] = results;
      dispatch.resultDigest = result.resultDigest;
      dispatch.resultReceivedAt = at;
      dispatch.workerTabId = null;
      dispatch.updatedAt = at;
      task.lease = null;
      task.lastResultDispatchId = dispatchId;
      task.resultCommit = result.commit;
      task.workerConversationId = dispatch.conversationId || task.workerConversationId || null;
      task.updatedAt = at;
      if (result.status === "pull_request_opened") {
        dispatch.status = "review";
        dispatch.branch = result.pullRequest.branch;
        task.status = "review";
        task.branch = result.pullRequest.branch;
        task.pullRequest = { ...result.pullRequest };
        task.workflowState = "pull_request_open";
      } else {
        dispatch.status = result.status;
        task.status = "failed";
        task.workflowState = result.status;
        project.status = "failed";
      }
      project.updatedAt = at;
      return { store, project: clone(project), task: clone(task), dispatch: clone(dispatch), result: clone(result), runtimeSummary: projectStore.summarizeProjectRuntime(store, id) };
    };

    projectStore.buildProjectReviewerPrompt = function buildGitHubPullReviewPrompt(storeInput, projectId, dispatchId) {
      const store = clone(storeInput);
      const id = String(projectId || store.activeProjectId || "");
      const project = store.projects?.[id];
      const dispatch = store.dispatchesByProject?.[id]?.[dispatchId];
      const task = dispatch && store.tasksByProject?.[id]?.[dispatch.taskId];
      const result = store.resultsByProject?.[id]?.[dispatchId];
      if (!project || !dispatch || !task || !result?.pullRequest) throw new Error("An open pull request result is required before review.");
      return { store, project: clone(project), task: clone(task), dispatch: clone(dispatch), result: clone(result), prompt: buildPullReviewPrompt(project, task, dispatch, result) };
    };

    projectStore.submitProjectReview = function submitGitHubPullReview(storeInput, projectId, dispatchId, output, clock = Date.now) {
      const store = clone(storeInput);
      const id = String(projectId || store.activeProjectId || "");
      const project = store.projects?.[id];
      if (!project || project.githubWorkflowMode !== MODE) throw new Error("Pull request review is available only in GitHub Issue Mode.");
      const dispatch = store.dispatchesByProject?.[id]?.[dispatchId];
      const task = dispatch && store.tasksByProject?.[id]?.[dispatch.taskId];
      const result = store.resultsByProject?.[id]?.[dispatchId];
      if (!dispatch || !task || !result?.pullRequest) throw new Error("An open pull request result is required before review.");
      if (task.status !== "review") throw new Error(`Cannot review an issue task in ${task.status} state.`);
      const review = parsePullReview(output, { project, task, dispatch, result });
      const reviews = store.reviewsByProject[id] || {};
      if (reviews[dispatchId]) {
        if (JSON.stringify(reviews[dispatchId]) !== JSON.stringify(review)) throw new Error("A conflicting pull request review already exists.");
        return { store, project: clone(project), task: clone(task), dispatch: clone(dispatch), review: clone(review), integrationReady: false, runtimeSummary: projectStore.summarizeProjectRuntime(store, id) };
      }
      reviews[dispatchId] = review;
      store.reviewsByProject[id] = reviews;
      const at = addEvent(store, review.decision === "merged" ? "pull_request_merged" : "pull_request_feedback", id, `${task.id}: ${review.summary}`, clock);
      dispatch.reviewedAt = at;
      dispatch.reviewDecision = review.decision;
      dispatch.workerTabId = null;
      dispatch.updatedAt = at;
      task.lastReviewDispatchId = dispatchId;
      task.lease = null;
      task.updatedAt = at;

      if (review.decision === "merged") {
        dispatch.status = "accepted";
        task.status = "accepted";
        task.requiredChanges = [];
        task.acceptedDispatchId = dispatchId;
        task.acceptedBranch = result.pullRequest.branch;
        task.acceptedCommit = review.mergeCommit;
        task.mergeCommit = review.mergeCommit;
        task.workflowState = "merged";
        task.pullRequest = { ...result.pullRequest, state: "merged", mergeCommit: review.mergeCommit };
        task.githubIssue = { ...issueFromTask(task), state: "closed" };
        const allTasks = Object.values(store.tasksByProject[id] || {});
        if (allTasks.length && allTasks.every(item => item.status === "accepted")) {
          project.status = "completed";
          addEvent(store, "project_completed", id, "Every GitHub issue pull request was reviewed and merged.", clock);
        }
      } else if (review.decision === "changes_requested") {
        dispatch.status = "revision_required";
        task.status = "ready";
        task.requiredChanges = clone(review.feedback);
        task.workflowState = "changes_requested";
        task.pullRequest = { ...result.pullRequest, state: "open" };
      } else {
        dispatch.status = "blocked";
        task.status = "failed";
        task.requiredChanges = clone(review.feedback);
        task.workflowState = "review_blocked";
        project.status = "failed";
      }
      project.updatedAt = at;
      return { store, project: clone(project), task: clone(task), dispatch: clone(dispatch), review: clone(review), integrationReady: false, runtimeSummary: projectStore.summarizeProjectRuntime(store, id) };
    };

    projectStore.summarizeProjectRuntime = function summarizeGitHubIssueRuntime(store, projectId) {
      const summary = originalSummarizeProjectRuntime(store, projectId);
      const project = store.projects?.[projectId];
      if (project?.githubWorkflowMode !== MODE) return summary;
      const tasks = Object.values(store.tasksByProject?.[projectId] || {});
      return {
        ...summary,
        taskExecutionMode: MODE,
        integrationReady: false,
        githubIssueCount: tasks.length,
        openPullRequestCount: tasks.filter(task => task.pullRequest?.state === "open").length,
        mergedPullRequestCount: tasks.filter(task => task.pullRequest?.state === "merged").length
      };
    };

    projectStore.buildProjectIntegratorPrompt = function disabledGitHubIntegrator() {
      throw new Error("GitHub Issue Mode uses the reviewer chat as the pull-request reviewer and merger; there is no separate integrator stage.");
    };

    const installed = {
      mode: MODE,
      originalCreateProject,
      originalMigrateStore,
      originalBuildPlannerPrompt,
      originalSubmitPlannerOutput,
      originalApproveProjectPlan,
      originalPrepareProjectDispatches,
      originalSummarizeProjectRuntime
    };
    Object.defineProperty(projectStore, PATCH_FLAG, { value: installed, enumerable: false });
    return installed;
  }

  return {
    MODE,
    ISSUES_BEGIN,
    ISSUES_END,
    ISSUE_WORK_BEGIN,
    ISSUE_WORK_END,
    PR_REVIEW_BEGIN,
    PR_REVIEW_END,
    parseIssueManifest,
    manifestProposal,
    issueFromTask,
    issueBranch,
    buildIssuePlannerPrompt,
    buildIssueWorkerPrompt,
    parseIssueWorkerResult,
    buildPullReviewPrompt,
    parsePullReview,
    install
  };
});