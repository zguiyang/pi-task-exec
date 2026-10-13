import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { WorkerManager } from "../../dist/mcp/workers/manager.js";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const fakePi = fileURLToPath(new URL("./fixtures/fake-pi.mjs", import.meta.url));
const names = [
  "PI_WORKER_COMMAND", "PI_WORKER_RPC_TIMEOUT_MS", "PI_WORKER_IDLE_TIMEOUT_MS",
  "PI_WORKER_TASK_TIMEOUT_MS", "PI_WORKER_ABORT_GRACE_MS", "PI_WORKER_TERM_GRACE_MS",
  "PI_WORKER_MAX_RECENT_EVENTS", "PI_WORKER_ALLOWED_ROOTS", "PI_WORKER_MAX_WORKERS", "FAKE_PI_MODE",
  "FAKE_PI_MODELS", "FAKE_PI_DEFAULT_MODEL", "FAKE_PI_REQUEST_LOG", "FAKE_PI_THINKING", "FAKE_PI_THINKING_LEVELS",
];
const prior = new Map(names.map((name) => [name, process.env[name]]));
let manager;
let requestLog;

function configure(mode, values = {}) {
  process.env.PI_WORKER_COMMAND = fakePi;
  process.env.FAKE_PI_MODE = mode;
  process.env.PI_WORKER_ALLOWED_ROOTS = root;
  process.env.PI_WORKER_MAX_WORKERS = String(values.maxWorkers ?? 4);
  process.env.PI_WORKER_RPC_TIMEOUT_MS = "500";
  process.env.PI_WORKER_IDLE_TIMEOUT_MS = "0";
  process.env.PI_WORKER_TASK_TIMEOUT_MS = "2000";
  process.env.PI_WORKER_ABORT_GRACE_MS = "50";
  process.env.PI_WORKER_TERM_GRACE_MS = "100";
  process.env.PI_WORKER_MAX_RECENT_EVENTS = "8";
  process.env.FAKE_PI_MODELS = JSON.stringify([{ provider: "provider-x", id: "X" }]);
  process.env.FAKE_PI_DEFAULT_MODEL = JSON.stringify({ provider: "local", id: "default" });
  if (values.thinkingLevels !== undefined) process.env.FAKE_PI_THINKING_LEVELS = JSON.stringify(values.thinkingLevels);
  else delete process.env.FAKE_PI_THINKING_LEVELS;
  requestLog = join(tmpdir(), `pi-worker-thinking-${process.pid}-${Math.random()}.jsonl`);
  process.env.FAKE_PI_REQUEST_LOG = requestLog;
  manager = new WorkerManager();
}

async function spawn(input = {}) {
  return manager.spawn({ task: "safe fake task", cwd: root, mode: "direct", ...input });
}

async function requests() {
  return (await readFile(requestLog, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

async function waitFor(read, predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = read();
    if (predicate(result)) return result;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  }
  throw new Error("Timed out waiting for worker state");
}

afterEach(async () => {
  await manager?.shutdown();
  manager = undefined;
  if (requestLog) await rm(requestLog, { force: true });
  for (const name of names) {
    const value = prior.get(name);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

test("omitted thinking keeps Pi's default and never queries or sets a level", async () => {
  configure("normal");
  const worker = await spawn({ profile: "inspect" });
  assert.equal(worker.requestedThinking, undefined);
  assert.equal(worker.thinkingLevel, "high");
  assert.deepEqual((await requests()).map((request) => request.type), ["get_state", "prompt"]);
  await manager.abort(worker.id);
});

test("explicit thinking is validated, applied, and read back before the prompt", async () => {
  configure("normal");
  const worker = await spawn({ profile: "inspect", thinking: "high" });
  assert.equal(worker.requestedThinking, "high");
  assert.equal(worker.thinkingLevel, "high");
  const recorded = await requests();
  assert.deepEqual(recorded.map((request) => request.type), ["get_available_thinking_levels", "set_thinking_level", "get_state", "prompt"]);
  assert.equal(recorded[1].level, "high");
  await manager.abort(worker.id);
});

test("model override resolves before thinking validation and readback", async () => {
  configure("normal");
  const worker = await spawn({ profile: "implement", model: "provider-x/X", thinking: "medium" });
  assert.deepEqual(worker.effectiveModel, { provider: "provider-x", id: "X" });
  assert.equal(worker.thinkingLevel, "medium");
  assert.deepEqual(
    (await requests()).map((request) => request.type),
    ["get_available_models", "set_model", "get_available_thinking_levels", "set_thinking_level", "get_state", "prompt"],
  );
  await manager.abort(worker.id);
});

test("a thinking level unsupported by the active model fails without prompting and releases the process", async () => {
  configure("thinking_no_support");
  await assert.rejects(spawn({ profile: "inspect", thinking: "high" }), (error) => {
    assert.equal(error.code, "THINKING_LEVEL_NOT_AVAILABLE");
    assert.match(error.message, /not supported by the active model/);
    assert.match(error.message, /off/);
    return true;
  });
  assert.deepEqual((await requests()).map((request) => request.type), ["get_available_thinking_levels", "abort"]);
  const failed = manager.list()[0];
  assert.equal(failed.failure.code, "THINKING_LEVEL_NOT_AVAILABLE");
  assert.equal(failed.processAlive, false);
  assert.equal(failed.recentEvents.some((event) => event.type === "prompt"), false);
});

test("Pi rejecting set_thinking_level is reported as THINKING_LEVEL_SET_FAILED", async () => {
  configure("thinking_reject");
  await assert.rejects(spawn({ profile: "inspect", thinking: "high" }), (error) => {
    assert.equal(error.code, "THINKING_LEVEL_SET_FAILED");
    assert.match(error.message, /Pi refused thinking level/);
    return true;
  });
  assert.deepEqual((await requests()).map((request) => request.type), ["get_available_thinking_levels", "set_thinking_level", "abort"]);
  assert.equal(manager.list()[0].failure.code, "THINKING_LEVEL_SET_FAILED");
});

test("a readback mismatch after a successful set is reported and never prompts", async () => {
  configure("thinking_mismatch");
  await assert.rejects(spawn({ profile: "inspect", thinking: "high" }), (error) => {
    assert.equal(error.code, "THINKING_LEVEL_MISMATCH");
    assert.match(error.message, /get_state reported low/);
    return true;
  });
  assert.deepEqual(
    (await requests()).map((request) => request.type),
    ["get_available_thinking_levels", "set_thinking_level", "get_state", "abort"],
  );
  assert.equal(manager.list()[0].failure.code, "THINKING_LEVEL_MISMATCH");
  assert.equal(manager.list()[0].recentEvents.some((event) => event.type === "prompt"), false);
});

test("thinking is applied once per worker and not re-applied on continuation", async () => {
  configure("normal_follow_up");
  const worker = await spawn({ profile: "inspect", thinking: "low" });
  assert.equal(worker.thinkingLevel, "low");
  await waitFor(() => manager.status(worker.id), (value) => value.state === "settled");
  const continued = await manager.continue(worker.id, "related follow-up");
  assert.equal(continued.requestedThinking, "low");
  assert.equal(continued.thinkingLevel, "low");
  const types = (await requests()).map((request) => request.type);
  assert.deepEqual(types, ["get_available_thinking_levels", "set_thinking_level", "get_state", "prompt", "prompt"]);
  assert.equal(types.filter((type) => type === "set_thinking_level").length, 1);
  await manager.abort(worker.id);
});

test("manager default profile is inspect when profile is omitted", async () => {
  configure("normal");
  const worker = await spawn();
  assert.equal(worker.profile, "inspect");
  await manager.abort(worker.id);
});
