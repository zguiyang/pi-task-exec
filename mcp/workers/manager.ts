import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { mkdir, realpath, stat } from "node:fs/promises";
import { delimiter, isAbsolute, join, relative, resolve, sep } from "node:path";
import { PiRpcWorker } from "../rpc/pi-rpc.js";
import type { WorkerConfig, WorkerMode, WorkerProfile, WorkerSnapshot } from "./types.js";
import { DEFAULT_WORKER_CONFIG } from "./types.js";

function environmentNumber(name: string, fallback: number, minimum = 1, maximum = 2_147_000_000): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed >= minimum ? Math.min(Math.floor(parsed), maximum) : fallback;
}

function readConfig(): WorkerConfig {
  const legacyTaskTimeout = environmentNumber("PI_WORKER_TIMEOUT_MS", DEFAULT_WORKER_CONFIG.taskTimeoutMs);
  return {
    rpcTimeoutMs: environmentNumber("PI_WORKER_RPC_TIMEOUT_MS", DEFAULT_WORKER_CONFIG.rpcTimeoutMs),
    idleTimeoutMs: environmentNumber("PI_WORKER_IDLE_TIMEOUT_MS", DEFAULT_WORKER_CONFIG.idleTimeoutMs, 0),
    taskTimeoutMs: environmentNumber("PI_WORKER_TASK_TIMEOUT_MS", legacyTaskTimeout),
    abortGraceMs: environmentNumber("PI_WORKER_ABORT_GRACE_MS", DEFAULT_WORKER_CONFIG.abortGraceMs, 0),
    termGraceMs: environmentNumber("PI_WORKER_TERM_GRACE_MS", DEFAULT_WORKER_CONFIG.termGraceMs, 0),
    worktreeSetupTimeoutMs: environmentNumber("PI_WORKER_WORKTREE_TIMEOUT_MS", DEFAULT_WORKER_CONFIG.worktreeSetupTimeoutMs),
    maxRecentEvents: environmentNumber("PI_WORKER_MAX_RECENT_EVENTS", DEFAULT_WORKER_CONFIG.maxRecentEvents, 1, 1_000),
  };
}

export class WorkerManager {
  private readonly workers = new Map<string, PiRpcWorker>();
  private readonly config = readConfig();
  private readonly maxWorkers = environmentNumber("PI_WORKER_MAX_WORKERS", 4);
  private readonly allowedRootsSetting = process.env.PI_WORKER_ALLOWED_ROOTS;
  private clientRoots: string[] | undefined;
  private rootsPending: Promise<void> = Promise.resolve();
  private rootsRevision = 0;
  private shuttingDown = false;
  private spawning = 0;

  /** Explicit user roots always win. A Roots failure must not widen access. */
  refreshClientRoots(load: () => Promise<readonly string[]>): Promise<void> {
    if (this.allowedRootsSetting !== undefined) return Promise.resolve();
    const revision = ++this.rootsRevision;
    this.clientRoots = [];
    const pending = (async () => {
      const uris = await load();
      const roots = await Promise.all(uris.map(async (uri) => {
        const url = new URL(uri);
        if (url.protocol !== "file:" || url.search || url.hash) throw new Error("MCP Roots must be local file URLs");
        const root = await realpath(fileURLToPath(url));
        if (!(await stat(root)).isDirectory()) throw new Error("MCP Roots must be existing directories");
        return root;
      }));
      if (revision === this.rootsRevision) this.clientRoots = roots;
    })();
    this.rootsPending = pending;
    return pending;
  }

  async spawn(input: { task: string; cwd: string; mode: WorkerMode; profile: WorkerProfile; taskTimeoutMs?: number | undefined; model?: string | undefined }) {
    if (this.shuttingDown) throw new Error("MCP server is shutting down and cannot start workers");
    const active = [...this.workers.values()].filter((worker) => worker.isLive()).length;
    if (active + this.spawning >= this.maxWorkers) {
      throw new Error(`Maximum live worker count reached (${this.maxWorkers}). Use pi_list to inspect capacity, then pi_abort an unnecessary settled worker before retrying.`);
    }
    this.spawning++;
    let reservationHeld = true;
    try {
      const sourceCwd = await this.assertAllowedDirectory(input.cwd);
      if (this.shuttingDown) throw new Error("MCP server is shutting down and cannot start workers");
      const id = randomUUID();
      let workerCwd = sourceCwd;
      if (input.mode === "worktree") workerCwd = await this.createWorktree(sourceCwd, id);
      if (this.shuttingDown) throw new Error("MCP server is shutting down and cannot start workers");

      const now = new Date().toISOString();
      const snapshot: WorkerSnapshot = {
        id,
        task: input.task,
        cwd: workerCwd,
        mode: input.mode,
        profile: input.profile,
        ...(input.model !== undefined ? { requestedModel: input.model } : {}),
        sessionMode: "no-session",
        status: "starting",
        state: "starting",
        processAlive: false,
        createdAt: now,
        updatedAt: now,
        lastActivityAt: now,
        taskTimeoutMs: input.taskTimeoutMs ?? this.config.taskTimeoutMs,
        pendingFollowUps: 0,
        elapsedMs: 0,
        recentEvents: [],
        lastOutput: "",
      };
      const args = ["--mode", "rpc", "--no-session"];
      args.push("--tools", input.profile === "inspect" ? "read,grep,find,ls" : "read,edit,write,bash,grep,find,ls");
      const workerConfig = {
        ...this.config,
        taskTimeoutMs: input.taskTimeoutMs ?? this.config.taskTimeoutMs,
      };
      const worker = new PiRpcWorker(snapshot, {
        command: process.env.PI_WORKER_COMMAND || "pi",
        args,
        cwd: workerCwd,
        config: workerConfig,
      });
      this.workers.set(id, worker);
      this.spawning--;
      reservationHeld = false;
      try {
        await worker.ready();
        await worker.initializeModel(input.model);
        await worker.prompt(input.task);
        return worker.refresh();
      } catch (error) {
        if (worker.isLive() && !worker.isTerminal()) await worker.abort();
        throw error;
      }
    } finally {
      if (reservationHeld) this.spawning--;
    }
  }

  status(id: string): WorkerSnapshot {
    return this.getWorker(id).refresh();
  }

  list(): WorkerSnapshot[] {
    return [...this.workers.values()]
      .map((worker) => worker.refresh())
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  }

  async steer(id: string, task: string): Promise<WorkerSnapshot> {
    const worker = this.getWorker(id);
    await worker.steer(task);
    return worker.refresh();
  }

  async continue(id: string, task: string): Promise<WorkerSnapshot> {
    const worker = this.getWorker(id);
    await worker.followUp(task);
    return worker.refresh();
  }

  async abort(id: string): Promise<WorkerSnapshot> {
    const worker = this.getWorker(id);
    await worker.abort();
    return worker.refresh();
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    const results = await Promise.allSettled([...this.workers.values()].map((worker) => worker.shutdown()));
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failures.length > 0) throw new AggregateError(failures.map((result) => result.reason), "One or more Pi workers failed to shut down cleanly");
  }

  private getWorker(id: string): PiRpcWorker {
    const worker = this.workers.get(id);
    if (!worker) throw new Error(`Unknown worker id: ${id}. Use pi_list to inspect available worker IDs.`);
    return worker;
  }

  private async assertAllowedDirectory(rawPath: string): Promise<string> {
    if (!isAbsolute(rawPath)) throw new Error("cwd must be an absolute path");
    const target = await realpath(rawPath);
    if (!(await stat(target)).isDirectory()) throw new Error("cwd must be a directory");
    if (this.allowedRootsSetting === undefined) await this.rootsPending;
    const configured = this.allowedRootsSetting?.split(delimiter).filter(Boolean) ?? this.clientRoots ?? [process.cwd()];
    const roots = await Promise.all(configured.map((root) => realpath(resolve(root))));
    if (!roots.some((root) => this.isInside(root, target))) {
      throw new Error(`cwd is outside PI_WORKER_ALLOWED_ROOTS: ${target}. Choose a directory inside an allowed root or configure PI_WORKER_ALLOWED_ROOTS before spawning.`);
    }
    return target;
  }

  private isInside(root: string, target: string): boolean {
    const rel = relative(root, target);
    return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
  }

  private async createWorktree(sourceCwd: string, id: string): Promise<string> {
    const timeout = this.config.worktreeSetupTimeoutMs;
    const topLevel = execFileSync("git", ["-C", sourceCwd, "rev-parse", "--show-toplevel"], { encoding: "utf8", timeout }).trim();
    const prefix = execFileSync("git", ["-C", sourceCwd, "rev-parse", "--show-prefix"], { encoding: "utf8", timeout }).trim();
    const safeId = id.replaceAll("-", "").slice(0, 12);
    const base = join(topLevel, ".pi-task-exec", "worktrees");
    const path = join(base, safeId);
    const branch = `pi-task-exec/${safeId}`;
    await mkdir(base, { recursive: true });
    if (this.shuttingDown) throw new Error("MCP server is shutting down and cannot start workers");
    execFileSync("git", ["-C", topLevel, "worktree", "add", "-b", branch, path, "HEAD"], { stdio: "pipe", timeout });
    return prefix ? join(path, prefix) : path;
  }
}
