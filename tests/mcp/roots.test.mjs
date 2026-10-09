import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { WorkerManager } from "../../dist/mcp/workers/manager.js";

test("Roots updates validate actual paths, fail closed, and preserve explicit restrictions", async () => {
  const old = process.env.PI_WORKER_ALLOWED_ROOTS;
  delete process.env.PI_WORKER_ALLOWED_ROOTS;
  const temp = await mkdtemp(join(tmpdir(), "pi-roots-"));
  try {
    const first = join(temp, "first"), second = join(temp, "second");
    await mkdir(first); await mkdir(second);
    const manager = new WorkerManager();
    await manager.refreshClientRoots(async () => [pathToFileURL(first).href]);
    assert.equal(await manager.assertAllowedDirectory(first), await realpath(first));
    await assert.rejects(manager.assertAllowedDirectory(second), /outside/);
    await symlink(second, join(first, "escape"), "dir");
    await assert.rejects(manager.assertAllowedDirectory(join(first, "escape")), /outside/);
    await manager.refreshClientRoots(async () => [pathToFileURL(second).href]);
    await assert.rejects(manager.assertAllowedDirectory(first), /outside/);
    await manager.assertAllowedDirectory(second);
    await assert.rejects(manager.refreshClientRoots(async () => ["https://example.com"]), /file URLs/);
    await assert.rejects(manager.assertAllowedDirectory(second), /file URLs/);
    await manager.refreshClientRoots(async () => []);
    await assert.rejects(manager.assertAllowedDirectory(second), /outside/);
    process.env.PI_WORKER_ALLOWED_ROOTS = first;
    const explicit = new WorkerManager();
    await explicit.refreshClientRoots(async () => { throw new Error("must not query Host roots"); });
    await explicit.assertAllowedDirectory(first);
    await assert.rejects(explicit.assertAllowedDirectory(second), /outside/);
    process.env.PI_WORKER_ALLOWED_ROOTS = "";
    const empty = new WorkerManager();
    await empty.refreshClientRoots(async () => [pathToFileURL(first).href]);
    await assert.rejects(empty.assertAllowedDirectory(first), /outside/);
  } finally {
    if (old === undefined) delete process.env.PI_WORKER_ALLOWED_ROOTS;
    else process.env.PI_WORKER_ALLOWED_ROOTS = old;
    await rm(temp, { recursive: true, force: true });
  }
});

test("late Roots responses cannot overwrite a newer directory list", async () => {
  const old = process.env.PI_WORKER_ALLOWED_ROOTS;
  delete process.env.PI_WORKER_ALLOWED_ROOTS;
  const temp = await mkdtemp(join(tmpdir(), "pi-roots-race-"));
  try {
    const manager = new WorkerManager();
    let finish;
    const slow = manager.refreshClientRoots(() => new Promise(resolve => { finish = resolve; }));
    await manager.refreshClientRoots(async () => []);
    finish([pathToFileURL(temp).href]);
    await slow;
    await assert.rejects(manager.assertAllowedDirectory(temp), /outside/);
  } finally {
    if (old === undefined) delete process.env.PI_WORKER_ALLOWED_ROOTS;
    else process.env.PI_WORKER_ALLOWED_ROOTS = old;
    await rm(temp, { recursive: true, force: true });
  }
});
