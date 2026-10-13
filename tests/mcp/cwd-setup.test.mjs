// Phase 1: the manager must run Pi in the canonical authorized cwd unchanged.
// It must never discover a Git project, create a worktree, or create a branch.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { afterEach, test } from "node:test";
import { mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { WorkerManager } from "../../dist/mcp/workers/manager.js";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const fakePi = fileURLToPath(new URL("./fixtures/fake-pi.mjs", import.meta.url));
const names = [
  "PI_WORKER_COMMAND", "PI_WORKER_RPC_TIMEOUT_MS", "PI_WORKER_IDLE_TIMEOUT_MS",
  "PI_WORKER_TASK_TIMEOUT_MS", "PI_WORKER_ABORT_GRACE_MS", "PI_WORKER_TERM_GRACE_MS",
  "PI_WORKER_MAX_RECENT_EVENTS", "PI_WORKER_ALLOWED_ROOTS", "PI_WORKER_MAX_WORKERS",
  "FAKE_PI_MODE", "FAKE_PI_MODELS", "FAKE_PI_DEFAULT_MODEL",
];
const prior = new Map(names.map((name) => [name, process.env[name]]));
let manager;

function configure(allowedRoot, values = {}) {
  process.env.PI_WORKER_COMMAND = fakePi;
  process.env.FAKE_PI_MODE = "normal";
  process.env.PI_WORKER_ALLOWED_ROOTS = allowedRoot;
  process.env.PI_WORKER_MAX_WORKERS = String(values.maxWorkers ?? 4);
  process.env.PI_WORKER_RPC_TIMEOUT_MS = "3000";
  process.env.PI_WORKER_IDLE_TIMEOUT_MS = "0";
  process.env.PI_WORKER_TASK_TIMEOUT_MS = "2000";
  process.env.PI_WORKER_ABORT_GRACE_MS = "50";
  process.env.PI_WORKER_TERM_GRACE_MS = "100";
  process.env.PI_WORKER_MAX_RECENT_EVENTS = "8";
  process.env.FAKE_PI_MODELS = JSON.stringify([{ provider: "local", id: "default" }]);
  process.env.FAKE_PI_DEFAULT_MODEL = JSON.stringify({ provider: "local", id: "default" });
  manager = new WorkerManager();
}

function git(repo, args) {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
}

async function makeRepo(base) {
  const repo = join(base, "repo");
  await mkdir(repo, { recursive: true });
  git(repo, ["init", "-q"]);
  git(repo, ["-c", "user.email=test@example.com", "-c", "user.name=Test", "commit", "-q", "--allow-empty", "-m", "init"]);
  return repo;
}

function worktreeState(repo) {
  return {
    worktrees: git(repo, ["worktree", "list", "--porcelain"]),
    branches: git(repo, ["branch", "--format=%(refname:short)"]),
  };
}

afterEach(async () => {
  await manager?.shutdown();
  manager = undefined;
  for (const name of names) {
    const value = prior.get(name);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

test("an ordinary non-git directory is used as the worker cwd without creating project scaffolding", async () => {
  const base = await mkdtemp(join(tmpdir(), "pi-cwd-ordinary-"));
  const plain = join(base, "plain");
  await mkdir(plain);
  configure(base);
  try {
    const worker = await manager.spawn({ task: "plain task", cwd: plain, profile: "inspect" });
    assert.equal(worker.cwd, await realpath(plain));
    assert.equal(worker.mode, undefined);
    assert.equal(existsSync(join(plain, ".pi-task-exec")), false);
    await manager.abort(worker.id);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("a Git project root is used in place: no worktree, no branch, no .pi-task-exec directory", async () => {
  const base = await mkdtemp(join(tmpdir(), "pi-cwd-root-"));
  configure(base);
  try {
    const repo = await makeRepo(base);
    const before = worktreeState(repo);
    const worker = await manager.spawn({ task: "root task", cwd: repo, profile: "implement" });
    assert.equal(worker.cwd, await realpath(repo));
    assert.equal(existsSync(join(repo, ".pi-task-exec")), false);
    assert.deepEqual(worktreeState(repo), before);
    await manager.abort(worker.id);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("a project subdirectory executes in place instead of discovering the Git top level", async () => {
  const base = await mkdtemp(join(tmpdir(), "pi-cwd-subdir-"));
  configure(base);
  try {
    const repo = await makeRepo(base);
    const sub = join(repo, "packages", "pkg");
    await mkdir(sub, { recursive: true });
    const worker = await manager.spawn({ task: "subdir task", cwd: sub, profile: "implement" });
    assert.equal(worker.cwd, await realpath(sub));
    assert.notEqual(worker.cwd, await realpath(repo));
    assert.equal(existsSync(join(repo, ".pi-task-exec")), false);
    await manager.abort(worker.id);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("an existing Git worktree is used exactly as given and no additional worktree or branch appears", async () => {
  const base = await mkdtemp(join(tmpdir(), "pi-cwd-worktree-"));
  configure(base);
  try {
    const repo = await makeRepo(base);
    const existing = join(base, "existing-wt");
    git(repo, ["worktree", "add", "-q", "-b", "feature/existing", existing]);
    const before = worktreeState(repo);
    const worker = await manager.spawn({ task: "existing worktree task", cwd: existing, profile: "implement" });
    assert.equal(worker.cwd, await realpath(existing));
    const after = worktreeState(repo);
    assert.deepEqual(after, before);
    assert.equal(after.branches.includes("feature/existing"), true);
    assert.equal(existsSync(join(existing, ".pi-task-exec")), false);
    await manager.abort(worker.id);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("a symlink that escapes the authorized root is rejected before Pi starts", async () => {
  if (process.platform === "win32") return;
  const base = await mkdtemp(join(tmpdir(), "pi-cwd-symlink-"));
  const allowed = join(base, "project");
  const outside = join(base, "outside");
  await Promise.all([mkdir(allowed), mkdir(outside)]);
  await symlink(outside, join(allowed, "escape"));
  configure(allowed);
  try {
    await assert.rejects(
      manager.spawn({ task: "symlink escape", cwd: join(allowed, "escape"), profile: "inspect" }),
      (error) => /outside PI_WORKER_ALLOWED_ROOTS/.test(error.message),
    );
    assert.equal(manager.list().length, 0);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("an unauthorized absolute directory is rejected and never spawns Pi", async () => {
  const base = await mkdtemp(join(tmpdir(), "pi-cwd-unauthorized-"));
  const allowed = join(base, "project");
  const outside = join(base, "outside");
  await Promise.all([mkdir(allowed), mkdir(outside)]);
  configure(allowed);
  try {
    await assert.rejects(
      manager.spawn({ task: "escape", cwd: outside, profile: "inspect" }),
      (error) => /outside PI_WORKER_ALLOWED_ROOTS/.test(error.message),
    );
    assert.equal(manager.list().length, 0);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("the concurrent worker capacity limit still applies with the cwd-only spawn contract", async () => {
  const base = await mkdtemp(join(tmpdir(), "pi-cwd-capacity-"));
  configure(base, { maxWorkers: 2 });
  try {
    const attempts = await Promise.allSettled([
      manager.spawn({ task: "one", cwd: base, profile: "inspect" }),
      manager.spawn({ task: "two", cwd: base, profile: "inspect" }),
      manager.spawn({ task: "three", cwd: base, profile: "inspect" }),
    ]);
    assert.equal(attempts.filter((result) => result.status === "fulfilled").length, 2);
    const rejected = attempts.find((result) => result.status === "rejected");
    assert.match(rejected.reason.message, /Maximum live worker count/);
    await Promise.all(attempts
      .filter((result) => result.status === "fulfilled")
      .map((result) => manager.abort(result.value.id)));
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});
