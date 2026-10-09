import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, default as test } from "node:test";
import { VERSION } from "../../dist/cli/identity.js";
import { parseCli, runCli } from "../../dist/cli/commands/index.js";
import { createDefaultAdapters } from "../../dist/cli/hosts/adapters.js";
import { executePlan } from "../../dist/cli/plan/executor.js";
import { generatePlan } from "../../dist/cli/plan/model.js";
import {
  SKILL_DEV_REF,
  SKILL_EXPECTED_SOURCE,
  SKILL_REPOSITORY,
  SKILL_SUBPATH,
  SkillsCliInstaller,
  detectSkillUpdate,
  readSkillLockRecord,
} from "../../dist/cli/installers/skills-cli.js";

const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const temporaryRoots = [];
const targetRef = `v${VERSION}`;

async function makeRoot() {
  const root = await mkdtemp(join(tmpdir(), "pi-task-exec-update-"));
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

/** A non-git package root carrying the bundled Skill bytes, so npm/release mode is exercised. */
async function makePackageRoot(base, { git = false } = {}) {
  const pkg = join(base, "pkg");
  await mkdir(join(pkg, "skills", "pi-delegate", "references"), { recursive: true });
  await cp(join(repoRoot, "skills/pi-delegate/SKILL.md"), join(pkg, "skills", "pi-delegate", "SKILL.md"));
  await cp(join(repoRoot, "skills/pi-delegate/references/mcp-contract.md"), join(pkg, "skills", "pi-delegate", "references", "mcp-contract.md"));
  if (git) await mkdir(join(pkg, ".git"), { recursive: true });
  return pkg;
}

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

function skillPaths(root, scope) {
  if (scope === "project") {
    return { installDir: join(root, "project", ".agents", "skills", "pi-delegate"), lockFile: join(root, "project", "skills-lock.json") };
  }
  return { installDir: join(root, "home", ".agents", "skills", "pi-delegate"), lockFile: join(root, "home", ".agents", ".skill-lock.json") };
}

/** Seed an installed skill directory and/or lock record for detection tests. */
async function seedSkill(root, { scope = "project", ref = "v0.0.9", withDir = true, withLock = true, lockSource = SKILL_EXPECTED_SOURCE, lockRef } = {}) {
  const target = skillPaths(root, scope);
  if (withDir) {
    await mkdir(join(target.installDir, "references"), { recursive: true });
    await cp(join(repoRoot, "skills/pi-delegate/SKILL.md"), join(target.installDir, "SKILL.md"));
    await cp(join(repoRoot, "skills/pi-delegate/references/mcp-contract.md"), join(target.installDir, "references", "mcp-contract.md"));
  }
  if (withLock) {
    await mkdir(dirname(target.lockFile), { recursive: true });
    const record = { source: lockSource };
    if (lockRef !== null) record.ref = lockRef ?? ref;
    await writeFile(target.lockFile, `${JSON.stringify({ version: 1, skills: { "pi-delegate": record } }, null, 2)}\n`);
  }
  return target;
}

async function seedCodex(root, version, scope = "project") {
  const path = scope === "project" ? join(root, "project", ".codex", "config.toml") : join(root, "home", ".codex", "config.toml");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `[mcp_servers.pi-task-exec]\ncommand = "npx"\nargs = ["-y", "@zguiyang/pi-task-exec@${version}", "mcp", "serve"]\n`);
  return path;
}

/** Fake Skills CLI that writes real files/lock/JSON unless told to fail. */
function makeSkillSpawn({ installDir, lockFile, scope, ref, behavior = "ok" }) {
  const calls = [];
  const spawn = async (command, args, options) => {
    calls.push({ command, args, options });
    if (behavior === "spawn-error") return { code: null, stdout: "", stderr: "", error: "spawn npx ENOENT" };
    if (behavior === "timeout") return { code: null, stdout: "", stderr: "", error: "timeout", timedOut: true };
    if (behavior === "nonzero") return { code: 1, stdout: "", stderr: "git clone failed" };
    await mkdir(join(installDir, "references"), { recursive: true });
    await writeFile(join(installDir, "SKILL.md"), await readFile(join(repoRoot, "skills/pi-delegate/SKILL.md")));
    await writeFile(join(installDir, "references/mcp-contract.md"), await readFile(join(repoRoot, "skills/pi-delegate/references/mcp-contract.md")));
    await mkdir(dirname(lockFile), { recursive: true });
    await writeFile(lockFile, `${JSON.stringify({ version: 1, skills: { "pi-delegate": { source: SKILL_EXPECTED_SOURCE, ref } } }, null, 2)}\n`);
    const json = [{ name: "pi-delegate", status: "installed", source: SKILL_EXPECTED_SOURCE, ref, path: installDir, scope, mode: "copy" }];
    return { code: 0, stdout: `${JSON.stringify(json, null, 2)}\n`, stderr: "" };
  };
  return { spawn, calls };
}

function makeDeps(root, overrides = {}) {
  const captured = capture();
  const preflightCalls = [];
  const preflight = overrides.releaseTagPreflight ?? (async (tag) => { preflightCalls.push(tag); return { ok: true }; });
  const deps = {
    io: captured.io,
    env: overrides.env ?? {},
    cwd: join(root, "project"),
    home: join(root, "home"),
    platform: overrides.platform ?? "darwin",
    packageRoot: overrides.packageRoot ?? join(root, "pkg"),
    packageVersion: VERSION,
    adapters: createDefaultAdapters(),
    skillInstaller: overrides.skillInstaller ?? new SkillsCliInstaller({ platform: "darwin" }),
    now: () => new Date("2026-10-09T00:00:00.000Z"),
    spawn: overrides.spawn ?? (async () => ({ code: 0, stdout: "", stderr: "" })),
    roots: [root],
    launchMode: overrides.launchMode ?? "npm",
    ...overrides,
    releaseTagPreflight: preflight,
  };
  return { deps, captured, preflightCalls };
}

const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));
const exists = async (path) => { try { await stat(path); return true; } catch { return false; } };

// ---------------------------------------------------------------------------
// Parser and selection behavior
// ---------------------------------------------------------------------------

test("update parses as a command, rejects missing host/scope, and rejects --target", () => {
  const missingHost = parseCli(["update"]);
  assert.equal(missingHost.kind, "error");
  assert.equal(missingHost.code, "missing_host");
  const missingScope = parseCli(["update", "--host", "codex"]);
  assert.equal(missingScope.kind, "error");
  assert.equal(missingScope.code, "missing_scope");
  const parsed = parseCli(["update", "--host", "zed", "--scope", "global", "--dry-run", "--json", "--yes"]);
  assert.equal(parsed.kind, "command");
  assert.equal(parsed.operation, "update");
  assert.equal(parsed.target, "both", "update always inspects both components");
  assert.equal(parsed.options.dryRun, true);
  assert.equal(parsed.options.yes, true);
  // The component-selection override is intentionally not offered by update.
  for (const value of ["mcp", "skill", "both"]) {
    const rejected = parseCli(["update", "--target", value]);
    assert.equal(rejected.kind, "error", `update --target ${value} must be rejected`);
    assert.equal(rejected.code, "unexpected_option");
  }
  // --target is still an error for add/remove, and still valid for setup.
  assert.equal(parseCli(["add", "mcp", "--target", "mcp"]).code, "unexpected_option");
  assert.equal(parseCli(["setup", "--target", "mcp", "--host", "codex", "--scope", "project"]).kind, "command");
});

test("update --json with missing selections fails machine-readably without prompting", async () => {
  const root = await makeRoot();
  const interaction = scriptedInteraction({ selects: ["codex", "project"] });
  const { deps, captured } = makeDeps(root, { interaction });
  const action = await runCli(["update", "--json"], deps);
  assert.deepEqual(action, { kind: "exit", code: 1 });
  assert.equal(interaction.calls.length, 0);
  assert.deepEqual(JSON.parse(captured.stdout()).error.code, "missing_host");
  assert.equal(await exists(join(root, "project", ".codex", "config.toml")), false);
});

test("interactive update prompts for the missing Agent and Scope", async () => {
  const root = await makeRoot();
  const pkg = await makePackageRoot(root);
  await seedCodex(root, "0.0.9");
  const interaction = scriptedInteraction({ selects: ["codex", "project"], confirms: [true] });
  const { deps } = makeDeps(root, { packageRoot: pkg, interaction });
  const action = await runCli(["update"], deps);
  assert.deepEqual(action, { kind: "exit", code: 0 });
  assert.deepEqual(interaction.calls[0].values, ["codex", "zed", "opencode"]);
  assert.deepEqual(interaction.calls[1].values, ["project", "global"]);
});

// ---------------------------------------------------------------------------
// MCP update discovery and planning
// ---------------------------------------------------------------------------

test("MCP old-version update rewrites only the pinned npm token and preserves unrelated config", async () => {
  const root = await makeRoot();
  const pkg = await makePackageRoot(root);
  const path = join(root, "project", ".codex", "config.toml");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, [
    "# keep comment",
    'model = "gpt-5"',
    "",
    "[mcp_servers.pi-task-exec]",
    'command = "npx"',
    'args = ["-y", "@zguiyang/pi-task-exec@0.0.9", "mcp", "serve"]',
    "",
    "[history]",
    'persistence = "save-all"',
    "",
  ].join("\n"));
  const { deps, captured, preflightCalls } = makeDeps(root, { packageRoot: pkg });
  const action = await runCli(["update", "--host", "codex", "--scope", "project", "--yes", "--json"], deps);
  assert.deepEqual(action, { kind: "exit", code: 0 });
  const [plan, execution] = jsonBlocks(captured.stdout());
  assert.equal(plan.operation, "update");
  assert.equal(plan.updatePreview[0].state, "update");
  assert.equal(plan.updatePreview[0].current, "@zguiyang/pi-task-exec@0.0.9");
  assert.equal(plan.updatePreview[0].desired, `@zguiyang/pi-task-exec@${VERSION}`);
  assert.equal(plan.updatePreview[0].key, "mcp_servers.pi-task-exec");
  assert.equal(plan.hostTarget.path, path);
  assert.equal(execution.status, "success");
  // An MCP-only update (Skill absent) is not blocked by the release tag.
  assert.deepEqual(preflightCalls, []);
  const merged = await readFile(path, "utf8");
  assert.match(merged, /# keep comment/);
  assert.match(merged, /\[history\]/);
  assert.match(merged, /@0\.1\.0/);
  assert.doesNotMatch(merged, /@0\.0\.9/);
});

test("MCP already at target is an idempotent no-op and skips the release preflight", async () => {
  const root = await makeRoot();
  const pkg = await makePackageRoot(root);
  const path = await seedCodex(root, VERSION);
  const before = await readFile(path, "utf8");
  const { deps, captured, preflightCalls } = makeDeps(root, { packageRoot: pkg });
  const action = await runCli(["update", "--host", "codex", "--scope", "project", "--yes", "--json"], deps);
  assert.deepEqual(action, { kind: "exit", code: 0 });
  const [plan, execution] = jsonBlocks(captured.stdout());
  assert.equal(plan.updatePreview[0].state, "no-op");
  assert.ok(plan.warnings.some((warning) => warning.code === "already_up_to_date"));
  assert.equal(plan.updates.length, 0);
  assert.equal(execution.status, "no-op");
  assert.deepEqual(preflightCalls, []);
  assert.equal(await readFile(path, "utf8"), before);
});

test("MCP absent is a no-write no-op that points at setup and never installs", async () => {
  const root = await makeRoot();
  const pkg = await makePackageRoot(root);
  const { deps, captured, preflightCalls } = makeDeps(root, { packageRoot: pkg });
  const action = await runCli(["update", "--host", "codex", "--scope", "project", "--yes", "--json"], deps);
  assert.deepEqual(action, { kind: "exit", code: 0 });
  const [plan, execution] = jsonBlocks(captured.stdout());
  assert.equal(plan.updatePreview[0].state, "absent");
  assert.ok(plan.warnings.some((warning) => warning.code === "not_installed" && /setup/.test(warning.message)));
  assert.equal(plan.creates.length + plan.updates.length, 0);
  assert.equal(execution.status, "no-op");
  assert.deepEqual(preflightCalls, []);
  assert.equal(await exists(join(root, "project", ".codex", "config.toml")), false);
});

test("unknown or modified same-name MCP entries conflict and are never rewritten", async () => {
  const cases = [
    `[mcp_servers.pi-task-exec]\ncommand = "npx"\nargs = ["-y", "@zguiyang/pi-task-exec@0.0.9", "mcp", "serve"]\nenv = { TOKEN = "x" }\n`,
    `[mcp_servers.pi-task-exec]\ncommand = "npx"\nargs = ["-y", "@someone-else/pi-task-exec@0.0.9", "mcp", "serve"]\n`,
    `[mcp_servers.pi-task-exec]\ncommand = "npx"\nargs = ["-y", "@zguiyang/pi-task-exec@latest", "mcp", "serve"]\n`,
    `[mcp_servers.pi-task-exec]\ncommand = "npx"\nargs = ["-y", "@zguiyang/pi-task-exec@0.0.9", "mcp", "serve", "--extra"]\n`,
  ];
  for (const entry of cases) {
    const root = await makeRoot();
    const pkg = await makePackageRoot(root);
    const path = join(root, "home", ".codex", "config.toml");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, entry);
    const { deps, captured, preflightCalls } = makeDeps(root, { packageRoot: pkg });
    const action = await runCli(["update", "--host", "codex", "--scope", "global", "--yes", "--json"], deps);
    assert.deepEqual(action, { kind: "exit", code: 1 }, entry);
    const [plan, execution] = jsonBlocks(captured.stdout());
    assert.equal(plan.conflicts[0].code, "mcp_entry_conflict", entry);
    assert.equal(execution.status, "conflict", entry);
    assert.equal(await readFile(path, "utf8"), entry, "the conflicting entry is untouched");
    assert.deepEqual(preflightCalls, [], "no preflight runs when the plan already conflicts");
  }
});

test("checkout mode MCP update requires --local-dev and writes the current checkout launch", async () => {
  const root = await makeRoot();
  const pkg = await makePackageRoot(root, { git: true });
  const path = await seedCodex(root, "0.0.9");
  const before = await readFile(path, "utf8");

  const blocked = makeDeps(root, { packageRoot: pkg, launchMode: "checkout" });
  const blockedAction = await runCli(["update", "--host", "codex", "--scope", "project", "--yes", "--json"], blocked.deps);
  assert.deepEqual(blockedAction, { kind: "exit", code: 1 });
  const [blockedPlan] = jsonBlocks(blocked.captured.stdout());
  assert.equal(blockedPlan.conflicts[0].code, "local_dev_required");
  assert.equal(blockedPlan.launchMode, "checkout");
  assert.equal(await readFile(path, "utf8"), before);

  const allowed = makeDeps(root, { packageRoot: pkg, launchMode: "checkout" });
  const allowedAction = await runCli(["update", "--host", "codex", "--scope", "project", "--yes", "--local-dev", "--json"], allowed.deps);
  assert.deepEqual(allowedAction, { kind: "exit", code: 0 });
  const merged = await readFile(path, "utf8");
  assert.match(merged, /command = "node"/);
  assert.ok(merged.includes(join(pkg, "dist", "cli", "index.js")));
  assert.deepEqual(allowed.preflightCalls, [], "checkout mode never needs the GitHub tag preflight");
});

// ---------------------------------------------------------------------------
// Skill update discovery and planning
// ---------------------------------------------------------------------------

test("skill update uses skills add with the pinned release ref, not skills update", async () => {
  const root = await makeRoot();
  const pkg = await makePackageRoot(root);
  const target = await seedSkill(root, { scope: "project", ref: "v0.0.9" });
  await writeFile(join(target.installDir, "LOCAL.txt"), "my edit");
  const { spawn, calls } = makeSkillSpawn({ ...target, scope: "project", ref: targetRef });
  const { deps, captured } = makeDeps(root, { packageRoot: pkg, skillSpawn: spawn, confirm: async () => true });
  const action = await runCli(["update", "--host", "codex", "--scope", "project", "--yes", "--json"], deps);
  assert.deepEqual(action, { kind: "exit", code: 0 });
  const [plan, execution] = jsonBlocks(captured.stdout());
  assert.equal(plan.skillCli.ref, targetRef);
  assert.equal(plan.skillCli.refKind, "release");
  assert.equal(plan.skillCli.currentRef, "v0.0.9");
  assert.equal(plan.skillCli.source, `${SKILL_REPOSITORY}/tree/${targetRef}/${SKILL_SUBPATH}`);
  assert.ok(plan.updatePreview.some((item) => item.target === "skill" && item.state === "update" && item.lossWarning === true));
  assert.equal(execution.status, "success");
  assert.equal(calls.length, 1);
  assert.ok(calls[0].args.includes("add"));
  assert.ok(!calls[0].args.includes("update"));
  assert.ok(calls[0].args.includes(targetRef) || calls[0].args.some((arg) => arg.includes(`tree/${targetRef}/`)));
  const lock = await readJson(target.lockFile);
  assert.equal(lock.skills["pi-delegate"].ref, targetRef);
});

test("checkout mode skill update targets the existing fixed SHA", async () => {
  const root = await makeRoot();
  const pkg = await makePackageRoot(root, { git: true });
  const target = await seedSkill(root, { scope: "project", ref: "v0.0.9" });
  const { spawn } = makeSkillSpawn({ ...target, scope: "project", ref: SKILL_DEV_REF });
  const { deps, captured } = makeDeps(root, { packageRoot: pkg, launchMode: "checkout", skillSpawn: spawn, confirm: async () => true });
  const action = await runCli(["update", "--host", "codex", "--scope", "project", "--yes", "--json"], deps);
  assert.deepEqual(action, { kind: "exit", code: 0 });
  const [plan] = jsonBlocks(captured.stdout());
  assert.equal(plan.skillCli.ref, SKILL_DEV_REF);
  assert.equal(plan.skillCli.refKind, "commit");
  assert.equal(plan.launchMode, "checkout");
});

test("skill already at target is a no-op that never invokes the Skills CLI", async () => {
  const root = await makeRoot();
  const pkg = await makePackageRoot(root);
  const target = await seedSkill(root, { scope: "project", ref: targetRef });
  const { spawn, calls } = makeSkillSpawn({ ...target, scope: "project", ref: targetRef });
  const { deps, captured } = makeDeps(root, { packageRoot: pkg, skillSpawn: spawn });
  const action = await runCli(["update", "--host", "codex", "--scope", "project", "--yes", "--json"], deps);
  assert.deepEqual(action, { kind: "exit", code: 0 });
  const [plan, execution] = jsonBlocks(captured.stdout());
  const skillPreview = plan.updatePreview.find((item) => item.target === "skill");
  assert.equal(skillPreview.state, "no-op");
  assert.ok(plan.warnings.some((warning) => warning.code === "skill_already_up_to_date"));
  assert.equal(plan.skillCli, null);
  assert.equal(execution.status, "no-op");
  assert.equal(calls.length, 0);
});

test("an absent skill is a no-write no-op that points at setup", async () => {
  const root = await makeRoot();
  const pkg = await makePackageRoot(root);
  const { spawn, calls } = makeSkillSpawn({ ...skillPaths(root, "project"), scope: "project", ref: targetRef });
  const { deps, captured } = makeDeps(root, { packageRoot: pkg, skillSpawn: spawn });
  const action = await runCli(["update", "--host", "codex", "--scope", "project", "--yes", "--json"], deps);
  assert.deepEqual(action, { kind: "exit", code: 0 });
  const [plan, execution] = jsonBlocks(captured.stdout());
  const skillPreview = plan.updatePreview.find((item) => item.target === "skill");
  assert.equal(skillPreview.state, "absent");
  assert.ok(plan.warnings.some((warning) => warning.code === "skill_not_installed" && /setup/.test(warning.message)));
  assert.equal(plan.skillCli, null);
  assert.equal(execution.status, "no-op");
  assert.equal(calls.length, 0);
});

test("inconsistent or unknown skill ownership conflicts without touching anything", async () => {
  // Directory present, lock missing.
  {
    const root = await makeRoot();
    const pkg = await makePackageRoot(root);
    const target = await seedSkill(root, { withLock: false });
    const before = await readFile(join(target.installDir, "SKILL.md"), "utf8");
    const { deps, captured } = makeDeps(root, { packageRoot: pkg });
    const action = await runCli(["update", "--host", "codex", "--scope", "project", "--yes", "--json"], deps);
    assert.deepEqual(action, { kind: "exit", code: 1 });
    const [plan] = jsonBlocks(captured.stdout());
    assert.equal(plan.conflicts[0].code, "skill_lock_missing");
    assert.equal(await readFile(join(target.installDir, "SKILL.md"), "utf8"), before);
  }
  // Lock present, directory missing.
  {
    const root = await makeRoot();
    const pkg = await makePackageRoot(root);
    await seedSkill(root, { withDir: false });
    const { deps, captured } = makeDeps(root, { packageRoot: pkg });
    const action = await runCli(["update", "--host", "codex", "--scope", "project", "--yes", "--json"], deps);
    assert.deepEqual(action, { kind: "exit", code: 1 });
    const [plan] = jsonBlocks(captured.stdout());
    assert.equal(plan.conflicts[0].code, "skill_install_missing");
  }
  // Lock owned by another source.
  {
    const root = await makeRoot();
    const pkg = await makePackageRoot(root);
    await seedSkill(root, { lockSource: "someone-else/repo" });
    const { deps, captured } = makeDeps(root, { packageRoot: pkg });
    const action = await runCli(["update", "--host", "codex", "--scope", "project", "--yes", "--json"], deps);
    assert.deepEqual(action, { kind: "exit", code: 1 });
    const [plan] = jsonBlocks(captured.stdout());
    assert.equal(plan.conflicts[0].code, "skill_ownership_conflict");
  }
  // Lock record without a ref.
  {
    const root = await makeRoot();
    const pkg = await makePackageRoot(root);
    await seedSkill(root, { lockRef: null });
    const { deps, captured } = makeDeps(root, { packageRoot: pkg });
    const action = await runCli(["update", "--host", "codex", "--scope", "project", "--yes", "--json"], deps);
    assert.deepEqual(action, { kind: "exit", code: 1 });
    const [plan] = jsonBlocks(captured.stdout());
    assert.equal(plan.conflicts[0].code, "skill_ref_unknown");
  }
});

test("skill install errors surface as failures without rollback claims", async () => {
  for (const behavior of ["nonzero", "spawn-error", "timeout"]) {
    const root = await makeRoot();
    const pkg = await makePackageRoot(root);
    const target = await seedSkill(root, { scope: "project", ref: "v0.0.9" });
    const { spawn, calls } = makeSkillSpawn({ ...target, scope: "project", ref: targetRef, behavior });
    const { deps, captured } = makeDeps(root, { packageRoot: pkg, skillSpawn: spawn, confirm: async () => true });
    const action = await runCli(["update", "--host", "codex", "--scope", "project", "--yes", "--json"], deps);
    assert.deepEqual(action, { kind: "exit", code: 1 }, behavior);
    assert.match(captured.stdout(), /skill_cli_verification_failed/, behavior);
    assert.match(captured.stdout(), /not transactional/i, behavior);
    assert.equal(calls.length, 1);
  }
});

test("unsafe skill paths (symlink or non-directory) conflict before any MCP mutation with --yes", async () => {
  for (const kind of ["symlink", "file"]) {
    const root = await makeRoot();
    const pkg = await makePackageRoot(root);
    const configPath = await seedCodex(root, "0.0.9");
    const beforeConfig = await readFile(configPath, "utf8");
    const target = skillPaths(root, "project");
    await mkdir(join(root, "project", ".agents", "skills"), { recursive: true });
    if (kind === "symlink") {
      await mkdir(join(root, "outside"), { recursive: true });
      await symlink(join(root, "outside"), target.installDir);
    } else {
      await writeFile(target.installDir, "not a directory");
    }
    await mkdir(dirname(target.lockFile), { recursive: true });
    await writeFile(target.lockFile, `${JSON.stringify({ version: 1, skills: { "pi-delegate": { source: SKILL_EXPECTED_SOURCE, ref: "v0.0.9" } } })}\n`);
    const { spawn, calls } = makeSkillSpawn({ ...target, scope: "project", ref: targetRef });
    let confirmCalls = 0;
    const { deps, captured } = makeDeps(root, { packageRoot: pkg, skillSpawn: spawn, confirm: async () => { confirmCalls += 1; return true; } });
    const action = await runCli(["update", "--host", "codex", "--scope", "project", "--yes", "--json"], deps);
    assert.deepEqual(action, { kind: "exit", code: 1 }, kind);
    const [plan, execution] = jsonBlocks(captured.stdout());
    assert.ok(plan.conflicts.length > 0, `${kind}: the plan must conflict`);
    assert.match(captured.stdout(), /symlink|not a directory|not-directory|skill_path_/, kind);
    assert.equal(execution.status, "conflict", kind);
    assert.equal(calls.length, 0, `${kind}: never spawns the Skills CLI`);
    assert.equal(confirmCalls, 0, `${kind}: an unsafe path never reaches the confirmation prompt`);
    assert.equal(await readFile(configPath, "utf8"), beforeConfig, `${kind}: the MCP config is untouched`);
  }
});

test("replacement confirmation is default-No and cannot be bypassed by --yes", async () => {
  const root = await makeRoot();
  const pkg = await makePackageRoot(root);
  const configPath = await seedCodex(root, "0.0.9");
  const beforeConfig = await readFile(configPath, "utf8");
  const target = await seedSkill(root, { scope: "project", ref: "v0.0.9" });
  const before = await readFile(join(target.installDir, "SKILL.md"), "utf8");
  const { spawn, calls } = makeSkillSpawn({ ...target, scope: "project", ref: targetRef });
  // Decline the default-No Skill replacement prompt even though --yes was given.
  const { deps, captured } = makeDeps(root, { packageRoot: pkg, skillSpawn: spawn, confirm: async () => false });
  const action = await runCli(["update", "--host", "codex", "--scope", "project", "--yes", "--json"], deps);
  assert.deepEqual(action, { kind: "exit", code: 1 });
  const [, execution] = jsonBlocks(captured.stdout());
  assert.equal(execution.status, "cancelled");
  assert.equal(calls.length, 0, "--yes must not bypass the safety prompt");
  assert.equal(await readFile(join(target.installDir, "SKILL.md"), "utf8"), before);
  assert.equal(await readFile(configPath, "utf8"), beforeConfig, "the MCP config must stay unchanged when the replacement is declined");
  assert.equal(await exists(join(target.installDir, "LOCAL.txt")), false);
});

// ---------------------------------------------------------------------------
// Combined update: each target-presence permutation and partial success
// ---------------------------------------------------------------------------

async function runCombined(root, { mcpVersion, skill, behavior = "ok", preflight } = {}) {
  const pkg = await makePackageRoot(root);
  if (mcpVersion !== undefined) await seedCodex(root, mcpVersion);
  let target = skill;
  if (skill && skill.seed) {
    target = await seedSkill(root, { scope: "project", ref: skill.ref ?? "v0.0.9", ...skill.seed });
  }
  const skillTarget = target ?? skillPaths(root, "project");
  const { spawn, calls } = makeSkillSpawn({ ...skillTarget, scope: "project", ref: targetRef, behavior });
  const overrides = { packageRoot: pkg, skillSpawn: spawn, confirm: async () => true };
  if (preflight) overrides.releaseTagPreflight = preflight;
  const { deps, captured, preflightCalls } = makeDeps(root, overrides);
  const action = await runCli(["update", "--host", "codex", "--scope", "project", "--yes", "--json"], deps);
  return { action, plan: jsonBlocks(captured.stdout())[0], execution: jsonBlocks(captured.stdout())[1], spawnCalls: calls, captured, preflightCalls };
}

test("combined update reports success when both installed components update", async () => {
  const root = await makeRoot();
  const { action, execution, spawnCalls, preflightCalls } = await runCombined(root, { mcpVersion: "0.0.9", skill: { seed: true } });
  assert.deepEqual(action, { kind: "exit", code: 0 });
  assert.deepEqual(execution.parts.map((part) => [part.target, part.status]), [["mcp", "success"], ["skill", "success"]]);
  assert.equal(execution.status, "success");
  assert.equal(spawnCalls.length, 1);
  assert.deepEqual(preflightCalls, [targetRef]);
  assert.match(await readFile(join(root, "project", ".codex", "config.toml"), "utf8"), /@0\.1\.0/);
});

test("combined update asks the replacement confirmation once before the MCP write", async () => {
  const root = await makeRoot();
  const pkg = await makePackageRoot(root);
  await seedCodex(root, "0.0.9");
  const target = await seedSkill(root, { scope: "project", ref: "v0.0.9" });
  const { spawn, calls } = makeSkillSpawn({ ...target, scope: "project", ref: targetRef });
  const confirmCalls = [];
  const { deps, captured } = makeDeps(root, {
    packageRoot: pkg,
    skillSpawn: spawn,
    confirm: async (plan, safety) => { confirmCalls.push({ operation: plan.operation, safety: safety?.reason ?? null }); return true; },
  });
  const action = await runCli(["update", "--host", "codex", "--scope", "project", "--yes", "--json"], deps);
  assert.deepEqual(action, { kind: "exit", code: 0 });
  assert.equal(confirmCalls.length, 1, "the safety prompt is asked once, not duplicated after the MCP write");
  assert.equal(confirmCalls[0].safety, "skill-path-safety");
  assert.equal(calls.length, 1);
  assert.match(await readFile(join(root, "project", ".codex", "config.toml"), "utf8"), /@0\.1\.0/);
  const [plan] = jsonBlocks(captured.stdout());
  assert.equal(plan.operation, "update");
});

test("combined update preserves MCP success when the skill install fails (partial A)", async () => {
  const root = await makeRoot();
  const { action, execution, spawnCalls } = await runCombined(root, { mcpVersion: "0.0.9", skill: { seed: true }, behavior: "nonzero" });
  assert.deepEqual(action, { kind: "exit", code: 1 });
  assert.equal(execution.status, "partial");
  assert.deepEqual(execution.parts.map((part) => [part.target, part.status]), [["mcp", "success"], ["skill", "failed"]]);
  assert.equal(spawnCalls.length, 1);
  assert.match(await readFile(join(root, "project", ".codex", "config.toml"), "utf8"), /@0\.1\.0/);
});

test("combined update preserves skill success when the MCP write fails (partial B)", async () => {
  const root = await makeRoot();
  const pkg = await makePackageRoot(root);
  const configPath = await seedCodex(root, "0.0.9");
  const target = await seedSkill(root, { scope: "project", ref: "v0.0.9" });
  const { spawn, calls } = makeSkillSpawn({ ...target, scope: "project", ref: targetRef });
  const context = { home: join(root, "home"), cwd: join(root, "project"), platform: "darwin", env: {} };
  const plan = await generatePlan(
    { operation: "update", target: "both", host: "codex", scope: "project", dryRun: false },
    {
      adapters: createDefaultAdapters(),
      skillInstaller: new SkillsCliInstaller({ platform: "darwin" }),
      context,
      now: () => new Date("2026-10-09T00:00:00.000Z"),
      packageVersion: VERSION,
      packageRoot: pkg,
      launch: { command: "npx", args: ["-y", `@zguiyang/pi-task-exec@${VERSION}`, "mcp", "serve"] },
      launchMode: "npm",
      localDev: false,
      releaseTagPreflight: async () => ({ ok: true }),
    },
  );
  const result = await executePlan(plan, {
    roots: [root],
    adapters: createDefaultAdapters(),
    io: { stdout() {}, stderr() {} },
    yes: true,
    confirm: async () => true,
    skillSpawn: spawn,
    skillPackageRoot: pkg,
    skillHome: join(root, "home"),
    skillEnv: {},
    afterWrite: async (path) => {
      if (path === configPath) throw new Error("forced MCP write failure");
    },
  });
  assert.equal(result.status, "partial");
  assert.deepEqual(result.parts.map((part) => [part.target, part.status]), [["mcp", "failed"], ["skill", "success"]]);
  assert.equal(calls.length, 1, "the skill still runs after an independent MCP failure");
  assert.equal(await readFile(join(target.installDir, "SKILL.md"), "utf8").then(() => true), true);
});

test("combined update handles every presence permutation without installing absent components", async () => {
  // MCP only.
  {
    const root = await makeRoot();
    const { action, execution, spawnCalls } = await runCombined(root, { mcpVersion: "0.0.9" });
    assert.deepEqual(action, { kind: "exit", code: 0 });
    assert.deepEqual(execution.parts.map((part) => [part.target, part.status]), [["mcp", "success"], ["skill", "no-op"]]);
    assert.equal(spawnCalls.length, 0);
  }
  // Skill only.
  {
    const root = await makeRoot();
    const { action, execution } = await runCombined(root, { skill: { seed: true } });
    assert.deepEqual(action, { kind: "exit", code: 0 });
    assert.deepEqual(execution.parts.map((part) => [part.target, part.status]), [["mcp", "no-op"], ["skill", "success"]]);
  }
  // Neither.
  {
    const root = await makeRoot();
    const { action, execution, plan, spawnCalls, preflightCalls } = await runCombined(root, {});
    assert.deepEqual(action, { kind: "exit", code: 0 });
    assert.deepEqual(execution.parts.map((part) => [part.target, part.status]), [["mcp", "no-op"], ["skill", "no-op"]]);
    assert.equal(execution.status, "no-op");
    assert.equal(spawnCalls.length, 0);
    assert.deepEqual(preflightCalls, []);
    assert.equal(plan.creates.length + plan.updates.length, 0);
  }
});

test("update with nothing installed is a no-op that never asks for confirmation", async () => {
  const root = await makeRoot();
  const pkg = await makePackageRoot(root);
  const { spawn } = makeSkillSpawn({ ...skillPaths(root, "project"), scope: "project", ref: targetRef });
  let confirmCalls = 0;
  const { deps, captured } = makeDeps(root, { packageRoot: pkg, skillSpawn: spawn, confirm: async () => { confirmCalls += 1; return true; } });
  const action = await runCli(["update", "--host", "codex", "--scope", "project", "--json"], deps);
  assert.deepEqual(action, { kind: "exit", code: 0 });
  const [plan, execution] = jsonBlocks(captured.stdout());
  assert.equal(confirmCalls, 0, "a mutation-free plan must not be confirmed");
  assert.equal(execution.status, "no-op");
  assert.equal(plan.creates.length + plan.updates.length, 0);
  assert.ok(plan.warnings.some((warning) => warning.code === "not_installed" && /setup/.test(warning.message)));
  assert.ok(plan.warnings.some((warning) => warning.code === "skill_not_installed" && /setup/.test(warning.message)));
});

test("update with both components already current is a no-op that never asks for confirmation", async () => {
  const root = await makeRoot();
  const pkg = await makePackageRoot(root);
  await seedCodex(root, VERSION);
  const target = await seedSkill(root, { scope: "project", ref: targetRef });
  const beforeConfig = await readFile(join(root, "project", ".codex", "config.toml"), "utf8");
  const beforeSkill = await readFile(join(target.installDir, "SKILL.md"), "utf8");
  const { spawn, calls } = makeSkillSpawn({ ...target, scope: "project", ref: targetRef });
  let confirmCalls = 0;
  const { deps, captured } = makeDeps(root, { packageRoot: pkg, skillSpawn: spawn, confirm: async () => { confirmCalls += 1; return true; } });
  const action = await runCli(["update", "--host", "codex", "--scope", "project", "--json"], deps);
  assert.deepEqual(action, { kind: "exit", code: 0 });
  const [plan, execution] = jsonBlocks(captured.stdout());
  assert.equal(confirmCalls, 0, "both-at-target is a mutation-free no-op");
  assert.equal(execution.status, "no-op");
  assert.equal(calls.length, 0);
  assert.equal(plan.creates.length + plan.updates.length, 0);
  assert.equal(await readFile(join(root, "project", ".codex", "config.toml"), "utf8"), beforeConfig);
  assert.equal(await readFile(join(target.installDir, "SKILL.md"), "utf8"), beforeSkill);
});

test("a symlinked skill lockfile is a conflict and never a no-op or a spawn", async () => {
  const root = await makeRoot();
  const pkg = await makePackageRoot(root);
  const configPath = await seedCodex(root, "0.0.9");
  const beforeConfig = await readFile(configPath, "utf8");
  const target = await seedSkill(root, { scope: "project", ref: targetRef });
  // Replace the real lockfile with a symlink whose target holds a valid record
  // with the target ref: following it would otherwise look like a no-op.
  await rm(target.lockFile);
  const decoy = join(root, "decoy-lock.json");
  await writeFile(decoy, `${JSON.stringify({ version: 1, skills: { "pi-delegate": { source: SKILL_EXPECTED_SOURCE, ref: targetRef } } })}\n`);
  await symlink(decoy, target.lockFile);
  const { spawn, calls } = makeSkillSpawn({ ...target, scope: "project", ref: targetRef });
  let confirmCalls = 0;
  const { deps, captured } = makeDeps(root, { packageRoot: pkg, skillSpawn: spawn, confirm: async () => { confirmCalls += 1; return true; } });
  const action = await runCli(["update", "--host", "codex", "--scope", "project", "--yes", "--json"], deps);
  assert.deepEqual(action, { kind: "exit", code: 1 });
  const [plan, execution] = jsonBlocks(captured.stdout());
  assert.ok(plan.conflicts.some((conflict) => /symlink/.test(conflict.message)), "the symlinked lockfile must conflict");
  assert.equal(execution.status, "conflict");
  assert.equal(calls.length, 0);
  assert.equal(confirmCalls, 0);
  assert.equal(await readFile(configPath, "utf8"), beforeConfig);
});

test("readSkillLockRecord refuses to follow a lockfile symlink", async () => {
  const root = await makeRoot();
  const decoy = join(root, "decoy-lock.json");
  const link = join(root, "linked-lock.json");
  await writeFile(decoy, `${JSON.stringify({ version: 1, skills: { "pi-delegate": { source: SKILL_EXPECTED_SOURCE, ref: "v0.1.1" } } })}\n`);
  await symlink(decoy, link);
  const result = await readSkillLockRecord(link);
  assert.equal(result.ok, false);
  assert.match(result.message, /symlink/);
});

test("detectSkillUpdate refuses a symlinked or non-directory install path", async () => {
  const root = await makeRoot();
  const lockFile = join(root, "project", "skills-lock.json");
  await mkdir(dirname(lockFile), { recursive: true });
  await writeFile(lockFile, `${JSON.stringify({ version: 1, skills: { "pi-delegate": { source: SKILL_EXPECTED_SOURCE, ref: "v0.0.9" } } })}\n`);
  // Symlinked install directory.
  const symlinkTarget = join(root, "real-skill");
  await mkdir(symlinkTarget, { recursive: true });
  const symlinkInstall = join(root, "project", ".agents", "skills", "pi-delegate");
  await mkdir(dirname(symlinkInstall), { recursive: true });
  await symlink(symlinkTarget, symlinkInstall);
  const viaSymlink = await detectSkillUpdate({ installDir: symlinkInstall, lockFile, expectedSource: SKILL_EXPECTED_SOURCE, desiredRef: targetRef });
  assert.equal(viaSymlink.kind, "conflict");
  assert.equal(viaSymlink.conflict.code, "skill_path_symlink");

  // Non-directory install path.
  const fileInstall = join(root, "project", ".agents", "skills", "pi-delegate-file");
  await writeFile(fileInstall, "not a directory");
  const viaFile = await detectSkillUpdate({ installDir: fileInstall, lockFile, expectedSource: SKILL_EXPECTED_SOURCE, desiredRef: targetRef });
  assert.equal(viaFile.kind, "conflict");
  assert.equal(viaFile.conflict.code, "skill_path_not_directory");
});

// ---------------------------------------------------------------------------
// Release tag preflight
// ---------------------------------------------------------------------------

test("a missing or unverifiable release tag conflicts the complete update before any write", async () => {
  const root = await makeRoot();
  const configPath = await seedCodex(root, "0.0.9");
  const target = await seedSkill(root, { scope: "project", ref: "v0.0.9" });
  const beforeConfig = await readFile(configPath, "utf8");
  const beforeSkill = await readFile(join(target.installDir, "SKILL.md"), "utf8");
  const { spawn, calls } = makeSkillSpawn({ ...target, scope: "project", ref: targetRef });
  const { deps, captured, preflightCalls } = makeDeps(root, {
    packageRoot: await makePackageRoot(root),
    skillSpawn: spawn,
    confirm: async () => true,
    releaseTagPreflight: async (tag) => { preflightCalls.push(tag); return { ok: false, message: `missing ${tag}` }; },
  });
  const action = await runCli(["update", "--host", "codex", "--scope", "project", "--yes", "--json"], deps);
  assert.deepEqual(action, { kind: "exit", code: 1 });
  const [plan, execution] = jsonBlocks(captured.stdout());
  assert.equal(plan.conflicts[0].code, "release_tag_missing");
  assert.match(plan.conflicts[0].message, /missing v0\.1\.0/);
  assert.equal(execution.status, "conflict");
  assert.equal(calls.length, 0, "no Skills CLI spawn after a failed tag preflight");
  assert.equal(await readFile(configPath, "utf8"), beforeConfig);
  assert.equal(await readFile(join(target.installDir, "SKILL.md"), "utf8"), beforeSkill);
  assert.deepEqual(preflightCalls, [targetRef]);
});

test("a missing release tag does not block an MCP-only update (Skill absent)", async () => {
  const root = await makeRoot();
  const configPath = await seedCodex(root, "0.0.9");
  const { deps, captured, preflightCalls } = makeDeps(root, {
    packageRoot: await makePackageRoot(root),
    releaseTagPreflight: async (tag) => { preflightCalls.push(tag); return { ok: false, message: "unreachable" }; },
  });
  const action = await runCli(["update", "--host", "codex", "--scope", "project", "--yes", "--json"], deps);
  assert.deepEqual(action, { kind: "exit", code: 0 });
  const [plan, execution] = jsonBlocks(captured.stdout());
  assert.equal(plan.conflicts.length, 0, "an unrelated GitHub tag must not block an MCP-only update");
  assert.deepEqual(preflightCalls, [], "no Skill update means no release tag preflight");
  assert.equal(execution.status, "success");
  assert.match(await readFile(configPath, "utf8"), /@0\.1\.0/);
});

// ---------------------------------------------------------------------------
// Dry-run, preview, refusal, and regressions
// ---------------------------------------------------------------------------

test("update dry-run prints the plan, spawns nothing, and performs the read-only preflight", async () => {
  const root = await makeRoot();
  const pkg = await makePackageRoot(root);
  await seedCodex(root, "0.0.9");
  const target = await seedSkill(root, { scope: "project", ref: "v0.0.9" });
  const { spawn, calls } = makeSkillSpawn({ ...target, scope: "project", ref: targetRef });
  const { deps, captured, preflightCalls } = makeDeps(root, { packageRoot: pkg, skillSpawn: spawn, confirm: async () => true });
  const action = await runCli(["update", "--host", "codex", "--scope", "project", "--dry-run", "--json"], deps);
  assert.deepEqual(action, { kind: "exit", code: 0 });
  const [plan, execution] = jsonBlocks(captured.stdout());
  assert.equal(plan.dryRun, true);
  assert.equal(execution.status, "dry-run");
  assert.equal(calls.length, 0);
  assert.deepEqual(preflightCalls, [targetRef]);
  assert.match(await readFile(join(root, "project", ".codex", "config.toml"), "utf8"), /@0\.0\.9/);
});

test("the text preview shows current/target refs, managed key/path, scope impact, and possible skill loss", async () => {
  const root = await makeRoot();
  const pkg = await makePackageRoot(root);
  await seedCodex(root, "0.0.9");
  await seedSkill(root, { scope: "project", ref: "v0.0.9" });
  const { deps, captured } = makeDeps(root, { packageRoot: pkg, interaction: scriptedInteraction() });
  const action = await runCli(["update", "--host", "codex", "--scope", "project", "--dry-run"], deps);
  assert.deepEqual(action, { kind: "exit", code: 0 });
  const text = captured.stdout();
  assert.match(text, /Pi TaskExec Update/);
  assert.match(text, /current: @zguiyang\/pi-task-exec@0\.0\.9/);
  assert.match(text, /target: @zguiyang\/pi-task-exec@0\.1\.0/);
  assert.match(text, /mcp_servers\.pi-task-exec/);
  assert.match(text, /current: v0\.0\.9/);
  assert.match(text, /target: v0\.1\.0/);
  assert.match(text, /existing local changes may be lost/);
  assert.match(text, /Skill scope: project/);
});

test("global skill preview describes the shared .agents/skills scope", async () => {
  const root = await makeRoot();
  const pkg = await makePackageRoot(root);
  await seedSkill(root, { scope: "global", ref: "v0.0.9" });
  const { deps, captured } = makeDeps(root, { packageRoot: pkg, interaction: scriptedInteraction() });
  const action = await runCli(["update", "--host", "codex", "--scope", "global", "--dry-run"], deps);
  assert.deepEqual(action, { kind: "exit", code: 0 });
  assert.match(captured.stdout(), /Skill scope: global \(shared \.agents\/skills/);
});

test("refusing the plan confirmation leaves MCP and skill untouched", async () => {
  const root = await makeRoot();
  const pkg = await makePackageRoot(root);
  const configPath = await seedCodex(root, "0.0.9");
  const target = await seedSkill(root, { scope: "project", ref: "v0.0.9" });
  const beforeConfig = await readFile(configPath, "utf8");
  const beforeSkill = await readFile(join(target.installDir, "SKILL.md"), "utf8");
  const { spawn, calls } = makeSkillSpawn({ ...target, scope: "project", ref: targetRef });
  const interaction = scriptedInteraction({ confirms: [false] });
  const { deps, captured } = makeDeps(root, { packageRoot: pkg, skillSpawn: spawn, interaction });
  const action = await runCli(["update", "--host", "codex", "--scope", "project"], deps);
  assert.deepEqual(action, { kind: "exit", code: 0 });
  assert.match(captured.stdout(), /Cancelled: no changes were made\./);
  assert.equal(calls.length, 0);
  assert.equal(await readFile(configPath, "utf8"), beforeConfig);
  assert.equal(await readFile(join(target.installDir, "SKILL.md"), "utf8"), beforeSkill);
});

test("add and setup regressions: add still refuses old MCP entries and setup still installs", async () => {
  const root = await makeRoot();
  const pkg = await makePackageRoot(root);
  await seedCodex(root, "0.0.9");
  const add = makeDeps(root, { packageRoot: pkg });
  const addAction = await runCli(["add", "mcp", "--host", "codex", "--scope", "project", "--yes", "--json"], add.deps);
  assert.deepEqual(addAction, { kind: "exit", code: 1 });
  assert.equal(jsonBlocks(add.captured.stdout())[0].conflicts[0].code, "mcp_entry_conflict");
  assert.match(await readFile(join(root, "project", ".codex", "config.toml"), "utf8"), /@0\.0\.9/);

  const target = skillPaths(root, "project");
  const { spawn } = makeSkillSpawn({ ...target, scope: "project", ref: `v${VERSION}` });
  const setup = makeDeps(root, { packageRoot: pkg, skillSpawn: spawn, confirm: async () => true });
  const setupAction = await runCli(["setup", "--target", "skill", "--host", "zed", "--scope", "project", "--yes", "--json"], setup.deps);
  assert.deepEqual(setupAction, { kind: "exit", code: 0 });
  assert.ok(await exists(join(target.installDir, "SKILL.md")));
});
