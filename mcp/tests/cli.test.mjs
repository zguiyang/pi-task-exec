import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import test from "node:test";
import { VERSION, helpText, runCli } from "../dist/cli.js";

const mcpRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const entrypoint = resolve(mcpRoot, "dist/index.js");

function capture() {
  const out = [];
  const err = [];
  return {
    io: { stdout: (text) => out.push(text), stderr: (text) => err.push(text) },
    stdout: () => out.join(""),
    stderr: () => err.join(""),
  };
}

async function runEntry(args) {
  const child = spawn(process.execPath, [entrypoint, ...args], {
    cwd: mcpRoot,
    env: { ...process.env, PI_WORKER_COMMAND: process.execPath },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  child.stdin.end();
  const [code, signal] = await once(child, "exit");
  return { code, signal, stdout, stderr };
}

test("no arguments shows help, exits 0, and never requests the MCP runtime", () => {
  const captured = capture();
  const action = runCli([], captured.io);
  assert.deepEqual(action, { kind: "exit", code: 0 });
  assert.match(captured.stdout(), /pi-task-exec 0\.1\.1/);
  assert.match(captured.stdout(), /Usage:/);
  assert.match(captured.stdout(), /pi-task-exec mcp serve/);
  assert.equal(captured.stderr(), "");
});

test("--help shows the same help and --version prints only the version", () => {
  const help = capture();
  assert.deepEqual(runCli(["--help"], help.io), { kind: "exit", code: 0 });
  assert.equal(help.stdout(), `${helpText()}\n`);
  assert.equal(help.stderr(), "");

  const version = capture();
  assert.deepEqual(runCli(["--version"], version.io), { kind: "exit", code: 0 });
  assert.equal(version.stdout(), `${VERSION}\n`);
  assert.equal(version.stderr(), "");
});

test("mcp serve requests the runtime without printing help", () => {
  const captured = capture();
  assert.deepEqual(runCli(["mcp", "serve"], captured.io), { kind: "serve" });
  assert.equal(captured.stdout(), "");
  assert.equal(captured.stderr(), "");
});

test("mcp serve --help describes the launch route without starting MCP", () => {
  const captured = capture();
  assert.deepEqual(runCli(["mcp", "serve", "--help"], captured.io), { kind: "exit", code: 0 });
  assert.match(captured.stdout(), /Usage:\s+pi-task-exec mcp serve/);
  assert.equal(captured.stderr(), "");
});

test("unknown commands and old routes report an error plus help", () => {
  for (const args of [
    ["frobnicate"],
    ["mcp"],
    ["mcp", "start"],
    ["mcp", "serve", "extra"],
    ["add"],
    ["add", "other"],
    ["remove"],
    ["remove", "other"],
    ["help"],
    ["version"],
    ["serve"],
    ["update"],
    ["uninstall"],
  ]) {
    const captured = capture();
    const action = runCli(args, captured.io);
    assert.deepEqual(action, { kind: "exit", code: 1 }, `${args.join(" ")} should exit 1`);
    assert.match(captured.stderr(), new RegExp(`Unknown command: ${args.join(" ")}`));
    assert.match(captured.stderr(), /Usage:/);
    assert.equal(captured.stdout(), "", `${args.join(" ")} must not print to stdout`);
  }
});

test("future-stage commands show a notice instead of running old behavior", () => {
  for (const args of [
    ["add", "mcp"],
    ["add", "skill"],
    ["add", "mcp", "--host", "codex"],
    ["setup"],
    ["setup", "--host", "codex", "--scope", "project"],
    ["doctor"],
    ["remove", "mcp"],
    ["remove", "skill", "--scope", "global"],
  ]) {
    const captured = capture();
    const action = runCli(args, captured.io);
    assert.deepEqual(action, { kind: "exit", code: 1 }, `${args.join(" ")} should exit 1`);
    assert.match(captured.stdout(), /planned for a future stage/i);
    assert.match(captured.stdout(), /not implemented in this build/i);
    assert.match(captured.stdout(), /No host configuration or files were changed/i);
    assert.equal(captured.stderr(), "", `${args.join(" ")} must not report a routing error`);
  }
});

test("entrypoint with no arguments prints help and does not start MCP", async () => {
  const result = await runEntry([]);
  assert.equal(result.code, 0);
  assert.equal(result.signal, null);
  assert.match(result.stdout, /Usage:/);
  assert.doesNotMatch(result.stderr, /started over MCP stdio/);
});

test("entrypoint with an unknown command exits non-zero with error and help", async () => {
  const result = await runEntry(["uninstall"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Unknown command: uninstall/);
  assert.match(result.stderr, /Usage:/);
  assert.doesNotMatch(result.stderr, /started over MCP stdio/);
});

test("entrypoint mcp serve starts the MCP runtime and speaks JSON-RPC", async () => {
  const child = spawn(process.execPath, [entrypoint, "mcp", "serve"], {
    cwd: mcpRoot,
    env: {
      ...process.env,
      PI_WORKER_COMMAND: process.execPath,
      PI_WORKER_ALLOWED_ROOTS: mcpRoot,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const messages = [];
  const lines = readline.createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    try { messages.push(JSON.parse(line)); } catch { /* diagnostics are on stderr */ }
  });
  child.stdin.write(`${JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "cli-test", version: "0.0.0" } },
  })}\n`);
  const deadline = Date.now() + 3_000;
  while (!messages.some((message) => message.id === 1) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const response = messages.find((message) => message.id === 1);
  assert.ok(response, "expected an MCP initialize response");
  assert.equal(response.result.serverInfo.name, "pi-task-exec");
  child.stdin.end();
  const [code] = await Promise.race([
    once(child, "exit"),
    new Promise((_, reject) => setTimeout(() => reject(new Error("mcp serve shutdown hung")), 3_000)),
  ]);
  assert.equal(code, 0);
});
