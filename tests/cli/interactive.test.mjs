import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PassThrough, Writable } from "node:stream";
import { afterEach, default as test } from "node:test";
import { VERSION } from "../../dist/cli/identity.js";
import { runCli } from "../../dist/cli/commands/index.js";
import { createDefaultAdapters } from "../../dist/cli/hosts/adapters.js";
import { executePlan } from "../../dist/cli/plan/executor.js";
import { SkillsCliInstaller, SKILL_DEV_REF, SKILL_EXPECTED_SOURCE } from "../../dist/cli/installers/skills-cli.js";
import { createArrowInteraction } from "../../dist/cli/interactive.js";

const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const temporaryRoots = [];

async function makeRoot() {
  const root = await mkdtemp(join(tmpdir(), "pi-task-exec-interactive-"));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

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

/** Injectable interaction with scripted answers; records every prompt. */
function scriptedInteraction({ selects = [], confirms = [] } = {}) {
  const calls = [];
  let selectIndex = 0;
  let confirmIndex = 0;
  return {
    calls,
    async select(question, choices, defaultValue) {
      calls.push({ type: "select", question, values: choices.map((choice) => choice.value), defaultValue });
      if (selectIndex >= selects.length) return defaultValue ?? null;
      return selects[selectIndex++];
    },
    async confirm(question, defaultValue) {
      calls.push({ type: "confirm", question, defaultValue });
      if (confirmIndex >= confirms.length) return false;
      return confirms[confirmIndex++];
    },
  };
}

function skillPathsFor(root, scope) {
  if (scope === "project") {
    return {
      installDir: join(root, "project", ".agents", "skills", "pi-delegate"),
      lockFile: join(root, "project", "skills-lock.json"),
    };
  }
  return {
    installDir: join(root, "home", ".agents", "skills", "pi-delegate"),
    lockFile: join(root, "home", ".agents", ".skill-lock.json"),
  };
}

/** Fake Skills CLI that writes real files/lock/JSON unless told otherwise. */
function makeSkillSpawn({ installDir, lockFile, scope, behavior = "ok" }) {
  const calls = [];
  const spawn = async (command, args, options) => {
    calls.push({ command, args, options });
    if (behavior === "nonzero") return { code: 1, stdout: "", stderr: "git clone failed" };
    await mkdir(join(installDir, "references"), { recursive: true });
    await writeFile(join(installDir, "SKILL.md"), await readFile(join(repoRoot, "skills/pi-delegate/SKILL.md")));
    await writeFile(join(installDir, "references/mcp-contract.md"), await readFile(join(repoRoot, "skills/pi-delegate/references/mcp-contract.md")));
    const entry = { source: SKILL_EXPECTED_SOURCE, ref: SKILL_DEV_REF, sourceType: "github", skillPath: "skills/pi-delegate/SKILL.md" };
    const lock = scope === "global" ? { version: 3, skills: { "pi-delegate": entry }, dismissed: {} } : { version: 1, skills: { "pi-delegate": entry } };
    await mkdir(dirname(lockFile), { recursive: true });
    await writeFile(lockFile, `${JSON.stringify(lock, null, 2)}\n`);
    const json = [{ name: "pi-delegate", status: "installed", source: SKILL_EXPECTED_SOURCE, ref: SKILL_DEV_REF, path: installDir, scope, mode: "copy" }];
    return { code: 0, stdout: `${JSON.stringify(json, null, 2)}\n`, stderr: "" };
  };
  return { spawn, calls };
}

function makeDeps(root, overrides = {}) {
  const captured = capture();
  const deps = {
    io: captured.io,
    env: overrides.env ?? {},
    cwd: join(root, "project"),
    home: join(root, "home"),
    platform: "darwin",
    packageRoot: repoRoot,
    packageVersion: VERSION,
    adapters: createDefaultAdapters(),
    skillInstaller: overrides.skillInstaller ?? new SkillsCliInstaller({ platform: "darwin" }),
    now: () => new Date("2026-10-09T00:00:00.000Z"),
    spawn: async () => ({ code: 0, stdout: "v1.0.0\n", stderr: "" }),
    roots: [root],
    launchMode: "npm",
    ...overrides,
  };
  return { deps, captured };
}

const exists = async (path) => { try { await stat(path); return true; } catch { return false; } };

async function chooseWithArrowKey(choices, defaultValue, keypresses, confirm = false) {
  const input = new PassThrough();
  const outputChunks = [];
  const interaction = createArrowInteraction({
    input,
    output: new Writable({ write(chunk, _encoding, callback) { outputChunks.push(String(chunk)); callback(); } }),
  });
  const selection = confirm
    ? interaction.confirm("Continue?", defaultValue)
    : interaction.select("Choose", choices, defaultValue);
  input.write(keypresses);
  const value = await selection;
  input.destroy();
  return { value, output: outputChunks.join("") };
}

test("arrow keys change Agent, Scope, and Yes/No selections", async () => {
  const agents = await chooseWithArrowKey(
    [{ value: "codex", label: "Codex" }, { value: "zed", label: "Zed" }, { value: "opencode", label: "OpenCode" }],
    "codex",
    "\u001b[B\r",
  );
  assert.equal(agents.value, "zed", "Down + Enter selects the next Agent");

  const scopes = await chooseWithArrowKey(
    [{ value: "project", label: "Project" }, { value: "global", label: "Global" }],
    "project",
    "\u001b[B\r",
  );
  assert.equal(scopes.value, "global", "Down + Enter selects the next Scope");

  const confirmation = await chooseWithArrowKey([], false, "\u001b[B\r", true);
  assert.equal(confirmation.value, true, "Yes/No starts at the safe No default and requires moving to Yes");
});

// ---------------------------------------------------------------------------
// --json never prompts
// ---------------------------------------------------------------------------

test("setup/add --json with missing selections fails without prompting", async () => {
  for (const args of [["setup", "--json"], ["add", "mcp", "--json"], ["add", "skill", "--json"]]) {
    const root = await makeRoot();
    const interaction = scriptedInteraction({ selects: ["codex", "project"], confirms: [true] });
    const { deps, captured } = makeDeps(root, { interaction });
    const action = await runCli(args, deps);
    assert.deepEqual(action, { kind: "exit", code: 1 }, args.join(" "));
    assert.equal(interaction.calls.length, 0, `${args.join(" ")} must not prompt in --json mode`);
    assert.match(captured.stdout(), /missing_(host|scope)/);
    assert.equal(await exists(join(root, "project", ".codex", "config.toml")), false);
  }
});

test("real setup --json with no interaction defaults --target to both and fails for missing host", async () => {
  const root = await makeRoot();
  const { deps, captured } = makeDeps(root);
  const action = await runCli(["setup", "--json"], deps);
  assert.deepEqual(action, { kind: "exit", code: 1 });
  assert.deepEqual(JSON.parse(captured.stdout()), {
    error: { code: "missing_host", message: "setup requires an explicit --host codex|zed|opencode." },
  });
  assert.equal(await exists(join(root, "project", ".codex", "config.toml")), false);
});

test("real setup --json with an explicit agent fails for missing scope, never for target", async () => {
  const root = await makeRoot();
  const { deps, captured } = makeDeps(root);
  const action = await runCli(["setup", "--json", "--host", "codex"], deps);
  assert.deepEqual(action, { kind: "exit", code: 1 });
  assert.deepEqual(JSON.parse(captured.stdout()), {
    error: { code: "missing_scope", message: "setup requires an explicit --scope project|global." },
  });
});

test("non-interactive setup/add keep the missing-selection errors", async () => {
  for (const args of [["setup"], ["add", "mcp"], ["add", "skill"]]) {
    const { deps, captured } = makeDeps(await makeRoot());
    const action = await runCli(args, deps);
    assert.deepEqual(action, { kind: "exit", code: 1 }, args.join(" "));
    assert.match(captured.stderr(), /requires|missing/);
  }
});

// ---------------------------------------------------------------------------
// Injectable arrow-key flow per command
// ---------------------------------------------------------------------------

test("add mcp prompts for Agent and Scope and installs only the MCP entry", async () => {
  const root = await makeRoot();
  const interaction = scriptedInteraction({ selects: ["codex", "project"], confirms: [true] });
  const { deps, captured } = makeDeps(root, { interaction });
  const action = await runCli(["add", "mcp", "--local-dev"], deps);
  assert.deepEqual(action, { kind: "exit", code: 0 });
  assert.deepEqual(interaction.calls.map((call) => call.type), ["select", "select", "confirm"]);
  assert.deepEqual(interaction.calls[0].values, ["codex", "zed", "opencode"]);
  assert.deepEqual(interaction.calls[1].values, ["project", "global"]);
  assert.ok(await exists(join(root, "project", ".codex", "config.toml")));
  assert.equal(await exists(join(root, "project", ".agents", "skills", "pi-delegate")), false);
  assert.match(captured.stdout(), /Done\./);
});

test("interactive MCP removal selects targets and confirms before changing only its entry", async () => {
  for (const approval of [false, true]) {
    const root = await makeRoot();
    const config = join(root, "project", "opencode.json");
    await mkdir(dirname(config), { recursive: true });
    await writeFile(config, JSON.stringify({ theme: "keep" }));
    const initial = makeDeps(root);
    await runCli(["add", "mcp", "--host", "opencode", "--scope", "project", "--local-dev", "--yes"], initial.deps);
    const before = await readFile(config, "utf8");
    const interaction = scriptedInteraction({ selects: ["opencode", "project"], confirms: [approval] });
    const { deps, captured } = makeDeps(root, { interaction });
    const action = await runCli(["remove", "mcp"], deps);
    assert.equal(action.code, 0);
    assert.deepEqual(interaction.calls.map(call => call.type), ["select", "select", "confirm"]);
    assert.equal(interaction.calls[2].defaultValue, false);
    assert.match(captured.stdout(), /Remove MCP · OpenCode · project/);
    const after = await readFile(config, "utf8");
    if (!approval) assert.equal(after, before);
    else {
      assert.equal(JSON.parse(after).theme, "keep");
      assert.equal(JSON.parse(after).mcp?.["pi-task-exec"], undefined);
    }
  }
});

test("JSON MCP removal with missing targets never prompts", async () => {
  const root = await makeRoot();
  const interaction = scriptedInteraction();
  const { deps, captured } = makeDeps(root, { interaction });
  const action = await runCli(["remove", "mcp", "--json"], deps);
  assert.equal(action.code, 1);
  assert.equal(interaction.calls.length, 0);
  assert.equal(jsonBlocks(captured.stdout())[0].error.code, "missing_host");
});

test("add skill prompts for Agent and Scope and installs only the Skill", async () => {
  const root = await makeRoot();
  const target = skillPathsFor(root, "project");
  const { spawn, calls } = makeSkillSpawn({ ...target, scope: "project" });
  const interaction = scriptedInteraction({ selects: ["zed", "project"], confirms: [true] });
  const { deps } = makeDeps(root, { interaction, skillSpawn: spawn });
  const action = await runCli(["add", "skill"], deps);
  assert.deepEqual(action, { kind: "exit", code: 0 });
  assert.equal(calls.length, 1);
  assert.ok(calls[0].args.includes("--agent") && calls[0].args.includes("zed"));
  assert.ok(await exists(join(target.installDir, "SKILL.md")));
  assert.equal(await exists(join(root, "project", ".codex", "config.toml")), false);
});

test("setup no-target prompts only for Agent and Scope, then confirms", async () => {
  const root = await makeRoot();
  const target = skillPathsFor(root, "project");
  const { spawn, calls } = makeSkillSpawn({ ...target, scope: "project" });
  const interaction = scriptedInteraction({ selects: ["codex", "project"], confirms: [true] });
  const { deps, captured } = makeDeps(root, { interaction, skillSpawn: spawn });
  const action = await runCli(["setup", "--local-dev"], deps);
  assert.deepEqual(action, { kind: "exit", code: 0 });
  assert.deepEqual(interaction.calls.map((call) => call.type), ["select", "select", "confirm"]);
  assert.ok(captured.stdout().startsWith("Pi TaskExec Setup\n"));
  assert.deepEqual(interaction.calls[0].values, ["codex", "zed", "opencode"], "first prompt is the Agent");
  assert.deepEqual(interaction.calls[1].values, ["project", "global"], "second prompt is the Scope");
  assert.ok(await exists(join(root, "project", ".codex", "config.toml")));
  assert.ok(await exists(join(target.installDir, "SKILL.md")));
  assert.equal(calls.length, 1);
  assert.match(captured.stdout(), /Done\./);
  assert.doesNotMatch(captured.stdout(), /Parts:|Execution:/);
  assert.doesNotMatch(captured.stdout(), /mcp: success|skill: success/);
});

test("cancelling a prompt exits 0 with no side effects", async () => {
  const root = await makeRoot();
  const target = skillPathsFor(root, "project");
  const { spawn, calls } = makeSkillSpawn({ ...target, scope: "project" });
  const interaction = scriptedInteraction({ selects: [null], confirms: [true] });
  const { deps, captured } = makeDeps(root, { interaction, skillSpawn: spawn });
  const action = await runCli(["setup", "--local-dev"], deps);
  assert.deepEqual(action, { kind: "exit", code: 0 });
  assert.match(captured.stdout(), /Cancelled(?:\.|:) (?:No files changed|no changes were made)\./);
  assert.equal(calls.length, 0);
  assert.equal(await exists(join(root, "project", ".codex", "config.toml")), false);
  assert.equal(await exists(target.installDir), false);
});

test("answering No to the plan confirmation exits 0 with no side effects", async () => {
  const root = await makeRoot();
  const target = skillPathsFor(root, "project");
  const { spawn, calls } = makeSkillSpawn({ ...target, scope: "project" });
  const interaction = scriptedInteraction({ confirms: [false] });
  const { deps, captured } = makeDeps(root, { interaction, skillSpawn: spawn });
  const action = await runCli(["setup", "--local-dev", "--host", "codex", "--scope", "project"], deps);
  assert.deepEqual(action, { kind: "exit", code: 0 });
  assert.match(captured.stdout(), /Cancelled(?:\.|:) (?:No files changed|no changes were made)\./);
  assert.equal(calls.length, 0);
  assert.equal(await exists(join(root, "project", ".codex", "config.toml")), false);
  assert.equal(await exists(target.installDir), false);
});

test("pre-supplied --host/--scope skip the Agent/Scope prompts", async () => {
  const root = await makeRoot();
  const target = skillPathsFor(root, "project");
  const { spawn } = makeSkillSpawn({ ...target, scope: "project" });
  const interaction = scriptedInteraction({ confirms: [true] });
  const { deps, captured } = makeDeps(root, { interaction, skillSpawn: spawn });
  const action = await runCli(["setup", "--local-dev", "--host", "codex", "--scope", "project"], deps);
  assert.deepEqual(action, { kind: "exit", code: 0 });
  assert.deepEqual(interaction.calls.map((call) => call.type), ["confirm"]);
  assert.ok(await exists(join(root, "project", ".codex", "config.toml")));
  assert.ok(await exists(join(target.installDir, "SKILL.md")));
  assert.doesNotMatch(captured.stdout(), /Parts:|Execution:/);
});

// ---------------------------------------------------------------------------
// Unified setup: one plan, independent MCP + Skill results
// ---------------------------------------------------------------------------

test("unified setup builds one plan with MCP and Skill and preserves both successes", async () => {
  const root = await makeRoot();
  const target = skillPathsFor(root, "project");
  const { spawn, calls } = makeSkillSpawn({ ...target, scope: "project" });
  // An injected interaction makes parsing interactive; --json then defaults a
  // missing --target to the unified MCP + Skill plan without prompting.
  const interaction = scriptedInteraction();
  const { deps, captured } = makeDeps(root, { skillSpawn: spawn, interaction });
  const action = await runCli([
    "setup", "--json", "--yes", "--local-dev",
    "--host", "codex", "--scope", "project",
  ], deps);
  assert.deepEqual(action, { kind: "exit", code: 0 });
  assert.equal(interaction.calls.length, 0, "--json must not prompt");
  const [plan, execution] = jsonBlocks(captured.stdout());
  assert.equal(plan.operation, "setup");
  assert.equal(plan.target, "both");
  assert.ok(plan.resolvedPaths.config, "plan carries the MCP config path");
  assert.ok(plan.skillCli, "plan carries the Skills CLI install");
  assert.deepEqual(execution.parts.map((part) => [part.target, part.status]), [["mcp", "success"], ["skill", "success"]]);
  assert.equal(execution.status, "success");
  assert.equal(calls.length, 1, "the Skills CLI runs exactly once");
  assert.ok(await exists(join(root, "project", ".codex", "config.toml")));
  assert.ok(await exists(join(target.installDir, "SKILL.md")));
  assert.ok(await exists(target.lockFile));
});

test("unified setup reports a partial result and keeps the successful MCP write when the Skill CLI fails", async () => {
  const root = await makeRoot();
  const target = skillPathsFor(root, "project");
  const failingSpawn = makeSkillSpawn({ ...target, scope: "project", behavior: "nonzero" }).spawn;
  const { deps, captured } = makeDeps(root, { skillSpawn: failingSpawn });
  const action = await runCli([
    "setup", "--json", "--yes", "--local-dev", "--target", "both",
    "--host", "codex", "--scope", "project",
  ], deps);
  assert.deepEqual(action, { kind: "exit", code: 1 }, "a partial failure is a non-zero exit");
  const [, execution] = jsonBlocks(captured.stdout());
  assert.equal(execution.status, "partial");
  assert.deepEqual(execution.parts.map((part) => [part.target, part.status]), [["mcp", "success"], ["skill", "failed"]]);
  assert.ok(await exists(join(root, "project", ".codex", "config.toml")), "the MCP mutation survives the Skill failure");
  assert.equal(await exists(join(target.installDir, "SKILL.md")), false);
});

test("unified setup reports the MCP no-op next to a failed Skill when MCP is already configured", async () => {
  const root = await makeRoot();
  const target = skillPathsFor(root, "project");
  // Configure the MCP entry first so the unified setup plans no MCP writes.
  const first = makeDeps(root);
  const configured = await runCli([
    "add", "mcp", "--json", "--yes", "--local-dev",
    "--host", "codex", "--scope", "project",
  ], first.deps);
  assert.deepEqual(configured, { kind: "exit", code: 0 });

  const failingSpawn = makeSkillSpawn({ ...target, scope: "project", behavior: "nonzero" }).spawn;
  const { deps, captured } = makeDeps(root, { skillSpawn: failingSpawn });
  const action = await runCli([
    "setup", "--json", "--yes", "--local-dev", "--target", "both",
    "--host", "codex", "--scope", "project",
  ], deps);
  assert.deepEqual(action, { kind: "exit", code: 1 });
  const [plan, execution] = jsonBlocks(captured.stdout());
  assert.equal(plan.creates.length + plan.updates.length, 0, "the MCP entry is already configured");
  assert.ok(plan.warnings.some((warning) => warning.code === "already_configured"));
  assert.ok(plan.skillCli);
  assert.equal(execution.status, "partial");
  assert.deepEqual(execution.parts.map((part) => [part.target, part.status]), [["mcp", "no-op"], ["skill", "failed"]]);
  assert.ok(await exists(join(root, "project", ".codex", "config.toml")), "the existing MCP entry is preserved");
});

test("unified setup dry-run prints the combined plan and performs no writes or spawns", async () => {
  const root = await makeRoot();
  const target = skillPathsFor(root, "project");
  const { spawn, calls } = makeSkillSpawn({ ...target, scope: "project" });
  const { deps, captured } = makeDeps(root, { skillSpawn: spawn });
  const action = await runCli([
    "setup", "--json", "--dry-run", "--local-dev", "--target", "both",
    "--host", "codex", "--scope", "project",
  ], deps);
  assert.deepEqual(action, { kind: "exit", code: 0 });
  const [plan, execution] = jsonBlocks(captured.stdout());
  assert.ok(plan.skillCli);
  assert.equal(execution.status, "dry-run");
  assert.equal(calls.length, 0);
  assert.equal(await exists(join(root, "project", ".codex", "config.toml")), false);
  assert.equal(await exists(target.installDir), false);
});

test("the executor treats an empty plan as a no-op", async () => {
  const root = await makeRoot();
  const plan = {
    schema: "pi-task-exec.plan.v1",
    operation: "add",
    target: "mcp",
    dryRun: false,
    createdAt: "2026-10-09T00:00:00.000Z",
    resolvedPaths: {},
    creates: [],
    updates: [],
    removals: [],
    conflicts: [],
    backups: [],
    warnings: [],
    unsupported: [],
    supported: true,
  };
  const result = await executePlan(plan, { roots: [root], adapters: [], io: { stdout() {}, stderr() {} }, yes: true });
  assert.equal(result.status, "no-op");
  assert.deepEqual(result.parts, []);
});

test("prompt stream failures restore raw mode and become a nonzero CLI error", async () => {
  const input = new PassThrough();
  const rawStates = [];
  input.isRaw = true;
  input.setRawMode = (value) => { input.isRaw = value; rawStates.push(value); };
  const output = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  const interaction = createArrowInteraction({ input, output });
  const { deps, captured } = makeDeps(await makeRoot(), { interaction });
  const action = runCli(["setup"], deps);
  setImmediate(() => input.emit("error", new Error("terminal disconnected")));
  assert.equal((await action).code, 1);
  assert.equal(input.isRaw, true);
  assert.match(captured.stderr(), /Interactive prompt failed: terminal disconnected/);
  assert.equal(input.listenerCount("keypress"), 0);
  assert.equal(input.listenerCount("error"), 0);
  input.destroy();
  output.destroy();
});

test("JSON with explicit selections never invokes terminal prompts without --yes", async () => {
  const interaction = scriptedInteraction({ confirms: [true] });
  const { deps, captured } = makeDeps(await makeRoot(), { interaction });
  const action = await runCli(["add", "mcp", "--host", "codex", "--scope", "project", "--local-dev", "--json"], deps);
  assert.equal(action.code, 1);
  assert.equal(interaction.calls.length, 0);
  assert.equal(jsonBlocks(captured.stdout()).at(-1).status, "cancelled");
  assert.doesNotMatch(captured.stdout(), /Cancelled: no changes/);
});

test("zero-width terminals fail before entering raw mode", async () => {
  const input = new PassThrough();
  let rawCalls = 0;
  input.setRawMode = () => { rawCalls++; };
  const output = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  output.isTTY = true;
  output.columns = 0;
  await assert.rejects(createArrowInteraction({ input, output }).select("Choose", [{ value: "a", label: "A" }]), /nonzero width/);
  assert.equal(rawCalls, 0);
  input.destroy(); output.destroy();
});
