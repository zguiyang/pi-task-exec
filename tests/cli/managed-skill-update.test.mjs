import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, default as test } from "node:test";
import { VERSION } from "../../dist/cli/identity.js";
import { createDefaultAdapters } from "../../dist/cli/hosts/adapters.js";
import { executePlan } from "../../dist/cli/plan/executor.js";
import { generatePlan } from "../../dist/cli/plan/model.js";
import { SKILL_EXPECTED_SOURCE, SkillsCliInstaller } from "../../dist/cli/installers/skills-cli.js";

const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const temporaryRoots = [];
const NOW = new Date("2026-10-09T00:00:00.000Z");
const STAMP = "2026-10-09T00-00-00-000Z";
const targetRef = `v${VERSION}`;

const SEEDED_SKILL = "---\nname: pi-delegate\n---\n# seeded local Skill body\n";
const SEEDED_CONTRACT = "seeded local contract\n";
const SEEDED_NOTES = "operator notes\n";

async function makeRoot() {
  const root = await mkdtemp(join(tmpdir(), "pi-task-exec-managed-update-"));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** A non-git package root carrying the bundled Skill bytes (npm/release mode). */
async function makePackageRoot(base) {
  const pkg = join(base, "pkg");
  await mkdir(join(pkg, "skills", "pi-delegate", "references"), { recursive: true });
  await writeFile(join(pkg, "skills", "pi-delegate", "SKILL.md"), await readFile(join(repoRoot, "skills/pi-delegate/SKILL.md")));
  await writeFile(join(pkg, "skills", "pi-delegate", "references/mcp-contract.md"), await readFile(join(repoRoot, "skills/pi-delegate/references/mcp-contract.md")));
  return pkg;
}

function skillsTree(root) {
  const agentsDir = join(root, "project", ".agents");
  return {
    agentsDir,
    skillsRoot: join(agentsDir, "skills"),
    installDir: join(agentsDir, "skills", "pi-delegate"),
    lockFile: join(root, "project", "skills-lock.json"),
    configPath: join(root, "project", ".codex", "config.toml"),
  };
}

async function seedCodex(root, version) {
  const path = join(root, "project", ".codex", "config.toml");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `[mcp_servers.pi-task-exec]\ncommand = "npx"\nargs = ["-y", "@zguiyang/pi-task-exec@${version}", "mcp", "serve"]\n`);
  return path;
}

/** Seed a planner-proven managed Skill: install tree plus the fixed-source lock record. */
async function seedManagedSkill(paths, { source = SKILL_EXPECTED_SOURCE, ref = "v0.0.9" } = {}) {
  await mkdir(join(paths.installDir, "references"), { recursive: true });
  await writeFile(join(paths.installDir, "SKILL.md"), SEEDED_SKILL);
  await writeFile(join(paths.installDir, "references", "mcp-contract.md"), SEEDED_CONTRACT);
  await writeFile(join(paths.installDir, "LOCAL-notes.txt"), SEEDED_NOTES);
  await mkdir(dirname(paths.lockFile), { recursive: true });
  await writeFile(paths.lockFile, `${JSON.stringify({ version: 1, skills: { "pi-delegate": { source, ref } } }, null, 2)}\n`);
}

/** Fake Skills CLI that installs the bundled bytes and rewrites the lock record. */
function makeSkillSpawn({ installDir, lockFile, scope = "project" }) {
  const calls = [];
  const spawn = async (command, args, options) => {
    calls.push({ command, args, options });
    await mkdir(join(installDir, "references"), { recursive: true });
    await writeFile(join(installDir, "SKILL.md"), await readFile(join(repoRoot, "skills/pi-delegate/SKILL.md")));
    await writeFile(join(installDir, "references/mcp-contract.md"), await readFile(join(repoRoot, "skills/pi-delegate/references/mcp-contract.md")));
    await mkdir(dirname(lockFile), { recursive: true });
    await writeFile(lockFile, `${JSON.stringify({ version: 1, skills: { "pi-delegate": { source: SKILL_EXPECTED_SOURCE, ref: targetRef } } }, null, 2)}\n`);
    const json = [{ name: "pi-delegate", status: "installed", source: SKILL_EXPECTED_SOURCE, ref: targetRef, path: installDir, scope, mode: "copy" }];
    return { code: 0, stdout: `${JSON.stringify(json, null, 2)}\n`, stderr: "" };
  };
  return { spawn, calls };
}

function planDeps(root, pkg) {
  return {
    adapters: createDefaultAdapters(),
    skillInstaller: new SkillsCliInstaller({ platform: "darwin" }),
    context: { home: join(root, "home"), cwd: join(root, "project"), platform: "darwin", env: {} },
    now: () => NOW,
    packageVersion: VERSION,
    packageRoot: pkg,
    launch: { command: "npx", args: ["-y", "@zguiyang/pi-task-exec@latest", "mcp", "serve"] },
    launchMode: "npm",
    localDev: false,
    releaseTagPreflight: async () => ({ ok: true }),
  };
}

async function buildPlan(root, pkg, request) {
  return generatePlan(request, planDeps(root, pkg));
}

function confirmationLog(answer = false) {
  const reasons = [];
  return {
    reasons,
    confirm: async (_plan, safety) => {
      reasons.push(safety?.reason ?? "generic");
      return answer;
    },
  };
}

async function runExecute(plan, { root, pkg, spawn, confirm, auto }) {
  return executePlan(plan, {
    roots: [root],
    adapters: createDefaultAdapters(),
    io: { stdout() {}, stderr() {} },
    yes: false,
    now: () => NOW,
    ...(confirm ? { confirm } : {}),
    ...(auto === undefined ? {} : { autoManagedSkillUpdate: auto }),
    skillSpawn: spawn,
    skillPackageRoot: pkg,
    skillHome: join(root, "home"),
    skillEnv: {},
  });
}

// ---------------------------------------------------------------------------
// Automatic managed Skill update
// ---------------------------------------------------------------------------

test("an automatic managed Skill update runs without confirmation and reports its backup beside skills/", async () => {
  const root = await makeRoot();
  const pkg = await makePackageRoot(root);
  const paths = skillsTree(root);
  const configPath = await seedCodex(root, "0.0.9");
  await seedManagedSkill(paths);
  const { spawn, calls } = makeSkillSpawn(paths);
  const plan = await buildPlan(root, pkg, { operation: "update", target: "both", host: "codex", scope: "project", dryRun: false });
  assert.deepEqual(plan.conflicts, []);

  const log = confirmationLog();
  const result = await runExecute(plan, { root, pkg, spawn, confirm: log.confirm, auto: true });

  assert.equal(log.reasons.length, 0, "the managed Skill update must never ask for confirmation");
  assert.equal(result.status, "success");
  assert.equal(calls.length, 1, "the pinned Skills CLI runs exactly once");

  // The backup is reported in the execution result...
  const expectedBackup = join(paths.agentsDir, `pi-delegate.backup-${STAMP}`);
  const skillBackup = result.backups.find((entry) => entry.path === paths.installDir);
  assert.ok(skillBackup, "the Skill directory backup must be reported in the execution result");
  assert.equal(skillBackup.backupPath, expectedBackup);
  const skillPart = result.parts.find((part) => part.target === "skill");
  assert.equal(skillPart.status, "success");
  assert.equal(skillPart.backups.length, 1);
  assert.equal(skillPart.backups[0].backupPath, expectedBackup);

  // ...and it lives under `.agents/`, outside the directory hosts scan.
  assert.equal(dirname(expectedBackup), paths.agentsDir);
  assert.deepEqual(await readdir(paths.skillsRoot), ["pi-delegate"], "nothing may be written inside skills/");
  assert.deepEqual(
    (await readdir(paths.agentsDir)).filter((name) => name.startsWith("pi-delegate.backup-")),
    [`pi-delegate.backup-${STAMP}`],
    "the backup must be a timestamped sibling of skills/",
  );

  // The backup is a faithful, recoverable copy of the entire pre-update tree.
  assert.equal(await readFile(join(expectedBackup, "SKILL.md"), "utf8"), SEEDED_SKILL);
  assert.equal(await readFile(join(expectedBackup, "references", "mcp-contract.md"), "utf8"), SEEDED_CONTRACT);
  assert.equal(await readFile(join(expectedBackup, "LOCAL-notes.txt"), "utf8"), SEEDED_NOTES);

  // The update itself converged on the pinned bytes.
  assert.equal(await readFile(join(paths.installDir, "SKILL.md"), "utf8"), await readFile(join(pkg, "skills/pi-delegate/SKILL.md"), "utf8"));
  assert.equal(JSON.parse(await readFile(paths.lockFile, "utf8")).skills["pi-delegate"].ref, targetRef);
  assert.match(await readFile(configPath, "utf8"), /@latest/);
  assert.equal(result.parts.find((part) => part.target === "mcp").status, "success");
});

test("a symlink inside the Skill tree refuses the automatic update before any spawn", async () => {
  const root = await makeRoot();
  const pkg = await makePackageRoot(root);
  const paths = skillsTree(root);
  const configPath = await seedCodex(root, "0.0.9");
  const beforeConfig = await readFile(configPath, "utf8");
  await seedManagedSkill(paths);
  // The link stays inside the tree, so the planner's path inspection passes.
  await symlink(join(paths.installDir, "SKILL.md"), join(paths.installDir, "alias.md"));
  const { spawn, calls } = makeSkillSpawn(paths);
  const plan = await buildPlan(root, pkg, { operation: "update", target: "both", host: "codex", scope: "project", dryRun: false });
  assert.deepEqual(plan.conflicts, [], "planning alone does not walk nested Skill entries");

  const log = confirmationLog();
  const result = await runExecute(plan, { root, pkg, spawn, confirm: log.confirm, auto: true });

  assert.equal(result.status, "conflict");
  assert.equal(result.errors[0].code, "skill_backup_unsafe_entry");
  assert.match(result.errors[0].message, /symlink/);
  assert.equal(log.reasons.length, 0, "an unsafe Skill tree is refused instead of prompted");
  assert.equal(calls.length, 0, "the third-party CLI must never spawn");
  assert.deepEqual(await readdir(paths.agentsDir), ["skills"], "no backup is written for a refused tree");
  assert.equal(await readFile(configPath, "utf8"), beforeConfig, "the refusal happens before any MCP mutation");
  assert.equal(await readFile(join(paths.installDir, "SKILL.md"), "utf8"), SEEDED_SKILL, "the existing Skill tree is untouched");
  assert.equal(result.parts.find((part) => part.target === "mcp").status, "no-op");
});

test("a non-regular entry inside the Skill tree refuses the automatic update before any spawn", async () => {
  const root = await makeRoot();
  const pkg = await makePackageRoot(root);
  const paths = skillsTree(root);
  await seedCodex(root, "0.0.9");
  await seedManagedSkill(paths);
  // A dangling symlink is still a symlink: never followed, never copied.
  await symlink(join(paths.installDir, "missing-target"), join(paths.installDir, "trap.link"));
  const { spawn, calls } = makeSkillSpawn(paths);
  const plan = await buildPlan(root, pkg, { operation: "update", target: "both", host: "codex", scope: "project", dryRun: false });

  const log = confirmationLog();
  const result = await runExecute(plan, { root, pkg, spawn, confirm: log.confirm, auto: true });

  assert.equal(result.status, "conflict");
  assert.equal(result.errors[0].code, "skill_backup_unsafe_entry");
  assert.equal(calls.length, 0);
  assert.deepEqual(await readdir(paths.agentsDir), ["skills"]);
});

// ---------------------------------------------------------------------------
// Legacy default and the boundaries of automatic approval
// ---------------------------------------------------------------------------

test("the default legacy behavior still requires confirmation for the same managed Skill update", async () => {
  // Declined: nothing runs, nothing is backed up, nothing is written.
  const declinedRoot = await makeRoot();
  const declinedPkg = await makePackageRoot(declinedRoot);
  const declinedPaths = skillsTree(declinedRoot);
  const declinedConfig = await seedCodex(declinedRoot, "0.0.9");
  const beforeConfig = await readFile(declinedConfig, "utf8");
  await seedManagedSkill(declinedPaths);
  const declinedSpawn = makeSkillSpawn(declinedPaths);
  const declinedPlan = await buildPlan(declinedRoot, declinedPkg, { operation: "update", target: "both", host: "codex", scope: "project", dryRun: false });
  const declinedLog = confirmationLog();
  const declined = await runExecute(declinedPlan, { root: declinedRoot, pkg: declinedPkg, spawn: declinedSpawn.spawn, confirm: declinedLog.confirm, auto: false });

  assert.equal(declined.status, "cancelled");
  assert.ok(declinedLog.reasons.length >= 1, "legacy still asks for confirmation");
  assert.equal(declinedSpawn.calls.length, 0);
  assert.deepEqual(declined.backups, []);
  assert.equal(await readFile(declinedConfig, "utf8"), beforeConfig);
  assert.deepEqual(await readdir(declinedPaths.agentsDir), ["skills"], "no directory backup is taken in legacy mode");

  // Accepted: the update runs, still without an automatic directory backup.
  const acceptedRoot = await makeRoot();
  const acceptedPkg = await makePackageRoot(acceptedRoot);
  const acceptedPaths = skillsTree(acceptedRoot);
  await seedCodex(acceptedRoot, "0.0.9");
  await seedManagedSkill(acceptedPaths);
  const acceptedSpawn = makeSkillSpawn(acceptedPaths);
  const acceptedPlan = await buildPlan(acceptedRoot, acceptedPkg, { operation: "update", target: "both", host: "codex", scope: "project", dryRun: false });
  const acceptedLog = confirmationLog(true);
  const accepted = await runExecute(acceptedPlan, { root: acceptedRoot, pkg: acceptedPkg, spawn: acceptedSpawn.spawn, confirm: acceptedLog.confirm, auto: false });

  assert.equal(accepted.status, "success");
  assert.ok(acceptedLog.reasons.length >= 1, "legacy still asks for confirmation");
  assert.equal(acceptedSpawn.calls.length, 1);
  assert.equal(
    accepted.backups.some((entry) => entry.path === acceptedPaths.installDir),
    false,
    "the Skill directory backup only exists in the automatic mode",
  );
  assert.deepEqual(await readdir(acceptedPaths.agentsDir), ["skills"]);
});

test("the automatic option never approves an add plan", async () => {
  const root = await makeRoot();
  const pkg = await makePackageRoot(root);
  const paths = skillsTree(root);
  await seedManagedSkill(paths);
  const { spawn, calls } = makeSkillSpawn(paths);
  const plan = await buildPlan(root, pkg, { operation: "add", target: "skill", host: "codex", scope: "project", dryRun: false });
  assert.deepEqual(plan.conflicts, []);

  const log = confirmationLog();
  const result = await runExecute(plan, { root, pkg, spawn, confirm: log.confirm, auto: true });

  assert.equal(result.status, "cancelled");
  assert.ok(log.reasons.length >= 1, "add plans keep the default-No replacement prompt");
  assert.ok(log.reasons.includes("skill-path-safety"));
  assert.equal(calls.length, 0, "an add plan is never approved automatically");
  assert.deepEqual(await readdir(paths.agentsDir), ["skills"]);
});

test("an owner that cannot be re-proven at execution time falls back to legacy confirmation", async () => {
  const root = await makeRoot();
  const pkg = await makePackageRoot(root);
  const paths = skillsTree(root);
  await seedCodex(root, "0.0.9");
  await seedManagedSkill(paths);
  const { spawn, calls } = makeSkillSpawn(paths);
  const plan = await buildPlan(root, pkg, { operation: "update", target: "both", host: "codex", scope: "project", dryRun: false });
  // The lock now records a foreign source: ownership is no longer proven even
  // though the plan was generated while it was.
  await writeFile(paths.lockFile, `${JSON.stringify({ version: 1, skills: { "pi-delegate": { source: "someone-else/repo", ref: "v0.0.9" } } }, null, 2)}\n`);

  const log = confirmationLog();
  const result = await runExecute(plan, { root, pkg, spawn, confirm: log.confirm, auto: true });

  assert.equal(result.status, "cancelled");
  assert.ok(log.reasons.length >= 1, "an unknown owner must never be approved automatically");
  assert.equal(calls.length, 0, "an unknown owner never reaches the third-party spawn");
  assert.deepEqual(await readdir(paths.agentsDir), ["skills"]);
});
