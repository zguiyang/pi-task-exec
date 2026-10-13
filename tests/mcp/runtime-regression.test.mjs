import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { mkdtemp, readFile, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { WorkerManager } from "../../dist/mcp/workers/manager.js";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const fakePi = fileURLToPath(new URL("./fixtures/fake-pi.mjs", import.meta.url));
const names = [
  "PI_WORKER_COMMAND", "PI_WORKER_RPC_TIMEOUT_MS", "PI_WORKER_IDLE_TIMEOUT_MS",
  "PI_WORKER_TASK_TIMEOUT_MS", "PI_WORKER_ABORT_GRACE_MS", "PI_WORKER_TERM_GRACE_MS",
  "PI_WORKER_MAX_RECENT_EVENTS", "PI_WORKER_ALLOWED_ROOTS", "PI_WORKER_MAX_WORKERS",
  "FAKE_PI_MODE", "FAKE_PI_MODELS", "FAKE_PI_DEFAULT_MODEL", "FAKE_PI_REQUEST_LOG", "FAKE_PI_CONTEXT_LOG",
];
const prior = new Map(names.map((name) => [name, process.env[name]]));
let manager;
let requestLog;

function configure(mode, values = {}) {
  process.env.PI_WORKER_COMMAND = fakePi;
  process.env.FAKE_PI_MODE = mode;
  process.env.PI_WORKER_ALLOWED_ROOTS = values.allowedRoot ?? root;
  process.env.PI_WORKER_MAX_WORKERS = String(values.maxWorkers ?? 4);
  process.env.PI_WORKER_RPC_TIMEOUT_MS = String(values.rpc ?? 200);
  process.env.PI_WORKER_IDLE_TIMEOUT_MS = String(values.idle ?? 0);
  process.env.PI_WORKER_TASK_TIMEOUT_MS = String(values.task ?? 2_000);
  process.env.PI_WORKER_ABORT_GRACE_MS = String(values.abort ?? 50);
  process.env.PI_WORKER_TERM_GRACE_MS = String(values.term ?? 100);
  process.env.PI_WORKER_MAX_RECENT_EVENTS = String(values.maxEvents ?? 12);
  process.env.FAKE_PI_MODELS = JSON.stringify(values.models ?? [
    { provider: "provider-a", id: "foo" }, { provider: "provider-b", id: "foo" },
    { provider: "provider-x", id: "X" }, { provider: "provider-y", id: "Y" },
  ]);
  process.env.FAKE_PI_DEFAULT_MODEL = JSON.stringify(values.defaultModel ?? { provider: "local", id: "default" });
  requestLog = join(tmpdir(), `pi-worker-regression-${process.pid}-${Math.random()}.jsonl`);
  process.env.FAKE_PI_REQUEST_LOG = requestLog;
  manager = new WorkerManager();
}

async function waitFor(read, predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = read();
    if (predicate(result)) return result;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for worker state");
}

async function spawn(taskTimeoutMs = 2_000, model) {
  return manager.spawn({ task: "safe fake task", cwd: root, profile: "inspect", taskTimeoutMs, ...(model !== undefined ? { model } : {}) });
}

async function settle(id) {
  return manager.waitStatus(id, { waitMs: 2_000 });
}

async function requests() {
  return (await readFile(requestLog, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

afterEach(async () => {
  await manager?.shutdown().catch(() => undefined);
  manager = undefined;
  if (requestLog) await rm(requestLog, { force: true });
  for (const name of names) {
    const value = prior.get(name);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

// ---- Model selection baseline regressions ---------------------------------

test("an ambiguous bare model fails without a prompt and frees capacity", async () => {
  configure("normal", { maxWorkers: 1 });
  await assert.rejects(spawn(2_000, "foo"), (error) => {
    assert.equal(error.code, "AMBIGUOUS_MODEL");
    assert.match(error.message, /provider-a\/foo/);
    assert.match(error.message, /provider-b\/foo/);
    assert.doesNotMatch(error.message, /provider-x\/X/);
    return true;
  });
  assert.deepEqual((await requests()).map((request) => request.type), ["get_available_models", "abort"]);
  const failed = manager.list()[0];
  assert.equal(failed.failure.code, "AMBIGUOUS_MODEL");
  assert.equal(failed.processAlive, false);
  const replacement = await spawn();
  assert.equal(replacement.effectiveModel.id, "default");
});

test("a model state mismatch after a successful set_model fails and never prompts", async () => {
  configure("state_mismatch");
  await assert.rejects(spawn(2_000, "provider-x/X"), (error) => error.code === "MODEL_STATE_MISMATCH");
  assert.deepEqual((await requests()).map((request) => request.type), ["get_available_models", "set_model", "get_state", "abort"]);
  const failed = manager.list()[0];
  assert.equal(failed.failure.code, "MODEL_STATE_MISMATCH");
  assert.equal(failed.processAlive, false);
});

test("explicit model overrides stay isolated between workers", async () => {
  configure("silent", { maxWorkers: 2, task: 5_000 });
  const first = await spawn(5_000, "provider-x/X");
  const second = await spawn(5_000, "provider-y/Y");
  assert.deepEqual(first.effectiveModel, { provider: "provider-x", id: "X" });
  assert.deepEqual(second.effectiveModel, { provider: "provider-y", id: "Y" });
  await manager.release(first.id);
  await manager.release(second.id);
});

test("a worker without an override uses its own Pi default", async () => {
  configure("normal", { maxWorkers: 1 });
  const first = await spawn(2_000, "provider-x/X");
  await manager.release(first.id);
  const second = await spawn();
  assert.equal(second.requestedModel, undefined);
  assert.deepEqual(second.effectiveModel, { provider: "local", id: "default" });
});

test("follow-ups and steering retain the selected model without resolving again", async () => {
  configure("normal_follow_up");
  const worker = await spawn(2_000, "provider-x/X");
  await settle(worker.id);
  const followed = await manager.continue(worker.id, "first follow-up with the same model");
  assert.deepEqual(followed.effectiveModel, { provider: "provider-x", id: "X" });
  assert.equal(followed.pid, worker.pid);
  const secondFollowUp = await manager.continue(worker.id, "second follow-up with the same model");
  assert.deepEqual(secondFollowUp.effectiveModel, { provider: "provider-x", id: "X" });
  const steered = await manager.steer(worker.id, "stay with the selected model");
  assert.deepEqual(steered.effectiveModel, { provider: "provider-x", id: "X" });
  await settle(worker.id);
  const types = (await requests()).map((request) => request.type);
  assert.deepEqual(types, ["get_available_models", "set_model", "get_state", "prompt", "prompt", "follow_up", "steer"]);
  assert.equal(types.filter((type) => type === "get_available_models").length, 1);
  assert.equal(types.filter((type) => type === "set_model").length, 1);
  await manager.release(worker.id);
});

// ---- Prompt/follow-up disposition regressions ------------------------------

test("a Pi-handled initial prompt settles without inventing an agent_settled event", async () => {
  configure("prompt_handled");
  const worker = await spawn();
  assert.equal(worker.state, "settled");
  assert.equal(worker.deadlineAt, undefined);
  assert.ok(worker.recentEvents.some((event) => event.type === "prompt_handled"));
  assert.equal(worker.recentEvents.some((event) => event.type === "agent_settled"), false);
  assert.equal(worker.result.text, "");
});

test("a Pi-handled follow-up settles the new cycle through the handled path", async () => {
  configure("follow_up_handled");
  const worker = await spawn();
  await settle(worker.id);
  const handled = await manager.continue(worker.id, "extension-handled follow up");
  assert.equal(handled.state, "settled");
  assert.equal(handled.deadlineAt, undefined);
  assert.ok(handled.recentEvents.some((event) => event.type === "follow_up_handled"));
  assert.deepEqual((await requests()).map((request) => request.type), ["get_state", "prompt", "prompt"]);
});

// ---- Timeout, stall, and diagnostics regressions ---------------------------

test("a silent agent stalls and keeps its process for release", async () => {
  configure("silent", { idle: 90, rpc: 300, abort: 20, term: 60 });
  const worker = await spawn();
  const stalled = await waitFor(() => manager.status(worker.id), (value) => value.state === "stalled");
  assert.equal(stalled.failure.code, "IDLE_TIMEOUT");
  assert.ok(stalled.lastActivityAt);
  assert.equal(stalled.processAlive, true);
  await manager.release(worker.id);
});

test("a reported long-running tool suppresses idle stall detection", async () => {
  configure("tool_active", { idle: 60, rpc: 300, abort: 20, term: 60 });
  const worker = await spawn();
  await new Promise((resolve) => setTimeout(resolve, 120));
  const status = manager.status(worker.id);
  assert.equal(status.state, "running");
  assert.equal(status.currentTool, "bash");
  assert.equal(status.currentOperation, "tool:bash");
  await manager.release(worker.id);
});

test("malformed JSONL is observed and the pending RPC still times out", async () => {
  configure("malformed", { rpc: 80, abort: 20, term: 60 });
  await assert.rejects(spawn(), /timed out/i);
  const worker = manager.list()[0];
  assert.equal(worker.state, "timed_out");
  assert.ok(worker.recentEvents.some((event) => event.type === "malformed_jsonl"));
});

test("a malformed RPC response rejects its request and fails the worker", async () => {
  configure("malformed_response", { rpc: 300, abort: 20, term: 60 });
  await assert.rejects(spawn(), /malformed response/i);
  const worker = manager.list()[0];
  assert.equal(worker.state, "failed");
  assert.equal(worker.failure.code, "MALFORMED_RPC_RESPONSE");
});

test("a broken Pi stdin becomes terminal within the request timeout", async () => {
  configure("stdin_closed", { rpc: 300, abort: 20, term: 60 });
  const worker = await spawn();
  await new Promise((resolve) => setTimeout(resolve, 30));
  await assert.rejects(manager.steer(worker.id, "this write should fail"));
  const terminal = await waitFor(() => manager.status(worker.id), (value) => ["timed_out", "crashed", "failed"].includes(value.state));
  assert.equal(terminal.processAlive, false);
});

test("Pi stdout closure while the process remains alive is detected", async () => {
  configure("stdout_closed", { rpc: 500, abort: 20, term: 60 });
  await assert.rejects(spawn());
  const worker = await waitFor(() => manager.list()[0], (value) => value.state === "crashed");
  assert.ok(["STDOUT_CLOSED", "PROCESS_CRASHED"].includes(worker.failure.code));
});

test("the task deadline is independent of RPC and idle deadlines", async () => {
  configure("silent", { rpc: 300, idle: 0, task: 100, abort: 20, term: 60 });
  const worker = await spawn(100);
  const timedOut = await waitFor(() => manager.status(worker.id), (value) => value.state === "timed_out");
  assert.equal(timedOut.failure.code, "TASK_TIMEOUT");
  await manager.release(worker.id);
});

test("a failed activity cycle does not fabricate a completion timestamp", async () => {
  configure("agent_failure");
  const worker = await spawn();
  const failed = await waitFor(() => manager.status(worker.id), (value) => value.state === "failed");
  assert.equal(failed.completedAt, undefined);
});

test("Pi exiting during an abort is recorded as aborted, not crashed", async () => {
  configure("abort_exit", { rpc: 300, abort: 20, term: 60 });
  const worker = await spawn();
  const aborted = await manager.abort(worker.id);
  assert.equal(aborted.state, "aborted");
  assert.equal(aborted.processAlive, false);
  assert.equal(aborted.failure, undefined);
});

test("an aborting worker serializes concurrent steer and follow-up without overlap", async () => {
  configure("abort_stuck", { rpc: 70, abort: 30, term: 60 });
  const worker = await spawn();
  const aborting = manager.abort(worker.id);
  await waitFor(() => manager.status(worker.id), (value) => value.state === "aborting");
  const results = await Promise.allSettled([
    manager.steer(worker.id, "must not steer while aborting"),
    manager.continue(worker.id, "must not continue while aborting"),
  ]);
  assert.equal(results[0].status, "rejected");
  assert.equal(results[1].status, "rejected");
  assert.equal((await aborting).state, "aborted");
  assert.equal(manager.status(worker.id).processAlive, false);
});

test("worker list orders snapshots by creation time, newest first", async () => {
  configure("silent", { maxWorkers: 2, task: 5_000 });
  const older = await spawn(5_000);
  await new Promise((resolve) => setTimeout(resolve, 5));
  const newer = await spawn(5_000);
  assert.deepEqual(manager.list().map((worker) => worker.id), [newer.id, older.id]);
  await manager.release(older.id);
  await manager.release(newer.id);
});

// ---- Concurrent mutation races ---------------------------------------------

test("a concurrent continue and release serialize so a new cycle cannot be left half-released", async () => {
  configure("follow_up_running", { task: 5_000 });
  const worker = await spawn(5_000);
  const [continued, released] = await Promise.allSettled([
    manager.continue(worker.id, "queued during release race"),
    manager.release(worker.id),
  ]);
  assert.equal(released.status, "fulfilled");
  assert.equal(released.value.released, true);
  assert.equal(released.value.processAlive, false);
  const final = manager.status(worker.id);
  assert.equal(final.released, true);
  assert.equal(final.processAlive, false);
  // The queued follow-up either landed in the same cycle before release or was
  // rejected cleanly; either way the worker is released exactly once.
  if (continued.status === "fulfilled") assert.equal(continued.value.cycleId, 1);
});

test("a concurrent abort and continue serialize into a new reusable cycle", async () => {
  configure("silent", { task: 5_000, rpc: 500, abort: 50, term: 100 });
  const worker = await spawn(5_000);
  const [aborted, continued] = await Promise.allSettled([
    manager.abort(worker.id),
    manager.continue(worker.id, "next cycle after abort race"),
  ]);
  assert.equal(aborted.status, "fulfilled");
  assert.equal(continued.status, "fulfilled");
  const final = manager.status(worker.id);
  assert.equal(final.state, "running");
  assert.equal(final.cycleId, 2);
  await manager.release(worker.id);
});

test("a stale expired-cycle timeout cancel cannot abort a newer cycle", async () => {
  configure("silent", { task: 5_000, rpc: 500, abort: 50, term: 100 });
  const worker = await spawn(5_000);
  const internal = manager["workers"].get(worker.id);
  assert.ok(internal);
  await manager.abort(worker.id);
  const resumed = await manager.continue(worker.id, "cycle 2 after a cancelled cycle 1");
  assert.equal(resumed.cycleId, 2);
  assert.equal(resumed.state, "running");

  // The expired cycle-1 task/idle timer fires late and queues its cancellation
  // under the serialized mutation chain, after cycle 2 has already started.
  await internal.cancelCurrentCycle(1);

  const status = manager.status(worker.id);
  assert.equal(status.cycleId, 2);
  assert.equal(status.state, "running", "the stale cancel must not terminate cycle 2");
  assert.equal(status.failure, undefined);
  await manager.release(worker.id);
});

test("a concurrent release and continue rejects the continue without corrupting release", async () => {
  configure("normal");
  const worker = await spawn();
  await settle(worker.id);
  const [released, continued] = await Promise.allSettled([
    manager.release(worker.id),
    manager.continue(worker.id, "too late"),
  ]);
  assert.equal(released.status, "fulfilled");
  assert.equal(released.value.released, true);
  assert.equal(continued.status, "rejected");
  assert.match(continued.reason.message, /released|not running/i);
  assert.equal(manager.status(worker.id).state, "settled");
});

test("shutdown reports an unconfirmed termination instead of silent success", async () => {
  configure("stubborn_alive", { maxWorkers: 1, rpc: 300, abort: 30, term: 40, task: 5_000 });
  const worker = await spawn(5_000);
  const originalKill = process.kill;
  try {
    process.kill = () => {
      const error = new Error("EPERM: simulated signal failure");
      error.code = "EPERM";
      throw error;
    };
    await assert.rejects(manager.shutdown(), (error) => {
      assert.ok(error instanceof AggregateError);
      assert.ok(error.errors.some((entry) => entry.code === "SHUTDOWN_INCOMPLETE"));
      return true;
    });
    assert.equal(manager["workers"].has(worker.id), true, "an unconfirmed shutdown must retain the live slot");
  } finally {
    process.kill = originalKill;
  }
  const released = await manager.release(worker.id);
  assert.equal(released.released, true);
  assert.equal(released.processAlive, false);
});

// ---- Default wait target ----------------------------------------------------

test("a wait without cycleId binds to the cycle that was current at entry", async () => {
  configure("follow_up_running", { task: 5_000 });
  const worker = await spawn(5_000);
  const pending = manager.waitStatus(worker.id, { waitMs: 2_000 });
  // A running follow-up stays inside cycle 1, so the captured target still settles there.
  await manager.continue(worker.id, "queued");
  const snapshot = await pending;
  assert.equal(snapshot.cycleId, 1);
  assert.equal(snapshot.state, "settled");
});

test("a wait targeting a future cycle resolves once that cycle starts and settles", async () => {
  configure("normal_follow_up");
  const worker = await spawn();
  await settle(worker.id);
  const pending = manager.waitStatus(worker.id, { cycleId: 2, waitMs: 2_000 });
  await manager.continue(worker.id, "second cycle");
  const snapshot = await pending;
  assert.equal(snapshot.cycleId, 2);
  assert.equal(snapshot.state, "settled");
  assert.ok(snapshot.cycles.some((cycle) => cycle.cycleId === 2));
});

// ---- Leader exit with surviving descendant ---------------------------------

test("a process group leader exit still reaps surviving tool descendants", { skip: process.platform === "win32" }, async () => {
  configure("orphan_descendant", { rpc: 400, abort: 20, term: 100 });
  await spawn();
  const worker = await waitFor(() => manager.list()[0], (value) => value !== undefined && /DESCENDANT_PID=\d+/.test(value.lastOutput));
  const descendantPid = Number(worker.lastOutput.match(/DESCENDANT_PID=(\d+)/)?.[1]);
  assert.ok(descendantPid > 0);
  try {
    await waitFor(() => manager.status(worker.id), (value) => value.state === "crashed");
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.throws(() => process.kill(descendantPid, 0), { code: "ESRCH" });
  } finally {
    try { process.kill(descendantPid, "SIGKILL"); } catch { /* already reaped */ }
  }
});

// ---- Profile-scoped tools and canonical cwd --------------------------------

test("spawn selects profile-scoped Pi tools and runs in the canonical authorized cwd", { skip: process.platform === "win32" }, async () => {
  const base = await mkdtemp(join(tmpdir(), "pi-worker-tools-"));
  const linked = join(base, "linked");
  await symlink(base, linked);
  const contextLog = join(tmpdir(), `pi-worker-context-${process.pid}-${Math.random()}.jsonl`);
  configure("silent", { allowedRoot: base, task: 5_000 });
  process.env.FAKE_PI_CONTEXT_LOG = contextLog;
  try {
    const inspect = await manager.spawn({ task: "inspect task", cwd: linked, profile: "inspect" });
    const implement = await manager.spawn({ task: "implement task", cwd: base, profile: "implement" });
    const contexts = (await readFile(contextLog, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    assert.equal(contexts.length, 2);
    const [inspectContext, implementContext] = contexts;
    const toolsFor = (context) => {
      const index = context.argv.indexOf("--tools");
      assert.notEqual(index, -1, "Pi must be launched with an explicit --tools list");
      return context.argv[index + 1].split(",");
    };
    assert.deepEqual(inspectContext.argv.slice(0, 3), ["--mode", "rpc", "--no-session"]);
    assert.deepEqual(toolsFor(inspectContext), ["read", "grep", "find", "ls"]);
    assert.equal(toolsFor(inspectContext).some((tool) => ["edit", "write", "bash"].includes(tool)), false);
    assert.deepEqual(toolsFor(implementContext), ["read", "edit", "write", "bash", "grep", "find", "ls"]);
    assert.equal(["edit", "write", "bash"].every((tool) => toolsFor(implementContext).includes(tool)), true);
    assert.equal(inspectContext.cwd, await realpath(linked));
    assert.equal(inspectContext.cwd, await realpath(base));
    assert.equal(implementContext.cwd, await realpath(base));
    assert.equal(inspect.cwd, await realpath(linked));
    assert.equal(implement.cwd, await realpath(base));
    await manager.release(inspect.id);
    await manager.release(implement.id);
  } finally {
    await rm(base, { recursive: true, force: true });
    await rm(contextLog, { force: true });
  }
});
