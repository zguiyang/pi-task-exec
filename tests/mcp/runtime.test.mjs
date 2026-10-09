import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import readline from "node:readline";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const fakePi = fileURLToPath(new URL("./fixtures/fake-pi.mjs", import.meta.url));

function startServer(mode) {
  const child = spawn(process.execPath, [resolve(root, "bin/pi-task-exec.mjs"), "mcp", "serve"], {
    cwd: root,
    env: {
      ...process.env,
      PI_WORKER_COMMAND: fakePi,
      PI_WORKER_ALLOWED_ROOTS: root,
      PI_WORKER_RPC_TIMEOUT_MS: "100",
      PI_WORKER_IDLE_TIMEOUT_MS: "0",
      PI_WORKER_TASK_TIMEOUT_MS: "2000",
      PI_WORKER_ABORT_GRACE_MS: "30",
      PI_WORKER_TERM_GRACE_MS: "100",
      FAKE_PI_MODE: mode,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const messages = new Map();
  const lines = readline.createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    try {
      const message = JSON.parse(line);
      if (message.id !== undefined) {
        const resolveMessage = messages.get(message.id);
        if (resolveMessage) {
          messages.delete(message.id);
          resolveMessage(message);
        }
      }
    } catch { /* stderr is reserved for diagnostics; malformed stdout is ignored by this harness */ }
  });
  let nextId = 0;
  function request(method, params = {}) {
    const id = ++nextId;
    const result = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        messages.delete(id);
        reject(new Error(`MCP ${method} timed out`));
      }, 3_000);
      messages.set(id, (message) => {
        clearTimeout(timer);
        resolve(message);
      });
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return result;
  }
  function notify(method, params = {}) {
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }
  return { child, request, notify };
}

async function initialize(server) {
  const result = await server.request("initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: { name: "pi-task-exec-test", version: "0.1.0" },
  });
  assert.equal(result.error, undefined);
  server.notify("notifications/initialized");
  return result.result;
}

async function waitForWorkerState(server, workerId, state) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const result = await server.request("tools/call", { name: "pi_status", arguments: { workerId } });
    const snapshot = JSON.parse(result.result.content[0].text);
    if (snapshot.state === state) return snapshot;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`Worker ${workerId} did not reach ${state}`);
}

test("MCP discovery exposes delegation guidance, tool choice semantics, and typed schemas", async () => {
  const server = startServer("normal");
  try {
    const initialized = await initialize(server);
    assert.equal(initialized.serverInfo.name, "pi-task-exec");
    assert.equal(initialized.serverInfo.version, "0.1.1");
    assert.match(initialized.instructions, /subordinate coding workers/i);
    assert.match(initialized.instructions, /planning.*architecture.*delegation.*integration.*final review/i);
    assert.match(initialized.instructions, /never recursively delegate/i);
    assert.match(initialized.instructions, /review worker output/i);

    const result = await server.request("tools/list");
    assert.equal(result.error, undefined);
    const tools = result.result.tools;
    assert.deepEqual(tools.map((tool) => tool.name), [
      "pi_spawn", "pi_status", "pi_steer", "pi_continue", "pi_abort", "pi_list",
    ]);
    const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));

    const runtimeGuidance = [initialized.instructions, ...tools.map((tool) => tool.description)].join("\n");
    assert.doesNotMatch(runtimeGuidance, /\b(codex|openai|claude|anthropic|cursor|zed|opencode)\b/i);

    for (const phrase of ["bounded", "trivial", "architecture", "independent", "worktrees", "final review", "accepted, not completed"]) {
      assert.ok(byName.pi_spawn.description.toLowerCase().includes(phrase), `pi_spawn description should mention ${phrase}`);
    }
    for (const phrase of ["progress", "settled", "failure", "busy polling"]) {
      assert.ok(byName.pi_status.description.toLowerCase().includes(phrase), `pi_status description should mention ${phrase}`);
    }
    assert.match(byName.pi_status.description, /decide how to recover or continue related work/i);
    assert.match(byName.pi_steer.description, /running worker/i);
    assert.match(byName.pi_steer.description, /not a follow-up/i);
    assert.match(byName.pi_continue.description, /related follow-up/i);
    assert.match(byName.pi_continue.description, /unrelated work/i);
    assert.match(byName.pi_continue.description, /running.*queued.*settled.*activity cycle/i);
    assert.match(byName.pi_spawn.description, /failed direct worker.*partial edits.*worktree edits.*not merged or deleted automatically/i);
    assert.match(byName.pi_abort.description, /terminal worker.*existing snapshot.*does not revert direct edits or delete its worktree/i);
    assert.match(byName.pi_list.description, /fleet.*newest first.*does not include the configured worker limit/i);

    const spawnSchema = byName.pi_spawn.inputSchema;
    assert.deepEqual(spawnSchema.required, ["task", "cwd", "mode"]);
    assert.deepEqual(spawnSchema.properties.mode.enum, ["direct", "worktree"]);
    assert.deepEqual(spawnSchema.properties.profile.enum, ["inspect", "implement"]);
    assert.match(spawnSchema.properties.profile.description, /read-only/i);
    assert.match(spawnSchema.properties.mode.description, /separate worktrees/i);
    assert.equal(spawnSchema.properties.model.type, "string");
    assert.equal(spawnSchema.properties.model.enum, undefined);
    assert.match(spawnSchema.properties.model.description, /this worker only/i);
    assert.match(spawnSchema.properties.model.description, /Pi chooses its locally configured default/i);
    assert.deepEqual(spawnSchema.required, ["task", "cwd", "mode"]);
    assert.deepEqual(byName.pi_status.inputSchema.required, ["workerId"]);
    assert.deepEqual(byName.pi_steer.inputSchema.required, ["workerId", "task"]);
    assert.deepEqual(byName.pi_continue.inputSchema.required, ["workerId", "task"]);
    assert.deepEqual(byName.pi_abort.inputSchema.required, ["workerId"]);
    assert.deepEqual(byName.pi_list.inputSchema.properties, {});
    assert.equal(byName.pi_list.inputSchema.required, undefined);
  } finally {
    server.child.stdin.end();
    await Promise.race([once(server.child, "exit"), new Promise((_, reject) => setTimeout(() => reject(new Error("MCP server shutdown hung")), 3_000))]);
  }
});

test("MCP model resolution errors include a structured code and never prompt Pi", async () => {
  const server = startServer("normal");
  try {
    await initialize(server);
    const result = await server.request("tools/call", {
      name: "pi_spawn",
      arguments: { task: "bounded fake task", cwd: root, mode: "direct", model: "not-available" },
    });
    assert.equal(result.result.isError, true);
    assert.deepEqual(result.result.structuredContent, {
      code: "MODEL_NOT_AVAILABLE",
      message: result.result.content[0].text,
    });
    assert.match(result.result.content[0].text, /local Pi environment/);
    const listed = await server.request("tools/call", { name: "pi_list", arguments: {} });
    const worker = JSON.parse(listed.result.content[0].text)[0];
    assert.equal(worker.failure.code, "MODEL_NOT_AVAILABLE");
    assert.equal(worker.processAlive, false);
    assert.equal(worker.recentEvents.some((event) => event.type === "prompt"), false);
  } finally {
    server.child.stdin.end();
    await Promise.race([once(server.child, "exit"), new Promise((_, reject) => setTimeout(() => reject(new Error("MCP server shutdown hung")), 3_000))]);
  }
});

test("MCP worker lifecycle supports steer, settled continuation, review, and release", async () => {
  const server = startServer("steer_then_follow_up");
  try {
    await initialize(server);
    const spawned = await server.request("tools/call", {
      name: "pi_spawn",
      arguments: { task: "bounded fake implementation", cwd: root, mode: "direct", profile: "inspect" },
    });
    assert.equal(spawned.result.isError, undefined);
    const worker = JSON.parse(spawned.result.content[0].text);

    const steered = await server.request("tools/call", {
      name: "pi_steer",
      arguments: { workerId: worker.id, task: "Keep the investigation within the stated scope." },
    });
    assert.equal(steered.result.isError, undefined);
    await waitForWorkerState(server, worker.id, "settled");

    const followedUp = await server.request("tools/call", {
      name: "pi_continue",
      arguments: { workerId: worker.id, task: "Check the related edge case." },
    });
    assert.equal(followedUp.result.isError, undefined);
    await waitForWorkerState(server, worker.id, "settled");

    const released = await server.request("tools/call", { name: "pi_abort", arguments: { workerId: worker.id } });
    assert.equal(released.result.isError, undefined);
    const listed = await server.request("tools/call", { name: "pi_list", arguments: {} });
    const workers = JSON.parse(listed.result.content[0].text);
    assert.equal(workers.find((item) => item.id === worker.id).state, "aborted");
    assert.equal(workers.find((item) => item.id === worker.id).processAlive, false);
  } finally {
    server.child.stdin.end();
    await Promise.race([once(server.child, "exit"), new Promise((_, reject) => setTimeout(() => reject(new Error("MCP server shutdown hung")), 3_000))]);
  }
});

test("MCP spawn RPC timeout returns and pi_status exposes a recoverable terminal failure", async () => {
  const server = startServer("no_response");
  try {
    await initialize(server);
    const spawnResult = await server.request("tools/call", {
      name: "pi_spawn",
      arguments: { task: "fake no-response", cwd: root, mode: "direct", profile: "inspect" },
    });
    assert.equal(spawnResult.error, undefined);
    assert.equal(spawnResult.result.isError, true);
    const listResult = await server.request("tools/call", { name: "pi_list", arguments: {} });
    const workers = JSON.parse(listResult.result.content[0].text);
    assert.equal(workers[0].state, "timed_out");
    assert.equal(workers[0].failure.code, "RPC_TIMEOUT");
  } finally {
    server.child.stdin.end();
    await Promise.race([once(server.child, "exit"), new Promise((_, reject) => setTimeout(() => reject(new Error("MCP server shutdown hung")), 3_000))]);
  }
});

test("MCP stdin shutdown terminates an active worker process", async () => {
  const server = startServer("silent");
  let workerPid;
  try {
    await initialize(server);
    const result = await server.request("tools/call", {
      name: "pi_spawn",
      arguments: { task: "fake active task", cwd: root, mode: "direct", profile: "inspect" },
    });
    assert.equal(result.result.isError, undefined);
    const worker = JSON.parse(result.result.content[0].text);
    workerPid = worker.pid;
    assert.ok(workerPid);
  } finally {
    server.child.stdin.end();
    const [code, signal] = await Promise.race([
      once(server.child, "exit"),
      new Promise((_, reject) => setTimeout(() => reject(new Error("MCP shutdown left its worker hanging")), 3_000)),
    ]);
    assert.equal(code, 0);
    assert.equal(signal, null);
  }
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.throws(() => process.kill(workerPid, 0), { code: "ESRCH" });
});

test("SIGTERM shutdown terminates an active worker process", async () => {
  const server = startServer("silent");
  let workerPid;
  try {
    await initialize(server);
    const result = await server.request("tools/call", {
      name: "pi_spawn",
      arguments: { task: "fake active task", cwd: root, mode: "direct", profile: "inspect" },
    });
    workerPid = JSON.parse(result.result.content[0].text).pid;
    server.child.kill("SIGTERM");
    const [code, signal] = await Promise.race([
      once(server.child, "exit"),
      new Promise((_, reject) => setTimeout(() => reject(new Error("SIGTERM shutdown hung")), 3_000)),
    ]);
    assert.equal(code, 0);
    assert.equal(signal, null);
  } finally {
    if (server.child.exitCode === null) server.child.kill("SIGKILL");
  }
  assert.throws(() => process.kill(workerPid, 0), { code: "ESRCH" });
});
