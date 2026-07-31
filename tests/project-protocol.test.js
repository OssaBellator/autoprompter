"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const fixtureRoot = path.join(root, "examples", "sample-project", ".autoprompter");

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), "utf8"));
}

function readFixture(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(fixtureRoot, relativePath), "utf8"));
}

function assertSafeRelativePath(value) {
  assert.equal(typeof value, "string");
  assert.ok(value.length > 0);
  assert.equal(path.posix.isAbsolute(value), false);
  assert.equal(value.includes(".."), false);
  assert.equal(value.includes("\0"), false);
}

function assertAcyclic(tasks) {
  const byId = new Map(tasks.map(task => [task.id, task]));
  const visiting = new Set();
  const visited = new Set();

  function visit(id) {
    if (visited.has(id)) return;
    assert.equal(visiting.has(id), false, `cycle detected at ${id}`);
    visiting.add(id);
    const task = byId.get(id);
    assert.ok(task, `unknown task ${id}`);
    for (const dependency of task.dependencies) {
      assert.ok(byId.has(dependency), `unknown dependency ${dependency}`);
      visit(dependency);
    }
    visiting.delete(id);
    visited.add(id);
  }

  for (const task of tasks) visit(task.id);
}

test("protocol schemas are draft 2020-12 JSON documents", () => {
  for (const filename of [
    "project.schema.json",
    "plan.schema.json",
    "task.schema.json",
    "result.schema.json"
  ]) {
    const schema = readJson(path.join("schemas", filename));
    assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
    assert.equal(schema.type, "object");
    assert.equal(schema.additionalProperties, false);
    assert.ok(Array.isArray(schema.required));
    assert.ok(schema.required.includes("schemaVersion"));
  }
});

test("sample project has unique role chats and bounded concurrency", () => {
  const project = readFixture("project.json");
  assert.equal(project.schemaVersion, "1.0");
  assert.equal(project.classification, "large_project");
  assert.equal(project.modelPolicy.mode, "manual_verified");

  const roleChats = [
    project.roles.plannerChatId,
    project.roles.reviewerChatId,
    project.roles.integratorChatId,
    ...project.roles.workerChatIds
  ].filter(Boolean);
  assert.equal(new Set(roleChats).size, roleChats.length);
  assert.ok(project.scheduler.maxConcurrentWorkers >= 1);
  assert.ok(project.scheduler.maxConcurrentWorkers <= project.roles.workerChatIds.length);
  assert.equal(project.scheduler.circuitBreakerEnabled, true);
});

test("sample plan has unique, known, acyclic dependencies", () => {
  const plan = readFixture("plan.json");
  const ids = plan.tasks.map(task => task.id);
  assert.equal(new Set(ids).size, ids.length);
  assertAcyclic(plan.tasks);

  const known = new Set(ids);
  for (const phase of plan.phases) {
    for (const taskId of phase.taskIds) assert.ok(known.has(taskId));
  }
  for (const taskId of plan.criticalPath) assert.ok(known.has(taskId));
});

test("sample task files match the plan and use safe allowlisted paths", () => {
  const plan = readFixture("plan.json");
  const summaries = new Map(plan.tasks.map(task => [task.id, task]));
  const taskDir = path.join(fixtureRoot, "tasks");

  for (const filename of fs.readdirSync(taskDir).filter(name => name.endsWith(".json"))) {
    const task = JSON.parse(fs.readFileSync(path.join(taskDir, filename), "utf8"));
    const summary = summaries.get(task.id);
    assert.ok(summary, `task ${task.id} is missing from plan.json`);
    assert.equal(task.projectId, plan.projectId);
    assert.equal(task.role, summary.role);
    assert.equal(task.preferredModelClass, summary.preferredModelClass);
    assert.equal(task.description, summary.description);
    assert.deepEqual(task.allowedPaths, summary.allowedPaths);
    assert.deepEqual(task.acceptanceCriteria, summary.acceptanceCriteria);
    assert.deepEqual(task.verificationCommands, summary.verificationCommands);
    assert.notEqual(task.dependencies.includes(task.id), true);
    for (const allowedPath of task.allowedPaths) assertSafeRelativePath(allowedPath);
  }
});

test("sample worker result references a known task and valid commit claim", () => {
  const plan = readFixture("plan.json");
  const result = readFixture(path.join("results", "task-project-schema.json"));
  assert.ok(plan.tasks.some(task => task.id === result.taskId));
  assert.match(result.commit, /^[0-9a-f]{7,64}$/i);
  assert.ok(result.tests.some(entry => entry.status === "passed"));
  for (const changedPath of result.filesChanged) assertSafeRelativePath(changedPath);
});
