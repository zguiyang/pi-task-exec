import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import readline from "node:readline";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const fakePi = fileURLToPath(new URL("./fixtures/fake-pi.mjs", import.meta.url));

function startServer(mode, options = {}) {
  const child = spawn(process.execPath, [resolve(root, "bin/pi-task-exec.mjs"), "mcp", "serve"], {
    cwd: root,
    env: {
      ...process.env,
      PI_WORKER_COMMAND: fakePi,
      ...(options.allowedRoots === null ? { PI_WORKER_ALLOWED_ROOTS: undefined } : { PI_WORKER_ALLOWED_ROOTS: options.allowedRoots ?? root }),
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
      if (message.method === "roots/list") {
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { roots: options.roots().map(uri => ({ uri })) } })}\n`);
        return;
      }
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

async function initialize(server, capabilities = {}) {
  const result = await server.request("initialize", {
    protocolVersion: "2025-03-26",
    capabilities,
    clientInfo: { name: "pi-task-exec-test", version: "0.3.0" },
  });
  assert.equal(result.error, undefined);
  server.notify("notifications/initialized");
  return result.result;
}

async function tool(server, name, args = {}) {
  const response = await server.request("tools/call", { name, arguments: args });
  assert.equal(response.error, undefined, `${name} transport error`);
  if (response.result.isError) throw Object.assign(new Error(response.result.content[0].text), { result: response.result });
  return JSON.parse(response.result.content[0].text);
}

async function shutdown(server) {
  server.child.stdin.end();
  await Promise.race([once(server.child, "exit"), new Promise((_, reject) => setTimeout(() => reject(new Error("MCP server shutdown hung")), 3_000))]);
}

test("MCP discovery exposes delegation guidance, tool choice semantics, and typed schemas", async () => {
  const server = startServer("normal");
  try {
    const initialized = await initialize(server);
    assert.equal(initialized.serverInfo.name, "pi-task-exec");
    assert.equal(initialized.serverInfo.version, "0.3.1");
    assert.match(initialized.instructions, /investigate, analyze, implement, or verify/i);
    assert.match(initialized.instructions, /work directly/i);
    assert.match(initialized.instructions, /supervisor owns scope, authorization, global decisions/i);
    assert.match(initialized.instructions, /never recursively delegate/i);
    assert.match(initialized.instructions, /review its result/i);
    assert.doesNotMatch(initialized.instructions, /delegate.*by default/i);

    const result = await server.request("tools/list");
    assert.equal(result.error, undefined);
    const tools = result.result.tools;
    assert.deepEqual(tools.map((tool) => tool.name), [
      "pi_spawn", "pi_status", "pi_steer", "pi_continue", "pi_abort", "pi_release", "pi_list",
    ]);
    const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));

    const runtimeGuidance = [initialized.instructions, ...tools.map((tool) => tool.description)].join("\n");
    assert.doesNotMatch(runtimeGuidance, /\b(codex|openai|claude|anthropic|cursor|zed|opencode)\b/i);

    for (const phrase of ["bounded", "investigation", "analysis", "implementation", "verification", "simple", "stopping condition", "final review", "accepted, not completed"]) {
      assert.ok(byName.pi_spawn.description.toLowerCase().includes(phrase), `pi_spawn description should mention ${phrase}`);
    }
    assert.doesNotMatch(byName.pi_spawn.description, /delegate.*by default/i);
    assert.match(byName.pi_spawn.description, /inspect.*read-only.*implement.*writes and shell commands/i);
    assert.match(byName.pi_status.description, /authoritative result/i);
    assert.match(byName.pi_status.description, /waitMs/i);
    assert.match(byName.pi_status.description, /does not cancel/i);
    assert.match(byName.pi_steer.description, /running worker/i);
    assert.match(byName.pi_steer.description, /not a follow-up/i);
    assert.match(byName.pi_continue.description, /related follow-up/i);
    assert.match(byName.pi_continue.description, /unrelated work/i);
    assert.match(byName.pi_continue.description, /queued.*current activity cycle/i);
    assert.match(byName.pi_continue.description, /released or crashed/i);
    assert.match(byName.pi_spawn.description, /failed implement worker.*partial edits/i);
    assert.match(byName.pi_abort.description, /cancel/i);
    assert.match(byName.pi_abort.description, /without releasing/i);
    assert.match(byName.pi_abort.description, /pi_release/i);
    assert.match(byName.pi_release.description, /preserves its authoritative result/i);
    assert.match(byName.pi_release.description, /idempotent/i);
    assert.match(byName.pi_release.description, /releaseError/i);
    assert.match(byName.pi_list.description, /fleet.*newest first.*does not include the configured worker limit/i);
    assert.match(byName.pi_list.description, /released\/crashed snapshots/i);

    const spawnSchema = byName.pi_spawn.inputSchema;
    assert.deepEqual(spawnSchema.required, ["task", "cwd"]);
    assert.deepEqual(Object.keys(spawnSchema.properties).sort(), ["cwd", "model", "profile", "task", "taskTimeoutMs", "thinking"]);
    assert.deepEqual(spawnSchema.properties.profile.enum, ["inspect", "implement"]);
    assert.equal(spawnSchema.properties.profile.default, "inspect");
    assert.match(spawnSchema.properties.profile.description, /read-only/i);
    assert.equal(spawnSchema.properties.model.type, "string");
    assert.match(spawnSchema.properties.model.description, /Pi chooses its locally configured default/i);
    assert.deepEqual(spawnSchema.properties.thinking.enum, ["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
    assert.match(spawnSchema.properties.thinking.description, /configured default/i);
    assert.match(spawnSchema.properties.thinking.description, /unsupported level is reported/i);
    assert.deepEqual(byName.pi_status.inputSchema.required, ["workerId"]);
    assert.equal(byName.pi_status.inputSchema.properties.waitMs.minimum, 0);
    assert.equal(byName.pi_status.inputSchema.properties.waitMs.maximum, 30_000);
    assert.equal(byName.pi_status.inputSchema.properties.cycleId.minimum, 1);
    assert.deepEqual(byName.pi_steer.inputSchema.required, ["workerId", "task"]);
    assert.deepEqual(byName.pi_continue.inputSchema.required, ["workerId", "task"]);
    assert.deepEqual(byName.pi_abort.inputSchema.required, ["workerId"]);
    assert.deepEqual(byName.pi_release.inputSchema.required, ["workerId"]);
    assert.deepEqual(byName.pi_list.inputSchema.properties, {});
    assert.equal(byName.pi_list.inputSchema.required, undefined);

    // The published contract table must name exactly the live tool parameters.
    const contract = await readFile(resolve(root, "skills/pi-delegate/references/mcp-contract.md"), "utf8");
    const documented = Object.fromEntries(
      contract.split("\n")
        .filter((line) => /^\|\s*`pi_/.test(line))
        .map((line) => {
          const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
          const name = cells[0].replaceAll("`", "");
          const parse = (cell) => (cell === "none" ? [] : [...cell.matchAll(/`([^`]+)`/g)].map((match) => match[1]));
          return [name, { required: parse(cells[1]), optional: parse(cells[2]) }];
        }),
    );
    assert.deepEqual(Object.keys(documented).sort(), tools.map((entry) => entry.name).sort());
    for (const [name, entry] of Object.entries(documented)) {
      const schema = byName[name].inputSchema;
      const required = [...(schema.required ?? [])].sort();
      const optional = Object.keys(schema.properties ?? {}).filter((property) => !required.includes(property)).sort();
      assert.deepEqual(required, [...entry.required].sort(), `${name} required parameters must match the contract`);
      assert.deepEqual(optional, [...entry.optional].sort(), `${name} optional parameters must match the contract`);
    }
  } finally {
    await shutdown(server);
  }
});

test("MCP model resolution errors include code, message, phase, and workerId and never prompt Pi", async () => {
  const server = startServer("normal");
  try {
    await initialize(server);
    const response = await server.request("tools/call", {
      name: "pi_spawn",
      arguments: { task: "bounded fake task", cwd: root, model: "not-available" },
    });
    assert.equal(response.result.isError, true);
    assert.equal(response.result.structuredContent.code, "MODEL_NOT_AVAILABLE");
    assert.equal(response.result.structuredContent.phase, "model");
    assert.equal(typeof response.result.structuredContent.workerId, "string");
    assert.equal(response.result.structuredContent.message, response.result.content[0].text);
    assert.match(response.result.content[0].text, /local Pi environment/);
    const worker = (await tool(server, "pi_list"))[0];
    assert.equal(worker.failure.code, "MODEL_NOT_AVAILABLE");
    assert.equal(worker.processAlive, false);
    assert.equal(worker.recentEvents.some((event) => event.type === "prompt"), false);
  } finally {
    await shutdown(server);
  }
});

test("MCP worker lifecycle supports steer, settled continuation, bounded wait, review, and release", async () => {
  const server = startServer("steer_then_follow_up");
  try {
    await initialize(server);
    const worker = await tool(server, "pi_spawn", { task: "bounded fake implementation", cwd: root, profile: "inspect" });
    await tool(server, "pi_steer", { workerId: worker.id, task: "Keep the investigation within the stated scope." });
    const settled = await tool(server, "pi_status", { workerId: worker.id, waitMs: 2_000 });
    assert.equal(settled.state, "settled");
    assert.equal(settled.cycleId, 1);
    assert.equal(settled.result.text, "safe fake task complete");

    const followed = await tool(server, "pi_continue", { workerId: worker.id, task: "Check the related edge case." });
    assert.equal(followed.cycleId, 2);
    const afterFollow = await tool(server, "pi_status", { workerId: worker.id, waitMs: 2_000, cycleId: 2 });
    assert.equal(afterFollow.state, "settled");

    const released = await tool(server, "pi_release", { workerId: worker.id });
    assert.equal(released.released, true);
    assert.equal(released.state, "settled");
    assert.equal(released.result.text, "safe fake task complete");
    const workers = await tool(server, "pi_list");
    assert.equal(workers.find((item) => item.id === worker.id).processAlive, false);
  } finally {
    await shutdown(server);
  }
});

test("MCP pi_status wait times out without cancelling and reports a recoverable failure", async () => {
  const server = startServer("silent");
  try {
    await initialize(server);
    const worker = await tool(server, "pi_spawn", { task: "fake silent task", cwd: root, profile: "inspect" });
    const snapshot = await tool(server, "pi_status", { workerId: worker.id, waitMs: 100 });
    assert.equal(snapshot.state, "running");
    assert.equal(snapshot.processAlive, true);
    await tool(server, "pi_release", { workerId: worker.id });
  } finally {
    await shutdown(server);
  }
});

test("MCP operational errors carry code, phase, and workerId once a worker exists", async () => {
  const server = startServer("normal");
  try {
    await initialize(server);
    const unknownId = "11111111-1111-4111-8111-111111111111";
    const unknown = await server.request("tools/call", { name: "pi_status", arguments: { workerId: unknownId } });
    assert.equal(unknown.result.isError, true);
    assert.equal(unknown.result.structuredContent.code, "UNKNOWN_WORKER");
    assert.equal(unknown.result.structuredContent.workerId, unknownId);

    const worker = await tool(server, "pi_spawn", { task: "bounded fake task", cwd: root, profile: "inspect" });
    await tool(server, "pi_status", { workerId: worker.id, waitMs: 2_000 });
    const invalid = await server.request("tools/call", { name: "pi_steer", arguments: { workerId: worker.id, task: "too late to steer" } });
    assert.equal(invalid.result.isError, true);
    assert.equal(invalid.result.structuredContent.code, "INVALID_STATE");
    assert.equal(invalid.result.structuredContent.phase, "steer");
    assert.equal(invalid.result.structuredContent.workerId, worker.id);
    await tool(server, "pi_release", { workerId: worker.id });
  } finally {
    await shutdown(server);
  }
});

test("MCP spawn RPC timeout returns and pi_status exposes a recoverable terminal failure", async () => {
  const server = startServer("no_response");
  try {
    await initialize(server);
    const response = await server.request("tools/call", {
      name: "pi_spawn",
      arguments: { task: "fake no-response", cwd: root, profile: "inspect" },
    });
    assert.equal(response.result.isError, true);
    const workers = await tool(server, "pi_list");
    assert.equal(workers[0].state, "timed_out");
    assert.equal(workers[0].failure.code, "RPC_TIMEOUT");
  } finally {
    await shutdown(server);
  }
});

test("MCP stdin shutdown terminates an active worker process", async () => {
  const server = startServer("silent");
  let workerPid;
  try {
    await initialize(server);
    const worker = await tool(server, "pi_spawn", { task: "fake active task", cwd: root, profile: "inspect" });
    workerPid = worker.pid;
    assert.ok(workerPid);
  } finally {
    await shutdown(server);
  }
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.throws(() => process.kill(workerPid, 0), { code: "ESRCH" });
});

test("SIGTERM shutdown terminates an active worker process", async () => {
  const server = startServer("silent");
  let workerPid;
  try {
    await initialize(server);
    const worker = await tool(server, "pi_spawn", { task: "fake active task", cwd: root, profile: "inspect" });
    workerPid = worker.pid;
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

test("MCP negotiates Roots without blocking discovery or spawning Pi", async () => {
  const server = startServer("normal", { allowedRoots: null, roots: () => [] });
  try {
    await initialize(server, { roots: { listChanged: true } });
    const catalog = await server.request("tools/list");
    assert.equal(catalog.result.tools.length, 7);
    const denied = await server.request("tools/call", { name: "pi_spawn", arguments: { task: "must be denied", cwd: root, profile: "inspect" } });
    assert.equal(denied.result.isError, true);
    assert.match(denied.result.content[0].text, /outside PI_WORKER_ALLOWED_ROOTS/);
    const listed = await tool(server, "pi_list");
    assert.equal(listed.length, 0);
  } finally {
    await shutdown(server);
  }
});

test("explicit Worker roots cannot be widened by Host Roots", async () => {
  const server = startServer("normal", { allowedRoots: root, roots: () => [pathToFileURL("/").href] });
  try {
    await initialize(server, { roots: { listChanged: true } });
    const denied = await server.request("tools/call", { name: "pi_spawn", arguments: { task: "must be denied", cwd: "/", profile: "inspect" } });
    assert.equal(denied.result.isError, true);
    assert.match(denied.result.content[0].text, /outside PI_WORKER_ALLOWED_ROOTS/);
  } finally {
    await shutdown(server);
  }
});
