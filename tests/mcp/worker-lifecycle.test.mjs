import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink } from "node:fs/promises";
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
  "PI_WORKER_MAX_RESULT_CHARS", "PI_WORKER_MAX_CYCLES", "PI_WORKER_MAX_ARCHIVED",
  "FAKE_PI_MODE", "FAKE_PI_MODELS", "FAKE_PI_DEFAULT_MODEL", "FAKE_PI_REQUEST_LOG", "FAKE_PI_TEXT_LENGTH",
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
  process.env.PI_WORKER_MAX_RESULT_CHARS = String(values.maxResultChars ?? 256_000);
  process.env.PI_WORKER_MAX_CYCLES = String(values.maxCycles ?? 10);
  process.env.PI_WORKER_MAX_ARCHIVED = String(values.maxArchived ?? 25);
  if (values.textLength !== undefined) process.env.FAKE_PI_TEXT_LENGTH = String(values.textLength);
  else delete process.env.FAKE_PI_TEXT_LENGTH;
  process.env.FAKE_PI_MODELS = JSON.stringify(values.models ?? [
    { provider: "provider-a", id: "foo" }, { provider: "provider-b", id: "foo" },
    { provider: "provider-x", id: "X" }, { provider: "provider-y", id: "Y" },
  ]);
  process.env.FAKE_PI_DEFAULT_MODEL = JSON.stringify(values.defaultModel ?? { provider: "local", id: "default" });
  requestLog = join(tmpdir(), `pi-worker-requests-${process.pid}-${Math.random()}.jsonl`);
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
  return manager.spawn({ task: "safe fake task", cwd: root, mode: "direct", profile: "inspect", taskTimeoutMs, ...(model !== undefined ? { model } : {}) });
}

async function settle(id, waitMs = 2_000) {
  return manager.waitStatus(id, { waitMs });
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

// ---------------------------------------------------------------------------
// Model preflight
// ---------------------------------------------------------------------------

test("omitted model uses Pi default, observes state, and starts prompt without model catalog RPC", async () => {
  configure("normal");
  const worker = await spawn();
  assert.deepEqual(worker.effectiveModel, { provider: "local", id: "default" });
  assert.equal(worker.thinkingLevel, "high");
  assert.equal(worker.requestedModel, undefined);
  const types = (await requests()).map((request) => request.type);
  assert.deepEqual(types, ["get_state", "prompt"]);
});

test("canonical explicit model resolves, sets, observes, then prompts in order", async () => {
  configure("normal");
  const worker = await spawn(2_000, "provider-x/X");
  assert.equal(worker.requestedModel, "provider-x/X");
  assert.deepEqual(worker.effectiveModel, { provider: "provider-x", id: "X" });
  const recorded = await requests();
  assert.deepEqual(recorded.map((request) => request.type), ["get_available_models", "set_model", "get_state", "prompt"]);
  assert.deepEqual({ provider: recorded[1].provider, modelId: recorded[1].modelId }, { provider: "provider-x", modelId: "X" });
});

test("a unique bare model id resolves to its sole provider", async () => {
  configure("normal", { models: [{ provider: "provider-a", id: "foo" }] });
  const worker = await spawn(2_000, "foo");
  assert.deepEqual(worker.effectiveModel, { provider: "provider-a", id: "foo" });
});

test("Pi set_model rejection is reported as MODEL_SET_FAILED with Pi's reason and phase", async () => {
  configure("set_model_reject");
  await assert.rejects(spawn(2_000, "provider-x/X"), (error) => {
    assert.equal(error.code, "MODEL_SET_FAILED");
    assert.equal(error.phase, "model");
    assert.match(error.message, /Pi refused model selection/);
    return true;
  });
  assert.deepEqual((await requests()).map((request) => request.type), ["get_available_models", "set_model", "abort"]);
  const failed = manager.list()[0];
  assert.equal(failed.failure.code, "MODEL_SET_FAILED");
  assert.equal(failed.failure.phase, "model");
  assert.equal(failed.failure.workerId, failed.id);
  assert.equal(failed.processAlive, false);
  assert.equal(manager["workers"].has(failed.id), false);
  assert.equal(manager["archived"].has(failed.id), true);
});

test("missing model fails without prompt, releases the process slot, and can be released again", async () => {
  configure("normal", { maxWorkers: 1 });
  await assert.rejects(spawn(2_000, "does-not-exist"), (error) => error.code === "MODEL_NOT_AVAILABLE" && error.phase === "model");
  assert.deepEqual((await requests()).map((request) => request.type), ["get_available_models", "abort"]);
  const failed = manager.list()[0];
  assert.equal(failed.failure.code, "MODEL_NOT_AVAILABLE");
  assert.equal(failed.processAlive, false);
  const released = await manager.release(failed.id);
  assert.equal(released.released, true);
  assert.equal(released.failure.code, "MODEL_NOT_AVAILABLE");
  const replacement = await spawn();
  assert.equal(replacement.processAlive, true);
});

// ---------------------------------------------------------------------------
// Authoritative results and diagnostics
// ---------------------------------------------------------------------------

test("result comes from the finalized assistant message and never from streamed deltas", async () => {
  configure("deltas");
  const worker = await spawn();
  const settled = await settle(worker.id);
  assert.equal(settled.state, "settled");
  assert.equal(settled.result.text, "authoritative full text");
  assert.equal(settled.result.chars, "authoritative full text".length);
  assert.equal(settled.result.truncated, false);
  // Diagnostics still carry the streamed deltas and are independent of the result.
  assert.match(settled.lastOutput, /streamed draft only/);
  assert.notEqual(settled.lastOutput, settled.result.text);
});

test("a full long authoritative result is not silently truncated", async () => {
  configure("long_result", { textLength: 50_000 });
  const worker = await spawn();
  const settled = await settle(worker.id);
  assert.equal(settled.result.chars, 50_000);
  assert.equal(settled.result.text.length, 50_000);
  assert.equal(settled.result.truncated, false);
});

test("a configured size limit marks the result as truncated with the original length", async () => {
  configure("long_result", { textLength: 5_000, maxResultChars: 1_000 });
  const worker = await spawn();
  const settled = await settle(worker.id);
  assert.equal(settled.result.truncated, true);
  assert.equal(settled.result.chars, 5_000);
  assert.equal(settled.result.text.length, 1_000);
});

test("a non-retry model failure settles the cycle as failed with a structured phase", async () => {
  configure("agent_error_settle");
  const worker = await spawn();
  const failed = await settle(worker.id);
  assert.equal(failed.state, "failed");
  assert.equal(failed.failure.code, "PI_AGENT_ERROR");
  assert.equal(failed.failure.message, "non-retry model failure");
  assert.equal(failed.failure.phase, "runtime");
  assert.equal(failed.failure.workerId, worker.id);
  assert.equal(failed.failure.cycleId, 1);
  assert.equal(failed.processAlive, true, "a model failure must not kill the reusable process");
});

test("automatic retry success recovers in the same cycle without a failure", async () => {
  configure("retry_success");
  const worker = await spawn();
  const settled = await settle(worker.id);
  assert.equal(settled.state, "settled");
  assert.equal(settled.failure, undefined);
  assert.equal(settled.result.text, "recovered answer");
  assert.equal(settled.cycleId, 1);
  assert.equal(settled.cycles.length, 1);
});

test("exhausted automatic retries fail the same cycle with the final provider error", async () => {
  configure("retry_failure");
  const worker = await spawn();
  const failed = await settle(worker.id);
  assert.equal(failed.state, "failed");
  assert.equal(failed.failure.code, "PI_AGENT_ERROR");
  assert.equal(failed.failure.message, "provider unavailable");
  assert.equal(failed.failure.phase, "runtime");
  assert.deepEqual((await requests()).map((request) => request.type), ["get_state", "prompt"]);
});

test("stopReason length explicitly marks the result incomplete and fails the cycle", async () => {
  configure("length_stop");
  const worker = await spawn();
  const failed = await settle(worker.id);
  assert.equal(failed.state, "failed");
  assert.equal(failed.failure.code, "PI_OUTPUT_TRUNCATED");
  assert.equal(failed.result.truncated, true);
  assert.equal(failed.result.stopReason, "length");
});

test("an assistant aborted stopReason is treated as cancellation even without a host abort", async () => {
  configure("assistant_aborted");
  const worker = await spawn();
  const aborted = await settle(worker.id);
  assert.equal(aborted.state, "aborted");
  assert.equal(aborted.failure, undefined);
});

test("credentials in diagnostics and failure messages are redacted while result text is untouched", async () => {
  configure("secret_error");
  const worker = await spawn();
  const failed = await settle(worker.id);
  assert.doesNotMatch(failed.failure.message, /sk-ABCDEFGHIJKLMNOP/);
  assert.match(failed.failure.message, /REDACTED/);
  await manager.release(worker.id);

  configure("secret_stderr");
  const second = await spawn();
  const settled = await settle(second.id);
  assert.doesNotMatch(settled.lastOutput, /ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345/);
  assert.match(settled.lastOutput, /REDACTED/);
  assert.equal(settled.result.text, "stdout stays clean");
});

// ---------------------------------------------------------------------------
// Cycles
// ---------------------------------------------------------------------------

test("sequential settled continuations start distinct cycles and never reuse an old result", async () => {
  configure("normal_follow_up");
  const worker = await spawn();
  const first = await settle(worker.id);
  assert.equal(first.cycleId, 1);
  assert.equal(first.result.cycleId, 1);

  const running = await manager.continue(worker.id, "second cycle");
  assert.equal(running.cycleId, 2);
  assert.equal(running.state, "running");
  assert.equal(running.result, undefined, "a new cycle must not expose the previous result");
  assert.equal(running.lastOutput, "", "a new cycle must not expose the previous diagnostics");

  const second = await settle(worker.id);
  assert.equal(second.cycleId, 2);
  assert.equal(second.result.cycleId, 2);
  assert.equal(second.cycles.length, 2);
  assert.equal(second.cycles[0].cycleId, 2);
  assert.equal(second.cycles[1].cycleId, 1);
  assert.equal(second.cycles[0].state, "settled");
});

test("archived cycles are bounded and keep only the most recent entries", async () => {
  configure("normal_follow_up", { maxCycles: 2 });
  const worker = await spawn();
  await settle(worker.id);
  for (let index = 0; index < 2; index++) {
    await manager.continue(worker.id, `cycle ${index + 2}`);
    await settle(worker.id);
  }
  const snapshot = manager.status(worker.id);
  assert.equal(snapshot.cycleId, 3);
  assert.equal(snapshot.cycles.length, 2);
  assert.deepEqual(snapshot.cycles.map((cycle) => cycle.cycleId), [3, 2]);
  assert.equal(snapshot.result.cycleId, 3);
});

test("a running follow-up is drained inside the same cycle and does not start a new one", async () => {
  configure("follow_up_running", { task: 5_000 });
  const worker = await spawn();
  const started = manager.status(worker.id);
  assert.equal(started.cycleId, 1);
  assert.equal(started.state, "running");

  const queued = await manager.continue(worker.id, "queue while active");
  assert.equal(queued.cycleId, 1);
  assert.equal(queued.runStartedAt, started.runStartedAt);
  assert.equal(queued.deadlineAt, started.deadlineAt);

  const observed = await waitFor(() => manager.status(worker.id), (value) => value.pendingFollowUps === 1);
  assert.equal(observed.cycleId, 1);
  const settled = await settle(worker.id);
  assert.equal(settled.cycleId, 1, "a drained queued follow-up stays in the current cycle");
  assert.equal(settled.state, "settled");
  assert.equal(settled.pendingFollowUps, 0);
  assert.equal(settled.runStartedAt, started.runStartedAt);
  const types = (await requests()).map((request) => request.type);
  assert.deepEqual(types, ["get_state", "prompt", "follow_up"]);
  assert.ok(settled.recentEvents.some((event) => event.type === "user_message_started"));
});

// ---------------------------------------------------------------------------
// Bounded, event-driven status waits
// ---------------------------------------------------------------------------

test("waitStatus returns an immediate snapshot when waitMs is omitted", async () => {
  configure("follow_up_running", { task: 5_000 });
  const worker = await spawn();
  const before = Date.now();
  const snapshot = await manager.waitStatus(worker.id);
  assert.ok(Date.now() - before < 200);
  assert.equal(snapshot.state, "running");
});

test("waitStatus wakes on settle well before the wait window expires and does not cancel the worker", async () => {
  configure("follow_up_running", { task: 5_000 });
  const worker = await spawn();
  const before = Date.now();
  const snapshot = await manager.waitStatus(worker.id, { waitMs: 2_000 });
  const elapsed = Date.now() - before;
  assert.equal(snapshot.state, "settled");
  assert.ok(elapsed < 1_500, `expected an event-driven wake, took ${elapsed}ms`);
  assert.equal(snapshot.processAlive, true);
});

test("a wait-window timeout returns the running snapshot without cancelling the worker", async () => {
  configure("silent", { task: 5_000, rpc: 500, abort: 30, term: 60 });
  const worker = await spawn(5_000);
  const before = Date.now();
  const snapshot = await manager.waitStatus(worker.id, { waitMs: 80 });
  assert.ok(Date.now() - before >= 60);
  assert.equal(snapshot.state, "running");
  assert.equal(snapshot.processAlive, true);
  await manager.release(worker.id);
});

test("concurrent bounded waits all resolve on the same settle event", async () => {
  configure("follow_up_running", { task: 5_000 });
  const worker = await spawn();
  const before = Date.now();
  const results = await Promise.all(Array.from({ length: 5 }, () => manager.waitStatus(worker.id, { waitMs: 2_000 })));
  assert.ok(Date.now() - before < 1_500);
  for (const snapshot of results) {
    assert.equal(snapshot.state, "settled");
    assert.equal(snapshot.cycleId, 1);
  }
});

test("waitStatus targets an explicit cycleId, including already-archived cycles", async () => {
  configure("normal_follow_up");
  const worker = await spawn();
  await settle(worker.id);
  await manager.continue(worker.id, "second");
  const second = await settle(worker.id);
  assert.equal(second.cycleId, 2);

  const archived = await manager.waitStatus(worker.id, { cycleId: 1, waitMs: 100 });
  assert.equal(archived.cycles.find((cycle) => cycle.cycleId === 1).state, "settled");

  const before = Date.now();
  const future = await manager.waitStatus(worker.id, { cycleId: 5, waitMs: 80 });
  assert.ok(Date.now() - before >= 60);
  assert.equal(future.cycleId, 2);
});

test("waitStatus returns immediately for a dead archived worker instead of waiting for a future cycle", async () => {
  configure("crash", { rpc: 400, abort: 20, term: 60 });
  await assert.rejects(spawn(), /exited/i);
  const crashed = await waitFor(() => manager.list()[0], (value) => value.state === "crashed");
  const before = Date.now();
  const snapshot = await manager.waitStatus(crashed.id, { cycleId: 9, waitMs: 5_000 });
  assert.ok(Date.now() - before < 200);
  assert.equal(snapshot.state, "crashed");
});

// ---------------------------------------------------------------------------
// abort: cancellation only
// ---------------------------------------------------------------------------

test("abort cancels the running cycle but keeps the process alive and the worker continuable", async () => {
  configure("silent", { task: 5_000, rpc: 500, abort: 50, term: 100 });
  const worker = await spawn(5_000);
  const aborted = await manager.abort(worker.id);
  assert.equal(aborted.state, "aborted");
  assert.equal(aborted.processAlive, true);
  assert.equal(aborted.failure, undefined);
  assert.equal(aborted.released, false);

  const resumed = await manager.continue(worker.id, "new cycle after abort");
  assert.equal(resumed.cycleId, 2);
  assert.equal(resumed.state, "running");
  await manager.release(worker.id);
});

test("abort is a no-op for a settled worker and concurrent aborts are idempotent", async () => {
  configure("normal");
  const worker = await spawn();
  await settle(worker.id);
  const first = await manager.abort(worker.id);
  assert.equal(first.state, "settled");
  assert.equal(first.result.text, "safe fake task complete");
  assert.equal(first.processAlive, true);
  const [a, b] = await Promise.all([manager.abort(worker.id), manager.abort(worker.id)]);
  assert.equal(a.state, "settled");
  assert.equal(b.state, "settled");
});

test("abort escalates to process termination only when Pi ignores the abort request", async () => {
  configure("abort_stuck", { rpc: 70, abort: 20, term: 60 });
  const worker = await spawn();
  const [result, repeated] = await Promise.all([manager.abort(worker.id), manager.abort(worker.id)]);
  assert.equal(result.state, "aborted");
  assert.equal(repeated.state, "aborted");
  assert.equal(result.processAlive, false);
  assert.equal(manager["workers"].has(worker.id), false);
});

// ---------------------------------------------------------------------------
// release: resource lifecycle
// ---------------------------------------------------------------------------

test("release preserves a completed result, is idempotent, and frees the slot", async () => {
  configure("normal", { maxWorkers: 1 });
  const worker = await spawn();
  const settled = await settle(worker.id);
  const result = settled.result;

  const released = await manager.release(worker.id);
  assert.equal(released.state, "settled");
  assert.deepEqual(released.result, result);
  assert.equal(released.released, true);
  assert.equal(released.processAlive, false);

  const repeated = await manager.release(worker.id);
  assert.deepEqual(repeated.result, result);
  assert.equal(repeated.released, true);

  const replacement = await spawn();
  assert.equal(replacement.processAlive, true);
});

test("release of a running cycle cancels it and preserves the cancellation outcome", async () => {
  configure("silent", { task: 5_000, rpc: 500, abort: 50, term: 100 });
  const worker = await spawn(5_000);
  const released = await manager.release(worker.id);
  assert.equal(released.state, "aborted");
  assert.equal(released.released, true);
  assert.equal(released.failure, undefined);
  assert.equal(released.processAlive, false);
  assert.equal(released.cycles.at(-1).state, "aborted");
});

test("release on an archived crashed worker preserves the failure and marks it released", async () => {
  configure("crash_after_spawn", { rpc: 400, abort: 20, term: 60 });
  const worker = await spawn();
  const crashed = await waitFor(() => manager.status(worker.id), (value) => value.state === "crashed");
  assert.equal(crashed.failure.code, "PROCESS_CRASHED");
  assert.equal(crashed.released, false);
  const released = await manager.release(crashed.id);
  assert.equal(released.released, true);
  assert.equal(released.failure.code, "PROCESS_CRASHED");
  assert.equal(released.processAlive, false);
});

test("an incomplete release keeps the live slot occupied and a retry succeeds", async () => {
  configure("normal", { maxWorkers: 1, rpc: 300, abort: 30, term: 40 });
  const worker = await spawn();
  const settled = await settle(worker.id);
  const originalKill = process.kill;
  try {
    process.kill = () => {
      const error = new Error("EPERM: simulated signal failure");
      error.code = "EPERM";
      throw error;
    };
    const failed = await manager.release(worker.id);
    assert.equal(failed.released, false);
    assert.equal(failed.processAlive, true);
    assert.equal(failed.releaseError.code, "RELEASE_INCOMPLETE");
    assert.equal(manager["workers"].has(worker.id), true, "an incomplete release must not archive a live worker");
    assert.equal(manager["archived"].has(worker.id), false);
    await assert.rejects(spawn(), /Maximum live worker count/);
  } finally {
    process.kill = originalKill;
  }
  const retried = await manager.release(worker.id);
  assert.equal(retried.released, true);
  assert.equal(retried.processAlive, false);
  assert.deepEqual(retried.result, settled.result);
});

test("archived worker history is bounded and evicts the oldest released snapshot", async () => {
  configure("normal", { maxArchived: 2, maxWorkers: 4 });
  const ids = [];
  for (let index = 0; index < 3; index++) {
    const worker = await spawn();
    await manager.release(worker.id);
    ids.push(worker.id);
  }
  assert.equal(manager["archived"].size, 2);
  assert.equal(manager.list().length, 2);
  assert.equal(manager["archived"].has(ids[0]), false);
  assert.equal(manager["archived"].has(ids[1]), true);
  assert.equal(manager["archived"].has(ids[2]), true);
});

// ---------------------------------------------------------------------------
// Process exits, shutdown, and process-group cleanup
// ---------------------------------------------------------------------------

test("unexpected nonzero process exit is recorded as crashed and archived", async () => {
  configure("crash", { rpc: 400, abort: 20, term: 60 });
  await assert.rejects(spawn(), /exited/i);
  const crashed = await waitFor(() => manager.list()[0], (value) => value.state === "crashed");
  assert.equal(crashed.exitCode, 23);
  assert.equal(crashed.failure.code, "PROCESS_CRASHED");
  assert.equal(crashed.terminatedAt !== undefined, true);
  assert.equal(manager["workers"].has(crashed.id), false);
  assert.ok(crashed.recentEvents.some((event) => event.type === "process_exit"));
});

test("RPC no-response becomes timed_out, reaps the child, and cannot be continued", async () => {
  configure("no_response", { rpc: 80, abort: 20, term: 60 });
  await assert.rejects(spawn(), /timed out/i);
  const worker = manager.list()[0];
  assert.equal(worker.state, "timed_out");
  assert.equal(worker.failure.code, "RPC_TIMEOUT");
  assert.equal(worker.processAlive, false);
  await assert.rejects(manager.continue(worker.id, "must not restart"), /not running|released|terminal/i);
  await assert.rejects(manager.steer(worker.id, "must not steer"), /not running|released|terminal/i);
});

test("a missing Pi executable is terminal but no longer consumes a live worker slot", async () => {
  configure("normal", { maxWorkers: 1, rpc: 500, abort: 10, term: 20 });
  process.env.PI_WORKER_COMMAND = join(root, "definitely-missing-pi-binary");
  await assert.rejects(spawn(), /ENOENT/);
  const failed = await waitFor(() => manager.list()[0], (value) => value.state === "crashed" && !value.processAlive);
  const released = await manager.release(failed.id);
  assert.equal(released.state, "crashed");
  assert.equal(released.processAlive, false);
  await assert.rejects(spawn(), /ENOENT/);
});

test("shutdown terminates an active process without rewriting a completed outcome", async () => {
  configure("normal");
  const worker = await spawn();
  const settled = await settle(worker.id);
  await manager.shutdown();
  const after = manager.status(worker.id);
  assert.equal(after.state, "settled");
  assert.deepEqual(after.result, settled.result);
  assert.equal(after.processAlive, false);
  assert.equal(after.released, true);
});

test("Unix process-group release reaps tool descendants", { skip: process.platform === "win32" }, async () => {
  configure("forked", { rpc: 300, abort: 20, term: 100 });
  const worker = await spawn();
  const withPid = await waitFor(() => manager.status(worker.id), (value) => /DESCENDANT_PID=\d+/.test(value.lastOutput));
  const descendantPid = Number(withPid.lastOutput.match(/DESCENDANT_PID=(\d+)/)?.[1]);
  assert.ok(descendantPid > 0);
  try {
    const released = await manager.release(worker.id);
    assert.equal(released.released, true);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.throws(() => process.kill(descendantPid, 0), { code: "ESRCH" });
  } finally {
    try { process.kill(descendantPid, "SIGKILL"); } catch { /* already reaped */ }
  }
});

// ---------------------------------------------------------------------------
// Directory authorization (Phase 1 ownership; kept intact here)
// ---------------------------------------------------------------------------

test("allowed-root containment accepts the root and descendants, and rejects escapes and prefix siblings", async () => {
  const base = await mkdtemp(join(tmpdir(), "pi-worker-roots-"));
  const allowed = join(base, "project");
  const prefixSibling = join(base, "project-other");
  const outside = join(base, "outside");
  const child = join(allowed, "child");
  const deeper = join(child, "deeper");
  await Promise.all([mkdir(deeper, { recursive: true }), mkdir(prefixSibling), mkdir(outside)]);
  configure("normal", { allowedRoot: allowed, maxWorkers: 8 });
  try {
    for (const cwd of [allowed, child, deeper]) {
      const worker = await manager.spawn({ task: "allowed path", cwd, mode: "direct", profile: "inspect" });
      assert.equal(worker.cwd, await realpath(cwd));
      await manager.release(worker.id);
    }
    for (const cwd of [prefixSibling, outside, join(allowed, "..", "outside")]) {
      await assert.rejects(
        manager.spawn({ task: "escaped path", cwd, mode: "direct", profile: "inspect" }),
        (error) => /outside PI_WORKER_ALLOWED_ROOTS/.test(error.message) && /inside an allowed root/.test(error.message),
      );
    }
    assert.equal(manager.list().length, 3);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("allowed-root containment resolves a symlink before checking the boundary", async () => {
  if (process.platform === "win32") return;
  const base = await mkdtemp(join(tmpdir(), "pi-worker-symlink-"));
  const allowed = join(base, "project");
  const outside = join(base, "outside");
  await Promise.all([mkdir(allowed), mkdir(outside)]);
  await symlink(outside, join(allowed, "escape"));
  configure("normal", { allowedRoot: allowed });
  try {
    await assert.rejects(
      manager.spawn({ task: "symlink escape", cwd: join(allowed, "escape"), mode: "direct", profile: "inspect" }),
      (error) => /outside PI_WORKER_ALLOWED_ROOTS/.test(error.message) && /configure PI_WORKER_ALLOWED_ROOTS/.test(error.message),
    );
    assert.equal(manager.list().length, 0);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("concurrent spawn reservations cannot exceed maxWorkers", async () => {
  configure("silent", { maxWorkers: 2, task: 5_000 });
  const results = await Promise.allSettled([spawn(5_000), spawn(5_000), spawn(5_000)]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 2);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  const rejected = results.find((result) => result.status === "rejected");
  assert.match(rejected.reason.message, /Maximum live worker count/);
  assert.match(rejected.reason.message, /pi_release/);
  for (const result of results) if (result.status === "fulfilled") await manager.release(result.value.id);
});

test("shutdown racing with path validation prevents a late worker spawn", async () => {
  configure("normal");
  const spawning = spawn();
  const shuttingDown = manager.shutdown();
  const [spawnResult] = await Promise.allSettled([spawning, shuttingDown]);
  assert.equal(spawnResult.status, "rejected");
  assert.match(spawnResult.reason.message, /shutting down/);
  assert.equal(manager.list().length, 0);
});
