import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, default as test } from "node:test";

import { executeSkillRemoval, planSkillRemoval } from "../../dist/cli/installers/skill-removal.js";

const temporaryRoots = [];

async function makeTempDirectory(prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const FIXED_NOW = () => new Date("2025-06-01T12:00:00.000Z");
const FIXED_STAMP = "2025-06-01T12-00-00-000Z";

function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

const SKILL_BODY = "---\nname: pi-delegate\n---\nbody\n";
const CONTRACT_BODY = "# contract\n";

function ownedLock() {
  return {
    schema: "skills-lock.v1",
    updatedAt: "2025-01-02T03:04:05.000Z",
    skills: {
      "pi-delegate": { source: "zguiyang/pi-task-exec", ref: "v0.3.1" },
      "other-skill": { source: "someone/else", ref: "v9.9.9" },
    },
  };
}

async function plantSkill(installDir) {
  await mkdir(join(installDir, "references"), { recursive: true });
  await writeFile(join(installDir, "SKILL.md"), SKILL_BODY);
  await writeFile(join(installDir, "references", "mcp-contract.md"), CONTRACT_BODY);
}

async function makeProject({ plant = true, lock = ownedLock() } = {}) {
  const root = await makeTempDirectory("pi-task-exec-removal-");
  const installDir = join(root, ".agents", "skills", "pi-delegate");
  if (plant) await plantSkill(installDir);
  const lockFile = join(root, "skills-lock.json");
  if (lock !== null) await writeFile(lockFile, `${JSON.stringify(lock, null, 2)}\n`);
  const context = { home: join(root, "home"), cwd: root, platform: process.platform, env: {} };
  return { root, installDir, lockFile, context };
}

async function makeGlobalHome() {
  const root = await makeTempDirectory("pi-task-exec-removal-global-");
  const installDir = join(root, ".agents", "skills", "pi-delegate");
  await plantSkill(installDir);
  const lockFile = join(root, ".agents", ".skill-lock.json");
  await writeFile(lockFile, `${JSON.stringify(ownedLock(), null, 2)}\n`);
  const context = { home: root, cwd: join(root, "work"), platform: process.platform, env: {} };
  return { root, installDir, lockFile, context };
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

test("an uninstalled skill plans as absent and execution is a read-only no-op", async () => {
  const { root, installDir, lockFile, context } = await makeProject({ plant: false, lock: null });
  const plan = await planSkillRemoval({ scope: "project", context });
  assert.equal(plan.kind, "absent");
  assert.equal(plan.installDir, installDir);
  assert.equal(plan.lockFile, lockFile);
  assert.equal(plan.lockSha256, null);
  assert.equal(plan.metadata.skill, "pi-delegate");
  assert.equal(plan.metadata.owner, "zguiyang/pi-task-exec");
  assert.equal(plan.metadata.managedBy, "pi-task-exec");

  // Planning is strictly read-only: nothing was created.
  assert.equal(await exists(join(root, ".agents")), false);
  assert.equal(await exists(lockFile), false);

  const result = await executeSkillRemoval(plan, { roots: [root], now: FIXED_NOW });
  assert.equal(result.status, "absent");
  assert.deepEqual(result.backups, []);
  assert.deepEqual(result.errors, []);
  assert.equal(await exists(join(root, ".agents")), false);
  assert.equal(await exists(lockFile), false);
});

test("an absent skill with an unrelated lockfile still plans as absent with a lock snapshot hash", async () => {
  const lock = { schema: "skills-lock.v1", skills: { "other-skill": { source: "someone/else", ref: "v1" } } };
  const { root, lockFile, context } = await makeProject({ plant: false, lock });
  const plan = await planSkillRemoval({ scope: "project", context });
  assert.equal(plan.kind, "absent");
  assert.equal(plan.lockSha256, sha256(await readFile(lockFile, "utf8")));
  const result = await executeSkillRemoval(plan, { roots: [root], now: FIXED_NOW });
  assert.equal(result.status, "absent");
});

test("an owned skill at project scope is removed with recoverable directory and lock backups", async () => {
  const { root, installDir, lockFile, context } = await makeProject();
  const rawLock = await readFile(lockFile, "utf8");

  const plan = await planSkillRemoval({ scope: "project", context });
  assert.equal(plan.kind, "ready");
  assert.equal(plan.installDir, installDir);
  assert.equal(plan.lockFile, lockFile);
  assert.equal(plan.lockSha256, sha256(rawLock));
  assert.match(plan.dirFingerprint, /^[0-9a-f]{64}$/);
  assert.ok(plan.checkedPaths.includes(installDir));
  assert.ok(plan.checkedPaths.includes(lockFile));
  assert.equal(plan.metadata.ref, "v0.3.1");
  assert.equal(plan.metadata.owner, "zguiyang/pi-task-exec");

  const result = await executeSkillRemoval(plan, { roots: [root], now: FIXED_NOW });
  assert.equal(result.status, "success");
  assert.deepEqual(result.errors, []);
  assert.equal(result.rollback, "none");
  assert.deepEqual(result.performed, [lockFile]);
  assert.deepEqual(result.removed, [installDir]);
  assert.equal(result.backups.length, 2);

  assert.equal(await exists(installDir), false);

  const lockDirBackup = result.backups.find((entry) => entry.path === installDir);
  assert.equal(lockDirBackup.backupPath, join(root, ".agents", `pi-delegate.backup-${FIXED_STAMP}`));
  assert.equal(await readFile(join(lockDirBackup.backupPath, "SKILL.md"), "utf8"), SKILL_BODY);
  assert.equal(await readFile(join(lockDirBackup.backupPath, "references", "mcp-contract.md"), "utf8"), CONTRACT_BODY);

  const lockBackup = result.backups.find((entry) => entry.path === lockFile);
  assert.equal(lockBackup.backupPath, join(root, `skills-lock.json.backup-${FIXED_STAMP}`));
  assert.equal(await readFile(lockBackup.backupPath, "utf8"), rawLock);
});

test("an owned skill at global scope is removed under home", async () => {
  const { root, installDir, lockFile, context } = await makeGlobalHome();
  const plan = await planSkillRemoval({ scope: "global", context });
  assert.equal(plan.kind, "ready");
  assert.equal(plan.installDir, installDir);
  assert.equal(plan.lockFile, lockFile);

  const result = await executeSkillRemoval(plan, { roots: [root], now: FIXED_NOW });
  assert.equal(result.status, "success");
  assert.equal(await exists(installDir), false);
  const updated = JSON.parse(await readFile(lockFile, "utf8"));
  assert.ok(!("pi-delegate" in updated.skills));
  assert.equal(updated.skills["other-skill"].source, "someone/else");
  assert.equal(result.backups.length, 2);
  for (const backup of result.backups) assert.equal(await exists(backup.backupPath), true);
});

test("a foreign lock source is a conflict and execution changes nothing", async () => {
  const lock = ownedLock();
  lock.skills["pi-delegate"] = { source: "evil/other-repo", ref: "v6.6.6" };
  const { root, installDir, lockFile, context } = await makeProject({ lock });
  const rawLock = await readFile(lockFile, "utf8");

  const plan = await planSkillRemoval({ scope: "project", context });
  assert.equal(plan.kind, "conflict");
  assert.equal(plan.conflict.code, "skill_ownership_conflict");
  assert.equal(plan.conflict.path, lockFile);

  const result = await executeSkillRemoval(plan, { roots: [root], now: FIXED_NOW });
  assert.equal(result.status, "conflict");
  assert.equal(result.errors[0].code, "skill_ownership_conflict");
  assert.deepEqual(result.backups, []);

  assert.equal(await exists(installDir), true);
  assert.equal(await readFile(lockFile, "utf8"), rawLock);
});

test("a malformed lockfile is a conflict and execution changes nothing", async () => {
  const { root, installDir, lockFile, context } = await makeProject({ lock: null });
  await writeFile(lockFile, "{ this is not json");
  const rawLock = await readFile(lockFile, "utf8");

  const plan = await planSkillRemoval({ scope: "project", context });
  assert.equal(plan.kind, "conflict");
  assert.equal(plan.conflict.code, "skill_lock_malformed");
  assert.equal(plan.conflict.path, lockFile);

  const result = await executeSkillRemoval(plan, { roots: [root], now: FIXED_NOW });
  assert.equal(result.status, "conflict");
  assert.equal(result.errors[0].code, "skill_lock_malformed");

  assert.equal(await exists(installDir), true);
  assert.equal(await readFile(lockFile, "utf8"), rawLock);
});

test("a symlinked skills root ancestor is a conflict and is never followed", async () => {
  const root = await makeTempDirectory("pi-task-exec-removal-symlink-");
  const realSkills = join(root, "real", "skills");
  await plantSkill(join(realSkills, "pi-delegate"));
  await mkdir(join(root, ".agents"), { recursive: true });
  const skillsRoot = join(root, ".agents", "skills");
  await symlink(realSkills, skillsRoot);
  const lockFile = join(root, "skills-lock.json");
  await writeFile(lockFile, `${JSON.stringify(ownedLock(), null, 2)}\n`);
  const context = { home: join(root, "home"), cwd: root, platform: process.platform, env: {} };

  const plan = await planSkillRemoval({ scope: "project", context });
  assert.equal(plan.kind, "conflict");
  assert.equal(plan.conflict.code, "skill_path_symlink");
  assert.equal(plan.conflict.path, skillsRoot);

  const result = await executeSkillRemoval(plan, { roots: [root], now: FIXED_NOW });
  assert.equal(result.status, "conflict");
  assert.equal(await exists(skillsRoot), true);
  assert.equal(await exists(join(realSkills, "pi-delegate", "SKILL.md")), true);
});

test("a symlink anywhere under the skill directory is a conflict and is never followed", async () => {
  const { root, installDir, lockFile, context } = await makeProject();
  const planted = join(installDir, "references", "mcp-contract.md");
  await rm(planted);
  await symlink(join(installDir, "SKILL.md"), planted);

  const plan = await planSkillRemoval({ scope: "project", context });
  assert.equal(plan.kind, "conflict");
  assert.equal(plan.conflict.code, "skill_path_symlink");
  assert.equal(plan.conflict.path, planted);
  assert.match(plan.conflict.message, /refusing to follow/);

  const result = await executeSkillRemoval(plan, { roots: [root], now: FIXED_NOW });
  assert.equal(result.status, "conflict");
  assert.equal(await exists(lockFile), true);
});

test("lock drift between plan and execution is refused before any mutation", async () => {
  const { root, installDir, lockFile, context } = await makeProject();
  const plan = await planSkillRemoval({ scope: "project", context });
  assert.equal(plan.kind, "ready");

  const drifted = JSON.parse(await readFile(lockFile, "utf8"));
  drifted.drifted = true;
  await writeFile(lockFile, `${JSON.stringify(drifted, null, 2)}\n`);

  const result = await executeSkillRemoval(plan, { roots: [root], now: FIXED_NOW });
  assert.equal(result.status, "conflict");
  assert.equal(result.errors[0].code, "skill_removal_lock_drift");
  assert.deepEqual(result.backups, []);
  assert.equal(await exists(installDir), true);
  const current = JSON.parse(await readFile(lockFile, "utf8"));
  assert.equal(current.drifted, true);
  assert.ok("pi-delegate" in current.skills);
});

test("directory drift between plan and execution is refused before any mutation", async () => {
  const { root, installDir, lockFile, context } = await makeProject();
  const rawLock = await readFile(lockFile, "utf8");
  const plan = await planSkillRemoval({ scope: "project", context });
  assert.equal(plan.kind, "ready");

  await writeFile(join(installDir, "SKILL.md"), `${SKILL_BODY}local edit\n`);

  const result = await executeSkillRemoval(plan, { roots: [root], now: FIXED_NOW });
  assert.equal(result.status, "conflict");
  assert.equal(result.errors[0].code, "skill_removal_dir_drift");
  assert.deepEqual(result.backups, []);
  assert.equal(await exists(installDir), true);
  assert.equal(await readFile(lockFile, "utf8"), rawLock);
});

test("unrelated lock entries and top-level fields are preserved when removing pi-delegate", async () => {
  const lock = {
    version: 2,
    updatedAt: "2025-03-04T05:06:07.000Z",
    skills: {
      "pi-delegate": { source: "zguiyang/pi-task-exec", ref: "v0.3.1", installedBy: "skills-cli" },
      alpha: { source: "other/alpha", ref: "v1.0.0" },
      beta: { source: "other/beta", ref: "v2.0.0", extra: { nested: true } },
    },
    notes: { keep: ["a", "b"] },
  };
  const { root, installDir, lockFile, context } = await makeProject({ lock });
  const rawLock = await readFile(lockFile, "utf8");

  const plan = await planSkillRemoval({ scope: "project", context });
  assert.equal(plan.kind, "ready");
  const result = await executeSkillRemoval(plan, { roots: [root], now: FIXED_NOW });
  assert.equal(result.status, "success");

  const updated = JSON.parse(await readFile(lockFile, "utf8"));
  assert.ok(!("pi-delegate" in updated.skills));
  assert.deepEqual(Object.keys(updated.skills).sort(), ["alpha", "beta"]);
  assert.deepEqual(updated.skills.alpha, { source: "other/alpha", ref: "v1.0.0" });
  assert.deepEqual(updated.skills.beta, { source: "other/beta", ref: "v2.0.0", extra: { nested: true } });
  assert.equal(updated.version, 2);
  assert.equal(updated.updatedAt, "2025-03-04T05:06:07.000Z");
  assert.deepEqual(updated.notes, { keep: ["a", "b"] });

  // The backup keeps the original bytes, including the removed entry.
  const lockBackup = result.backups.find((entry) => entry.path === lockFile);
  assert.equal(await readFile(lockBackup.backupPath, "utf8"), rawLock);
  assert.equal(await exists(installDir), false);
});

test("a mutation failure rolls the lock file back and restores the skill directory", {
  skip: typeof process.getuid === "function" && process.getuid() === 0,
}, async () => {
  const { root, installDir, lockFile, context } = await makeProject();
  const rawLock = await readFile(lockFile, "utf8");
  const plan = await planSkillRemoval({ scope: "project", context });
  assert.equal(plan.kind, "ready");

  // Make directory removal fail after the lock write.
  await chmod(installDir, 0o555);
  try {
    const result = await executeSkillRemoval(plan, { roots: [root], now: FIXED_NOW });
    assert.equal(result.status, "failed");
    assert.equal(result.rollback, "restored");
    assert.equal(result.errors.length, 1);
    assert.equal(result.backups.length, 2);
    assert.equal(await readFile(lockFile, "utf8"), rawLock);
    assert.equal(await readFile(join(installDir, "SKILL.md"), "utf8"), SKILL_BODY);
  } finally {
    await chmod(installDir, 0o755);
  }
});

test("execution refuses targets outside the provided roots", async () => {
  const { root, installDir, lockFile, context } = await makeProject();
  const plan = await planSkillRemoval({ scope: "project", context });
  assert.equal(plan.kind, "ready");
  const elsewhere = await makeTempDirectory("pi-task-exec-removal-roots-");
  const result = await executeSkillRemoval(plan, { roots: [elsewhere], now: FIXED_NOW });
  assert.equal(result.status, "conflict");
  assert.deepEqual(result.backups, []);
  assert.equal(await exists(installDir), true);
  assert.equal(await exists(lockFile), true);
  assert.equal(await exists(elsewhere), true);
});
