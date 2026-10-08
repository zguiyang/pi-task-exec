import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { WorkerManager } from "../dist/worker-manager.js";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const fakePi = fileURLToPath(new URL("./fixtures/fake-pi.mjs", import.meta.url));
const names = [
  "PI_WORKER_COMMAND", "PI_WORKER_RPC_TIMEOUT_MS", "PI_WORKER_IDLE_TIMEOUT_MS",
  "PI_WORKER_TASK_TIMEOUT_MS", "PI_WORKER_ABORT_GRACE_MS", "PI_WORKER_TERM_GRACE_MS",
  "PI_WORKER_MAX_RECENT_EVENTS", "PI_WORKER_ALLOWED_ROOTS", "PI_WORKER_MAX_WORKERS", "FAKE_PI_MODE",
  "FAKE_PI_MODELS", "FAKE_PI_DEFAULT_MODEL", "FAKE_PI_REQUEST_LOG",
];
const prior = new Map(names.map((name) => [name, process.env[name]]));
let manager;
let requestLog;

function configure(mode, values = {}) {
  process.env.PI_WORKER_COMMAND = fakePi;
  process.env.FAKE_PI_MODE = mode;
  process.env.PI_WORKER_ALLOWED_ROOTS = values.allowedRoot ?? root;
  process.env.PI_WORKER_MAX_WORKERS = String(values.maxWorkers ?? 4);
  process.env.PI_WORKER_RPC_TIMEOUT_MS = String(values.rpc ?? 120);
  process.env.PI_WORKER_IDLE_TIMEOUT_MS = String(values.idle ?? 0);
  process.env.PI_WORKER_TASK_TIMEOUT_MS = String(values.task ?? 2_000);
  process.env.PI_WORKER_ABORT_GRACE_MS = String(values.abort ?? 50);
  process.env.PI_WORKER_TERM_GRACE_MS = String(values.term ?? 100);
  process.env.PI_WORKER_MAX_RECENT_EVENTS = "8";
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

async function requests() {
  return (await readFile(requestLog, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
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

test("omitted model uses Pi default, observes state, and starts prompt without model catalog RPC", async () => {
  configure("normal");
  const worker = await spawn();
  assert.deepEqual(worker.effectiveModel, { provider: "local", id: "default" });
  assert.equal(worker.thinkingLevel, "high");
  assert.equal(worker.requestedModel, undefined);
  const types = (await requests()).map((request) => request.type);
  assert.deepEqual(types, ["get_state", "prompt"]);
  await manager.abort(worker.id);
});

test("canonical explicit model resolves, sets, observes, then prompts in order", async () => {
  configure("normal");
  const worker = await spawn(2_000, "provider-x/X");
  assert.equal(worker.requestedModel, "provider-x/X");
  assert.deepEqual(worker.effectiveModel, { provider: "provider-x", id: "X" });
  const recorded = await requests();
  assert.deepEqual(recorded.map((request) => request.type), ["get_available_models", "set_model", "get_state", "prompt"]);
  assert.deepEqual({ provider: recorded[1].provider, modelId: recorded[1].modelId }, { provider: "provider-x", modelId: "X" });
  await manager.abort(worker.id);
});

test("a unique bare model id resolves to its sole provider", async () => {
  configure("normal", { models: [{ provider: "provider-a", id: "foo" }] });
  const worker = await spawn(2_000, "foo");
  assert.deepEqual(worker.effectiveModel, { provider: "provider-a", id: "foo" });
  await manager.abort(worker.id);
});

test("Pi set_model rejection is reported as MODEL_SET_FAILED with Pi's reason", async () => {
  configure("set_model_reject");
  await assert.rejects(spawn(2_000, "provider-x/X"), (error) => {
    assert.equal(error.code, "MODEL_SET_FAILED");
    assert.match(error.message, /Pi refused model selection/);
    return true;
  });
  assert.deepEqual((await requests()).map((request) => request.type), ["get_available_models", "set_model", "abort"]);
  const failed = manager.list()[0];
  assert.equal(failed.failure.code, "MODEL_SET_FAILED");
  assert.equal(failed.processAlive, false);
});

test("ambiguous bare model fails without prompt, lists only exact matches, and releases the process slot", async () => {
  configure("normal", { maxWorkers: 1 });
  await assert.rejects(spawn(2_000, "foo"), (error) => {
    assert.equal(error.code, "AMBIGUOUS_MODEL");
    assert.match(error.message, /provider-a\/foo/);
    assert.match(error.message, /provider-b\/foo/);
    assert.doesNotMatch(error.message, /provider-x\/X/);
    return true;
  });
  let recorded = await requests();
  assert.deepEqual(recorded.map((request) => request.type), ["get_available_models", "abort"]);
  const failed = manager.list()[0];
  assert.equal(failed.failure.code, "AMBIGUOUS_MODEL");
  assert.equal(failed.processAlive, false);
  assert.equal(manager["workers"].get(failed.id).isLive(), false);
  const replacement = await spawn();
  assert.equal(replacement.effectiveModel.id, "default");
  await manager.abort(replacement.id);
});

test("missing model fails without prompt and releases worker resources", async () => {
  configure("normal", { maxWorkers: 1 });
  await assert.rejects(spawn(2_000, "does-not-exist"), (error) => {
    assert.equal(error.code, "MODEL_NOT_AVAILABLE");
    assert.match(error.message, /does not configure providers/);
    return true;
  });
  assert.deepEqual((await requests()).map((request) => request.type), ["get_available_models", "abort"]);
  const failed = manager.list()[0];
  assert.equal(failed.failure.code, "MODEL_NOT_AVAILABLE");
  assert.equal(failed.processAlive, false);
  assert.equal(manager["workers"].get(failed.id).isLive(), false);
});

test("worker follow-ups and steering retain the selected model without resolving again", async () => {
  configure("normal_follow_up");
  const worker = await spawn(2_000, "provider-x/X");
  await waitFor(() => manager.status(worker.id), (value) => value.state === "settled");
  const followed = await manager.continue(worker.id, "first follow-up with the same model");
  assert.deepEqual(followed.effectiveModel, { provider: "provider-x", id: "X" });
  assert.equal(followed.id, worker.id);
  assert.equal(followed.pid, worker.pid);
  const secondFollowUp = await manager.continue(worker.id, "second follow-up with the same model");
  assert.deepEqual(secondFollowUp.effectiveModel, { provider: "provider-x", id: "X" });
  const steered = await manager.steer(worker.id, "stay with the selected model");
  assert.deepEqual(steered.effectiveModel, { provider: "provider-x", id: "X" });
  await waitFor(() => manager.status(worker.id), (value) => value.state === "settled" && value.recentEvents.some((event) => event.type === "agent_settled"));
  const types = (await requests()).map((request) => request.type);
  assert.deepEqual(types, ["get_available_models", "set_model", "get_state", "prompt", "prompt", "follow_up", "steer"]);
  assert.equal(types.filter((type) => type === "get_available_models").length, 1);
  assert.equal(types.filter((type) => type === "set_model").length, 1);
  assert.equal(steered.pid, worker.pid);
  await manager.abort(worker.id);
});

test("a new worker without an override uses its own Pi default", async () => {
  configure("normal", { maxWorkers: 1 });
  const first = await spawn(2_000, "provider-x/X");
  await manager.abort(first.id);
  const second = await spawn();
  assert.equal(second.requestedModel, undefined);
  assert.deepEqual(second.effectiveModel, { provider: "local", id: "default" });
  const recorded = await requests();
  const secondWorkerRequests = recorded.slice(recorded.findIndex((request) => request.type === "abort") + 1);
  assert.deepEqual(secondWorkerRequests.map((request) => request.type), ["get_state", "prompt"]);
  await manager.abort(second.id);
});

test("explicit model overrides stay isolated between workers", async () => {
  configure("normal", { maxWorkers: 2 });
  const first = await spawn(2_000, "provider-x/X");
  const second = await spawn(2_000, "provider-y/Y");
  assert.deepEqual(first.effectiveModel, { provider: "provider-x", id: "X" });
  assert.deepEqual(second.effectiveModel, { provider: "provider-y", id: "Y" });
  await manager.abort(first.id);
  await manager.abort(second.id);
});

test("state mismatch after successful set_model fails and never prompts", async () => {
  configure("state_mismatch");
  await assert.rejects(spawn(2_000, "provider-x/X"), (error) => error.code === "MODEL_STATE_MISMATCH");
  assert.deepEqual((await requests()).map((request) => request.type), ["get_available_models", "set_model", "get_state", "abort"]);
  const failed = manager.list()[0];
  assert.equal(failed.failure.code, "MODEL_STATE_MISMATCH");
  assert.equal(failed.processAlive, false);
});

test("normal RPC run settles and status retains a bounded event history", async () => {
  configure("normal");
  const worker = await spawn();
  assert.equal(worker.state, "running");
  const settled = await waitFor(() => manager.status(worker.id), (value) => value.state === "settled");
  assert.equal(settled.status, "settled");
  assert.ok(settled.pid);
  assert.ok(settled.startedAt);
  assert.ok(settled.settledAt);
  assert.ok(settled.completedAt);
  assert.ok(settled.elapsedMs >= 0);
  assert.ok(settled.recentEvents.length <= 8);
  assert.ok(settled.recentEvents.some((event) => event.type === "agent_settled"));
});

test("worker list orders snapshots by creation time, newest first", async () => {
  configure("silent", { maxWorkers: 2 });
  const older = await spawn();
  await new Promise((resolve) => setTimeout(resolve, 5));
  const newer = await spawn();

  assert.deepEqual(manager.list().map((worker) => worker.id), [newer.id, older.id]);
});

test("Pi-handled initial prompt is settled without inventing an agent_settled event", async () => {
  configure("prompt_handled");
  const worker = await spawn();
  assert.equal(worker.state, "settled");
  assert.equal(worker.completedAt, undefined);
  assert.equal(worker.deadlineAt, undefined);
  assert.ok(worker.recentEvents.some((event) => event.type === "prompt_handled"));
  assert.equal(worker.recentEvents.some((event) => event.type === "agent_settled"), false);
});

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
      await manager.abort(worker.id);
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
  configure("normal", { maxWorkers: 2 });
  const results = await Promise.allSettled([spawn(), spawn(), spawn()]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 2);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  const rejected = results.find((result) => result.status === "rejected");
  assert.match(rejected.reason.message, /Maximum live worker count/);
  assert.match(rejected.reason.message, /pi_list/);
  assert.match(rejected.reason.message, /pi_abort/);
  await Promise.all(results.filter((result) => result.status === "fulfilled").map((result) => manager.abort(result.value.id)));
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

test("settled worker follow-up starts a fresh activity cycle and can be terminated to release capacity", async () => {
  configure("normal_follow_up", { maxWorkers: 1 });
  const worker = await spawn();
  await waitFor(() => manager.status(worker.id), (value) => value.state === "settled");
  const firstCompletedAt = manager.status(worker.id).completedAt;
  assert.ok(firstCompletedAt);
  const previousStart = manager.status(worker.id).runStartedAt;
  const firstCycle = await manager.continue(worker.id, "follow up after settled");
  assert.equal(firstCycle.state, "running");
  assert.equal(firstCycle.completedAt, undefined);
  assert.notEqual(firstCycle.runStartedAt, previousStart);
  assert.ok(firstCycle.deadlineAt);
  const settled = await waitFor(() => manager.status(worker.id), (value) => value.state === "settled");
  assert.ok(settled.completedAt);
  assert.notEqual(settled.completedAt, firstCompletedAt);
  assert.equal(settled.pendingFollowUps, 0);
  assert.deepEqual((await requests()).map((request) => request.type), ["get_state", "prompt", "prompt"]);
  const released = await manager.abort(worker.id);
  assert.equal(released.state, "aborted");
  assert.equal(released.processAlive, false);
  const replacement = await spawn();
  assert.equal(replacement.state, "running");
});

test("Pi-handled follow-up does not claim an agent activity cycle was started", async () => {
  configure("follow_up_handled");
  const worker = await spawn();
  await waitFor(() => manager.status(worker.id), (value) => value.state === "settled");
  const handled = await manager.continue(worker.id, "extension-handled follow up");
  assert.equal(handled.state, "settled");
  assert.equal(handled.deadlineAt, undefined);
  assert.ok(handled.recentEvents.some((event) => event.type === "follow_up_handled"));
  assert.deepEqual((await requests()).map((request) => request.type), ["get_state", "prompt", "prompt"]);
});

test("running follow-up stays queued in the current cycle without resetting its deadline", async () => {
  configure("follow_up_running", { task: 2_000 });
  const worker = await spawn();
  const started = manager.status(worker.id);
  assert.equal(started.state, "running");
  const queued = await manager.continue(worker.id, "queue while active");
  assert.equal(queued.state, "running");
  assert.equal(queued.runStartedAt, started.runStartedAt);
  assert.equal(queued.deadlineAt, started.deadlineAt);
  assert.equal(queued.currentOperation, started.currentOperation);
  const withQueuedFollowUp = await waitFor(() => manager.status(worker.id), (value) => value.pendingFollowUps === 1);
  assert.equal(withQueuedFollowUp.runStartedAt, started.runStartedAt);
  assert.equal(withQueuedFollowUp.deadlineAt, started.deadlineAt);
  const settled = await waitFor(() => manager.status(worker.id), (value) => value.state === "settled");
  assert.equal(settled.pendingFollowUps, 0);
  assert.equal(settled.runStartedAt, started.runStartedAt);
  assert.equal(settled.deadlineAt, undefined);
  assert.ok(settled.recentEvents.some((event) => event.type === "agent_settled"));
  assert.deepEqual((await requests()).map((request) => request.type), ["get_state", "prompt", "follow_up"]);
});

test("RPC no-response becomes timed_out and reaps the Pi child", async () => {
  configure("no_response", { rpc: 80, abort: 20, term: 60 });
  await assert.rejects(spawn(), /timed out/i);
  const worker = manager.list()[0];
  assert.equal(worker.state, "timed_out");
  assert.equal(worker.failure.code, "RPC_TIMEOUT");
  assert.ok(worker.terminatedAt);
  assert.equal(manager["workers"].get(worker.id).isLive(), false);
  await assert.rejects(manager.continue(worker.id, "must not restart"), /not running|terminal/i);
  await assert.rejects(manager.steer(worker.id, "must not steer terminal worker"), /not running|terminal/i);
  assert.equal(manager.status(worker.id).state, "timed_out");
});

test("aborting worker rejects steer and follow-up while process termination is in progress", async () => {
  configure("abort_stuck", { rpc: 70, abort: 20, term: 60 });
  const worker = await spawn();
  const aborting = manager.abort(worker.id);
  assert.equal(manager.status(worker.id).state, "aborting");
  await assert.rejects(manager.steer(worker.id, "must not steer while aborting"), /aborting/i);
  await assert.rejects(manager.continue(worker.id, "must not continue while aborting"), /aborting/i);
  assert.equal((await aborting).state, "aborted");
});

test("silent agent becomes stalled and is terminated", async () => {
  configure("silent", { idle: 90, rpc: 300, abort: 20, term: 60 });
  const worker = await spawn();
  const stalled = await waitFor(() => manager.status(worker.id), (value) => value.state === "stalled");
  assert.equal(stalled.failure.code, "IDLE_TIMEOUT");
  assert.ok(stalled.lastActivityAt);
  assert.equal(manager["workers"].get(worker.id).isLive(), false);
});

test("reported long-running tool suppresses idle stall detection", async () => {
  configure("tool_active", { idle: 60, rpc: 300, abort: 20, term: 60 });
  const worker = await spawn();
  await new Promise((resolve) => setTimeout(resolve, 120));
  const status = manager.status(worker.id);
  assert.equal(status.state, "running");
  assert.equal(status.currentTool, "bash");
  assert.equal(status.currentOperation, "tool:bash");
  assert.equal((await manager.abort(worker.id)).state, "aborted");
});

test("unexpected nonzero process exit is recorded as crashed", async () => {
  configure("crash", { rpc: 400, abort: 20, term: 60 });
  await assert.rejects(spawn(), /exited/i);
  const crashed = await waitFor(() => manager.list()[0], (value) => value.state === "crashed");
  assert.equal(crashed.exitCode, 23);
  assert.equal(crashed.failure.code, "PROCESS_CRASHED");
  assert.ok(crashed.recentEvents.some((event) => event.type === "process_exit"));
});

test("a failed Pi executable is terminal but no longer consumes a live worker slot", async () => {
  configure("normal", { maxWorkers: 1, rpc: 500, abort: 10, term: 20 });
  process.env.PI_WORKER_COMMAND = join(root, "definitely-missing-pi-binary");

  await assert.rejects(spawn(), /ENOENT/);
  const failed = await waitFor(() => manager.list()[0], (value) => value.state === "crashed" && !value.processAlive);
  const released = await manager.abort(failed.id);
  assert.equal(released.state, "crashed");
  assert.equal(released.processAlive, false);

  await assert.rejects(spawn(), /ENOENT/);
});

test("failed activity cycle does not fabricate a completion timestamp", async () => {
  configure("agent_failure");
  const worker = await spawn();
  const failed = await waitFor(() => manager.status(worker.id), (value) => value.state === "failed");
  assert.equal(failed.completedAt, undefined);
});

test("abort RPC timeout escalates through signals to a terminal aborted state", async () => {
  configure("abort_stuck", { rpc: 70, abort: 20, term: 60 });
  const worker = await spawn();
  const [result, repeated] = await Promise.all([manager.abort(worker.id), manager.abort(worker.id)]);
  assert.equal(result.state, "aborted");
  assert.equal(repeated.state, "aborted");
  assert.equal(result.terminationReason, "ABORTED");
  assert.equal(result.terminationError.code, "RPC_TIMEOUT");
  assert.ok(result.terminatedAt);
  assert.equal(manager["workers"].get(worker.id).isLive(), false);
});

test("Pi exiting during abort is recorded as aborted, not crashed", async () => {
  configure("abort_exit", { rpc: 300, abort: 20, term: 60 });
  const worker = await spawn();

  const aborted = await manager.abort(worker.id);
  assert.equal(aborted.state, "aborted");
  assert.equal(aborted.processAlive, false);
  assert.equal(aborted.failure, undefined);
});

test("Unix process-group termination also reaps a Pi tool descendant", async () => {
  if (process.platform === "win32") return;
  configure("forked", { rpc: 300, abort: 20, term: 100 });
  const worker = await spawn();
  const withPid = await waitFor(() => manager.status(worker.id), (value) => /DESCENDANT_PID=\d+/.test(value.lastOutput));
  const descendantPid = Number(withPid.lastOutput.match(/DESCENDANT_PID=(\d+)/)?.[1]);
  assert.ok(descendantPid > 0);
  try {
    const result = await manager.abort(worker.id);
    assert.equal(result.state, "aborted");
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.throws(() => process.kill(descendantPid, 0), { code: "ESRCH" });
  } finally {
    try { process.kill(descendantPid, "SIGKILL"); } catch { /* already reaped */ }
  }
});

test("malformed JSONL is observed and pending RPC still times out", async () => {
  configure("malformed", { rpc: 80, abort: 20, term: 60 });
  await assert.rejects(spawn(), /timed out/i);
  const worker = manager.list()[0];
  assert.equal(worker.state, "timed_out");
  assert.ok(worker.recentEvents.some((event) => event.type === "malformed_jsonl"));
});

test("malformed RPC response rejects its correlated request and fails the worker", async () => {
  configure("malformed_response", { rpc: 300, abort: 20, term: 60 });
  await assert.rejects(spawn(), /malformed response/i);
  const worker = manager.list()[0];
  assert.equal(worker.state, "failed");
  assert.equal(worker.failure.code, "MALFORMED_RPC_RESPONSE");
});

test("Pi's final provider retry error is retained as a structured agent failure", async () => {
  configure("agent_failure", { rpc: 300, abort: 20, term: 60 });
  const accepted = await spawn();
  const failed = await waitFor(() => manager.status(accepted.id), (value) => value.state === "failed");
  assert.equal(failed.failure.code, "PI_AGENT_ERROR");
  assert.equal(failed.failure.message, "provider unavailable");
  assert.equal(failed.error, "provider unavailable");
  assert.equal(failed.processAlive, false);
});

test("broken Pi stdin remains bounded by the request timeout", async () => {
  configure("stdin_closed", { rpc: 300, abort: 20, term: 60 });
  const started = await spawn();
  await new Promise((resolve) => setTimeout(resolve, 30));
  await assert.rejects(manager.steer(started.id, "this write should fail"));
  const worker = await waitFor(() => manager.list()[0], (value) => value.state === "timed_out" || value.state === "crashed" || value.state === "failed");
  assert.equal(worker.state, "timed_out");
  assert.equal(worker.failure.code, "RPC_TIMEOUT");
});

test("Pi stdout closure while the process remains alive is detected", async () => {
  configure("stdout_closed", { rpc: 500, abort: 20, term: 60 });
  await assert.rejects(spawn());
  const worker = await waitFor(() => manager.list()[0], (value) => value.state === "crashed");
  assert.ok(["STDOUT_CLOSED", "PROCESS_CRASHED"].includes(worker.failure.code));
});

test("task deadline is independent of RPC and idle deadlines", async () => {
  configure("silent", { rpc: 300, idle: 0, task: 100, abort: 20, term: 60 });
  const worker = await spawn(100);
  const timedOut = await waitFor(() => manager.status(worker.id), (value) => value.state === "timed_out");
  assert.equal(timedOut.failure.code, "TASK_TIMEOUT");
});
