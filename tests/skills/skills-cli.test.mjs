import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, default as test } from "node:test";
import { VERSION } from "../../dist/cli/identity.js";
import { runCli } from "../../dist/cli/commands/index.js";
import { createDefaultAdapters } from "../../dist/cli/hosts/adapters.js";
import { unavailableSkillInstaller } from "../../dist/cli/installers/skill.js";
import { executePlan } from "../../dist/cli/plan/executor.js";
import {
  SKILLS_CLI_VERSION,
  SKILL_DEV_REF,
  SKILL_EXPECTED_SOURCE,
  SKILL_REPOSITORY,
  SKILL_SUBPATH,
  SkillsCliInstaller,
  buildSkillsCliArgs,
  maskSecrets,
  resolveSkillRef,
  resolveSkillsCliLaunch,
} from "../../dist/cli/installers/skills-cli.js";

const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const temporaryRoots = [];

async function makeTempDirectory(prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

async function makeRoot() {
  return makeTempDirectory("pi-task-exec-skills-");
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

function pathsFor(root, scope) {
  if (scope === "project") {
    const installDir = join(root, "project", ".agents", "skills", "pi-delegate");
    return { installDir, lockFile: join(root, "project", "skills-lock.json") };
  }
  const installDir = join(root, "home", ".agents", "skills", "pi-delegate");
  return { installDir, lockFile: join(root, "home", ".agents", ".skill-lock.json") };
}

/** Fake Skills CLI that writes real files/lock/JSON unless told otherwise. */
function makeSkillSpawn(config) {
  const calls = [];
  const spawn = async (command, args, options) => {
    calls.push({ command, args, options });
    if (config.behavior === "spawn-error") return { code: null, stdout: "", stderr: "", error: "spawn npx ENOENT" };
    if (config.behavior === "timeout") return { code: null, stdout: "", stderr: "", error: "timeout", timedOut: true };
    if (config.behavior === "nonzero") return { code: 1, stdout: "", stderr: "git clone failed" };
    const source = config.source ?? SKILL_EXPECTED_SOURCE;
    const ref = config.ref ?? SKILL_DEV_REF;
    if (config.behavior !== "missing-files") {
      await mkdir(join(config.installDir, "references"), { recursive: true });
      await writeFile(join(config.installDir, "SKILL.md"), await readFile(join(repoRoot, "skills/pi-delegate/SKILL.md")));
      await writeFile(join(config.installDir, "references/mcp-contract.md"), await readFile(join(repoRoot, "skills/pi-delegate/references/mcp-contract.md")));
    }
    if (config.behavior !== "missing-lock") {
      const entry = { source, ref, sourceType: "github", skillPath: "skills/pi-delegate/SKILL.md" };
      const lock = config.scope === "global"
        ? { version: 3, skills: { "pi-delegate": entry }, dismissed: {} }
        : { version: 1, skills: { "pi-delegate": entry } };
      await mkdir(dirname(config.lockFile), { recursive: true });
      await writeFile(config.lockFile, `${JSON.stringify(lock, null, 2)}\n`);
    }
    const json = [{ name: "pi-delegate", status: "installed", source, ref, path: config.installDir, scope: config.scope, mode: "copy" }];
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
    ...overrides,
  };
  return { deps, captured };
}

const exists = async (path) => { try { await stat(path); return true; } catch { return false; } };

// ---------------------------------------------------------------------------
// Pure source/ref/argv/launch selection
// ---------------------------------------------------------------------------

test("child diagnostics never echo env secret values", () => {
  const masked = maskSecrets("clone failed with GITHUB_TOKEN=SECRET-TOKEN-VALUE and NPM_TOKEN=OTHER-SECRET", {
    GITHUB_TOKEN: "SECRET-TOKEN-VALUE",
    NPM_TOKEN: "OTHER-SECRET",
    SHORT: "abc",
  });
  assert.doesNotMatch(masked, /SECRET-TOKEN-VALUE|OTHER-SECRET/);
  assert.match(masked, /\*\*\*/);
});

test("package engine floor and lockfile stay synchronized at Node >=22.20.0", async () => {
  const pkg = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8"));
  const lock = JSON.parse(await readFile(join(repoRoot, "package-lock.json"), "utf8"));
  assert.equal(pkg.engines.node, ">=22.20.0");
  assert.equal(lock.packages[""].engines.node, ">=22.20.0");
});

test("source/ref selection is explicit: release tag for npm, pinned commit for checkout, never main", () => {
  const release = resolveSkillRef({ launchMode: "npm", packageVersion: "0.2.0" });
  assert.equal(release.ref, "v0.2.0");
  assert.equal(release.refKind, "release");
  assert.equal(release.source, `${SKILL_REPOSITORY}/tree/v0.2.0/${SKILL_SUBPATH}`);
  assert.doesNotMatch(release.source, /main|master/);

  const checkout = resolveSkillRef({ launchMode: "checkout", packageVersion: "0.2.0" });
  assert.equal(checkout.ref, SKILL_DEV_REF);
  assert.equal(checkout.ref.length, 40);
  assert.equal(checkout.refKind, "commit");
  assert.equal(checkout.source, `${SKILL_REPOSITORY}/tree/${SKILL_DEV_REF}/${SKILL_SUBPATH}`);
});

test("plan argv pins skills@1.7.1 and passes explicit agent, skill, scope, copy, json", () => {
  assert.equal(SKILLS_CLI_VERSION, "1.7.1");
  const project = buildSkillsCliArgs({ source: "https://example.test/src", agent: "codex", scope: "project" });
  assert.deepEqual(project, ["add", "https://example.test/src", "--agent", "codex", "--skill", "pi-delegate", "--copy", "--json"]);
  const global = buildSkillsCliArgs({ source: "https://example.test/src", agent: "opencode", scope: "global" });
  assert.deepEqual(global, ["add", "https://example.test/src", "--agent", "opencode", "--global", "--skill", "pi-delegate", "--copy", "--json"]);
  assert.equal(project[project.indexOf("--skill") + 1], "pi-delegate");
});

test("Windows npm entry launches npm-cli.js through node and never a .cmd with shell", () => {
  const npmCli = "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js";
  const resolved = resolveSkillsCliLaunch({
    platform: "win32",
    execPath: "C:\\Program Files\\nodejs\\node.exe",
    env: {},
    fileExists: (path) => path === npmCli,
  });
  assert.ok(resolved);
  assert.equal(resolved.command, "C:\\Program Files\\nodejs\\node.exe");
  assert.equal(resolved.args[0], npmCli);
  assert.ok(!resolved.command.endsWith(".cmd"));
  assert.ok(!resolved.args.some((arg) => /\.cmd$/i.test(arg)));
  assert.deepEqual(resolved.args.slice(1, 5), ["exec", "--yes", "--package", `skills@${SKILLS_CLI_VERSION}`]);

  // Fail closed instead of shelling out when npm cannot be located.
  assert.equal(resolveSkillsCliLaunch({ platform: "win32", execPath: "C:\\node\\node.exe", env: {}, fileExists: () => false }), null);
  // POSIX uses npx directly.
  assert.deepEqual(resolveSkillsCliLaunch({ platform: "darwin", execPath: "/usr/bin/node", env: {} }), { command: "npx", args: ["-y", `skills@${SKILLS_CLI_VERSION}`] });
});

test("the installer accepts only codex/zed/opencode as the Skill Agent", async () => {
  const installer = new SkillsCliInstaller({ platform: "darwin" });
  for (const host of ["codex", "zed", "opencode"]) {
    const result = await installer.plan({
      operation: "add",
      scope: "project",
      context: { home: "/home/me", cwd: "/work/project", platform: "darwin", env: {} },
      host,
      sourceDir: "unused",
      packageVersion: VERSION,
      currentContent: null,
      launchMode: "checkout",
    });
    assert.equal(result.kind, "ok", host);
    assert.equal(result.plan.cli.agent, host);
  }
  const rejected = await installer.plan({
    operation: "add",
    scope: "project",
    context: { home: "/home/me", cwd: "/work/project", platform: "darwin", env: {} },
    host: "custom",
    sourceDir: "unused",
    packageVersion: VERSION,
    currentContent: null,
    launchMode: "checkout",
  });
  assert.equal(rejected.kind, "unsupported");
  assert.equal(rejected.capability.code, "skill_agent_required");
});

test("the installer fails closed on Windows when the npm entry cannot be resolved", async () => {
  const installer = new SkillsCliInstaller({ platform: "win32", execPath: "C:\\node\\node.exe", fileExists: () => false });
  const result = await installer.plan({
    operation: "add",
    scope: "project",
    context: { home: "C:\\home", cwd: "C:\\project", platform: "win32", env: {} },
    host: "codex",
    sourceDir: "unused",
    packageVersion: VERSION,
    currentContent: null,
    launchMode: "checkout",
  });
  assert.equal(result.kind, "unsupported");
  assert.equal(result.capability.code, "skill_cli_launch_unavailable");
});

// ---------------------------------------------------------------------------
// Plan generation is side-effect-free
// ---------------------------------------------------------------------------

test("add skill dry-run prints a CLI plan with the pinned source/ref and writes/spawns nothing", async () => {
  const root = await makeRoot();
  const { spawn, calls } = makeSkillSpawn({ installDir: pathsFor(root, "project").installDir, lockFile: pathsFor(root, "project").lockFile, scope: "project" });
  const { deps, captured } = makeDeps(root, { skillSpawn: spawn });
  const action = await runCli(["add", "skill", "--host", "codex", "--scope", "project", "--dry-run", "--json"], deps);
  assert.deepEqual(action, { kind: "exit", code: 0 });
  const plan = jsonBlocks(captured.stdout())[0];
  assert.ok(plan.skillCli);
  assert.equal(plan.skillCli.installer, "skills-cli");
  assert.equal(plan.skillCli.cliVersion, "1.7.1");
  assert.equal(plan.skillCli.agent, "codex");
  assert.equal(plan.skillCli.repository, SKILL_REPOSITORY);
  assert.equal(plan.skillCli.subpath, SKILL_SUBPATH);
  assert.equal(plan.skillCli.ref, SKILL_DEV_REF);
  assert.equal(plan.skillCli.source, `${SKILL_REPOSITORY}/tree/${SKILL_DEV_REF}/${SKILL_SUBPATH}`);
  assert.ok(plan.skillCli.args.includes("skills@1.7.1"));
  assert.ok(plan.skillCli.args.includes("--skill"));
  assert.equal(plan.skillCli.args[plan.skillCli.args.indexOf("--skill") + 1], "pi-delegate");
  assert.ok(plan.skillCli.args.includes("--copy"));
  assert.ok(plan.skillCli.args.includes("--json"));
  assert.ok(!plan.skillCli.args.includes("--yes"), "a printed plan does not contain Skills CLI --yes");
  assert.equal(plan.skillCli.lossWarning, false);
  assert.equal(calls.length, 0, "dry-run must not spawn the CLI");
  assert.equal(await exists(pathsFor(root, "project").installDir), false);
  assert.equal(await exists(pathsFor(root, "project").lockFile), false);
});

test("plan JSON exposes scope, install path, and lock path without env or secrets", async () => {
  const root = await makeRoot();
  const { deps, captured } = makeDeps(root, { env: { GITHUB_TOKEN: "SECRET-TOKEN-VALUE", XDG_STATE_HOME: join(root, "state") } });
  const action = await runCli(["add", "skill", "--host", "zed", "--scope", "global", "--dry-run", "--json"], deps);
  assert.deepEqual(action, { kind: "exit", code: 0 });
  const plan = jsonBlocks(captured.stdout())[0];
  assert.equal(plan.skillCli.installDir, join(root, "home", ".agents", "skills", "pi-delegate"));
  assert.equal(plan.skillCli.lockFile, join(root, "state", "skills", ".skill-lock.json"));
  assert.doesNotMatch(captured.stdout(), /SECRET-TOKEN-VALUE/);
  assert.doesNotMatch(captured.stdout(), /GITHUB_TOKEN/);
});

// ---------------------------------------------------------------------------
// Real (injected) install
// ---------------------------------------------------------------------------

test("first project install spawns the pinned CLI, verifies files and lock, and reports success", async () => {
  const root = await makeRoot();
  const target = pathsFor(root, "project");
  const { spawn, calls } = makeSkillSpawn({ installDir: target.installDir, lockFile: target.lockFile, scope: "project" });
  const { deps, captured } = makeDeps(root, { skillSpawn: spawn });
  const action = await runCli(["add", "skill", "--host", "codex", "--scope", "project", "--yes", "--json"], deps);
  assert.deepEqual(action, { kind: "exit", code: 0 });
  assert.equal(calls.length, 1);
  const { command, args, options } = calls[0];
  assert.equal(command, "npx");
  assert.deepEqual(args.slice(0, 2), ["-y", "skills@1.7.1"]);
  assert.ok(args.includes("--agent") && args.includes("codex"));
  assert.ok(args.includes("--yes"), "execution adds --yes only after plan confirmation");
  assert.equal(args[args.indexOf("--skill") + 1], "pi-delegate");
  assert.equal(options.env.DO_NOT_TRACK, "1");
  assert.equal(options.env.DISABLE_TELEMETRY, "1");
  assert.equal(options.cwd, deps.cwd);
  assert.match(await readFile(join(target.installDir, "SKILL.md"), "utf8"), /name: pi-delegate/);
  const lock = JSON.parse(await readFile(target.lockFile, "utf8"));
  assert.equal(lock.skills["pi-delegate"].ref, SKILL_DEV_REF);
  assert.match(captured.stdout(), /"status": "success"/);
});

test("global install resolves the shared .agents path and global lock", async () => {
  const root = await makeRoot();
  const target = pathsFor(root, "global");
  const { spawn, calls } = makeSkillSpawn({ installDir: target.installDir, lockFile: target.lockFile, scope: "global" });
  const { deps } = makeDeps(root, { skillSpawn: spawn });
  const action = await runCli(["add", "skill", "--host", "opencode", "--scope", "global", "--yes", "--json"], deps);
  assert.deepEqual(action, { kind: "exit", code: 0 });
  assert.ok(calls[0].args.includes("--global"));
  assert.ok(await exists(join(root, "home", ".agents", "skills", "pi-delegate", "references", "mcp-contract.md")));
  assert.ok(await exists(target.lockFile));
});

// ---------------------------------------------------------------------------
// Path safety and confirmation
// ---------------------------------------------------------------------------

test("a target created during confirmation fails closed and never spawns", async () => {
  const root = await makeRoot();
  const target = pathsFor(root, "project");
  await mkdir(join(root, "project"), { recursive: true });
  const { spawn, calls } = makeSkillSpawn({ installDir: target.installDir, lockFile: target.lockFile, scope: "project" });
  const { deps, captured } = makeDeps(root, {
    skillSpawn: spawn,
    confirm: async () => {
      // Drift the target while the prompt is open.
      await mkdir(join(target.installDir, "swapped"), { recursive: true });
      return true;
    },
  });
  const action = await runCli(["add", "skill", "--host", "codex", "--scope", "project", "--json"], deps);
  assert.deepEqual(action, { kind: "exit", code: 1 });
  assert.equal(calls.length, 0, "no third-party spawn after target drift");
  assert.match(captured.stdout(), /skill_targets_changed/);
});

test("existing same-name skill forces a default-No confirmation that --yes cannot bypass", async () => {
  const root = await makeRoot();
  const target = pathsFor(root, "project");
  await mkdir(join(target.installDir, "nested"), { recursive: true });
  await writeFile(join(target.installDir, "USER-FILE.txt"), "keep me");
  await mkdir(join(root, "project"), { recursive: true });
  const { spawn, calls } = makeSkillSpawn({ installDir: target.installDir, lockFile: target.lockFile, scope: "project" });

  // --yes without a confirm hook fails closed for an unsafe path.
  const noHook = makeDeps(root, { skillSpawn: spawn });
  const refused = await runCli(["add", "skill", "--host", "codex", "--scope", "project", "--yes", "--json"], noHook.deps);
  assert.deepEqual(refused, { kind: "exit", code: 1 });
  assert.equal(calls.length, 0);
  assert.equal(await readFile(join(target.installDir, "USER-FILE.txt"), "utf8"), "keep me");

  // --yes with an explicit default-No (false) answer is still refused.
  const declined = makeDeps(root, { skillSpawn: spawn, confirm: async () => false });
  const cancelled = await runCli(["add", "skill", "--host", "codex", "--scope", "project", "--yes", "--json"], declined.deps);
  assert.deepEqual(cancelled, { kind: "exit", code: 1 });
  assert.equal(calls.length, 0);

  // Explicit consent to the rendered plan proceeds.
  let safetySeen = null;
  const accepted = makeDeps(root, { skillSpawn: spawn, confirm: async (_plan, safety) => { safetySeen = safety; return true; } });
  const ok = await runCli(["add", "skill", "--host", "codex", "--scope", "project", "--yes", "--json"], accepted.deps);
  assert.deepEqual(ok, { kind: "exit", code: 0 });
  assert.equal(calls.length, 1);
  assert.ok(safetySeen && safetySeen.reason === "skill-path-safety");
  assert.match(safetySeen.message, /existing-skill/);
});

test("a symlinked target is reported and fails closed for unsafe paths", async () => {
  const root = await makeRoot();
  const target = pathsFor(root, "project");
  await mkdir(join(root, "outside"), { recursive: true });
  await mkdir(join(root, "project", ".agents", "skills"), { recursive: true });
  await symlink(join(root, "outside"), target.installDir);
  const { spawn, calls } = makeSkillSpawn({ installDir: target.installDir, lockFile: target.lockFile, scope: "project" });
  const { deps, captured } = makeDeps(root, { skillSpawn: spawn });
  const action = await runCli(["add", "skill", "--host", "codex", "--scope", "project", "--dry-run", "--json"], deps);
  assert.deepEqual(action, { kind: "exit", code: 0 });
  const plan = jsonBlocks(captured.stdout())[0];
  assert.equal(plan.skillCli.lossWarning, true);
  assert.ok(plan.skillCli.safety.some((item) => item.kind === "symlink"));

  const noConfirm = makeDeps(root, { skillSpawn: spawn });
  const refused = await runCli(["add", "skill", "--host", "codex", "--scope", "project", "--yes", "--json"], noConfirm.deps);
  assert.deepEqual(refused, { kind: "exit", code: 1 });
  assert.equal(calls.length, 0);

  // A symlink target remains forbidden even when it points within an allowed
  // root and the caller supplies affirmative confirmation. `--yes` cannot
  // convert a dangerous path into an ordinary replacement.
  const allowedRootLink = makeDeps(root, { skillSpawn: spawn, confirm: async () => true });
  const explicitlyConfirmed = await runCli(["add", "skill", "--host", "codex", "--scope", "project", "--yes", "--json"], allowedRootLink.deps);
  assert.deepEqual(explicitlyConfirmed, { kind: "exit", code: 1 });
  assert.equal(calls.length, 0, "a symlink must never spawn, even after explicit confirmation");
  assert.match(allowedRootLink.captured.stdout(), /unsafe_skill_path/);
});

test("refusal to confirm performs no spawn and leaves the target untouched", async () => {
  const root = await makeRoot();
  const target = pathsFor(root, "project");
  const { spawn, calls } = makeSkillSpawn({ installDir: target.installDir, lockFile: target.lockFile, scope: "project" });
  const { deps } = makeDeps(root, { skillSpawn: spawn, confirm: async () => false });
  const action = await runCli(["add", "skill", "--host", "codex", "--scope", "project", "--json"], deps);
  assert.deepEqual(action, { kind: "exit", code: 1 });
  assert.equal(calls.length, 0);
  assert.equal(await exists(target.installDir), false);
  assert.equal(await exists(target.lockFile), false);
});

// ---------------------------------------------------------------------------
// Result verification beyond exit code
// ---------------------------------------------------------------------------

test("exit 0 with missing installed files is a failure, not a success", async () => {
  const root = await makeRoot();
  const target = pathsFor(root, "project");
  const { spawn } = makeSkillSpawn({ installDir: target.installDir, lockFile: target.lockFile, scope: "project", behavior: "missing-files" });
  const { deps, captured } = makeDeps(root, { skillSpawn: spawn });
  const action = await runCli(["add", "skill", "--host", "codex", "--scope", "project", "--yes", "--json"], deps);
  assert.deepEqual(action, { kind: "exit", code: 1 });
  assert.match(captured.stdout(), /skill_cli_verification_failed/);
});

test("exit 0 with a missing lockfile is treated as partial/failure", async () => {
  const root = await makeRoot();
  const target = pathsFor(root, "project");
  const { spawn } = makeSkillSpawn({ installDir: target.installDir, lockFile: target.lockFile, scope: "project", behavior: "missing-lock" });
  const { deps, captured } = makeDeps(root, { skillSpawn: spawn });
  const action = await runCli(["add", "skill", "--host", "codex", "--scope", "project", "--yes", "--json"], deps);
  assert.deepEqual(action, { kind: "exit", code: 1 });
  assert.match(captured.stdout(), /lockfile is missing|lockfile/i);
});

test("a lockfile recording the wrong source/ref is a failure", async () => {
  const root = await makeRoot();
  const target = pathsFor(root, "project");
  const { spawn } = makeSkillSpawn({ installDir: target.installDir, lockFile: target.lockFile, scope: "project", ref: "main" });
  const { deps, captured } = makeDeps(root, { skillSpawn: spawn });
  const action = await runCli(["add", "skill", "--host", "codex", "--scope", "project", "--yes", "--json"], deps);
  assert.deepEqual(action, { kind: "exit", code: 1 });
  assert.match(captured.stdout(), /ref/i);
});

test("absent bundled reference bytes are an explicit verification failure", async () => {
  // Nothing bundled at all: SKILL.md reference is absent.
  const root1 = await makeRoot();
  const emptyPkg = join(root1, "empty-pkg");
  await mkdir(emptyPkg, { recursive: true });
  const target1 = pathsFor(root1, "project");
  const spawn1 = makeSkillSpawn({ installDir: target1.installDir, lockFile: target1.lockFile, scope: "project" });
  const deps1 = makeDeps(root1, { skillSpawn: spawn1.spawn, packageRoot: emptyPkg });
  const first = await runCli(["add", "skill", "--host", "codex", "--scope", "project", "--yes", "--json"], deps1.deps);
  assert.deepEqual(first, { kind: "exit", code: 1 });
  assert.match(deps1.captured.stdout(), /Bundled reference SKILL\.md is missing or unreadable/);

  // SKILL.md reference present but the contract reference is absent.
  const root2 = await makeRoot();
  const partialPkg = join(root2, "partial-pkg");
  await mkdir(join(partialPkg, "skills", "pi-delegate"), { recursive: true });
  await writeFile(join(partialPkg, "skills", "pi-delegate", "SKILL.md"), await readFile(join(repoRoot, "skills/pi-delegate/SKILL.md")));
  const target2 = pathsFor(root2, "project");
  const spawn2 = makeSkillSpawn({ installDir: target2.installDir, lockFile: target2.lockFile, scope: "project" });
  const deps2 = makeDeps(root2, { skillSpawn: spawn2.spawn, packageRoot: partialPkg });
  const second = await runCli(["add", "skill", "--host", "codex", "--scope", "project", "--yes", "--json"], deps2.deps);
  assert.deepEqual(second, { kind: "exit", code: 1 });
  assert.match(deps2.captured.stdout(), /references\/mcp-contract\.md is missing or unreadable/);
});

test("installed bytes that do not match the pinned source/ref are a failure", async () => {
  const root = await makeRoot();
  const target = pathsFor(root, "project");
  const { spawn } = makeSkillSpawn({ installDir: target.installDir, lockFile: target.lockFile, scope: "project" });
  const tampered = async (command, args, options) => {
    const result = await spawn(command, args, options);
    await writeFile(join(target.installDir, "SKILL.md"), "---\nname: pi-delegate\n---\ntampered\n");
    return result;
  };
  const { deps, captured } = makeDeps(root, { skillSpawn: tampered });
  const action = await runCli(["add", "skill", "--host", "codex", "--scope", "project", "--yes", "--json"], deps);
  assert.deepEqual(action, { kind: "exit", code: 1 });
  assert.match(captured.stdout(), /does not match the pinned/i);
});

test("spawn errors, non-zero exits, and timeouts all fail without rollback claims", async () => {
  for (const behavior of ["spawn-error", "nonzero", "timeout"]) {
    const root = await makeRoot();
    const target = pathsFor(root, "project");
    const { spawn } = makeSkillSpawn({ installDir: target.installDir, lockFile: target.lockFile, scope: "project", behavior });
    const { deps, captured } = makeDeps(root, { skillSpawn: spawn });
    const action = await runCli(["add", "skill", "--host", "codex", "--scope", "project", "--yes", "--json"], deps);
    assert.deepEqual(action, { kind: "exit", code: 1 }, behavior);
    assert.match(captured.stdout(), /skill_cli_verification_failed/, behavior);
    assert.match(captured.stdout(), /not transactional/i, behavior);
  }
});

// ---------------------------------------------------------------------------
// Stage 09A audit: root boundary for third-party Skills CLI targets
// ---------------------------------------------------------------------------

test("a global XDG_STATE_HOME outside home/cwd is an explicit root and the lock is written there", async () => {
  const root = await makeRoot();
  const installDir = join(root, "home", ".agents", "skills", "pi-delegate");
  const lockFile = join(root, "state", "skills", ".skill-lock.json");
  const { spawn, calls } = makeSkillSpawn({ installDir, lockFile, scope: "global" });
  const { deps, captured } = makeDeps(root, { skillSpawn: spawn, env: { XDG_STATE_HOME: join(root, "state") } });
  const action = await runCli(["add", "skill", "--host", "codex", "--scope", "global", "--yes", "--json"], deps);
  assert.deepEqual(action, { kind: "exit", code: 0 });
  assert.equal(calls.length, 1);
  assert.ok(await exists(lockFile), "the documented XDG lock override must remain reachable");
  assert.match(captured.stdout(), /"status": "success"/);
});

test("a symlinked skills ancestor outside the allowed roots fails closed before spawning", async () => {
  const root = await makeRoot();
  const outside = await makeTempDirectory("pi-task-exec-skills-outside-");
  await mkdir(join(root, "home"), { recursive: true });
  // home/.agents redirects the whole global install tree outside the root.
  await symlink(outside, join(root, "home", ".agents"));
  const installDir = join(root, "home", ".agents", "skills", "pi-delegate");
  const lockFile = join(root, "home", ".agents", ".skill-lock.json");
  const { spawn, calls } = makeSkillSpawn({ installDir, lockFile, scope: "global" });
  const { deps, captured } = makeDeps(root, { skillSpawn: spawn, confirm: async () => true });
  const action = await runCli(["add", "skill", "--host", "codex", "--scope", "global", "--yes", "--json"], deps);
  assert.deepEqual(action, { kind: "exit", code: 1 });
  assert.equal(calls.length, 0, "a symlink escape must never spawn the Skills CLI");
  assert.match(captured.stdout(), /symlink_escape/);
  assert.equal(await exists(join(outside, "skills", "pi-delegate", "SKILL.md")), false);
});

test("the executor asserts every Skills CLI target is within the allowed roots", async () => {
  const root = await makeRoot();
  const installDir = join(root, "project", ".agents", "skills", "pi-delegate");
  const outsideLock = join(root, "..", "pi-task-exec-outside-lock.json");
  const plan = {
    schema: "pi-task-exec.plan.v1",
    operation: "add",
    target: "skill",
    dryRun: false,
    createdAt: "2026-10-09T00:00:00.000Z",
    resolvedPaths: { skillDir: installDir },
    creates: [],
    updates: [],
    removals: [],
    conflicts: [],
    backups: [],
    warnings: [],
    unsupported: [],
    supported: true,
    skillCli: {
      installer: "skills-cli",
      cliVersion: SKILLS_CLI_VERSION,
      agent: "codex",
      scope: "project",
      repository: SKILL_REPOSITORY,
      subpath: SKILL_SUBPATH,
      source: `${SKILL_REPOSITORY}/tree/${SKILL_DEV_REF}/${SKILL_SUBPATH}`,
      ref: SKILL_DEV_REF,
      refKind: "commit",
      command: "npx",
      args: ["-y", "skills@1.7.1", "add"],
      cwd: join(root, "project"),
      home: join(root, "home"),
      installDir,
      skillFile: join(installDir, "SKILL.md"),
      contractFile: join(installDir, "references", "mcp-contract.md"),
      lockFile: outsideLock,
      expectedSource: SKILL_EXPECTED_SOURCE,
      expectedRef: SKILL_DEV_REF,
      safety: [],
      lossWarning: false,
    },
  };
  let spawned = false;
  const result = await executePlan(plan, {
    roots: [root],
    adapters: [],
    io: { stdout() {}, stderr() {} },
    yes: true,
    skillSpawn: async () => { spawned = true; return { code: 0, stdout: "[]", stderr: "" }; },
    skillPackageRoot: repoRoot,
    skillHome: join(root, "home"),
  });
  assert.equal(result.status, "conflict");
  assert.equal(result.errors[0].code, "path_escape");
  assert.equal(spawned, false, "an out-of-root lock must never spawn the Skills CLI");
});

test("setup skill remains deferred and remove skill is unchanged", async () => {
  const root = await makeRoot();
  const setup = makeDeps(root);
  const setupAction = await runCli(["setup", "--target", "skill", "--scope", "project", "--yes", "--json"], setup.deps);
  assert.deepEqual(setupAction, { kind: "exit", code: 1 });
  assert.match(setup.captured.stdout(), /skill_installer_unavailable|skill_installer_deferred/);

  const remove = makeDeps(root, { skillInstaller: unavailableSkillInstaller() });
  const removeAction = await runCli(["remove", "skill", "--scope", "project", "--yes", "--json"], remove.deps);
  assert.deepEqual(removeAction, { kind: "exit", code: 1 });
  assert.match(remove.captured.stdout(), /skill_installer_unavailable/);
});

test("add mcp still installs through the real adapter (MCP regression)", async () => {
  const root = await makeRoot();
  const { deps, captured } = makeDeps(root, { packageRoot: join(root, "pkg"), env: { PI_TASK_EXEC_LAUNCH_MODE: "npm" } });
  const action = await runCli(["add", "mcp", "--host", "codex", "--scope", "project", "--yes", "--json"], deps);
  assert.deepEqual(action, { kind: "exit", code: 0 });
  assert.match(await readFile(join(root, "project", ".codex", "config.toml"), "utf8"), /\[mcp_servers\.pi-task-exec\]/);
  assert.match(captured.stdout(), /"status": "success"/);
});
