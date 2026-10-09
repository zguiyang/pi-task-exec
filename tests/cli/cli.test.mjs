import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { VERSION, helpText, parseCli, runCli } from "../../dist/cli/commands/index.js";
import { createDefaultAdapters } from "../../dist/cli/hosts/adapters.js";
import { runDoctor } from "../../dist/cli/commands/doctor.js";
import { atomicWriteFile } from "../../dist/cli/plan/safety.js";
import { unavailableSkillInstaller } from "../../dist/cli/installers/skill.js";

const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const entrypoint = resolve(repoRoot, "bin/pi-task-exec.mjs");

function capture() {
  const out = [];
  const err = [];
  return {
    io: { stdout: (text) => out.push(text), stderr: (text) => err.push(text) },
    stdout: () => out.join(""),
    stderr: () => err.join(""),
  };
}

/** Extract the top-level JSON objects printed on stdout, in order. */
function jsonBlocks(text) {
  const blocks = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === "{") {
      if (depth === 0) start = index;
      depth += 1;
    } else if (character === "}") {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        blocks.push(JSON.parse(text.slice(start, index + 1)));
        start = -1;
      }
    }
  }
  return blocks;
}

function fakeAdapter(root, options = {}) {
  const id = options.id ?? "codex";
  const supported = options.supported ?? true;
  const unsupported = (scope, operation) => ({
    code: operation === "add" ? "mcp_install_unverified" : "mcp_remove_unverified",
    target: "mcp",
    host: id,
    scope,
    message: `Real MCP ${operation} for ${id}/${scope} is deferred.`,
  });
  return {
    id,
    displayName: `Fake ${id}`,
    configFormat: "json",
    supportedPlatforms: ["darwin", "linux", "win32"],
    supportedScopes: ["project", "global"],
    installSupport(_context, scope) {
      return supported ? undefined : unsupported(scope, "add");
    },
    removeSupport(_context, scope) {
      return supported ? undefined : unsupported(scope, "remove");
    },
    describe(context, scope, operation) {
      const support = operation === "remove" ? this.removeSupport(context, scope) : this.installSupport(context, scope);
      return {
        host: id,
        displayName: `Fake ${id}`,
        scope,
        platform: context.platform,
        format: "json",
        path: this.resolveConfigPath(context, scope),
        key: `mcpServers.${id}`,
        supported: support === undefined,
        ...(support ? { support } : {}),
        requiresRestart: true,
        requiresTrust: false,
      };
    },
    additionalRoots() {
      return [];
    },
    resolveConfigPath(_context, scope) {
      return join(root, scope, "config.json");
    },
    async readConfig(path) {
      try {
        return await readFile(path, "utf8");
      } catch {
        return undefined;
      }
    },
    async writeConfig(path, content, writeOptions) {
      await atomicWriteFile(path, content, writeOptions);
    },
    planEntry(input) {
      const path = this.resolveConfigPath(input.context, input.scope);
      let base = {};
      if (input.currentContent) {
        try {
          base = JSON.parse(input.currentContent);
        } catch {
          return { kind: "conflict", conflict: { code: "config_unparseable", path, message: `${path} is not parseable JSON.` } };
        }
      }
      const servers = { ...(base.mcpServers ?? {}) };
      servers[input.serverId] = { command: input.launch.command, args: input.launch.args };
      const content = `${JSON.stringify({ ...base, mcpServers: servers }, null, 2)}\n`;
      return { kind: "ok", path, content, warnings: [] };
    },
    planRemoval(input) {
      const path = this.resolveConfigPath(input.context, input.scope);
      if (!input.currentContent) return { kind: "ok", path, content: "", changed: false, warnings: [] };
      let base;
      try {
        base = JSON.parse(input.currentContent);
      } catch {
        return { kind: "conflict", conflict: { code: "config_unparseable", path, message: `${path} is not parseable JSON.` } };
      }
      const servers = { ...(base.mcpServers ?? {}) };
      const changed = input.serverId in servers;
      delete servers[input.serverId];
      const content = `${JSON.stringify({ ...base, mcpServers: servers }, null, 2)}\n`;
      return { kind: "ok", path, content, changed, warnings: [] };
    },
    async doctorChecks() {
      return [{ id: `host.${id}`, label: `Fake ${id}`, status: "pass", detail: "fake adapter is usable" }];
    },
  };
}

function fakeSkillInstaller() {
  return {
    id: "fake",
    async plan(request) {
      const directory = join(request.context.home, ".agents", "skills", "pi-delegate");
      return {
        kind: "ok",
        plan: {
          directory,
          writes: [{ path: join(directory, "SKILL.md"), content: "fake skill\n", baseSha256: null, summary: "Create fake skill." }],
          removals: [],
          conflicts: [],
          warnings: [],
        },
      };
    },
  };
}

async function makeRoot() {
  return mkdtemp(join(tmpdir(), "pi-task-exec-cli-"));
}

function makeDeps(root, overrides = {}) {
  const captured = capture();
  const deps = {
    io: captured.io,
    env: {},
    cwd: join(root, "project"),
    home: join(root, "home"),
    platform: "darwin",
    packageRoot: root,
    packageVersion: VERSION,
    adapters: [fakeAdapter(root)],
    skillInstaller: fakeSkillInstaller(),
    now: () => new Date("2026-10-09T00:00:00.000Z"),
    spawn: async () => ({ code: 0, stdout: "v1.0.0\n", stderr: "" }),
    launchMode: "npm",
    roots: [root],
    ...overrides,
  };
  return { deps, captured };
}

async function runEntry(args) {
  const child = spawn(process.execPath, [entrypoint, ...args], {
    cwd: repoRoot,
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

test("no arguments shows help, exits 0, and never requests the MCP runtime", async () => {
  const { deps, captured } = makeDeps(await makeRoot());
  const action = await runCli([], deps);
  assert.deepEqual(action, { kind: "exit", code: 0 });
  assert.match(captured.stdout(), /pi-task-exec 0\.2\.2/);
  assert.match(captured.stdout(), /Usage:/);
  assert.match(captured.stdout(), /mcp serve/);
  assert.equal(captured.stderr(), "");
});

test("--help shows the same help and --version prints only the package version", async () => {
  const { deps: helpDeps, captured: help } = makeDeps(await makeRoot());
  assert.deepEqual(await runCli(["--help"], helpDeps), { kind: "exit", code: 0 });
  assert.equal(help.stdout(), `${helpText()}\n`);
  assert.equal(help.stderr(), "");

  const { deps: versionDeps, captured: version } = makeDeps(await makeRoot());
  assert.deepEqual(await runCli(["--version"], versionDeps), { kind: "exit", code: 0 });
  assert.equal(version.stdout(), `${VERSION}\n`);
  assert.equal(version.stderr(), "");
});

test("mcp serve requests the runtime without printing help; mcp serve --help stays help", async () => {
  const { deps, captured } = makeDeps(await makeRoot());
  assert.deepEqual(await runCli(["mcp", "serve"], deps), { kind: "serve" });
  assert.equal(captured.stdout(), "");
  assert.equal(captured.stderr(), "");

  const { deps: helpDeps, captured: help } = makeDeps(await makeRoot());
  assert.deepEqual(await runCli(["mcp", "serve", "--help"], helpDeps), { kind: "exit", code: 0 });
  assert.match(help.stdout(), /only server-start command/);
  assert.equal(help.stderr(), "");
});

test("unknown commands and old routes exit non-zero with an error plus help", async () => {
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
    const { deps, captured } = makeDeps(await makeRoot());
    const action = await runCli(args, deps);
    assert.deepEqual(action, { kind: "exit", code: 1 }, `${args.join(" ")} should exit 1`);
    assert.match(captured.stderr(), /Unknown command|No command|requires/, `${args.join(" ")} should explain the problem`);
    assert.equal(captured.stdout(), "", `${args.join(" ")} must not print to stdout`);
  }
});

test("pure parser rejects malformed and unknown arguments", () => {
  const cases = [
    ["--host"],
    ["--scope"],
    ["--target"],
    ["--nope"],
    ["add", "mcp", "--host", "bogus", "--scope", "project"],
    ["add", "mcp", "--host", "codex", "--scope", "bogus"],
    ["add", "mcp", "--host", "codex", "--scope", "project", "--target", "mcp"],
  ];
  for (const args of cases) {
    const parsed = parseCli(args);
    assert.equal(parsed.kind, "error", `${args.join(" ")} should be an error`);
    assert.notEqual(parsed.code, undefined);
  }
  assert.deepEqual(parseCli(["mcp", "serve"]), { kind: "serve" });
  assert.equal(parseCli(["--version"]).kind, "version");
  assert.equal(parseCli([]).kind, "help");
});

test("MCP add/remove and setup require explicit host and scope", () => {
  const missing = [
    { args: ["add", "mcp"], code: "missing_host" },
    { args: ["add", "mcp", "--host", "codex"], code: "missing_scope" },
    { args: ["add", "skill"], code: "missing_scope" },
    { args: ["add", "skill", "--scope", "project"], code: "missing_host" },
    { args: ["remove", "mcp"], code: "missing_host" },
    { args: ["remove", "skill"], code: "missing_scope" },
    { args: ["setup"], code: "missing_host" },
    { args: ["setup", "--target", "mcp", "--scope", "project"], code: "missing_host" },
    { args: ["setup", "--target", "mcp", "--host", "codex"], code: "missing_scope" },
  ];
  for (const { args, code } of missing) {
    const parsed = parseCli(args);
    assert.equal(parsed.kind, "error", args.join(" "));
    assert.equal(parsed.code, code, args.join(" "));
  }
});

test("--json errors are exact machine-readable objects on stdout", async () => {
  const { deps, captured } = makeDeps(await makeRoot());
  const action = await runCli(["add", "mcp", "--json"], deps);
  assert.deepEqual(action, { kind: "exit", code: 1 });
  assert.deepEqual(JSON.parse(captured.stdout()), {
    error: { code: "missing_host", message: "add mcp requires an explicit --host codex|zed|opencode." },
  });
  assert.equal(captured.stderr(), "");
});

test("real adapters plan a supported MCP install and write only under --yes", async () => {
  const root = await makeRoot();
  const { deps, captured } = makeDeps(root, {
    adapters: createDefaultAdapters(),
    skillInstaller: unavailableSkillInstaller(),
  });
  const action = await runCli(["add", "mcp", "--host", "codex", "--scope", "project", "--yes", "--json"], deps);
  assert.deepEqual(action, { kind: "exit", code: 0 });
  assert.doesNotMatch(captured.stdout(), /mcp_install_unverified/);
  assert.match(captured.stdout(), /\"status\": \"success\"/);
  const configPath = join(root, "project", ".codex", "config.toml");
  assert.match(await readFile(configPath, "utf8"), /\[mcp_servers\.pi-task-exec\]/);
});

test("supported fake adapter dry-run prints the plan, exits 0, and writes nothing", async () => {
  const root = await makeRoot();
  const { deps, captured } = makeDeps(root);
  const action = await runCli(["add", "mcp", "--host", "codex", "--scope", "project", "--dry-run", "--json"], deps);
  assert.deepEqual(action, { kind: "exit", code: 0 });
  const parsed = jsonBlocks(captured.stdout())[0];
  assert.ok(parsed, "plan JSON should be printed");
  assert.equal(parsed.operation, "add");
  assert.equal(parsed.host, "codex");
  assert.equal(parsed.scope, "project");
  assert.equal(parsed.dryRun, true);
  assert.equal(parsed.creates.length, 1);
  assert.equal(parsed.creates[0].path, join(root, "project", "config.json"));
  assert.deepEqual(parsed.unsupported, []);
  await assert.rejects(readFile(join(root, "project", "config.json"), "utf8"));
});

test("existing-config plan reports a truthful timestamped backup strategy", async () => {
  const root = await makeRoot();
  const configPath = join(root, "project", "config.json");
  await atomicWriteFile(configPath, JSON.stringify({ mcpServers: {} }), { roots: [root] });
  const { deps, captured } = makeDeps(root);
  const action = await runCli(["add", "mcp", "--host", "codex", "--scope", "project", "--dry-run", "--json"], deps);
  assert.deepEqual(action, { kind: "exit", code: 0 });
  const parsed = jsonBlocks(captured.stdout())[0];
  assert.equal(parsed.updates.length, 1);
  assert.equal(parsed.backups.length, 1);
  assert.equal(parsed.backups[0].strategy, "timestamped-sibling");
  assert.match(parsed.backups[0].backupPath, /\.backup-<timestamp>$/);
  assert.doesNotMatch(parsed.backups[0].backupPath, /pi-task-exec\.bak/);
});

test("create-only plan does not claim a backup that will not happen", async () => {
  const root = await makeRoot();
  const { deps, captured } = makeDeps(root);
  const action = await runCli(["add", "mcp", "--host", "codex", "--scope", "project", "--dry-run", "--json"], deps);
  assert.deepEqual(action, { kind: "exit", code: 0 });
  const parsed = jsonBlocks(captured.stdout())[0];
  assert.equal(parsed.creates.length, 1);
  assert.deepEqual(parsed.backups, []);
});

test("plan JSON never includes config secrets or file contents", async () => {
  const root = await makeRoot();
  const configPath = join(root, "project", "config.json");
  await atomicWriteFile(configPath, JSON.stringify({ secret: "TOPSECRET-VALUE", mcpServers: { other: { command: "other" } } }), { roots: [root] });
  const { deps, captured } = makeDeps(root);
  const action = await runCli(["add", "mcp", "--host", "codex", "--scope", "project", "--dry-run", "--json"], deps);
  assert.deepEqual(action, { kind: "exit", code: 0 });
  assert.doesNotMatch(captured.stdout(), /TOPSECRET-VALUE/);
  assert.doesNotMatch(captured.stdout(), /"other"/);
});

test("supported fake adapter writes on --yes, then is idempotent on a second run", async () => {
  const root = await makeRoot();
  const first = makeDeps(root);
  const firstAction = await runCli(["add", "mcp", "--host", "codex", "--scope", "project", "--yes", "--json"], first.deps);
  assert.deepEqual(firstAction, { kind: "exit", code: 0 });
  const configPath = join(root, "project", "config.json");
  const written = JSON.parse(await readFile(configPath, "utf8"));
  assert.deepEqual(written.mcpServers["pi-task-exec"], { command: "npx", args: ["-y", "@zguiyang/pi-task-exec@latest", "mcp", "serve"] });

  const second = makeDeps(root);
  const secondAction = await runCli(["add", "mcp", "--host", "codex", "--scope", "project", "--yes"], second.deps);
  assert.deepEqual(secondAction, { kind: "exit", code: 0 });
  assert.doesNotMatch(second.captured.stdout(), /already_configured|Launch mode:/);
  assert.match(second.captured.stdout(), /No changes needed\./);
});

test("a plan conflict prevents the whole operation and reports an error", async () => {
  const root = await makeRoot();
  const configPath = join(root, "project", "config.json");
  await atomicWriteFile(configPath, "this is not json", { roots: [root] });
  const { deps, captured } = makeDeps(root);
  const action = await runCli(["add", "mcp", "--host", "codex", "--scope", "project", "--yes", "--json"], deps);
  assert.deepEqual(action, { kind: "exit", code: 1 });
  assert.match(captured.stdout(), /config_unparseable/);
  assert.equal(await readFile(configPath, "utf8"), "this is not json");
});

test("remove mcp with a fake adapter removes only the managed entry", async () => {
  const root = await makeRoot();
  const configPath = join(root, "project", "config.json");
  await atomicWriteFile(configPath, JSON.stringify({ user: "keep", mcpServers: { "pi-task-exec": { command: "npx", args: [] }, other: {} } }), { roots: [root] });
  const remove = makeDeps(root);
  const action = await runCli(["remove", "mcp", "--host", "codex", "--scope", "project", "--yes", "--json"], remove.deps);
  assert.deepEqual(action, { kind: "exit", code: 0 });
  const result = JSON.parse(await readFile(configPath, "utf8"));
  assert.equal(result.user, "keep");
  assert.deepEqual(result.mcpServers.other, {});
  assert.equal("pi-task-exec" in result.mcpServers, false);
});

test("add skill with the unavailable installer reports pending without writing", async () => {
  const root = await makeRoot();
  const { deps, captured } = makeDeps(root, { skillInstaller: unavailableSkillInstaller() });
  const action = await runCli(["add", "skill", "--host", "codex", "--scope", "project", "--yes", "--json"], deps);
  assert.deepEqual(action, { kind: "exit", code: 1 });
  assert.match(captured.stdout(), /skill_installer_unavailable/);
  await assert.rejects(readFile(join(deps.cwd, ".agents", "skills", "pi-delegate", "SKILL.md"), "utf8"));
});

test("setup --target both plans both targets and requires host/scope", async () => {
  const root = await makeRoot();
  const { deps, captured } = makeDeps(root);
  const action = await runCli(["setup", "--target", "both", "--host", "codex", "--scope", "project", "--dry-run", "--json"], deps);
  assert.deepEqual(action, { kind: "exit", code: 0 });
  const plan = jsonBlocks(captured.stdout())[0];
  assert.equal(plan.operation, "setup");
  assert.equal(plan.target, "both");
  assert.ok(plan.resolvedPaths.config);
  assert.ok(plan.resolvedPaths.skillDir);
});

test("doctor is read-only and reports module/version/tool/host/skill status", async () => {
  const root = await makeRoot();
  const { deps, captured } = makeDeps(root, {
    packageRoot: repoRoot,
  });
  const action = await runCli(["doctor", "--json"], deps);
  assert.deepEqual(action, { kind: "exit", code: 0 });
  const report = jsonBlocks(captured.stdout())[0];
  assert.equal(report.schema, "pi-task-exec.doctor.v1");
  assert.equal(report.package.version, VERSION);
  assert.ok(report.tools.some((check) => check.id === "runtime.node"));
  assert.ok(report.tools.some((check) => check.id === "tool.pi"));
  assert.ok(report.tools.some((check) => check.id === "tool.git"));
  assert.ok(report.hosts.length > 0);
  assert.ok(report.skill.length > 0);
  assert.ok(report.versions.checks.some((check) => check.id === "version.package"));
  await assert.rejects(readFile(join(root, "project", "config.json"), "utf8"));
});

test("default adapters expose verified platform, scope, and format metadata", () => {
  const adapters = createDefaultAdapters();
  assert.deepEqual(adapters.map((adapter) => adapter.id), ["codex", "zed", "opencode"]);
  for (const adapter of adapters) {
    assert.deepEqual([...adapter.supportedPlatforms].sort(), ["darwin", "linux", "win32"], `${adapter.id} platforms`);
    assert.deepEqual([...adapter.supportedScopes].sort(), ["global", "project"], `${adapter.id} scopes`);
    assert.ok(["toml", "jsonc"].includes(adapter.configFormat), `${adapter.id} format`);
  }
});

test("doctor does not read config for unsupported hosts and reports deferred paths", async () => {
  const root = await makeRoot();
  let configReads = 0;
  const capability = { code: "mcp_install_unverified", target: "mcp", host: "codex", scope: "project", message: "config path/format deferred to stage 8; not guessed or read" };
  const adapter = {
    id: "codex",
    displayName: "Deferred Codex",
    supportedPlatforms: [],
    supportedScopes: [],
    installSupport: () => capability,
    removeSupport: () => capability,
    resolveConfigPath() { throw new Error("resolveConfigPath must not be called"); },
    async readConfig() { configReads += 1; throw new Error("readConfig must not be called"); },
    async writeConfig() { throw new Error("writeConfig must not be called"); },
    planEntry() { return { kind: "unsupported", capability }; },
    planRemoval() { return { kind: "unsupported", capability }; },
    async doctorChecks() { throw new Error("doctorChecks must not run for an unsupported host"); },
  };
  const report = await runDoctor({
    adapters: [adapter],
    skillInstaller: unavailableSkillInstaller(),
    context: { home: join(root, "home"), cwd: join(root, "project"), platform: "darwin", env: {} },
    spawn: async () => ({ code: 0, stdout: "v1.0.0\n", stderr: "" }),
    now: () => new Date("2026-10-09T00:00:00.000Z"),
    packageRoot: repoRoot,
    packageVersion: VERSION,
  });
  assert.equal(configReads, 0, "doctor must never read config for an unsupported host");
  assert.ok(report.hosts.some((check) => check.status === "warn" && /deferred/i.test(check.detail)));
});

test("doctor reports skill content state without printing file contents", async () => {
  const root = await makeRoot();
  const home = join(root, "home");
  const skillDir = join(home, ".agents", "skills", "pi-delegate");
  await mkdir(skillDir, { recursive: true });
  await writeFile(join(skillDir, "SKILL.md"), "SUPERSECRET-SKILL-BODY\n");
  const report = await runDoctor({
    adapters: [],
    skillInstaller: unavailableSkillInstaller(),
    context: { home, cwd: join(root, "project"), platform: "darwin", env: {} },
    spawn: async () => ({ code: 0, stdout: "v1.0.0\n", stderr: "" }),
    now: () => new Date("2026-10-09T00:00:00.000Z"),
    packageRoot: repoRoot,
    packageVersion: VERSION,
  });
  const global = report.skill.find((check) => check.id === "skill.global");
  assert.ok(global);
  assert.match(global.detail, /SKILL\.md present/);
  assert.match(global.detail, /content state unknown/);
  assert.doesNotMatch(JSON.stringify(report), /SUPERSECRET-SKILL-BODY/);
});

test("entrypoint with no arguments prints help and does not start MCP", async () => {
  const result = await runEntry([]);
  assert.equal(result.code, 0);
  assert.equal(result.signal, null);
  assert.match(result.stdout, /Usage:/);
  assert.doesNotMatch(result.stderr, /started over MCP stdio/);
});

test("entrypoint with an unknown command exits non-zero with a concise error and help hint", async () => {
  const result = await runEntry(["uninstall"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /Unknown command: uninstall/);
  assert.match(result.stderr, /^Error: Unknown command:/);
  assert.match(result.stderr, /pi-task-exec --help/);
  assert.doesNotMatch(result.stderr, /Commands:|Options:/);
  assert.doesNotMatch(result.stderr, /started over MCP stdio/);
});

test("entrypoint mcp serve starts the MCP runtime and speaks JSON-RPC", async () => {
  const child = spawn(process.execPath, [entrypoint, "mcp", "serve"], {
    cwd: repoRoot,
    env: {
      ...process.env,
      PI_WORKER_COMMAND: process.execPath,
      PI_WORKER_ALLOWED_ROOTS: repoRoot,
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
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
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
