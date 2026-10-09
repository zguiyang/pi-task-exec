import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";
import { createServer } from "node:http";
import { readFile, readdir, realpath } from "node:fs/promises";
import { once } from "node:events";
import { npmLaunchSpec, resolveLaunchSpec } from "../../dist/cli/plan/model.js";
import { createDefaultAdapters } from "../../dist/cli/hosts/adapters.js";
import { classifyManagedEntry } from "../../dist/cli/hosts/shared.js";
import { parseCli, runCli } from "../../dist/cli/commands/index.js";
import { probeMcp } from "../../dist/cli/commands/probe.js";
import { parseToml, upsertTomlTable } from "../../dist/cli/hosts/toml.js";

const root = resolve(new URL("../..", import.meta.url).pathname);

test("updates replace entire MCP entries and remove old settings in both scopes", () => {
  for (const adapter of createDefaultAdapters()) for (const scope of ["project", "global"]) for (const enabled of [true, false]) {
    const context = { cwd: root, home: root, platform: process.platform, env: {} };
    const old = ["-y", "@zguiyang/pi-task-exec@0.1.0", "mcp", "serve"];
    const options = { enabled, startup_timeout_sec: 30, ...(adapter.id === "codex" ? { required: false } : {}) };
    const entry = adapter.id === "opencode"
      ? { type: "local", command: ["npx", ...old], environment: { PI_WORKER_ALLOWED_ROOTS: "/allowed" }, ...options }
      : { command: "npx", args: old, env: { PI_WORKER_ALLOWED_ROOTS: "/allowed" }, ...options };
    const container = adapter.id === "codex" ? "mcp_servers" : adapter.id === "zed" ? "context_servers" : "mcp";
    const before = adapter.id === "codex"
      ? upsertTomlTable('model = "keep"\n', [container, "pi-task-exec"], entry, ["command", "args"])
      : JSON.stringify({ theme: "keep", [container]: { "pi-task-exec": entry, unrelated: { marker: "keep" } } });
    const launch = npmLaunchSpec();
    const input = { context, scope, serverId: "pi-task-exec", launch, currentContent: before };
    const updated = adapter.planUpdate(input);
    assert.equal(updated.kind, "update");
    const doc = adapter.id === "codex" ? parseToml(updated.content) : JSON.parse(updated.content);
    const after = doc[container]["pi-task-exec"];
    assert.deepEqual(JSON.parse(JSON.stringify(after)), adapter.id === "opencode" ? { type: "local", command: ["npx", ...launch.args] } : { command: "npx", args: launch.args });
    assert.equal(adapter.id === "codex" ? doc.model : doc.theme, "keep");
    if (adapter.id !== "codex") assert.deepEqual(doc[container].unrelated, { marker: "keep" });
    assert.equal(adapter.planUpdate({ ...input, currentContent: updated.content }).kind, "update");
    assert.equal(adapter.inspectConfig(context, scope, updated.content, updated.path, launch).managed, true);
  }
});

test("isolated npm resolution keeps the same launch across Hosts and scopes", async () => {
  const prefix = await mkdtemp(join(tmpdir(), "pi-launch-"));
  try {
    const launch = resolveLaunchSpec({ packageRoot: prefix, packageVersion: "0.2.2", env: {}, npmPrefix: prefix }).launch;
    assert.deepEqual(launch, npmLaunchSpec(prefix));
    for (const adapter of createDefaultAdapters()) for (const scope of ["project", "global"]) {
      const planned = adapter.planEntry({ context: { cwd: prefix, home: prefix, platform: process.platform, env: {} }, scope, serverId: "pi-task-exec", launch, currentContent: null });
      assert.equal(planned.kind, "ok");
      assert.ok(planned.content.includes(prefix));
      assert.ok(!planned.content.includes('cwd ='), "package resolution must not set process cwd");
    }
    assert.throws(() => npmLaunchSpec("relative"), /absolute/);
    assert.throws(() => resolveLaunchSpec({ packageRoot: prefix, packageVersion: "0.2.2", env: {}, npmPrefix: join(prefix, "absent") }));
  } finally { await rm(prefix, { recursive: true, force: true }); }
});

test("managed fingerprints recognize isolated/required entries but retain drift protection", () => {
  const entry = { command: "npx", args: npmLaunchSpec(tmpdir()).args, required: true };
  assert.equal(classifyManagedEntry(entry, "codex").current, "@zguiyang/pi-task-exec@latest");
  assert.equal(classifyManagedEntry(entry, "command-args"), null);
  assert.equal(classifyManagedEntry({ ...entry, env: { TOKEN: "secret" } }, "codex"), null);
  assert.equal(classifyManagedEntry({ ...entry, required: false }, "codex"), null);
});

test("readiness uses only Codex native fields and never writes unsupported targets", async () => {
  const launch = { ...npmLaunchSpec(), requireReady: true };
  const adapter = createDefaultAdapters()[0];
  const planned = adapter.planEntry({ context: { cwd: root, home: root, platform: process.platform, env: {} }, scope: "project", serverId: "pi-task-exec", launch, currentContent: null });
  assert.match(planned.content, /required = true/);
  const errors = [];
  for (const host of ["opencode", "zed"]) {
    const action = await runCli(["setup", "--host", host, "--scope", "project", "--require-mcp", "--dry-run"], { cwd: root, home: root, env: {}, platform: process.platform, packageRoot: root, packageVersion: "0.2.2", adapters: createDefaultAdapters(), skillInstaller: { id: "unavailable" }, spawn: async () => ({code:0,stdout:"",stderr:""}), now: () => new Date(), io: { stdout() {}, stderr(text) { errors.push(text); } } });
    assert.equal(action.code, 1);
  }
  assert.match(errors.join(""), /requires a Codex MCP target/);
  assert.equal(parseCli(["setup", "--probe"]).kind, "error");
});

test("package probe verifies protocol without starting a Worker", async () => {
  const result = await probeMcp({ command: process.execPath, args: [join(root, "bin/pi-task-exec.mjs"), "mcp", "serve"] }, root, { ...process.env, PI_WORKER_COMMAND: "/this-command-must-never-run" });
  assert.equal(result.status, "pass", result.detail);
  assert.match(result.detail, /Host tool exposure remains unverified/);
});

test("probe reports missing command, malformed stdout, and timeout with bounded cleanup", async () => {
  const missing = await probeMcp({ command: "/missing-pi-command", args: [] }, root, {}, 100);
  assert.equal(missing.status, "fail");
  assert.equal(missing.stage, "launch");
  const malformed = await probeMcp({ command: process.execPath, args: ["-e", "console.log('not protocol');setInterval(()=>{},1000)"] }, root, {}, 100);
  assert.equal(malformed.status, "fail");
  assert.equal(malformed.stage, "initialize");
  const stalled = await probeMcp({ command: process.execPath, args: ["-e", "setInterval(()=>{},1000)"] }, root, {}, 30);
  assert.match(stalled.detail, /timed out/);
});

test("real npm prefix bypasses same-name root while preserving cwd", { skip: process.platform === "win32" }, async () => {
  const temp = await mkdtemp(join(tmpdir(), "pi-npm-resolution-"));
  let registry;
  try {
    const workspace = join(temp, "workspace");
    const prefix = join(temp, "prefix");
    const fixture = join(temp, "fixture");
    for (const path of [workspace, prefix, fixture]) await mkdir(path);
    const manifest = { name: "pi-launch-fixture", version: "1.0.0", bin: { "pi-launch-fixture": "bin.cjs" } };
    await writeFile(join(workspace, "package.json"), JSON.stringify(manifest));
    await writeFile(join(workspace, "bin.cjs"), "throw new Error('source bin must not run');");
    await writeFile(join(fixture, "package.json"), JSON.stringify(manifest));
    await writeFile(join(fixture, "bin.cjs"), "#!/usr/bin/env node\nconsole.log(JSON.stringify({cwd:process.cwd()}));\n", { mode: 0o755 });
    const packed = spawnSync("npm", ["pack", "--ignore-scripts", "--json"], { cwd: fixture, encoding: "utf8", timeout: 5000, env: { ...process.env, npm_config_cache: join(temp, "cache"), npm_config_ignore_scripts: "true" } });
    assert.equal(packed.status, 0, packed.stderr);
    const tarball = await readFile(join(fixture, JSON.parse(packed.stdout)[0].filename));
    let url;
    registry = createServer((request, response) => {
      if (request.method === "POST") response.end("{}");
      else if (request.url.includes(".tgz")) response.end(tarball);
      else {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ name: manifest.name, "dist-tags": { latest: "1.0.0" }, versions: { "1.0.0": { ...manifest, dist: { tarball: `${url}/fixture.tgz` } } } }));
      }
    });
    registry.listen(0, "127.0.0.1");
    await once(registry, "listening");
    url = `http://127.0.0.1:${registry.address().port}`;
    const run = (args) => new Promise((resolve, reject) => {
      const child = spawn("npx", args, { cwd: workspace, env: { ...process.env, npm_config_cache: join(temp, "cache"), npm_config_registry: url, npm_config_ignore_scripts: "true", npm_config_update_notifier: "false", npm_config_audit: "false" } });
      let stdout = "", stderr = "";
      child.stdout.on("data", chunk => { stdout += chunk; });
      child.stderr.on("data", chunk => { stderr += chunk; });
      child.on("error", reject);
      const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
      child.on("close", code => { clearTimeout(timer); resolve({code,stdout,stderr}); });
    });
    const failed = await run(["-y", "pi-launch-fixture@1.0.0"]);
    assert.notEqual(failed.code, 0);
    const passed = await run(["--prefix", prefix, "-y", "pi-launch-fixture@1.0.0"]);
    let diagnostic = passed.stderr;
    if (passed.code !== 0) {
      for (const name of await readdir(join(temp, "cache", "_logs"))) diagnostic += await readFile(join(temp, "cache", "_logs", name), "utf8");
    }
    assert.equal(passed.code, 0, diagnostic);
    assert.equal(await realpath(JSON.parse(passed.stdout).cwd), await realpath(workspace));
  } finally {
    registry?.closeAllConnections();
    if (registry?.listening) await new Promise(resolve => registry.close(resolve));
    await rm(temp, { recursive: true, force: true });
  }
});


test("managed updates use only explicitly requested resolution and readiness options", () => {
  const prefix = tmpdir();
  for (const adapter of createDefaultAdapters()) {
    const context = { cwd: root, home: root, platform: process.platform, env: {} };
    const first = adapter.planEntry({ context, scope: "project", serverId: "pi-task-exec", launch: { ...{ ...npmLaunchSpec(prefix), args: npmLaunchSpec(prefix).args.map(arg => arg.replace("@latest", "@0.0.9")) }, ...(adapter.id === "codex" ? { requireReady: true } : {}) }, currentContent: null });
    const updated = adapter.planUpdate({ context, scope: "project", serverId: "pi-task-exec", launch: npmLaunchSpec(), currentContent: first.content });
    assert.equal(updated.kind, "update");
    assert.ok(!updated.content.includes(prefix));
    assert.ok(updated.content.includes("@zguiyang/pi-task-exec@latest"));
    if (adapter.id === "codex") assert.doesNotMatch(updated.content, /required = true/);
    const explicit = adapter.planUpdate({ context, scope: "project", serverId: "pi-task-exec", launch: { ...npmLaunchSpec(prefix), ...(adapter.id === "codex" ? { requireReady: true } : {}) }, currentContent: first.content });
    assert.ok(explicit.content.includes(prefix));
    if (adapter.id === "codex") assert.match(explicit.content, /required = true/);
  }
});
