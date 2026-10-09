import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  SafetyError,
  assertManaged,
  assertPathWithinRoots,
  atomicWriteFile,
  backupFile,
  classifyContent,
  isWithin,
  removeFile,
  restoreBackup,
  sha256,
  snapshotFile,
} from "../../dist/cli/plan/safety.js";
import { executePlan } from "../../dist/cli/plan/executor.js";
import { spawnProcess } from "../../dist/cli/commands/doctor.js";

async function makeRoot() {
  return mkdtemp(join(tmpdir(), "pi-task-exec-safety-"));
}

function planWith({ creates = [], updates = [], removals = [], conflicts = [], unsupported = [], dryRun = false } = {}) {
  return {
    schema: "pi-task-exec.plan.v1",
    operation: "add",
    target: "skill",
    dryRun,
    createdAt: "2026-10-09T00:00:00.000Z",
    resolvedPaths: {},
    creates,
    updates,
    removals,
    conflicts,
    backups: [],
    warnings: [],
    unsupported,
    supported: unsupported.length === 0 && conflicts.length === 0,
  };
}

function write(path, content, baseSha256, kind = "create") {
  return { path, kind, target: "skill", content, baseSha256, summary: "test write" };
}

function removal(path, content, managedBy = "pi-task-exec") {
  return { path, target: "skill", managedBy, sha256: sha256(content), summary: "test removal" };
}

function execOptions(root, overrides = {}) {
  return {
    roots: [root],
    adapters: [],
    io: { stdout() {}, stderr() {} },
    yes: true,
    ...overrides,
  };
}

test("isWithin rejects lexical traversal and sibling prefixes", () => {
  assert.equal(isWithin("/a/b", "/a/b/c"), true);
  assert.equal(isWithin("/a/b", "/a/b"), true);
  assert.equal(isWithin("/a/b", "/a/bc"), false);
  assert.equal(isWithin("/a/b", "/a"), false);
  assert.equal(isWithin("/a/b", "/a/b/../c"), false);
});

test("assertPathWithinRoots blocks escape and symlink escape", async () => {
  const root = await makeRoot();
  const allowed = join(root, "inside", "file.txt");
  assert.equal(await assertPathWithinRoots(allowed, { roots: [root] }), allowed);

  const outside = await mkdtemp(join(tmpdir(), "pi-task-exec-outside-"));
  await assert.rejects(assertPathWithinRoots(join(outside, "file.txt"), { roots: [root] }), (error) => {
    assert.ok(error instanceof SafetyError);
    assert.equal(error.code, "path_escape");
    return true;
  });

  await symlink(outside, join(root, "link"));
  await assert.rejects(assertPathWithinRoots(join(root, "link", "file.txt"), { roots: [root] }), (error) => {
    assert.equal(error.code, "symlink_escape");
    return true;
  });
});

test("atomicWriteFile writes content, leaves no temp file, and preserves mode", async () => {
  const root = await makeRoot();
  const path = join(root, "nested", "config.json");
  await atomicWriteFile(path, "first", { roots: [root] });
  assert.equal(await readFile(path, "utf8"), "first");
  await chmod(path, 0o600);

  await atomicWriteFile(path, "second", { roots: [root] });
  assert.equal(await readFile(path, "utf8"), "second");
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  const entries = await readdir(join(root, "nested"));
  assert.deepEqual(entries, ["config.json"], "no temporary file should remain");
});

test("atomicWriteFile refuses to replace a symlink target", async () => {
  const root = await makeRoot();
  await writeFile(join(root, "victim.txt"), "victim");
  await symlink(join(root, "victim.txt"), join(root, "link.txt"));
  await assert.rejects(atomicWriteFile(join(root, "link.txt"), "attacker", { roots: [root] }), (error) => {
    assert.equal(error.code, "symlink_target");
    return true;
  });
  assert.equal(await readFile(join(root, "victim.txt"), "utf8"), "victim");
});

test("classifyContent distinguishes missing, unchanged, and different", async () => {
  const root = await makeRoot();
  const path = join(root, "file.txt");
  assert.equal(await classifyContent(path, "x"), "missing");
  await writeFile(path, "x");
  assert.equal(await classifyContent(path, "x"), "unchanged");
  assert.equal(await classifyContent(path, "y"), "different");
});

test("backupFile and restoreBackup round-trip content", async () => {
  const root = await makeRoot();
  const path = join(root, "file.txt");
  await writeFile(path, "original");
  const backup = await backupFile(path, { roots: [root], now: () => new Date("2026-10-09T00:00:00.000Z") });
  assert.equal(backup.existed, true);
  assert.ok(backup.backupPath);
  assert.equal(await readFile(backup.backupPath, "utf8"), "original");
  await writeFile(path, "changed");
  await restoreBackup(backup.backupPath, path, { roots: [root] });
  assert.equal(await readFile(path, "utf8"), "original");
});

test("managed removal requires ownership and an unchanged hash", async () => {
  const root = await makeRoot();
  const path = join(root, "managed.txt");
  await writeFile(path, "managed-content");
  const current = await snapshotFile(path);
  assertManaged({ path, sha256: sha256("managed-content"), managedBy: "pi-task-exec" }, current);
  await removeFile(path, { roots: [root] });
  await assert.rejects(lstat(path));

  await writeFile(path, "drifted");
  await assert.rejects(async () => {
    assertManaged({ path, sha256: sha256("managed-content"), managedBy: "pi-task-exec" }, await snapshotFile(path));
  }, (error) => {
    assert.equal(error.code, "managed_content_drifted");
    return true;
  });

  await assert.rejects(async () => {
    assertManaged({ path, sha256: sha256("drifted"), managedBy: "someone-else" }, await snapshotFile(path));
  }, (error) => {
    assert.equal(error.code, "not_managed");
    return true;
  });
});

test("executor dry-run performs no write", async () => {
  const root = await makeRoot();
  const path = join(root, "file.txt");
  const result = await executePlan(planWith({ dryRun: true, creates: [write(path, "content", null)] }), execOptions(root));
  assert.equal(result.status, "dry-run");
  await assert.rejects(lstat(path));
});

test("executor creates and updates files atomically", async () => {
  const root = await makeRoot();
  const created = join(root, "created.txt");
  const updated = join(root, "updated.txt");
  await writeFile(updated, "old");
  const result = await executePlan(
    planWith({
      creates: [write(created, "fresh", null)],
      updates: [write(updated, "new", sha256("old"), "update")],
    }),
    execOptions(root),
  );
  assert.equal(result.status, "success");
  assert.equal(await readFile(created, "utf8"), "fresh");
  assert.equal(await readFile(updated, "utf8"), "new");
});

test("executor is idempotent when the desired content already matches", async () => {
  const root = await makeRoot();
  const path = join(root, "file.txt");
  await writeFile(path, "same");
  const result = await executePlan(planWith({ updates: [write(path, "same", sha256("same"), "update")] }), execOptions(root));
  assert.equal(result.status, "no-op");
  assert.equal(await readFile(path, "utf8"), "same");
});

test("executor stops on a stale base hash before writing anything", async () => {
  const root = await makeRoot();
  const path = join(root, "file.txt");
  await writeFile(path, "changed-under-us");
  const result = await executePlan(planWith({ updates: [write(path, "new", sha256("expected-base"), "update")] }), execOptions(root));
  assert.equal(result.status, "conflict");
  assert.equal(result.errors[0].code, "plan_stale");
  assert.equal(await readFile(path, "utf8"), "changed-under-us");
});

test("executor rolls back created files after a failure", async () => {
  const root = await makeRoot();
  const path = join(root, "file.txt");
  const result = await executePlan(
    planWith({ creates: [write(path, "content", null)] }),
    execOptions(root, {
      afterWrite: async () => {
        throw new SafetyError("test_failure", "forced failure");
      },
    }),
  );
  assert.equal(result.status, "failed");
  assert.equal(result.rollback, "restored");
  await assert.rejects(lstat(path));
});

test("executor rolls back updated files to their backup after a failure", async () => {
  const root = await makeRoot();
  const path = join(root, "file.txt");
  await writeFile(path, "original");
  const result = await executePlan(
    planWith({ updates: [write(path, "new", sha256("original"), "update")] }),
    execOptions(root, {
      afterWrite: async () => {
        throw new SafetyError("test_failure", "forced failure");
      },
    }),
  );
  assert.equal(result.status, "failed");
  assert.equal(result.rollback, "restored");
  assert.equal(await readFile(path, "utf8"), "original");
});

test("executor skips rollback when managed content has drifted", async () => {
  const root = await makeRoot();
  const path = join(root, "file.txt");
  const result = await executePlan(
    planWith({ creates: [write(path, "our-content", null)] }),
    execOptions(root, {
      afterWrite: async () => {
        await writeFile(path, "tampered");
        throw new SafetyError("test_failure", "forced failure");
      },
    }),
  );
  assert.equal(result.status, "failed");
  assert.equal(result.rollback, "skipped");
  assert.equal(await readFile(path, "utf8"), "tampered");
  assert.ok(result.warnings.some((warning) => warning.includes("drifted")));
});

test("executor removes only managed, unchanged files and blocks drifted removals", async () => {
  const root = await makeRoot();
  const managed = join(root, "managed.txt");
  await writeFile(managed, "managed");
  const ok = await executePlan(planWith({ removals: [removal(managed, "managed")] }), execOptions(root));
  assert.equal(ok.status, "success");
  await assert.rejects(lstat(managed));

  const drifted = join(root, "drifted.txt");
  await writeFile(drifted, "user-change");
  const blocked = await executePlan(planWith({ removals: [removal(drifted, "managed")] }), execOptions(root));
  assert.equal(blocked.status, "conflict");
  assert.equal(blocked.errors[0].code, "managed_content_drifted");
  assert.equal(await readFile(drifted, "utf8"), "user-change");
});

test("spawnProcess passes arguments structurally and never through a shell", async () => {
  const result = await spawnProcess(process.execPath, ["-e", "console.log(process.argv.slice(1).join('|'))", "a b", "$(echo hi)"], {
    timeoutMs: 5_000,
    env: {},
  });
  assert.equal(result.code, 0);
  assert.equal(result.stdout.trim(), "a b|$(echo hi)");
});

test("safety roots are injectable across separate temp roots", async () => {
  const root = await makeRoot();
  const other = await mkdtemp(join(tmpdir(), "pi-task-exec-other-"));
  await mkdir(join(root, "sub"), { recursive: true });
  assert.ok((await assertPathWithinRoots(join(root, "sub", "x"), { roots: [root] })).endsWith("x"));
  await assert.rejects(assertPathWithinRoots(join(other, "x"), { roots: [root] }), (error) => {
    assert.equal(error.code, "path_escape");
    return true;
  });
});

test("executor blocks every write when a file changes during confirmation", async () => {
  const root = await makeRoot();
  const stable = join(root, "stable.txt");
  const changed = join(root, "changed.txt");
  await writeFile(stable, "stable-original");
  await writeFile(changed, "changed-original");
  const result = await executePlan(
    planWith({
      updates: [
        write(stable, "stable-new", sha256("stable-original"), "update"),
        write(changed, "changed-new", sha256("changed-original"), "update"),
      ],
    }),
    execOptions(root, {
      yes: false,
      confirm: async () => {
        // The user edits a file while the confirmation prompt is open.
        await writeFile(changed, "changed-during-confirm");
        return true;
      },
    }),
  );
  assert.equal(result.status, "conflict");
  assert.equal(result.errors[0].code, "plan_stale");
  assert.deepEqual(result.performed, [], "no write may survive a post-confirmation stale plan");
  assert.equal(await readFile(stable, "utf8"), "stable-original");
  assert.equal(await readFile(changed, "utf8"), "changed-during-confirm");
});

test("executor never overwrites a file created after planning", async () => {
  const root = await makeRoot();
  const path = join(root, "late.txt");
  const plan = planWith({ creates: [write(path, "planned-content", null)] });
  // The file did not exist when the plan was generated.
  await writeFile(path, "created-later");
  const result = await executePlan(plan, execOptions(root));
  assert.equal(result.status, "conflict");
  assert.equal(result.errors[0].code, "plan_stale");
  assert.equal(await readFile(path, "utf8"), "created-later");
});

test("executor refuses a file created during the confirmation window", async () => {
  const root = await makeRoot();
  const path = join(root, "late-confirm.txt");
  const result = await executePlan(
    planWith({ creates: [write(path, "planned-content", null)] }),
    execOptions(root, {
      yes: false,
      confirm: async () => {
        await writeFile(path, "created-during-confirm");
        return true;
      },
    }),
  );
  assert.equal(result.status, "conflict");
  assert.equal(result.errors[0].code, "plan_stale");
  assert.equal(await readFile(path, "utf8"), "created-during-confirm");
});

test("executor rollback restores original bytes and mode after an update failure", async () => {
  const root = await makeRoot();
  const path = join(root, "file.txt");
  await writeFile(path, "original");
  await chmod(path, 0o600);
  const result = await executePlan(
    planWith({ updates: [write(path, "new", sha256("original"), "update")] }),
    execOptions(root, {
      afterWrite: async () => {
        throw new SafetyError("test_failure", "forced failure");
      },
    }),
  );
  assert.equal(result.status, "failed");
  assert.equal(result.rollback, "restored");
  assert.equal(await readFile(path, "utf8"), "original");
  assert.equal((await stat(path)).mode & 0o777, 0o600);
});

test("executor restores a removed managed file when a later removal fails", async () => {
  const root = await makeRoot();
  const trigger = join(root, "trigger.txt");
  const first = join(root, "first.txt");
  const second = join(root, "second.txt");
  await writeFile(first, "first-content");
  await writeFile(second, "second-content");
  const result = await executePlan(
    planWith({
      creates: [write(trigger, "trigger-content", null)],
      removals: [removal(first, "first-content"), removal(second, "second-content")],
    }),
    execOptions(root, {
      afterWrite: async () => {
        // External drift between preflight and the second removal.
        await writeFile(second, "drifted-after-preflight");
      },
    }),
  );
  assert.equal(result.status, "failed");
  assert.equal(result.rollback, "restored");
  // The removed managed file comes back with its original bytes ...
  assert.equal(await readFile(first, "utf8"), "first-content");
  // ... the created trigger is deleted ...
  await assert.rejects(lstat(trigger));
  // ... and the externally drifted file is left untouched.
  assert.equal(await readFile(second, "utf8"), "drifted-after-preflight");
});

test("executor preserves a drifted created file and reports skipped rollback", async () => {
  const root = await makeRoot();
  const path = join(root, "created.txt");
  const result = await executePlan(
    planWith({ creates: [write(path, "our-content", null)] }),
    execOptions(root, {
      afterWrite: async () => {
        await writeFile(path, "external-edit");
        throw new SafetyError("test_failure", "forced failure");
      },
    }),
  );
  assert.equal(result.status, "failed");
  assert.equal(result.rollback, "skipped");
  assert.equal(await readFile(path, "utf8"), "external-edit");
  assert.ok(result.warnings.some((warning) => warning.includes("drifted")));
});

test("snapshotFile only treats ENOENT as missing and rejects non-regular files", async () => {
  const root = await makeRoot();
  assert.equal(await snapshotFile(join(root, "missing.txt")), null);

  const directory = join(root, "directory");
  await mkdir(directory);
  await assert.rejects(snapshotFile(directory), (error) => {
    assert.ok(error instanceof SafetyError);
    assert.equal(error.code, "not_regular_file");
    return true;
  });
  await assert.rejects(snapshotFile(root), (error) => error.code === "not_regular_file");
});

test("executor refuses a non-regular planned path without overwriting it", async () => {
  const root = await makeRoot();
  const directory = join(root, "config");
  await mkdir(directory);
  await writeFile(join(directory, "keep.txt"), "keep");

  // A create with no base hash owns an absent path. A directory at that path
  // must never be mistaken for "missing" and replaced.
  const result = await executePlan(planWith({ creates: [write(directory, "planned-content", null)] }), execOptions(root));
  assert.equal(result.status, "conflict");
  assert.equal(result.errors[0].code, "not_regular_file");
  assert.equal((await stat(directory)).isDirectory(), true);
  assert.equal(await readFile(join(directory, "keep.txt"), "utf8"), "keep");
});

test("executor skips rollback when an updated file is edited by the user", async () => {
  const root = await makeRoot();
  const path = join(root, "file.txt");
  await writeFile(path, "original");
  const result = await executePlan(
    planWith({ updates: [write(path, "new", sha256("original"), "update")] }),
    execOptions(root, {
      afterWrite: async () => {
        await writeFile(path, "user-edit");
        throw new SafetyError("test_failure", "forced failure");
      },
    }),
  );
  assert.equal(result.status, "failed");
  assert.equal(result.rollback, "skipped");
  assert.equal(await readFile(path, "utf8"), "user-edit");
  assert.ok(result.warnings.some((warning) => warning.includes("updated content drifted")));
});

test("executor skips rollback when an updated file was removed by the user", async () => {
  const root = await makeRoot();
  const path = join(root, "file.txt");
  await writeFile(path, "original");
  const result = await executePlan(
    planWith({ updates: [write(path, "new", sha256("original"), "update")] }),
    execOptions(root, {
      afterWrite: async () => {
        await rm(path);
        throw new SafetyError("test_failure", "forced failure");
      },
    }),
  );
  assert.equal(result.status, "failed");
  assert.equal(result.rollback, "skipped");
  await assert.rejects(lstat(path));
  assert.ok(result.warnings.some((warning) => warning.includes("missing")));
});

test("executor skips rollback when a file reappears at a removed path", async () => {
  const root = await makeRoot();
  const first = join(root, "first.txt");
  const second = join(root, "second.txt");
  await writeFile(first, "first-content");
  await writeFile(second, "second-content");
  let clockCalls = 0;
  const result = await executePlan(
    planWith({ removals: [removal(first, "first-content"), removal(second, "second-content")] }),
    execOptions(root, {
      now: () => {
        clockCalls += 1;
        if (clockCalls === 2) {
          // The user recreates the already-removed file while the second
          // removal is being prepared, then that removal fails.
          writeFileSync(first, "recreated-by-user");
          throw new SafetyError("test_failure", "forced failure during second removal");
        }
        return new Date("2026-10-09T00:00:00.000Z");
      },
    }),
  );
  assert.equal(result.status, "failed");
  assert.equal(result.rollback, "skipped");
  assert.equal(await readFile(first, "utf8"), "recreated-by-user");
  assert.ok(result.warnings.some((warning) => warning.includes("reappeared")));
});

test("backupFile never overwrites an earlier backup for the same timestamp", async () => {
  const root = await makeRoot();
  const path = join(root, "file.txt");
  const now = () => new Date("2026-10-09T00:00:00.000Z");
  await writeFile(path, "v1");
  const first = await backupFile(path, { roots: [root], now });
  await writeFile(path, "v2");
  const second = await backupFile(path, { roots: [root], now });
  assert.ok(first.backupPath && second.backupPath);
  assert.notEqual(first.backupPath, second.backupPath, "same-timestamp backups must not collide");
  assert.equal(await readFile(first.backupPath, "utf8"), "v1");
  assert.equal(await readFile(second.backupPath, "utf8"), "v2");
  assert.equal(await readFile(path, "utf8"), "v2");
});

test("backupFile and restoreBackup validate every path against the allowed roots", async () => {
  const root = await makeRoot();
  const outside = await mkdtemp(join(tmpdir(), "pi-task-exec-backup-outside-"));
  const path = join(root, "file.txt");
  await writeFile(path, "data");

  await assert.rejects(backupFile(path, { roots: [root], backupDir: outside }), (error) => error.code === "path_escape");
  await assert.rejects(backupFile(join(outside, "file.txt"), { roots: [root] }), (error) => error.code === "path_escape");

  const backup = await backupFile(path, { roots: [root] });
  await assert.rejects(restoreBackup(join(outside, "missing.bak"), path, { roots: [root] }), (error) => error.code === "path_escape");
  await assert.rejects(restoreBackup(backup.backupPath, join(outside, "victim.txt"), { roots: [root] }), (error) => error.code === "path_escape");
});

test("restoreBackup refuses a symlinked target and leaves the victim intact", async () => {
  const root = await makeRoot();
  const path = join(root, "file.txt");
  const victim = join(root, "victim.txt");
  await writeFile(path, "original");
  await writeFile(victim, "victim");
  const backup = await backupFile(path, { roots: [root] });
  await rm(path);
  await symlink(victim, path);
  await assert.rejects(restoreBackup(backup.backupPath, path, { roots: [root] }), (error) => error.code === "symlink_target");
  assert.equal(await readFile(victim, "utf8"), "victim");
});
