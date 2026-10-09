import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { createDefaultAdapters } from "../../dist/cli/hosts/adapters.js";
import { runCli } from "../../dist/cli/commands/index.js";
import { VERSION } from "../../dist/cli/identity.js";
import { parseJsoncRoot } from "../../dist/cli/hosts/jsonc.js";
import { detectLaunchMode, resolveLaunchSpec } from "../../dist/cli/plan/model.js";
import { unavailableSkillInstaller } from "../../dist/cli/installers/skill.js";

const npmLaunch = { command: "npx", args: ["-y", `@zguiyang/pi-task-exec@${VERSION}`, "mcp", "serve"] };

async function makeRoot() {
  return mkdtemp(join(tmpdir(), "pi-task-exec-host-"));
}

function capture() {
  const out = [];
  const err = [];
  return { io: { stdout: (text) => out.push(text), stderr: (text) => err.push(text) }, stdout: () => out.join(""), stderr: () => err.join("") };
}

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
    if (character === '"') { inString = true; continue; }
    if (character === "{") { if (depth === 0) start = index; depth += 1; }
    else if (character === "}") {
      depth -= 1;
      if (depth === 0 && start >= 0) { blocks.push(JSON.parse(text.slice(start, index + 1))); start = -1; }
    }
  }
  return blocks;
}

/** Run the CLI against the real adapters with isolated home/cwd/env. */
async function run(root, args, overrides = {}) {
  const captured = capture();
  const env = overrides.env ?? {};
  const deps = {
    io: captured.io,
    env,
    cwd: join(root, "project"),
    home: join(root, "home"),
    platform: overrides.platform ?? "darwin",
    packageRoot: overrides.packageRoot ?? root,
    packageVersion: VERSION,
    adapters: createDefaultAdapters(),
    skillInstaller: unavailableSkillInstaller(),
    now: () => new Date("2026-10-09T00:00:00.000Z"),
    spawn: async () => ({ code: 0, stdout: "v1.0.0\n", stderr: "" }),
    roots: [root],
    ...(overrides.launchMode !== undefined ? { launchMode: overrides.launchMode } : {}),
  };
  const action = await runCli(args, deps);
  return { action, captured, blocks: jsonBlocks(captured.stdout()), stdout: captured.stdout(), stderr: captured.stderr() };
}

const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));
const exists = async (path) => { try { await stat(path); return true; } catch { return false; } };

// ---------------------------------------------------------------------------
// Launch spec: npm-installed vs source checkout
// ---------------------------------------------------------------------------

test("npm install mode is the default and uses the published package with structured args", () => {
  const spec = resolveLaunchSpec({ packageRoot: "/tmp/some-package", packageVersion: "1.2.3", env: {} });
  assert.deepEqual(spec, { mode: "npm", launch: { command: "npx", args: ["-y", "@zguiyang/pi-task-exec@1.2.3", "mcp", "serve"] } });
});

test("checkout mode uses node with an absolute local dist/cli/index.js path, never an npm package", () => {
  const spec = resolveLaunchSpec({ packageRoot: "/work/pi-task-exec", packageVersion: "1.2.3", env: {} , mode: "checkout" });
  assert.equal(spec.mode, "checkout");
  assert.equal(spec.launch.command, "node");
  assert.deepEqual(spec.launch.args, ["/work/pi-task-exec/dist/cli/index.js", "mcp", "serve"]);
  assert.ok(!spec.launch.args.some((arg) => arg.includes("@zguiyang/pi-task-exec")));
  assert.deepEqual(detectLaunchMode("/work/pi-task-exec", { PI_TASK_EXEC_LAUNCH_MODE: "checkout" }), "checkout");
  assert.deepEqual(detectLaunchMode("/work/pi-task-exec", { PI_TASK_EXEC_LAUNCH_MODE: "npm" }), "npm");
});

test("checkout mode refuses to silently write an absolute local path without --local-dev", async () => {
  const root = await makeRoot();
  const repo = join(root, "repo");
  await mkdir(join(repo, ".git"), { recursive: true });
  assert.equal(detectLaunchMode(repo, {}), "checkout");

  const { action, blocks, stdout } = await run(root, ["add", "mcp", "--host", "codex", "--scope", "global", "--dry-run", "--json"], { packageRoot: repo });
  assert.deepEqual(action, { kind: "exit", code: 0 });
  assert.equal(blocks[0].launchMode, "checkout");
  assert.equal(blocks[0].conflicts[0].code, "local_dev_required");
  assert.equal(blocks[1].status, "dry-run");
  assert.equal(await exists(join(root, "home", ".codex", "config.toml")), false);
  assert.doesNotMatch(stdout, /@zguiyang\/pi-task-exec@/);

  const blocked = await run(root, ["add", "mcp", "--host", "codex", "--scope", "global", "--yes", "--json"], { packageRoot: repo });
  assert.deepEqual(blocked.action, { kind: "exit", code: 1 });
  assert.equal(blocked.blocks[1].status, "conflict");
  assert.equal(await exists(join(root, "home", ".codex", "config.toml")), false);
});

test("checkout mode with --local-dev writes an absolute node launch path to global config", async () => {
  const root = await makeRoot();
  const repo = join(root, "repo");
  await mkdir(join(repo, ".git"), { recursive: true });
  const { action, blocks } = await run(root, ["add", "mcp", "--host", "codex", "--scope", "global", "--yes", "--local-dev", "--json"], { packageRoot: repo });
  assert.deepEqual(action, { kind: "exit", code: 0 });
  assert.equal(blocks[0].launchMode, "checkout");
  assert.ok(blocks[0].warnings.some((warning) => warning.code === "local_checkout_launch"));
  const toml = await readFile(join(root, "home", ".codex", "config.toml"), "utf8");
  assert.match(toml, /command = "node"/);
  assert.ok(toml.includes(join(repo, "dist", "cli", "index.js")));
  assert.doesNotMatch(toml, /@zguiyang\/pi-task-exec@/);
});

// ---------------------------------------------------------------------------
// Codex
// ---------------------------------------------------------------------------

test("Codex global install honours CODEX_HOME and falls back to ~/.codex/config.toml", async () => {
  const root = await makeRoot();
  const codexHome = join(root, "custom-codex");
  const custom = await run(root, ["add", "mcp", "--host", "codex", "--scope", "global", "--yes", "--json"], { env: { CODEX_HOME: codexHome } });
  assert.deepEqual(custom.action, { kind: "exit", code: 0 });
  const customPath = join(codexHome, "config.toml");
  assert.ok(await exists(customPath));
  assert.match(await readFile(customPath, "utf8"), /\[mcp_servers\.pi-task-exec\]/);
  assert.deepEqual(custom.blocks[0].resolvedPaths.config, customPath);

  const root2 = await makeRoot();
  const fallback = await run(root2, ["add", "mcp", "--host", "codex", "--scope", "global", "--yes", "--json"], { env: {} });
  assert.deepEqual(fallback.action, { kind: "exit", code: 0 });
  assert.ok(await exists(join(root2, "home", ".codex", "config.toml")));
});

test("Codex project install targets cwd/.codex/config.toml and warns about project trust", async () => {
  const root = await makeRoot();
  const { action, blocks, stdout } = await run(root, ["add", "mcp", "--host", "codex", "--scope", "project", "--yes", "--json"]);
  assert.deepEqual(action, { kind: "exit", code: 0 });
  const path = join(root, "project", ".codex", "config.toml");
  assert.equal(blocks[0].resolvedPaths.config, path);
  const toml = await readFile(path, "utf8");
  assert.match(toml, /\[mcp_servers\.pi-task-exec\]/);
  assert.match(toml, /command = "npx"/);
  assert.match(toml, /args = \["-y", "@zguiyang\/pi-task-exec@0\.2\.0", "mcp", "serve"\]/);
  assert.ok(blocks[0].warnings.some((warning) => warning.code === "project_trust_required"));
  assert.match(stdout, /trust/);
});

test("Codex TOML merge preserves unrelated sections, values, and comments", async () => {
  const root = await makeRoot();
  const path = join(root, "home", ".codex", "config.toml");
  await mkdir(join(root, "home", ".codex"), { recursive: true });
  await writeFile(path, [
    "# keep this top comment",
    'model = "gpt-5"',
    "",
    "[model_providers.custom]",
    'name = "custom"',
    "",
    "[mcp_servers.other]",
    'command = "other"',
    'args = ["a"]',
    "",
    "[history]",
    'persistence = "save-all"',
    "",
  ].join("\n"));
  const { action } = await run(root, ["add", "mcp", "--host", "codex", "--scope", "global", "--yes", "--json"]);
  assert.deepEqual(action, { kind: "exit", code: 0 });
  const merged = await readFile(path, "utf8");
  assert.match(merged, /# keep this top comment/);
  assert.match(merged, /\[model_providers\.custom\]/);
  assert.match(merged, /\[mcp_servers\.other\]/);
  assert.match(merged, /\[history\]/);
  assert.match(merged, /persistence = "save-all"/);
  assert.match(merged, /\[mcp_servers\.pi-task-exec\]/);
  // The other MCP entry and its values are byte-for-byte intact.
  const other = merged.slice(merged.indexOf("[mcp_servers.other]"), merged.indexOf("[history]"));
  assert.match(other, /command = "other"/);
  assert.match(other, /args = \["a"\]/);
});

test("Codex install is exact-content idempotent and refuses an old-version entry", async () => {
  const root = await makeRoot();
  const first = await run(root, ["add", "mcp", "--host", "codex", "--scope", "global", "--yes", "--json"]);
  assert.deepEqual(first.action, { kind: "exit", code: 0 });
  const second = await run(root, ["add", "mcp", "--host", "codex", "--scope", "global", "--yes", "--json"]);
  assert.deepEqual(second.action, { kind: "exit", code: 0 });
  assert.equal(second.blocks[0].updates.length, 0);
  assert.equal(second.blocks[1].status, "no-op");
  assert.ok(second.blocks[0].warnings.some((warning) => warning.code === "already_configured"));

  const path = join(root, "home", ".codex", "config.toml");
  const before = await readFile(path, "utf8");
  await writeFile(path, before.replace(/@0\.2\.0/, "@0.0.9"));
  const third = await run(root, ["add", "mcp", "--host", "codex", "--scope", "global", "--yes", "--json"]);
  assert.deepEqual(third.action, { kind: "exit", code: 1 });
  assert.equal(third.blocks[0].conflicts[0].code, "mcp_entry_conflict");
  assert.match(await readFile(path, "utf8"), /@0\.0\.9/);
});

test("Codex removal removes only the managed entry and preserves everything else", async () => {
  const root = await makeRoot();
  const path = join(root, "home", ".codex", "config.toml");
  await mkdir(join(root, "home", ".codex"), { recursive: true });
  await writeFile(path, [
    'model = "gpt-5"',
    "",
    "[mcp_servers.other]",
    'command = "other"',
    "",
    "[mcp_servers.pi-task-exec]",
    'command = "npx"',
    'args = ["-y", "@zguiyang/pi-task-exec@0.2.0", "mcp", "serve"]',
    "",
    "[history]",
    'persistence = "save-all"',
    "",
  ].join("\n"));
  const removed = await run(root, ["remove", "mcp", "--host", "codex", "--scope", "global", "--yes", "--json"]);
  assert.deepEqual(removed.action, { kind: "exit", code: 0 });
  const result = await readFile(path, "utf8");
  assert.doesNotMatch(result, /\[mcp_servers\.pi-task-exec\]/);
  assert.match(result, /\[mcp_servers\.other\]/);
  assert.match(result, /\[history\]/);
  assert.match(result, /model = "gpt-5"/);

  const again = await run(root, ["remove", "mcp", "--host", "codex", "--scope", "global", "--yes", "--json"]);
  assert.deepEqual(again.action, { kind: "exit", code: 0 });
  assert.ok(again.blocks[0].warnings.some((warning) => warning.code === "not_configured"));
});

test("Codex refuses malformed TOML and never touches a user-owned pi-task-exec entry", async () => {
  const root = await makeRoot();
  const path = join(root, "home", ".codex", "config.toml");
  await mkdir(join(root, "home", ".codex"), { recursive: true });
  await writeFile(path, "this is = not valid [ toml\n");
  const broken = await run(root, ["add", "mcp", "--host", "codex", "--scope", "global", "--yes", "--json"]);
  assert.deepEqual(broken.action, { kind: "exit", code: 1 });
  assert.equal(broken.blocks[1].status, "conflict");
  assert.equal(broken.blocks[0].conflicts[0].code, "config_unparseable");
  assert.equal(await readFile(path, "utf8"), "this is = not valid [ toml\n");

  const root2 = await makeRoot();
  const path2 = join(root2, "home", ".codex", "config.toml");
  await mkdir(join(root2, "home", ".codex"), { recursive: true });
  await writeFile(path2, '[mcp_servers.pi-task-exec]\ncommand = "my-own-server"\nargs = []\n');
  const userEntry = await run(root2, ["add", "mcp", "--host", "codex", "--scope", "global", "--yes", "--json"]);
  assert.deepEqual(userEntry.action, { kind: "exit", code: 1 });
  assert.equal(userEntry.blocks[0].conflicts[0].code, "mcp_entry_conflict");
  assert.equal(await readFile(path2, "utf8"), '[mcp_servers.pi-task-exec]\ncommand = "my-own-server"\nargs = []\n');

  const remove = await run(root2, ["remove", "mcp", "--host", "codex", "--scope", "global", "--yes", "--json"]);
  assert.deepEqual(remove.action, { kind: "exit", code: 1 });
  assert.equal(remove.blocks[0].conflicts[0].code, "mcp_entry_not_managed");
});

// ---------------------------------------------------------------------------
// Zed
// ---------------------------------------------------------------------------

test("Zed project and user paths resolve to .zed/settings.json and XDG ~/.config/zed/settings.json", async () => {
  const root = await makeRoot();
  const project = await run(root, ["add", "mcp", "--host", "zed", "--scope", "project", "--yes", "--json"]);
  assert.deepEqual(project.action, { kind: "exit", code: 0 });
  const projectPath = join(root, "project", ".zed", "settings.json");
  assert.equal(project.blocks[0].resolvedPaths.config, projectPath);
  const settings = await readJson(projectPath);
  assert.deepEqual(settings.context_servers["pi-task-exec"], { command: "npx", args: npmLaunch.args });

  const root2 = await makeRoot();
  const xdg = join(root2, "xdg");
  const global = await run(root2, ["add", "mcp", "--host", "zed", "--scope", "global", "--yes", "--json"], { env: { XDG_CONFIG_HOME: xdg } });
  assert.deepEqual(global.action, { kind: "exit", code: 0 });
  assert.equal(global.blocks[0].resolvedPaths.config, join(xdg, "zed", "settings.json"));

  const root3 = await makeRoot();
  const fallback = await run(root3, ["add", "mcp", "--host", "zed", "--scope", "global", "--yes", "--json"], { env: {} });
  assert.deepEqual(fallback.action, { kind: "exit", code: 0 });
  assert.equal(fallback.blocks[0].resolvedPaths.config, join(root3, "home", ".config", "zed", "settings.json"));
});

test("Zed JSONC merge preserves comments, unrelated fields, and the managed env", async () => {
  const root = await makeRoot();
  const path = join(root, "project", ".zed", "settings.json");
  await mkdir(join(root, "project", ".zed"), { recursive: true });
  await writeFile(path, [
    "{",
    "  // editor comment",
    '  "theme": "One Dark",',
    '  "context_servers": {',
    '    "other": { "command": "other", "args": ["x"] }',
    "  },",
    '  "vim_mode": true',
    "}",
    "",
  ].join("\n"));
  const { action } = await run(root, ["add", "mcp", "--host", "zed", "--scope", "project", "--yes", "--json"]);
  assert.deepEqual(action, { kind: "exit", code: 0 });
  const merged = await readFile(path, "utf8");
  assert.match(merged, /\/\/ editor comment/);
  assert.match(merged, /"theme": "One Dark"/);
  assert.match(merged, /"vim_mode": true/);
  assert.match(merged, /"other"/);
  const parsed = JSON.parse(merged.replace(/\/\/.*$/gm, ""));
  assert.deepEqual(parsed.context_servers["pi-task-exec"], { command: "npx", args: npmLaunch.args });
  assert.deepEqual(parsed.context_servers.other, { command: "other", args: ["x"] });
});

test("Zed project install warns about Restricted Mode and refuses a malformed config", async () => {
  const root = await makeRoot();
  const { blocks, stdout } = await run(root, ["add", "mcp", "--host", "zed", "--scope", "project", "--dry-run", "--json"]);
  assert.ok(blocks[0].warnings.some((warning) => warning.code === "restricted_mode"));
  assert.match(stdout, /Restricted Mode/);

  const root2 = await makeRoot();
  const path = join(root2, "project", ".zed", "settings.json");
  await mkdir(join(root2, "project", ".zed"), { recursive: true });
  await writeFile(path, "{ this is not json ");
  const malformed = await run(root2, ["add", "mcp", "--host", "zed", "--scope", "project", "--yes", "--json"]);
  assert.deepEqual(malformed.action, { kind: "exit", code: 1 });
  assert.equal(malformed.blocks[1].status, "conflict");
  assert.equal(malformed.blocks[0].conflicts[0].code, "config_unparseable");
  assert.equal(await readFile(path, "utf8"), "{ this is not json ");
});

test("Zed removal removes only the managed entry", async () => {
  const root = await makeRoot();
  const path = join(root, "project", ".zed", "settings.json");
  await mkdir(join(root, "project", ".zed"), { recursive: true });
  await writeFile(path, JSON.stringify({
    theme: "keep",
    context_servers: {
      other: { command: "other", args: [] },
      "pi-task-exec": { command: "npx", args: npmLaunch.args },
    },
  }, null, 2));
  const { action, blocks } = await run(root, ["remove", "mcp", "--host", "zed", "--scope", "project", "--yes", "--json"]);
  assert.deepEqual(action, { kind: "exit", code: 0 });
  assert.equal(blocks[1].status, "success");
  const result = await readJson(path);
  assert.equal(result.theme, "keep");
  assert.deepEqual(result.context_servers.other, { command: "other", args: [] });
  assert.equal("pi-task-exec" in result.context_servers, false);
});

// ---------------------------------------------------------------------------
// OpenCode
// ---------------------------------------------------------------------------

test("OpenCode uses the stable mcp.<name> schema with a local command array", async () => {
  const root = await makeRoot();
  const { action, blocks } = await run(root, ["add", "mcp", "--host", "opencode", "--scope", "project", "--yes", "--json"]);
  assert.deepEqual(action, { kind: "exit", code: 0 });
  const path = join(root, "project", "opencode.json");
  assert.equal(blocks[0].resolvedPaths.config, path);
  const config = await readJson(path);
  assert.deepEqual(config.mcp["pi-task-exec"], { type: "local", command: ["npx", ...npmLaunch.args] });
  assert.equal("servers" in config.mcp, false, "must not use the obsolete mcp.servers shape");
});

test("OpenCode global resolution honours XDG_CONFIG_HOME, OPENCODE_CONFIG, and OPENCODE_CONFIG_DIR", async () => {
  const root = await makeRoot();
  const xdg = join(root, "xdg");
  const xdgRun = await run(root, ["add", "mcp", "--host", "opencode", "--scope", "global", "--yes", "--json"], { env: { XDG_CONFIG_HOME: xdg } });
  assert.deepEqual(xdgRun.action, { kind: "exit", code: 0 });
  assert.equal(xdgRun.blocks[0].resolvedPaths.config, join(xdg, "opencode", "opencode.json"));

  const root2 = await makeRoot();
  const customDir = join(root2, "custom-opencode");
  const dirRun = await run(root2, ["add", "mcp", "--host", "opencode", "--scope", "global", "--yes", "--json"], { env: { OPENCODE_CONFIG_DIR: customDir } });
  assert.deepEqual(dirRun.action, { kind: "exit", code: 0 });
  assert.equal(dirRun.blocks[0].resolvedPaths.config, join(customDir, "opencode.json"));
  assert.ok(dirRun.blocks[0].warnings.some((warning) => warning.code === "custom_config_dir"));

  const root3 = await makeRoot();
  const customFile = join(root3, "custom", "my-opencode.jsonc");
  const fileRun = await run(root3, ["add", "mcp", "--host", "opencode", "--scope", "global", "--yes", "--json"], { env: { OPENCODE_CONFIG: customFile } });
  assert.deepEqual(fileRun.action, { kind: "exit", code: 0 });
  assert.equal(fileRun.blocks[0].resolvedPaths.config, customFile);
  assert.ok(fileRun.blocks[0].warnings.some((warning) => warning.code === "custom_config_path"));
  assert.ok(await exists(customFile));
});

test("OpenCode preserves unrelated JSONC comments and fields when creating the entry", async () => {
  const root = await makeRoot();
  const path = join(root, "project", "opencode.jsonc");
  await mkdir(join(root, "project"), { recursive: true });
  await writeFile(path, [
    "{",
    "  // user comment",
    '  "theme": "opencode",',
    '  "mcp": {',
    '    "other": { "type": "remote", "url": "https://example.test" }',
    "  },",
    '  "autoupdate": true',
    "}",
    "",
  ].join("\n"));
  const { action, blocks } = await run(root, ["add", "mcp", "--host", "opencode", "--scope", "project", "--yes", "--json"]);
  assert.deepEqual(action, { kind: "exit", code: 0 });
  assert.equal(blocks[0].resolvedPaths.config, path);
  const merged = await readFile(path, "utf8");
  assert.match(merged, /\/\/ user comment/);
  assert.match(merged, /"autoupdate": true/);
  assert.match(merged, /"other"/);
  const parsed = parseJsoncRoot(merged);
  assert.deepEqual(parsed.mcp["pi-task-exec"], { type: "local", command: ["npx", ...npmLaunch.args] });
  assert.deepEqual(parsed.mcp.other, { type: "remote", url: "https://example.test" });
});

test("OpenCode treats an old version or modified entry fields as fingerprint drift", async () => {
  const root = await makeRoot();
  const path = join(root, "project", "opencode.jsonc");
  await mkdir(join(root, "project"), { recursive: true });
  await writeFile(path, [
    "{",
    "  // user comment",
    '  "theme": "opencode",',
    '  "mcp": {',
    '    "pi-task-exec": {',
    '      "type": "local",',
    '      "command": ["npx", "-y", "@zguiyang/pi-task-exec@0.0.9", "mcp", "serve"],',
    '      "enabled": false,',
    '      "environment": { "TOKEN": "secret" }',
    "    },",
    '    "other": { "type": "remote", "url": "https://example.test" }',
    "  },",
    '  "autoupdate": true',
    "}",
    "",
  ].join("\n"));
  const { action, blocks } = await run(root, ["add", "mcp", "--host", "opencode", "--scope", "project", "--yes", "--json"]);
  assert.deepEqual(action, { kind: "exit", code: 1 });
  assert.equal(blocks[0].conflicts[0].code, "mcp_entry_conflict");
  const merged = await readFile(path, "utf8");
  assert.match(merged, /@0\.0\.9/);
  assert.match(merged, /"enabled": false/);
  assert.match(merged, /"TOKEN": "secret"/);

  const remove = await run(root, ["remove", "mcp", "--host", "opencode", "--scope", "project", "--yes", "--json"]);
  assert.deepEqual(remove.action, { kind: "exit", code: 1 });
  assert.equal(remove.blocks[0].conflicts[0].code, "mcp_entry_not_managed");
  assert.match(await readFile(path, "utf8"), /@0\.0\.9/);
});

test("OpenCode warns that inline OPENCODE_CONFIG_CONTENT can shadow the file entry", async () => {
  const root = await makeRoot();
  const { blocks, stdout } = await run(root, ["add", "mcp", "--host", "opencode", "--scope", "project", "--dry-run", "--json"], {
    env: { OPENCODE_CONFIG_CONTENT: '{"mcp":{}}' },
  });
  assert.ok(blocks[0].warnings.some((warning) => warning.code === "inline_config_override"));
  assert.match(stdout, /OPENCODE_CONFIG_CONTENT/);
});

test("OpenCode removal removes only the managed mcp entry", async () => {
  const root = await makeRoot();
  const path = join(root, "project", "opencode.json");
  await mkdir(join(root, "project"), { recursive: true });
  await writeFile(path, JSON.stringify({
    mcp: {
      "pi-task-exec": { type: "local", command: ["npx", ...npmLaunch.args] },
      other: { type: "remote", url: "https://example.test" },
    },
    theme: "keep",
  }, null, 2));
  const { action } = await run(root, ["remove", "mcp", "--host", "opencode", "--scope", "project", "--yes", "--json"]);
  assert.deepEqual(action, { kind: "exit", code: 0 });
  const result = await readJson(path);
  assert.equal(result.theme, "keep");
  assert.deepEqual(result.mcp.other, { type: "remote", url: "https://example.test" });
  assert.equal("pi-task-exec" in result.mcp, false);
});

// ---------------------------------------------------------------------------
// Cross-cutting metadata, safety, and doctor
// ---------------------------------------------------------------------------

test("default adapters publish platform, scope, and format metadata", () => {
  const adapters = createDefaultAdapters();
  assert.deepEqual(adapters.map((adapter) => adapter.id), ["codex", "zed", "opencode"]);
  for (const adapter of adapters) {
    assert.deepEqual([...adapter.supportedPlatforms].sort(), ["darwin", "linux", "win32"]);
    assert.deepEqual([...adapter.supportedScopes].sort(), ["global", "project"]);
    assert.ok(["toml", "jsonc"].includes(adapter.configFormat));
    assert.equal(adapter.installSupport({ home: "/h", cwd: "/c", platform: "linux", env: {} }, "global"), undefined);
  }
  assert.equal(adapters[0].configFormat, "toml");
  assert.equal(adapters[1].configFormat, "jsonc");
  assert.equal(adapters[2].configFormat, "jsonc");
});

test("an unlisted platform reports unsupported with a resolved path and writes nothing", async () => {
  const root = await makeRoot();
  const { action, blocks } = await run(root, ["add", "mcp", "--host", "codex", "--scope", "global", "--yes", "--json"], { platform: "freebsd" });
  assert.deepEqual(action, { kind: "exit", code: 1 });
  assert.equal(blocks[0].unsupported[0].code, "mcp_install_unverified");
  assert.equal(blocks[0].hostTarget.platform, "freebsd");
  assert.equal(blocks[0].hostTarget.supported, false);
  assert.equal(blocks[0].hostTarget.support.code, "mcp_install_unverified");
  assert.equal(blocks[0].resolvedPaths.config, join(root, "home", ".codex", "config.toml"));
  assert.equal(await exists(join(root, "home", ".codex", "config.toml")), false);
});

test("adapter writes are atomic and back up a pre-existing config before the first MCP entry", async () => {
  const root = await makeRoot();
  const path = join(root, "project", ".zed", "settings.json");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify({ theme: "keep" }, null, 2));
  const add = await run(root, ["add", "mcp", "--host", "zed", "--scope", "project", "--yes", "--json"]);
  assert.deepEqual(add.action, { kind: "exit", code: 0 });
  assert.equal(add.blocks[1].backups.length, 1);
  const entries = await readdir(dirname(path));
  assert.ok(entries.some((name) => name.includes(".backup-")), "a timestamped backup must exist next to the config");
  const config = JSON.parse(await readFile(path, "utf8"));
  assert.equal(config.theme, "keep");
  assert.equal(config.context_servers["pi-task-exec"].command, "npx");

  // A symlinked config path must be refused by the executor/safety layer.
  const root2 = await makeRoot();
  const outside = join(root2, "outside.json");
  await writeFile(outside, "{}");
  await mkdir(join(root2, "project", ".zed"), { recursive: true });
  await symlink(outside, join(root2, "project", ".zed", "settings.json"));
  const symlinked = await run(root2, ["add", "mcp", "--host", "zed", "--scope", "project", "--yes", "--json"]);
  assert.deepEqual(symlinked.action, { kind: "exit", code: 1 });
  assert.equal(await readFile(outside, "utf8"), "{}");
});

test("doctor reports the resolved path, format, managed status, and trust notes read-only", async () => {
  const root = await makeRoot();
  const added = await run(root, ["add", "mcp", "--host", "codex", "--scope", "project", "--yes", "--json"]);
  assert.deepEqual(added.action, { kind: "exit", code: 0 });
  const { action, blocks, stdout } = await run(root, ["doctor", "--json"]);
  assert.deepEqual(action, { kind: "exit", code: 0 });
  const report = blocks[0];
  const check = report.hosts.find((entry) => entry.id === "host.codex.project");
  assert.ok(check);
  assert.equal(check.status, "pass");
  assert.match(check.detail, /config\.toml/);
  assert.match(check.detail, /toml/);
  assert.match(check.detail, /managed/);
  assert.match(check.detail, /trust/i);
  assert.deepEqual(check.host.path, join(root, "project", ".codex", "config.toml"));
  assert.equal(check.host.format, "toml");
  assert.equal(check.host.key, "mcp_servers.pi-task-exec");
  assert.equal(check.host.platform, "darwin");
  assert.equal(check.host.parseStatus, "ok");
  assert.equal(check.host.managedState, "exact");
  assert.equal(check.host.requiresRestart, true);
  assert.equal(check.host.requiresTrust, true);
  assert.match(check.host.trustNote, /trust/i);
  assert.doesNotMatch(stdout, /\[mcp_servers/);
});

test("doctor reports a malformed config as a warning without leaking contents", async () => {
  const root = await makeRoot();
  const path = join(root, "project", ".zed", "settings.json");
  await mkdir(join(root, "project", ".zed"), { recursive: true });
  await writeFile(path, "SUPERSECRET malformed {");
  const { action, blocks, stdout } = await run(root, ["doctor", "--json"]);
  assert.deepEqual(action, { kind: "exit", code: 0 });
  const check = blocks[0].hosts.find((entry) => entry.id === "host.zed.project");
  assert.equal(check.status, "warn");
  assert.match(check.detail, /not safely parseable/);
  assert.equal(check.host.parseStatus, "unparseable");
  assert.equal(check.host.managedState, "absent");
  assert.doesNotMatch(stdout, /SUPERSECRET/);
});

test("setup --target both installs the MCP entry through the real adapter", async () => {
  const root = await makeRoot();
  const { action, blocks } = await run(root, ["setup", "--target", "mcp", "--host", "opencode", "--scope", "project", "--yes", "--json"]);
  assert.deepEqual(action, { kind: "exit", code: 0 });
  assert.equal(blocks[0].target, "mcp");
  assert.ok(blocks[0].resolvedPaths.config);
  const config = await readJson(join(root, "project", "opencode.json"));
  assert.equal(config.mcp["pi-task-exec"].type, "local");
});

test("test roots isolate writes from the real user home", async () => {
  const root = await makeRoot();
  const { action } = await run(root, ["add", "mcp", "--host", "opencode", "--scope", "global", "--yes", "--json"]);
  assert.deepEqual(action, { kind: "exit", code: 0 });
  assert.ok(await exists(join(root, "home", ".config", "opencode", "opencode.json")));
  // The real user's config is never referenced: every resolved path is rooted
  // under the temp directory created for this test.
  assert.ok(resolve(root).startsWith(tmpdir()));
});

// ---------------------------------------------------------------------------
// Managed fingerprint drift and output contract
// ---------------------------------------------------------------------------

test("checkout --local-dev fingerprint includes the exact absolute path and rejects a different checkout path", async () => {
  const root = await makeRoot();
  const repoA = join(root, "repo-a");
  const repoB = join(root, "repo-b");
  await mkdir(join(repoA, ".git"), { recursive: true });
  await mkdir(join(repoB, ".git"), { recursive: true });

  const addA = await run(root, ["add", "mcp", "--host", "zed", "--scope", "project", "--yes", "--local-dev", "--json"], { packageRoot: repoA });
  assert.deepEqual(addA.action, { kind: "exit", code: 0 });
  const path = join(root, "project", ".zed", "settings.json");
  const written = await readFile(path, "utf8");
  assert.ok(written.includes(join(repoA, "dist", "cli", "index.js")));

  const removeB = await run(root, ["remove", "mcp", "--host", "zed", "--scope", "project", "--yes", "--json"], { packageRoot: repoB });
  assert.deepEqual(removeB.action, { kind: "exit", code: 1 });
  assert.equal(removeB.blocks[0].conflicts[0].code, "mcp_entry_not_managed");
  assert.ok((await readFile(path, "utf8")).includes(join(repoA, "dist", "cli", "index.js")));
});

test("old version and modified Codex entry fields are fingerprint drift for both add and remove", async () => {
  const root = await makeRoot();
  const path = join(root, "home", ".codex", "config.toml");
  await mkdir(join(root, "home", ".codex"), { recursive: true });
  await writeFile(path, '[mcp_servers.pi-task-exec]\ncommand = "npx"\nargs = ["-y", "@zguiyang/pi-task-exec@0.0.1", "mcp", "serve"]\n');
  const old = await run(root, ["add", "mcp", "--host", "codex", "--scope", "global", "--yes", "--json"]);
  assert.deepEqual(old.action, { kind: "exit", code: 1 });
  assert.equal(old.blocks[0].conflicts[0].code, "mcp_entry_conflict");
  assert.match(await readFile(path, "utf8"), /@0\.0\.1/);
  const oldRemove = await run(root, ["remove", "mcp", "--host", "codex", "--scope", "global", "--yes", "--json"]);
  assert.deepEqual(oldRemove.action, { kind: "exit", code: 1 });
  assert.equal(oldRemove.blocks[0].conflicts[0].code, "mcp_entry_not_managed");
  assert.match(await readFile(path, "utf8"), /@0\.0\.1/);

  const root2 = await makeRoot();
  const path2 = join(root2, "home", ".codex", "config.toml");
  await mkdir(join(root2, "home", ".codex"), { recursive: true });
  await writeFile(path2, `[mcp_servers.pi-task-exec]\ncommand = "npx"\nargs = ["-y", "@zguiyang/pi-task-exec@${VERSION}", "mcp", "serve"]\nenv = { TOKEN = "x" }\n`);
  const extra = await run(root2, ["add", "mcp", "--host", "codex", "--scope", "global", "--yes", "--json"]);
  assert.deepEqual(extra.action, { kind: "exit", code: 1 });
  assert.equal(extra.blocks[0].conflicts[0].code, "mcp_entry_conflict");
  assert.match(await readFile(path2, "utf8"), /TOKEN = "x"/);
});

test("plan JSON exposes launch mode, platform, format, modified key, support, backup strategy, restart and trust", async () => {
  const root = await makeRoot();
  const { action, blocks } = await run(root, ["add", "mcp", "--host", "codex", "--scope", "project", "--dry-run", "--json"]);
  assert.deepEqual(action, { kind: "exit", code: 0 });
  const plan = blocks[0];
  assert.equal(plan.launchMode, "npm");
  assert.equal(plan.backupStrategy, "none");
  assert.equal(plan.resolvedPaths.config, join(root, "project", ".codex", "config.toml"));
  assert.equal(plan.hostTarget.host, "codex");
  assert.equal(plan.hostTarget.displayName, "Codex");
  assert.equal(plan.hostTarget.scope, "project");
  assert.equal(plan.hostTarget.platform, "darwin");
  assert.equal(plan.hostTarget.format, "toml");
  assert.equal(plan.hostTarget.key, "mcp_servers.pi-task-exec");
  assert.equal(plan.hostTarget.path, join(root, "project", ".codex", "config.toml"));
  assert.equal(plan.hostTarget.supported, true);
  assert.equal(plan.hostTarget.support, null);
  assert.equal(plan.hostTarget.requiresRestart, true);
  assert.equal(plan.hostTarget.requiresTrust, true);
  assert.match(plan.hostTarget.trustNote, /trust/i);
});

test("text plan shows actionable host details without dumping internal or empty fields", async () => {
  const root = await makeRoot();
  const { stdout } = await run(root, ["add", "mcp", "--host", "zed", "--scope", "global", "--dry-run"]);
  assert.match(stdout, /Add MCP · Zed · global/);
  assert.match(stdout, /Create .*settings\.json/);
  assert.match(stdout, /Preview complete\. No files changed\./);
  assert.doesNotMatch(stdout, /Launch mode:|Host target:|Backup strategy:|Restart required:|Trust required:|Platform:|Config format:|Config key:|\(none\)|plan\.v1/);
});

test("plan reports the timestamped-sibling backup strategy when an existing config will be changed", async () => {
  const root = await makeRoot();
  const path = join(root, "project", "opencode.json");
  await mkdir(join(root, "project"), { recursive: true });
  await writeFile(path, JSON.stringify({ theme: "keep" }, null, 2));
  const { blocks } = await run(root, ["add", "mcp", "--host", "opencode", "--scope", "project", "--dry-run", "--json"]);
  assert.equal(blocks[0].backupStrategy, "timestamped-sibling");
  assert.equal(blocks[0].backups.length, 1);
});

test("absolute CODEX_HOME and OPENCODE_CONFIG overrides outside default roots are allowed, not path_escape", async () => {
  const root = await makeRoot();
  const externalCodex = await mkdtemp(join(tmpdir(), "pi-task-exec-codex-home-"));
  const codex = await run(root, ["add", "mcp", "--host", "codex", "--scope", "global", "--yes", "--json"], { env: { CODEX_HOME: externalCodex } });
  assert.deepEqual(codex.action, { kind: "exit", code: 0 });
  assert.ok(await exists(join(externalCodex, "config.toml")));
  assert.equal(codex.blocks[0].hostTarget.path, join(externalCodex, "config.toml"));
  assert.doesNotMatch(codex.stdout, /path_escape/);

  const root2 = await makeRoot();
  const externalDir = await mkdtemp(join(tmpdir(), "pi-task-exec-opencode-"));
  const customFile = join(externalDir, "custom.jsonc");
  const opencode = await run(root2, ["add", "mcp", "--host", "opencode", "--scope", "global", "--yes", "--json"], { env: { OPENCODE_CONFIG: customFile } });
  assert.deepEqual(opencode.action, { kind: "exit", code: 0 });
  assert.ok(await exists(customFile));
  assert.doesNotMatch(opencode.stdout, /path_escape/);
});

test("doctor host metadata reports parse status, fingerprint drift, restart and trust", async () => {
  const root = await makeRoot();
  const path = join(root, "project", ".codex", "config.toml");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `[mcp_servers.pi-task-exec]\ncommand = "npx"\nargs = ["-y", "@zguiyang/pi-task-exec@0.0.9", "mcp", "serve"]\n`);
  const { action, blocks } = await run(root, ["doctor", "--json"]);
  assert.deepEqual(action, { kind: "exit", code: 0 });
  const drift = blocks[0].hosts.find((entry) => entry.id === "host.codex.project");
  assert.equal(drift.host.parseStatus, "ok");
  assert.equal(drift.host.managedState, "drift");
  assert.equal(drift.host.requiresRestart, true);
  assert.equal(drift.host.requiresTrust, true);
  assert.equal(drift.host.key, "mcp_servers.pi-task-exec");
  assert.equal(drift.host.path, path);

  const absent = blocks[0].hosts.find((entry) => entry.id === "host.zed.project");
  assert.equal(absent.host.parseStatus, "absent");
  assert.equal(absent.host.managedState, "absent");
});

// ---------------------------------------------------------------------------
// Platform path resolution and unpublished-checkout protection
// ---------------------------------------------------------------------------

test("Zed resolves macOS/Linux ~/.config and Windows %APPDATA% settings paths", () => {
  const zed = createDefaultAdapters().find((adapter) => adapter.id === "zed");
  const mac = { home: "/Users/me", cwd: "/work/project", platform: "darwin", env: {} };
  assert.equal(zed.resolveConfigPath(mac, "global"), "/Users/me/.config/zed/settings.json");

  const linux = { home: "/home/me", cwd: "/work/project", platform: "linux", env: {} };
  assert.equal(zed.resolveConfigPath(linux, "global"), "/home/me/.config/zed/settings.json");
  const linuxXdg = { home: "/home/me", cwd: "/work/project", platform: "linux", env: { XDG_CONFIG_HOME: "/home/me/.config-custom" } };
  assert.equal(zed.resolveConfigPath(linuxXdg, "global"), "/home/me/.config-custom/zed/settings.json");
  assert.deepEqual([...zed.additionalRoots(linuxXdg, "global")], ["/home/me/.config-custom"]);

  const win = { home: "C:\\Users\\me", cwd: "C:\\work\\project", platform: "win32", env: { APPDATA: "C:\\Users\\me\\AppData\\Roaming" } };
  assert.equal(zed.resolveConfigPath(win, "global"), "C:\\Users\\me\\AppData\\Roaming\\Zed\\settings.json");
  assert.deepEqual([...zed.additionalRoots(win, "global")], ["C:\\Users\\me\\AppData\\Roaming"]);
  assert.equal(zed.resolveConfigPath(win, "project"), "C:\\work\\project\\.zed\\settings.json");

  const target = zed.describe(win, "global", "add");
  assert.equal(target.host, "zed");
  assert.equal(target.platform, "win32");
  assert.equal(target.format, "jsonc");
  assert.equal(target.key, "context_servers.pi-task-exec");
  assert.equal(target.path, "C:\\Users\\me\\AppData\\Roaming\\Zed\\settings.json");
  assert.equal(target.requiresTrust, false);

  const winFallback = { home: "C:\\Users\\me", cwd: "C:\\work", platform: "win32", env: {} };
  assert.equal(zed.resolveConfigPath(winFallback, "global"), "C:\\Users\\me\\AppData\\Roaming\\Zed\\settings.json");
});

test("OpenCode ignores the non-documented config.json candidate", async () => {
  const root = await makeRoot();
  const directory = join(root, "home", ".config", "opencode");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "config.json"), JSON.stringify({ theme: "legacy" }));
  const { action, blocks } = await run(root, ["add", "mcp", "--host", "opencode", "--scope", "global", "--dry-run", "--json"]);
  assert.deepEqual(action, { kind: "exit", code: 0 });
  assert.equal(blocks[0].resolvedPaths.config, join(directory, "opencode.json"));
});

test("a .git checkout cannot be overridden to npm mode; --local-dev is the only local route", async () => {
  const root = await makeRoot();
  const repo = join(root, "repo");
  await mkdir(join(repo, ".git"), { recursive: true });
  assert.equal(detectLaunchMode(repo, { PI_TASK_EXEC_LAUNCH_MODE: "npm" }), "checkout");
  const spec = resolveLaunchSpec({ packageRoot: repo, packageVersion: VERSION, env: { PI_TASK_EXEC_LAUNCH_MODE: "npm" }, mode: "npm" });
  assert.equal(spec.mode, "checkout");
  assert.equal(spec.launch.command, "node");
  assert.ok(spec.launch.args[0].includes(join(repo, "dist", "cli", "index.js")));

  const blocked = await run(root, ["add", "mcp", "--host", "codex", "--scope", "global", "--yes", "--json"], { packageRoot: repo, env: { PI_TASK_EXEC_LAUNCH_MODE: "npm" } });
  assert.deepEqual(blocked.action, { kind: "exit", code: 1 });
  assert.equal(blocked.blocks[0].launchMode, "checkout");
  assert.equal(blocked.blocks[0].conflicts[0].code, "local_dev_required");
  assert.equal(await exists(join(root, "home", ".codex", "config.toml")), false);

  const allowed = await run(root, ["add", "mcp", "--host", "codex", "--scope", "global", "--yes", "--local-dev", "--json"], { packageRoot: repo, env: { PI_TASK_EXEC_LAUNCH_MODE: "npm" } });
  assert.deepEqual(allowed.action, { kind: "exit", code: 0 });
  assert.match(await readFile(join(root, "home", ".codex", "config.toml"), "utf8"), /command = "node"/);
});

test("Codex resolves Windows project and global paths with win32 semantics", () => {
  const codex = createDefaultAdapters().find((adapter) => adapter.id === "codex");
  const win = { home: "C:\\Users\\me", cwd: "C:\\work\\project", platform: "win32", env: { CODEX_HOME: "D:\\codex-home" } };
  assert.equal(codex.resolveConfigPath(win, "project"), "C:\\work\\project\\.codex\\config.toml");
  assert.equal(codex.resolveConfigPath(win, "global"), "D:\\codex-home\\config.toml");
  assert.deepEqual([...codex.additionalRoots(win, "global")], ["D:\\codex-home"]);

  const fallback = { home: "C:\\Users\\me", cwd: "C:\\work\\project", platform: "win32", env: {} };
  assert.equal(codex.resolveConfigPath(fallback, "global"), "C:\\Users\\me\\.codex\\config.toml");

  const target = codex.describe(win, "global", "add");
  assert.equal(target.platform, "win32");
  assert.equal(target.format, "toml");
  assert.equal(target.key, "mcp_servers.pi-task-exec");
  assert.equal(target.path, "D:\\codex-home\\config.toml");
});

test("OpenCode resolves Windows drive and UNC config overrides with win32 semantics", () => {
  const opencode = createDefaultAdapters().find((adapter) => adapter.id === "opencode");

  const drive = { home: "C:\\Users\\me", cwd: "C:\\work\\project", platform: "win32", env: { OPENCODE_CONFIG: "D:\\configs\\custom.jsonc" } };
  assert.equal(opencode.resolveConfigPath(drive, "global"), "D:\\configs\\custom.jsonc");
  assert.deepEqual([...opencode.additionalRoots(drive, "global")], ["D:\\configs"]);

  const unc = { home: "C:\\Users\\me", cwd: "C:\\work\\project", platform: "win32", env: { OPENCODE_CONFIG: "\\\\server\\share\\opencode.json" } };
  assert.equal(opencode.resolveConfigPath(unc, "global"), "\\\\server\\share\\opencode.json");
  assert.deepEqual([...opencode.additionalRoots(unc, "global")], ["\\\\server\\share\\"]);

  const dir = { home: "C:\\Users\\me", cwd: "C:\\work\\project", platform: "win32", env: { OPENCODE_CONFIG_DIR: "E:\\opencode" } };
  assert.equal(opencode.resolveConfigPath(dir, "global"), "E:\\opencode\\opencode.json");
  assert.deepEqual([...opencode.additionalRoots(dir, "global")], ["E:\\opencode"]);

  const project = { home: "C:\\Users\\me", cwd: "C:\\work\\project", platform: "win32", env: {} };
  assert.equal(opencode.resolveConfigPath(project, "project"), "C:\\work\\project\\opencode.json");
});

test("OpenCode additionalRoots includes absolute XDG_CONFIG_HOME when the global path uses it", () => {
  const opencode = createDefaultAdapters().find((adapter) => adapter.id === "opencode");

  const linux = { home: "/home/me", cwd: "/work/project", platform: "linux", env: { XDG_CONFIG_HOME: "/custom/xdg" } };
  assert.equal(opencode.resolveConfigPath(linux, "global"), "/custom/xdg/opencode/opencode.json");
  assert.deepEqual([...opencode.additionalRoots(linux, "global")], ["/custom/xdg"]);

  const win = { home: "C:\\Users\\me", cwd: "C:\\work", platform: "win32", env: { XDG_CONFIG_HOME: "D:\\xdg" } };
  assert.equal(opencode.resolveConfigPath(win, "global"), "D:\\xdg\\opencode\\opencode.json");
  assert.deepEqual([...opencode.additionalRoots(win, "global")], ["D:\\xdg"]);

  // An explicit config directory means XDG_CONFIG_HOME is not the global path.
  const custom = { home: "/home/me", cwd: "/work", platform: "linux", env: { XDG_CONFIG_HOME: "/custom/xdg", OPENCODE_CONFIG_DIR: "/other" } };
  assert.equal(opencode.resolveConfigPath(custom, "global"), "/other/opencode.json");
  assert.deepEqual([...opencode.additionalRoots(custom, "global")], ["/other"]);
});
