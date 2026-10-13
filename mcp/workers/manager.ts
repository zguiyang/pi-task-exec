import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { realpath, stat } from "node:fs/promises";
import { delimiter, isAbsolute, relative, resolve, sep } from "node:path";
import { PiRpcWorker } from "../rpc/pi-rpc.js";
import { toWorkerError, WorkerError } from "./errors.js";
import { CYCLE_TERMINAL_STATES, DEFAULT_WORKER_CONFIG } from "./types.js";
import type { WorkerConfig, WorkerProfile, WorkerSnapshot, WorkerThinkingLevel } from "./types.js";

/** Maximum pi_status wait window. Kept below common MCP Host request timeouts. */
export const MAX_STATUS_WAIT_MS = 30_000;

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
    maxRecentEvents: environmentNumber("PI_WORKER_MAX_RECENT_EVENTS", DEFAULT_WORKER_CONFIG.maxRecentEvents, 1, 1_000),
    maxResultChars: environmentNumber("PI_WORKER_MAX_RESULT_CHARS", DEFAULT_WORKER_CONFIG.maxResultChars),
    maxCycles: environmentNumber("PI_WORKER_MAX_CYCLES", DEFAULT_WORKER_CONFIG.maxCycles, 1, 1_000),
    maxArchivedWorkers: environmentNumber("PI_WORKER_MAX_ARCHIVED", DEFAULT_WORKER_CONFIG.maxArchivedWorkers, 1, 10_000),
  };
}

export interface StatusWaitOptions {
  waitMs?: number;
  cycleId?: number;
}

export class WorkerManager {
  /** Live worker objects. Removed as soon as the process is dead or released. */
  private readonly workers = new Map<string, PiRpcWorker>();
  /** Bounded terminal snapshots shared by reference so late lifecycle updates are visible. */
  private readonly archived = new Map<string, WorkerSnapshot>();
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

  async spawn(input: { task: string; cwd: string; profile?: WorkerProfile; taskTimeoutMs?: number | undefined; model?: string | undefined; thinking?: WorkerThinkingLevel | undefined }) {
    const profile: WorkerProfile = input.profile ?? "inspect";
    if (this.shuttingDown) throw new WorkerError("SERVER_SHUTTING_DOWN", "MCP server is shutting down and cannot start workers", "spawn");
    if (this.workers.size + this.spawning >= this.maxWorkers) {
      throw new WorkerError(
        "CAPACITY_EXCEEDED",
        `Maximum live worker count reached (${this.maxWorkers}). Use pi_list to inspect capacity, then pi_release an unnecessary settled worker before retrying.`,
        "spawn",
      );
    }
    this.spawning++;
    let reservationHeld = true;
    try {
      let workerCwd: string;
      try {
        workerCwd = await this.assertAllowedDirectory(input.cwd);
      } catch (error) {
        throw toWorkerError(error, "spawn", "INVALID_CWD");
      }
      if (this.shuttingDown) throw new WorkerError("SERVER_SHUTTING_DOWN", "MCP server is shutting down and cannot start workers", "spawn");
      const id = randomUUID();

      const now = new Date().toISOString();
      const snapshot: WorkerSnapshot = {
        id,
        task: input.task,
        cwd: workerCwd,
        profile,
        ...(input.model !== undefined ? { requestedModel: input.model } : {}),
        ...(input.thinking !== undefined ? { requestedThinking: input.thinking } : {}),
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
        cycleId: 0,
        cycles: [],
        released: false,
      };
      const args = ["--mode", "rpc", "--no-session"];
      args.push("--tools", profile === "inspect" ? "read,grep,find,ls" : "read,edit,write,bash,grep,find,ls");
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
      worker.setDeadHandler(() => {
        if (worker.isReleasing()) return;
        // Reap descendants before dropping the live object, then archive only
        // once the process is confirmed dead.
        worker.reapAfterExit();
        this.archive(worker);
      });
      this.spawning--;
      reservationHeld = false;
      try {
        await worker.ready();
        await worker.initializeModel(input.model, input.thinking);
        await worker.prompt(input.task);
        return worker.refresh();
      } catch (error) {
        await worker.release();
        if (!worker.isLive()) this.archive(worker);
        // Attach the worker id across the API boundary once a worker exists.
        throw toWorkerError(error, "runtime", "WORKER_ERROR", id);
      }
    } finally {
      if (reservationHeld) this.spawning--;
    }
  }

  status(id: string): WorkerSnapshot {
    const worker = this.workers.get(id);
    if (worker) return worker.refresh();
    const snapshot = this.archived.get(id);
    if (snapshot) return snapshot;
    throw new WorkerError("UNKNOWN_WORKER", `Unknown worker id: ${id}. Use pi_list to inspect available worker IDs.`, "runtime", id);
  }

  /**
   * Return immediately when `waitMs` is omitted/zero. Otherwise wait, event
   * driven, until the requested cycle settles or fails, the process dies, or
   * the bounded window expires. A wait timeout never cancels the worker.
   */
  async waitStatus(id: string, options: StatusWaitOptions = {}): Promise<WorkerSnapshot> {
    if (options.cycleId !== undefined && (!Number.isInteger(options.cycleId) || options.cycleId < 1)) {
      throw new WorkerError("INVALID_CYCLE_ID", "cycleId must be a positive integer", "runtime", id);
    }
    const worker = this.workers.get(id);
    if (!worker) {
      const snapshot = this.archived.get(id);
      if (snapshot) return snapshot;
      throw new WorkerError("UNKNOWN_WORKER", `Unknown worker id: ${id}. Use pi_list to inspect available worker IDs.`, "runtime", id);
    }
    const requested = options.waitMs ?? 0;
    const waitMs = Math.min(Math.max(Math.floor(requested), 0), MAX_STATUS_WAIT_MS);
    // When no cycleId is supplied, capture the cycle at entry so a later
    // pi_continue cannot make an earlier wait chase a newer cycle.
    const targetCycle = options.cycleId ?? worker.snapshot.cycleId;
    const deadline = Date.now() + waitMs;
    for (;;) {
      const snapshot = worker.refresh();
      if (this.waitSatisfied(snapshot, targetCycle)) return snapshot;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return snapshot;
      await worker.waitChange(remaining);
    }
  }

  list(): WorkerSnapshot[] {
    const snapshots = [
      ...[...this.workers.values()].map((worker) => worker.refresh()),
      ...this.archived.values(),
    ];
    return snapshots.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  }

  async steer(id: string, task: string): Promise<WorkerSnapshot> {
    const worker = this.requireLiveWorker(id, "steer");
    try {
      await worker.steer(task);
    } catch (error) {
      throw toWorkerError(error, "steer", "STEER_FAILED", id, true);
    }
    return worker.refresh();
  }

  async continue(id: string, task: string): Promise<WorkerSnapshot> {
    const worker = this.requireLiveWorker(id, "continue");
    try {
      await worker.followUp(task);
    } catch (error) {
      throw toWorkerError(error, "follow_up", "CONTINUE_FAILED", id, true);
    }
    return worker.refresh();
  }

  /** Cancellation only: stop the current activity cycle without releasing the process or slot. */
  async abort(id: string): Promise<WorkerSnapshot> {
    const worker = this.workers.get(id);
    if (worker) {
      try {
        const snapshot = await worker.abort();
        if (!worker.isLive()) this.archive(worker);
        return snapshot;
      } catch (error) {
        throw toWorkerError(error, "abort", "ABORT_FAILED", id, true);
      }
    }
    const snapshot = this.archived.get(id);
    if (snapshot) return snapshot;
    throw new WorkerError("UNKNOWN_WORKER", `Unknown worker id: ${id}. Use pi_list to inspect available worker IDs.`, "runtime", id);
  }

  /** Release the process and live slot. Preserves a completed cycle outcome. Idempotent and retryable. */
  async release(id: string): Promise<WorkerSnapshot> {
    const worker = this.workers.get(id);
    if (worker) {
      try {
        const snapshot = await worker.release();
        // Never archive a still-live worker: keep its slot occupied so release can be retried.
        if (!worker.isLive()) this.archive(worker);
        return snapshot;
      } catch (error) {
        throw toWorkerError(error, "release", "RELEASE_FAILED", id, true);
      }
    }
    const snapshot = this.archived.get(id);
    if (!snapshot) throw new WorkerError("UNKNOWN_WORKER", `Unknown worker id: ${id}. Use pi_list to inspect available worker IDs.`, "runtime", id);
    if (!snapshot.released) {
      snapshot.released = true;
      snapshot.releasedAt = new Date().toISOString();
      delete snapshot.releaseError;
    }
    return snapshot;
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    const shutDownWorkers = [...this.workers.values()];
    const results = await Promise.allSettled(shutDownWorkers.map((worker) => worker.shutdown()));
    for (const worker of shutDownWorkers) {
      if (!worker.isLive()) this.archive(worker);
    }
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected").map((result) => result.reason);
    // An unconfirmed termination must be reported, not silently ignored.
    const stillLive = shutDownWorkers.filter((worker) => worker.isLive());
    for (const worker of stillLive) {
      failures.push(new WorkerError("SHUTDOWN_INCOMPLETE", `Worker ${worker.snapshot.id} did not terminate during shutdown`, "shutdown", worker.snapshot.id));
    }
    if (failures.length > 0) throw new AggregateError(failures, "One or more Pi workers failed to shut down cleanly");
  }

  private waitSatisfied(snapshot: WorkerSnapshot, cycleId: number): boolean {
    if (cycleId === 0) return !snapshot.processAlive || snapshot.released;
    const archived = snapshot.cycles.find((cycle) => cycle.cycleId === cycleId);
    if (archived) return true;
    if (snapshot.cycleId > cycleId) return true;
    if (snapshot.cycleId === cycleId) {
      return CYCLE_TERMINAL_STATES.has(snapshot.state) || !snapshot.processAlive || snapshot.released;
    }
    // The requested cycle has not started yet. A dead or released worker can never start it.
    return !snapshot.processAlive || snapshot.released;
  }

  private requireLiveWorker(id: string, operation: string): PiRpcWorker {
    const worker = this.workers.get(id);
    if (worker) return worker;
    const snapshot = this.archived.get(id);
    if (snapshot) {
      if (snapshot.released) throw new WorkerError("WORKER_RELEASED", `Cannot ${operation}: worker ${id} was released. Start a new worker if more work is needed.`, "runtime", id);
      throw new WorkerError("WORKER_NOT_LIVE", `Cannot ${operation}: worker ${id} is no longer running. Inspect its archived result or start a new worker.`, "runtime", id);
    }
    throw new WorkerError("UNKNOWN_WORKER", `Unknown worker id: ${id}. Use pi_list to inspect available worker IDs.`, "runtime", id);
  }

  /**
   * Move a dead worker out of the live-object map, retaining only its bounded
   * snapshot. Refuses while the process is still alive so capacity tracking
   * stays truthful and a failed release can be retried.
   */
  private archive(worker: PiRpcWorker): void {
    if (worker.isLive()) return;
    const snapshot = worker.refresh();
    this.archived.set(snapshot.id, snapshot);
    this.workers.delete(snapshot.id);
    this.pruneArchived();
  }

  private pruneArchived(): void {
    if (this.archived.size <= this.config.maxArchivedWorkers) return;
    const ordered = [...this.archived.values()].sort(
      (a, b) => Date.parse(a.releasedAt ?? a.createdAt) - Date.parse(b.releasedAt ?? b.createdAt),
    );
    const excess = this.archived.size - this.config.maxArchivedWorkers;
    for (let index = 0; index < excess; index++) {
      const victim = ordered[index];
      if (victim) this.archived.delete(victim.id);
    }
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

}
