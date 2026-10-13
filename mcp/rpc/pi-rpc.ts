import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { redactSecrets } from "../workers/redact.js";
import {
  CYCLE_TERMINAL_STATES,
  FAILURE_STATES,
  type FailurePhase,
  type WorkerConfig,
  type WorkerCycle,
  type WorkerEvent,
  type WorkerFailure,
  type WorkerResult,
  type WorkerSnapshot,
  type WorkerStatus,
} from "../workers/types.js";

interface RpcResponse {
  type: "response";
  id: string;
  command?: string;
  success: boolean;
  error?: string;
  data?: unknown;
}

interface PendingRequest {
  command: string;
  resolve: (response: RpcResponse) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

const OUTPUT_LIMIT = 12_000;

export class RpcError extends Error {
  readonly code: string;
  readonly phase: FailurePhase | undefined;

  constructor(code: string, message: string, phase?: FailurePhase) {
    super(redactSecrets(message));
    this.name = "RpcError";
    this.code = code;
    this.phase = phase;
  }
}

interface PiModelIdentity {
  provider: string;
  id: string;
}

function modelIdentity(value: unknown): PiModelIdentity | undefined {
  if (!value || typeof value !== "object") return undefined;
  const model = value as Record<string, unknown>;
  return typeof model.provider === "string" && typeof model.id === "string"
    ? { provider: model.provider, id: model.id }
    : undefined;
}

function canonicalModel(model: PiModelIdentity): string {
  return `${model.provider}/${model.id}`;
}

/** Extract the text parts of a finalized assistant message. Only `text` parts count. */
function assistantMessageText(message: unknown): string {
  if (!message || typeof message !== "object") return "";
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let text = "";
  for (const part of content) {
    if (part && typeof part === "object" && (part as { type?: unknown }).type === "text") {
      const value = (part as { text?: unknown }).text;
      if (typeof value === "string") text += value;
    }
  }
  return text;
}

/**
 * A single long-lived Pi RPC process. Task cycles and process lifecycle are
 * deliberately separate:
 *  - a cycle is one full Pi activity run, from a prompt/settled-follow-up that
 *    actually starts a run through Pi's `agent_settled` boundary. A running
 *    follow-up or steering message is delivered inside the same cycle;
 *  - `abort()` cancels the open cycle but keeps the process alive;
 *  - `release()` terminates the process and frees the worker's live slot.
 */
export class PiRpcWorker {
  readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly decoder = new StringDecoder("utf8");
  private readonly waiters = new Set<() => void>();
  private buffered = "";
  private output = "";
  private closed = false;
  private expectedExit = false;
  private releasing = false;
  private terminationPromise: Promise<WorkerSnapshot> | undefined;
  private terminationTarget: WorkerStatus | undefined;
  private terminationCode: string | undefined;
  private terminationMessage: string | undefined;
  private terminationPhase: FailurePhase = "runtime";
  private abortPromise: Promise<WorkerSnapshot> | undefined;
  private releasePromise: Promise<WorkerSnapshot> | undefined;
  private deadHandler: (() => void) | undefined;
  private readonly config: WorkerConfig;
  private taskTimer: NodeJS.Timeout | undefined;
  private idleTimer: NodeJS.Timeout | undefined;
  private stdoutCloseTimer: NodeJS.Timeout | undefined;
  /** Serializes all lifecycle mutations so cycles cannot overlap and release cannot race a continue. */
  private mutations: Promise<unknown> = Promise.resolve();

  // Activity-cycle state. `cycleOpen` is true between an actual run start and Pi's agent_settled.
  private cycleOpen = false;
  private cycleOperation: string | undefined;
  private finalAssistantText = "";
  private finalAssistantStopReason: string | undefined;
  private finalAssistantErrorMessage: string | undefined;
  private agentError: { code: string; message: string } | undefined;
  private pendingCycleFailure: { code: string; message: string; phase: FailurePhase; state: WorkerStatus } | undefined;
  private abortRequested = false;

  private readonly onSpawn = () => {
    if (this.child.pid !== undefined) this.snapshot.pid = this.child.pid;
    this.snapshot.startedAt = new Date().toISOString();
    this.recordEvent("process_started", `Pi process ${this.child.pid ?? "unknown"} started`);
    if (this.expectedExit || this.isProcessGone()) {
      this.signalProcessGroup("SIGKILL");
      return;
    }
    this.transition("running");
  };

  private readonly onExit = (code: number | null, signal: NodeJS.Signals | null) => {
    this.closed = true;
    this.clearTimers();
    if (code !== null) this.snapshot.exitCode = code;
    if (signal) this.snapshot.signal = signal;
    this.failPending(new RpcError("PROCESS_EXITED", `Pi exited${signal ? ` after ${signal}` : ` with code ${String(code)}`}`, "runtime"));
    this.recordEvent("process_exit", signal ? `Pi exited after ${signal}` : `Pi exited with code ${String(code)}`);
    this.snapshot.terminatedAt = new Date().toISOString();

    if (this.terminationPromise && this.terminationTarget) {
      this.finalizeTermination(
        this.terminationTarget,
        this.terminationCode ?? "PROCESS_EXITED",
        this.terminationMessage ?? "Pi process exited",
        this.terminationPhase,
      );
    } else if (this.releasing) {
      // release() owns the final snapshot and marks the worker released.
    } else if (this.cycleOpen && this.abortRequested) {
      // Pi exited in response to an abort request; the cycle is a cancellation, not a crash.
      this.closeCycle("aborted");
      this.transition("aborted", "ABORTED", "Worker aborted");
    } else if (this.cycleOpen) {
      const failure = this.makeFailure("PROCESS_CRASHED", `Pi process exited mid-cycle${signal ? ` after ${signal}` : ` with code ${String(code)}`}`, "runtime");
      this.closeCycle("crashed", failure);
      this.transition("crashed", failure.code, failure.message);
    } else if (this.snapshot.state === "settled") {
      // A clean exit after a completed cycle preserves the settled result.
    } else if (!CYCLE_TERMINAL_STATES.has(this.snapshot.state)) {
      const failure = this.makeFailure("PROCESS_CRASHED", `Pi process exited unexpectedly${signal ? ` after ${signal}` : ` with code ${String(code)}`}`, "runtime");
      this.setFailure("crashed", failure);
      this.transition("crashed", failure.code, failure.message);
    }
    this.touch();
    this.deadHandler?.();
  };

  private readonly onError = (error: Error) => {
    const failure = this.makeFailure("PROCESS_ERROR", error.message, "runtime");
    this.setFailure("crashed", failure);
    this.transition("crashed", failure.code, failure.message);
    this.failPending(new RpcError("PROCESS_ERROR", error.message, "runtime"));
    void this.terminate("crashed", "PROCESS_ERROR", error.message, "runtime", false);
  };

  private readonly onStdinError = (error: Error) => {
    const message = `Pi stdin failed: ${error.message}`;
    const failure = this.makeFailure("STDIN_ERROR", message, "runtime");
    this.setFailure("crashed", failure);
    this.transition("crashed", failure.code, failure.message);
    this.failPending(new RpcError("STDIN_ERROR", message, "runtime"));
    void this.terminate("crashed", "STDIN_ERROR", message, "runtime", false);
  };

  private readonly onClose = () => {
    this.closed = true;
    this.child.stdout.removeAllListeners();
    this.child.stderr.removeAllListeners();
    this.child.stdin.removeAllListeners();
    this.child.removeAllListeners();
  };

  constructor(
    readonly snapshot: WorkerSnapshot,
    options: { command: string; args: string[]; cwd: string; config: WorkerConfig },
  ) {
    this.config = options.config;
    this.child = spawn(options.command, options.args, {
      cwd: options.cwd,
      stdio: "pipe",
      env: process.env,
      // A dedicated process group lets shutdown reach Pi and its shell/tool descendants on Unix.
      detached: process.platform !== "win32",
    });
    this.child.stdout.on("data", (chunk: Buffer) => this.consume(chunk));
    this.child.stdout.on("end", () => {
      this.buffered += this.decoder.end();
      this.consumeLines();
      if (!this.closed && !this.expectedExit && !this.releasing) {
        this.recordEvent("stdout_closed", "Pi stdout closed before process exit");
        this.stdoutCloseTimer = setTimeout(() => {
          if (!this.releasing) {
            const failure = this.makeFailure("STDOUT_CLOSED", "Pi stdout closed before the worker settled", "runtime");
            this.setFailure("crashed", failure);
            this.transition("crashed", failure.code, failure.message);
            void this.terminate("crashed", failure.code, failure.message, "runtime", false);
          }
        }, 25);
        this.stdoutCloseTimer.unref();
      }
    });
    this.child.stderr.on("data", (chunk: Buffer) => this.appendOutput(chunk.toString("utf8")));
    this.child.once("spawn", this.onSpawn);
    this.child.once("error", this.onError);
    this.child.stdin.on("error", this.onStdinError);
    this.child.once("exit", this.onExit);
    this.child.once("close", this.onClose);
  }

  setDeadHandler(handler: () => void): void {
    this.deadHandler = handler;
  }

  isReleasing(): boolean {
    return this.releasing;
  }

  /** Best-effort cleanup of any tool descendants that outlived the group leader. */
  reapAfterExit(): void {
    this.signalProcessGroup("SIGKILL");
  }

  isLive(): boolean {
    return !this.closed && this.child.exitCode === null;
  }

  /** True when the current activity cycle has ended. */
  isCycleTerminal(): boolean {
    return CYCLE_TERMINAL_STATES.has(this.snapshot.state);
  }

  refresh(): WorkerSnapshot {
    this.snapshot.elapsedMs = Date.now() - Date.parse(this.snapshot.startedAt ?? this.snapshot.createdAt);
    this.snapshot.processAlive = this.isLive();
    return this.snapshot;
  }

  /** Wait for the next observable change, or the timeout, whichever comes first. */
  waitChange(timeoutMs: number): Promise<void> {
    if (timeoutMs <= 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        this.waiters.delete(finish);
        resolve();
      };
      const timer = setTimeout(finish, timeoutMs);
      timer.unref();
      this.waiters.add(finish);
    });
  }

  ready(): Promise<void> {
    return this.serialize(() => this.readyInternal());
  }

  prompt(message: string): Promise<void> {
    return this.serialize(() => this.runActivityCycle("prompt", "prompt", message, "prompt_handled", "Pi handled the prompt without starting an agent activity cycle", undefined, "prompt"));
  }

  initializeModel(requestedModel?: string): Promise<void> {
    return this.serialize(() => this.initializeModelInternal(requestedModel));
  }

  steer(message: string): Promise<void> {
    return this.serialize(async () => {
      if (!this.isLive()) throw new RpcError("WORKER_NOT_LIVE", "Cannot steer: Pi process is not running", "steer");
      if (this.snapshot.released) throw new RpcError("WORKER_RELEASED", "Cannot steer: worker was released", "steer");
      if (this.snapshot.state === "aborting") throw new RpcError("WORKER_ABORTING", "Cannot steer: worker is aborting", "steer");
      if (this.snapshot.state !== "running") {
        throw new RpcError("INVALID_STATE", `Cannot steer: worker is ${this.snapshot.state}. pi_steer only corrects a running worker; use pi_continue for a related follow-up after settlement.`, "steer");
      }
      try {
        await this.send("steer", { message });
        this.recordEvent("steer_accepted", "Steering instruction accepted");
      } catch (error) {
        await this.failRequest(error, "steer");
        throw error;
      }
    });
  }

  followUp(message: string): Promise<void> {
    return this.serialize(async () => {
      if (!this.isLive()) throw new RpcError("WORKER_NOT_LIVE", "Cannot continue: Pi process is not running", "follow_up");
      if (this.snapshot.released) throw new RpcError("WORKER_RELEASED", "Cannot continue: worker was released", "follow_up");
      if (this.snapshot.state === "aborting") throw new RpcError("WORKER_ABORTING", "Cannot continue: worker is aborting", "follow_up");
      if (this.snapshot.state === "running" || this.snapshot.state === "starting") {
        // A running follow-up is delivered inside the current cycle; it does not create a new one.
        try {
          const response = await this.send("follow_up", { message });
          const disposition = (response.data as { disposition?: string } | undefined)?.disposition;
          this.recordEvent("follow_up_accepted", disposition === "queued"
            ? "Follow-up queued; the current activity cycle continues"
            : "Follow-up accepted by Pi");
          if (disposition === "handled") this.recordEvent("follow_up_handled_same_cycle", "Pi handled the follow-up without starting a run");
        } catch (error) {
          await this.failRequest(error, "follow_up");
          throw error;
        }
        return;
      }
      if (this.snapshot.state === "crashed") {
        throw new RpcError("WORKER_TERMINAL", "Cannot continue: Pi process has crashed. Start a new worker.", "follow_up");
      }
      // A settled or cycle-failed worker with a live process starts a fresh activity cycle on the same process.
      await this.runActivityCycle("prompt", "follow_up", message, "follow_up_handled", "Pi handled the follow-up without starting an agent activity cycle", "follow_up_accepted", "follow_up");
    });
  }

  /** Cancel the current activity cycle. Keeps the process alive so the worker can be continued. */
  abort(): Promise<WorkerSnapshot> {
    if (this.abortPromise) return this.abortPromise;
    this.abortPromise = this.serialize(() => this.abortInternal()).finally(() => {
      this.abortPromise = undefined;
    });
    return this.abortPromise;
  }

  /**
   * Release the worker's process and live slot. A completed cycle outcome is
   * preserved. Releasing a running cycle cancels it first. An unconfirmed
   * termination records a retryable `releaseError`.
   */
  release(): Promise<WorkerSnapshot> {
    if (this.releasePromise) return this.releasePromise;
    this.releasePromise = this.serialize(() => this.releaseInternal()).finally(() => {
      this.releasePromise = undefined;
    });
    return this.releasePromise;
  }

  shutdown(): Promise<void> {
    return this.serialize(() => this.shutdownInternal());
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.mutations.then(operation, operation);
    this.mutations = run.then(() => undefined, () => undefined);
    return run;
  }

  private async readyInternal(): Promise<void> {
    if (this.child.pid !== undefined) return;
    try {
      await new Promise<void>((resolve, reject) => {
        let timer: NodeJS.Timeout;
        const cleanup = () => {
          clearTimeout(timer);
          this.child.removeListener("spawn", onSpawn);
          this.child.removeListener("error", onError);
        };
        const onSpawn = () => { cleanup(); resolve(); };
        const onError = (error: Error) => { cleanup(); reject(error); };
        timer = setTimeout(() => {
          cleanup();
          reject(new RpcError("START_TIMEOUT", "Timed out starting Pi process", "runtime"));
        }, this.config.rpcTimeoutMs);
        timer.unref();
        this.child.once("spawn", onSpawn);
        this.child.once("error", onError);
      });
    } catch (error) {
      await this.failRequest(error, "runtime");
      throw error;
    }
  }

  private async initializeModelInternal(requestedModel?: string): Promise<void> {
    try {
      let expected: PiModelIdentity | undefined;
      if (requestedModel !== undefined) {
        let response: RpcResponse;
        try {
          response = await this.send("get_available_models", {});
        } catch (error) {
          throw new RpcError("MODEL_RESOLUTION_FAILED", error instanceof Error ? error.message : String(error), "model");
        }
        const data = response.data as { models?: unknown } | undefined;
        const models = Array.isArray(data?.models)
          ? data.models.map(modelIdentity).filter((model): model is PiModelIdentity => model !== undefined)
          : [];
        const matches = requestedModel.includes("/")
          ? models.filter((model) => canonicalModel(model) === requestedModel)
          : models.filter((model) => model.id === requestedModel);
        if (matches.length === 0) {
          throw new RpcError("MODEL_NOT_AVAILABLE", `Requested model "${requestedModel}" is not available in the local Pi environment for this worker. Check Pi's local model and authentication configuration, then retry. pi-task-exec does not configure providers, credentials, or available models.`, "model");
        }
        if (matches.length > 1) {
          const candidates = matches.map(canonicalModel).sort();
          throw new RpcError("AMBIGUOUS_MODEL", `Requested model "${requestedModel}" is ambiguous in the local Pi environment.\nMatches:\n${candidates.map((candidate) => `- ${candidate}`).join("\n")}\nSpecify the canonical model identifier and retry.`, "model");
        }
        const match = matches[0];
        if (!match) throw new RpcError("MODEL_NOT_AVAILABLE", `Requested model "${requestedModel}" is not available in the local Pi environment for this worker.`, "model");
        expected = match;
        try {
          await this.send("set_model", { provider: match.provider, modelId: match.id });
        } catch (error) {
          throw new RpcError("MODEL_SET_FAILED", error instanceof Error ? error.message : String(error), "model");
        }
      }

      let stateResponse: RpcResponse;
      try {
        stateResponse = await this.send("get_state", {});
      } catch (error) {
        throw new RpcError("MODEL_STATE_FAILED", error instanceof Error ? error.message : String(error), "model");
      }
      const state = stateResponse.data as { model?: unknown; thinkingLevel?: unknown } | undefined;
      const effective = modelIdentity(state?.model);
      if (expected && (!effective || effective.provider !== expected.provider || effective.id !== expected.id)) {
        const observed = effective ? canonicalModel(effective) : "no active model";
        throw new RpcError("MODEL_STATE_MISMATCH", `Pi accepted model "${canonicalModel(expected)}" but get_state reported ${observed}. Worker prompt was not started.`, "model");
      }
      if (effective) this.snapshot.effectiveModel = effective;
      if (typeof state?.thinkingLevel === "string") this.snapshot.thinkingLevel = state.thinkingLevel;
    } catch (error) {
      await this.failRequest(error, "model");
      throw error;
    }
  }

  private async abortInternal(): Promise<WorkerSnapshot> {
    if (!this.isLive() || this.snapshot.released || !this.cycleOpen) return this.refresh();
    this.abortRequested = true;
    this.transition("aborting", "ABORT_REQUESTED", "Cancellation requested");
    this.recordEvent("abort_requested", "Cancellation requested for the running activity cycle");
    try {
      await this.send("abort", {}, Math.min(this.config.abortGraceMs, this.config.rpcTimeoutMs));
    } catch (error) {
      this.recordTerminationError(error, "abort_rpc_failed");
    }
    const deadline = Date.now() + this.config.abortGraceMs;
    while (this.cycleOpen && this.isLive() && Date.now() < deadline) {
      await this.waitChange(deadline - Date.now());
    }
    if (this.cycleOpen && this.isLive()) {
      // Pi did not settle after the abort request; terminate the process as the safe fallback.
      await this.terminate("aborted", "ABORTED", "Worker was aborted", "abort", false);
    }
    return this.refresh();
  }

  private async releaseInternal(): Promise<WorkerSnapshot> {
    if (this.snapshot.released) return this.refresh();
    this.releasing = true;
    try {
      if (this.cycleOpen) {
        this.abortRequested = true;
        this.pendingCycleFailure = undefined;
        try {
          await this.send("abort", {}, Math.min(this.config.abortGraceMs, this.config.rpcTimeoutMs));
        } catch (error) {
          this.recordTerminationError(error, "release_abort_rpc_failed");
        }
        const deadline = Date.now() + this.config.abortGraceMs;
        while (this.cycleOpen && this.isLive() && Date.now() < deadline) {
          await this.waitChange(deadline - Date.now());
        }
      }
      if (this.isLive()) {
        this.expectedExit = true;
        this.failPending(new RpcError("RELEASED", "Worker released", "release"));
        this.signalProcessGroup("SIGTERM");
        let exited = await this.waitForExit(this.config.termGraceMs);
        if (!exited) {
          this.signalProcessGroup("SIGKILL");
          exited = await this.waitForExit(Math.max(this.config.termGraceMs, 100));
        }
        if (!exited) {
          this.snapshot.releaseError = this.makeFailure("RELEASE_INCOMPLETE", "Pi process did not terminate after SIGKILL; release can be retried", "release");
          return this.refresh();
        }
        // Reap any descendants left behind after the group leader exited.
        this.signalProcessGroup("SIGKILL");
      }
      // A cycle interrupted by release is an explicit cancellation.
      if (this.cycleOpen) {
        this.closeCycle("aborted");
        this.transition("aborted", "RELEASED", "Worker released while a cycle was running");
        this.abortRequested = false;
      }
      delete this.snapshot.releaseError;
      this.snapshot.released = true;
      this.snapshot.releasedAt = new Date().toISOString();
      this.touch();
      return this.refresh();
    } finally {
      this.releasing = false;
    }
  }

  private async shutdownInternal(): Promise<void> {
    if (this.closed || this.snapshot.released) return;
    // Shutdown releases resources without rewriting a completed cycle outcome.
    // A running cycle is cancelled first (releaseInternal handles both cases).
    try {
      this.child.stdin.end();
    } catch (error) {
      this.recordEvent("stdin_close_error", error instanceof Error ? error.message : String(error));
    }
    await this.releaseInternal();
  }

  private async runActivityCycle(
    command: "prompt" | "follow_up",
    operation: string,
    message: string,
    handledEvent: string,
    handledMessage: string,
    acceptedEvent: string | undefined,
    phase: FailurePhase,
  ): Promise<void> {
    await this.startRun(operation);
    try {
      const response = await this.send(command, { message });
      const disposition = (response.data as { disposition?: string } | undefined)?.disposition;
      if (acceptedEvent) {
        this.recordEvent(acceptedEvent, disposition === "queued"
          ? "Follow-up queued; the current activity cycle continues"
          : "Task accepted by Pi");
      }
      if (disposition === "handled") this.finishCycle(handledEvent, handledMessage, false);
      else if (!this.isCycleTerminal()) this.transition("running");
    } catch (error) {
      await this.failRequest(error, phase);
      throw error;
    }
  }

  private async startRun(operation: string): Promise<void> {
    if (!this.isLive()) throw new RpcError("WORKER_NOT_LIVE", `Cannot ${operation}: Pi process is not running`, "runtime");
    if (this.snapshot.released) throw new RpcError("WORKER_RELEASED", `Cannot ${operation}: worker was released`, "runtime");
    if (this.snapshot.state === "aborting") throw new RpcError("WORKER_ABORTING", `Cannot ${operation}: worker is aborting`, "runtime");
    this.clearTaskTimer();
    delete this.snapshot.completedAt;
    delete this.snapshot.failure;
    delete this.snapshot.error;
    // A new cycle must never expose the previous cycle's result or diagnostics.
    delete this.snapshot.result;
    delete this.snapshot.latestMessage;
    this.output = "";
    this.snapshot.lastOutput = "";
    this.abortRequested = false;
    this.agentError = undefined;
    this.pendingCycleFailure = undefined;
    this.snapshot.cycleId += 1;
    // Capture the cycle this run belongs to. A queued timeout cancel must never
    // be allowed to abort a newer cycle that started while it was queued.
    const scheduledCycleId = this.snapshot.cycleId;
    this.cycleOpen = true;
    this.cycleOperation = operation;
    const runStartedAt = new Date();
    this.snapshot.runStartedAt = runStartedAt.toISOString();
    this.snapshot.deadlineAt = new Date(runStartedAt.getTime() + this.config.taskTimeoutMs).toISOString();
    this.finalAssistantText = "";
    this.finalAssistantStopReason = undefined;
    this.finalAssistantErrorMessage = undefined;
    delete this.snapshot.currentTool;
    this.snapshot.currentOperation = operation;
    this.transition("running");
    this.touchActivity();
    this.taskTimer = setTimeout(() => {
      // Stale timer from a superseded cycle: ignore it entirely.
      if (this.snapshot.cycleId !== scheduledCycleId) return;
      this.recordEvent("task_timeout", `Task exceeded ${this.config.taskTimeoutMs} ms`);
      this.pendingCycleFailure = {
        code: "TASK_TIMEOUT",
        message: `Task exceeded ${this.config.taskTimeoutMs} ms`,
        phase: "runtime",
        state: "timed_out",
      };
      void this.cancelCurrentCycle(scheduledCycleId);
    }, this.config.taskTimeoutMs);
    this.taskTimer.unref();
  }

  /** Request cancellation of the open cycle and escalate to process termination if Pi does not settle. */
  private cancelCurrentCycle(cycleId: number): Promise<void> {
    return this.serialize(() => this.cancelCurrentCycleInternal(cycleId));
  }

  private async cancelCurrentCycleInternal(cycleId: number): Promise<void> {
    // Stale timer work: the cycle this cancel was scheduled for has already
    // ended and possibly been replaced. Never touch the newer cycle.
    if (this.snapshot.cycleId !== cycleId) return;
    if (!this.cycleOpen || !this.isLive()) return;
    try {
      await this.send("abort", {}, Math.min(this.config.abortGraceMs, this.config.rpcTimeoutMs));
    } catch (error) {
      this.recordTerminationError(error, "abort_rpc_failed");
    }
    const deadline = Date.now() + this.config.abortGraceMs;
    while (this.cycleOpen && this.isLive() && this.snapshot.cycleId === cycleId && Date.now() < deadline) {
      await this.waitChange(deadline - Date.now());
    }
    if (this.cycleOpen && this.isLive() && this.snapshot.cycleId === cycleId) {
      const failure = this.pendingCycleFailure ?? { code: "CANCELLED", message: "Cycle cancelled", phase: "runtime" as FailurePhase, state: "aborted" as WorkerStatus };
      await this.terminate(failure.state, failure.code, failure.message, failure.phase, false);
    }
  }

  private finishCycle(eventType: string, message: string, aborted: boolean): void {
    if (!this.cycleOpen) {
      this.snapshot.pendingFollowUps = 0;
      delete this.snapshot.deadlineAt;
      delete this.snapshot.currentOperation;
      delete this.snapshot.currentTool;
      this.recordEvent(eventType, message);
      return;
    }
    this.clearTaskTimer();
    this.clearIdleTimer();
    this.snapshot.pendingFollowUps = 0;
    delete this.snapshot.deadlineAt;
    delete this.snapshot.currentOperation;
    delete this.snapshot.currentTool;

    // A host abort wins. Otherwise a recorded cycle failure (timeout/stall) is
    // more specific than Pi's generic `aborted` flag, which is also emitted
    // when the runtime itself requested cancellation to enforce a deadline.
    let state: WorkerStatus;
    let failure: WorkerFailure | undefined;
    if (this.abortRequested) {
      state = "aborted";
      this.recordEvent(eventType, "Pi activity cycle settled after cancellation");
    } else if (this.pendingCycleFailure) {
      state = this.pendingCycleFailure.state;
      failure = this.makeFailure(this.pendingCycleFailure.code, this.pendingCycleFailure.message, this.pendingCycleFailure.phase);
      this.recordEvent(eventType, message);
    } else if (aborted || this.finalAssistantStopReason === "aborted") {
      state = "aborted";
      this.recordEvent(eventType, "Pi activity cycle settled after cancellation");
    } else if (this.agentError) {
      state = "failed";
      failure = this.makeFailure(this.agentError.code, this.agentError.message, "runtime");
      this.recordEvent(eventType, this.agentError.message);
    } else if (this.finalAssistantStopReason === "length") {
      // The model hit its output limit: the run ended, but the result is explicitly incomplete.
      state = "failed";
      failure = this.makeFailure("PI_OUTPUT_TRUNCATED", "Pi assistant output stopped at its length limit; the result is incomplete", "runtime");
      this.recordEvent(eventType, failure.message);
    } else {
      state = "settled";
      this.recordEvent(eventType, message);
    }

    this.closeCycle(state, failure);
    this.abortRequested = false;
    this.agentError = undefined;
    this.pendingCycleFailure = undefined;
    this.transition(state, failure?.code, failure?.message);
    if (state === "settled") {
      const settledAt = this.snapshot.settledAt;
      if (settledAt !== undefined) this.snapshot.completedAt = settledAt;
    }
    this.touch();
  }

  /** Archive the open cycle and publish its authoritative result. */
  private closeCycle(state: WorkerStatus, failure?: WorkerFailure): void {
    if (!this.cycleOpen) {
      if (failure) this.setFailure(state, failure);
      return;
    }
    const cycleId = this.snapshot.cycleId;
    const endedAt = new Date().toISOString();
    const startedAt = this.snapshot.runStartedAt ?? endedAt;
    const raw = this.finalAssistantText;
    const chars = raw.length;
    const limit = this.config.maxResultChars;
    const truncatedBySize = chars > limit;
    const truncatedByModel = this.finalAssistantStopReason === "length";
    const result: WorkerResult = {
      cycleId,
      text: truncatedBySize ? raw.slice(0, limit) : raw,
      truncated: truncatedBySize || truncatedByModel,
      chars,
      completedAt: endedAt,
      ...(this.finalAssistantStopReason !== undefined ? { stopReason: this.finalAssistantStopReason } : {}),
    };
    const cycle: WorkerCycle = {
      cycleId,
      state,
      ...(this.cycleOperation !== undefined ? { operation: this.cycleOperation } : {}),
      startedAt,
      endedAt,
      result,
      ...(failure !== undefined ? { failure } : {}),
    };
    this.snapshot.result = result;
    this.snapshot.cycles.unshift(cycle);
    if (this.snapshot.cycles.length > this.config.maxCycles) this.snapshot.cycles.length = this.config.maxCycles;
    if (failure) this.setFailure(state, failure);
    else {
      delete this.snapshot.failure;
      delete this.snapshot.error;
    }
    this.cycleOpen = false;
    this.cycleOperation = undefined;
    this.finalAssistantText = "";
    this.finalAssistantStopReason = undefined;
    this.finalAssistantErrorMessage = undefined;
    this.touch();
  }

  private makeFailure(code: string, message: string, phase: FailurePhase): WorkerFailure {
    return {
      code,
      message: redactSecrets(message),
      phase,
      workerId: this.snapshot.id,
      ...(this.snapshot.cycleId > 0 ? { cycleId: this.snapshot.cycleId } : {}),
      at: new Date().toISOString(),
    };
  }

  private setFailure(state: WorkerStatus, failure: WorkerFailure): void {
    if (!FAILURE_STATES.has(state)) return;
    this.snapshot.failure = failure;
    this.snapshot.error = failure.message;
    this.snapshot.terminationReason = failure.code;
  }

  private async send(command: string, args: Record<string, unknown>, timeoutMs = this.config.rpcTimeoutMs): Promise<RpcResponse> {
    if (!this.isLive()) throw new RpcError("WORKER_NOT_LIVE", "Pi worker process is not running", "runtime");
    const id = randomUUID();
    const response = new Promise<RpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RpcError("RPC_TIMEOUT", `Pi RPC ${command} timed out after ${timeoutMs} ms`, "runtime"));
      }, timeoutMs);
      timer.unref();
      this.pending.set(id, { command, resolve, reject, timer });
    });
    try {
      const record = JSON.stringify({ id, type: command, ...args }) + "\n";
      if (!this.child.stdin.write(record)) {
        await new Promise<void>((resolve, reject) => {
          let timer: NodeJS.Timeout;
          const cleanup = () => {
            clearTimeout(timer);
            this.child.stdin.removeListener("drain", onDrain);
            this.child.stdin.removeListener("error", onError);
          };
          const onDrain = () => { cleanup(); resolve(); };
          const onError = (error: Error) => { cleanup(); reject(error); };
          timer = setTimeout(() => {
            cleanup();
            reject(new RpcError("STDIN_BACKPRESSURE_TIMEOUT", `Pi stdin remained blocked during ${command}`, "runtime"));
          }, timeoutMs);
          timer.unref();
          this.child.stdin.once("drain", onDrain);
          this.child.stdin.once("error", onError);
        });
      }
    } catch (error) {
      const pending = this.pending.get(id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(id);
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      }
    }
    const result = await response;
    if (result.success === false) throw new RpcError("RPC_REJECTED", result.error ?? `Pi RPC ${command} failed`, "runtime");
    return result;
  }

  private async failRequest(error: unknown, phase: FailurePhase): Promise<void> {
    const rpcError = error instanceof RpcError
      ? error
      : new RpcError("RPC_ERROR", error instanceof Error ? error.message : String(error), phase);
    if (!this.isLive()) {
      // The process already exited and onExit recorded the authoritative process
      // failure. A rejected in-flight RPC must not overwrite it with a weaker state.
      return;
    }
    const failurePhase = rpcError.phase ?? phase;
    const state: WorkerStatus = rpcError.code === "RPC_TIMEOUT" || rpcError.code === "START_TIMEOUT" || rpcError.code === "STDIN_BACKPRESSURE_TIMEOUT"
      ? "timed_out"
      : "failed";
    if (this.cycleOpen) {
      this.pendingCycleFailure = { code: rpcError.code, message: rpcError.message, phase: failurePhase, state };
    }
    await this.terminate(state, rpcError.code, rpcError.message, failurePhase, true);
  }

  private terminate(state: WorkerStatus, code: string, message: string, phase: FailurePhase, requestAbort: boolean): Promise<WorkerSnapshot> {
    if (this.terminationPromise) return this.terminationPromise;
    this.terminationTarget = state;
    this.terminationCode = code;
    this.terminationMessage = message;
    this.terminationPhase = phase;
    this.expectedExit = true;
    this.clearTimers();
    if (this.stdoutCloseTimer) clearTimeout(this.stdoutCloseTimer);
    this.stdoutCloseTimer = undefined;
    this.failPending(new RpcError(code, message, phase));
    if (this.closed || !this.isLive()) {
      this.finalizeTermination(state, code, message, phase);
      return Promise.resolve(this.refresh());
    }
    if (this.snapshot.state !== "aborting") this.transition("aborting", code, message);
    this.terminationPromise = this.terminateProcess(state, code, message, phase, requestAbort).catch(async (error) => {
      this.recordTerminationError(error, "termination_pipeline_error");
      this.signalProcessGroup("SIGKILL");
      const exited = await this.waitForExit(this.config.termGraceMs);
      if (!exited) this.recordTerminationError(new RpcError("PROCESS_STILL_ALIVE", "Pi process remained alive after emergency SIGKILL", "runtime"), "termination_incomplete");
      return this.finalizeTermination(state, code, message, phase);
    });
    return this.terminationPromise;
  }

  private async terminateProcess(state: WorkerStatus, code: string, message: string, phase: FailurePhase, requestAbort: boolean): Promise<WorkerSnapshot> {
    if (requestAbort && this.isLive()) {
      try {
        await this.send("abort", {}, Math.min(this.config.abortGraceMs, this.config.rpcTimeoutMs));
      } catch (error) {
        // The process signals below are the fallback when RPC cannot stop the agent.
        this.recordTerminationError(error, "abort_rpc_failed");
      }
    }
    if (!this.isLive()) return this.finalizeTermination(state, code, message, phase);
    if (requestAbort && this.config.abortGraceMs > 0) await this.delay(this.config.abortGraceMs);
    if (!this.isLive()) return this.finalizeTermination(state, code, message, phase);

    this.signalProcessGroup("SIGTERM");
    if (await this.waitForExit(this.config.termGraceMs)) {
      this.signalProcessGroup("SIGKILL");
      return this.finalizeTermination(state, code, message, phase);
    }
    this.signalProcessGroup("SIGKILL");
    const exited = await this.waitForExit(Math.max(this.config.termGraceMs, 100));
    if (!exited) this.recordTerminationError(new RpcError("PROCESS_STILL_ALIVE", "Pi process remained alive after SIGKILL", "runtime"), "termination_incomplete");
    return this.finalizeTermination(state, code, message, phase);
  }

  private finalizeTermination(state: WorkerStatus, code: string, message: string, phase: FailurePhase): WorkerSnapshot {
    const failure: WorkerFailure | undefined = FAILURE_STATES.has(state)
      ? this.makeFailure(code, message, phase)
      : undefined;
    if (this.cycleOpen) this.closeCycle(state, failure);
    else if (failure) this.setFailure(state, failure);
    this.transition(state, code, message);
    if (!this.isLive()) this.snapshot.terminatedAt ??= new Date().toISOString();
    this.failPending(new RpcError(code, message, phase));
    this.clearTimers();
    this.touch();
    return this.refresh();
  }

  private signalProcessGroup(signal: NodeJS.Signals): void {
    // Do not gate on `isLive()`: the group leader may have exited while tool
    // descendants remain, and the process group must still be signalled.
    if (this.child.pid === undefined) return;
    try {
      if (process.platform !== "win32") process.kill(-this.child.pid, signal);
      else this.child.kill(signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
        const failure = new RpcError(`SIGNAL_${signal}_FAILED`, error instanceof Error ? error.message : String(error), "runtime");
        this.recordTerminationError(failure, "termination_signal_error");
      }
    }
  }

  private async waitForExit(timeoutMs: number): Promise<boolean> {
    if (!this.isLive()) return true;
    return new Promise<boolean>((resolve) => {
      const finish = (exited: boolean) => {
        clearTimeout(timer);
        this.child.removeListener("exit", onExit);
        resolve(exited || !this.isLive());
      };
      const onExit = () => finish(true);
      const timer = setTimeout(() => finish(false), timeoutMs);
      this.child.once("exit", onExit);
    });
  }

  private consume(chunk: Buffer): void {
    this.buffered += this.decoder.write(chunk);
    this.consumeLines();
  }

  private consumeLines(): void {
    let newline = this.buffered.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffered.slice(0, newline).replace(/\r$/, "");
      this.buffered = this.buffered.slice(newline + 1);
      if (line) this.consumeRecord(line);
      newline = this.buffered.indexOf("\n");
    }
  }

  private consumeRecord(line: string): void {
    let record: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("JSONL record must be an object");
      record = parsed as Record<string, unknown>;
    } catch (error) {
      this.appendOutput(line + "\n");
      this.recordEvent("malformed_jsonl", error instanceof Error ? error.message : String(error));
      return;
    }
    this.touchActivity();
    const type = typeof record.type === "string" ? record.type : "unknown";
    if (type === "response") {
      this.consumeResponse(record);
      return;
    }
    if (type === "agent_settled") {
      this.finishCycle("agent_settled", record.aborted === true
        ? "Pi activity cycle settled after cancellation"
        : "Pi agent activity cycle settled", record.aborted === true);
      return;
    }
    if (type === "queue_update" && Array.isArray(record.followUp)) {
      this.snapshot.pendingFollowUps = record.followUp.length;
      this.recordEvent(type, `Pending follow-ups: ${this.snapshot.pendingFollowUps}`);
      if (!this.snapshot.released) this.resetIdleTimer();
      return;
    }

    const eventMessage = [record.finalError, record.errorMessage, record.error]
      .find((value): value is string => typeof value === "string");

    // `auto_retry_start`/`auto_retry_end` stay inside the same activity cycle.
    if (type === "auto_retry_start") {
      this.recordEvent(type, eventMessage?.slice(-300) ?? "Pi is retrying after a model error");
      if (!this.snapshot.released) this.resetIdleTimer();
      return;
    }
    if (type === "auto_retry_end") {
      if (record.success === false) {
        this.agentError = { code: "PI_AGENT_ERROR", message: redactSecrets(eventMessage ?? "Pi exhausted its automatic retries") };
        this.recordEvent(type, this.agentError.message.slice(-300));
      } else {
        this.agentError = undefined;
        this.recordEvent(type, "Pi recovered after an automatic retry");
      }
      if (!this.snapshot.released) this.resetIdleTimer();
      return;
    }

    const operation = typeof record.toolName === "string" ? record.toolName : undefined;
    if (type === "tool_execution_start") {
      this.snapshot.currentTool = operation ?? "tool";
      this.snapshot.currentOperation = `tool:${this.snapshot.currentTool}`;
    } else if (type === "tool_execution_end") {
      delete this.snapshot.currentTool;
      this.snapshot.currentOperation = "agent";
    }

    let delta: string | undefined;
    const update = record.assistantMessageEvent;
    if (update && typeof update === "object" && "delta" in update && "type" in update && typeof update.delta === "string" && update.type === "text_delta") {
      delta = update.delta;
    }
    if (delta) {
      // Deltas are diagnostics only. They are never used to build the authoritative result.
      this.appendOutput(delta);
      this.snapshot.latestMessage = redactSecrets(delta).slice(-500);
    }

    const message = record.message;
    if (type === "message_start" && message && typeof message === "object" && (message as { role?: unknown }).role === "user") {
      // A queued follow-up or a steering message is delivered inside the current run, so it does
      // not start a new cycle. The queue length itself is tracked from queue_update.
      this.recordEvent("user_message_started");
    }
    if (type === "message_end" && message && typeof message === "object" && (message as { role?: unknown }).role === "assistant") {
      const assistant = message as { content?: unknown; stopReason?: unknown; errorMessage?: unknown };
      this.finalAssistantText = assistantMessageText(assistant);
      this.finalAssistantStopReason = typeof assistant.stopReason === "string" ? assistant.stopReason : undefined;
      this.finalAssistantErrorMessage = typeof assistant.errorMessage === "string" ? redactSecrets(assistant.errorMessage) : undefined;
      if (this.finalAssistantStopReason === "error") {
        this.agentError = { code: "PI_AGENT_ERROR", message: this.finalAssistantErrorMessage ?? "Pi assistant message reported an error" };
      } else {
        // A later successful assistant message clears an earlier retry error in the same cycle.
        this.agentError = undefined;
      }
    }

    this.recordEvent(type, delta?.slice(-300) ?? eventMessage?.slice(-300), operation);
    if (!this.snapshot.released) this.resetIdleTimer();
  }

  private consumeResponse(record: Record<string, unknown>): void {
    const id = record.id;
    const pending = typeof id === "string" ? this.pending.get(id) : undefined;
    if (!pending) {
      this.recordEvent("unmatched_rpc_response", "Received a response with no pending request");
      return;
    }
    if (typeof record.success !== "boolean") {
      clearTimeout(pending.timer);
      this.pending.delete(id as string);
      pending.reject(new RpcError("MALFORMED_RPC_RESPONSE", `Malformed response for ${pending.command}: success must be boolean`, "runtime"));
      this.recordEvent("malformed_rpc_response", `Malformed response for ${pending.command}`);
      return;
    }
    clearTimeout(pending.timer);
    this.pending.delete(id as string);
    pending.resolve(record as unknown as RpcResponse);
    if (!this.snapshot.released) this.resetIdleTimer();
  }

  private transition(next: WorkerStatus, code?: string, message?: string): void {
    const current = this.snapshot.state;
    if (current !== next) {
      this.snapshot.state = next;
      this.snapshot.status = next;
      if (next === "settled") this.snapshot.settledAt = new Date().toISOString();
      // `terminatedAt` is reserved for actual process exit, not cycle completion.
      if (code) this.snapshot.terminationReason = code;
      if (code && message && FAILURE_STATES.has(next)) this.snapshot.error = redactSecrets(message);
      this.touch();
      this.recordEvent("state", `${current} → ${next}`);
    } else if (code && message && FAILURE_STATES.has(next)) {
      this.snapshot.terminationReason = code;
      this.snapshot.error = redactSecrets(message);
    }
  }

  private recordTerminationError(error: unknown, eventType: string): void {
    const failure = error instanceof RpcError
      ? error
      : new RpcError("TERMINATION_ERROR", error instanceof Error ? error.message : String(error), "runtime");
    this.snapshot.terminationError = {
      code: failure.code,
      message: failure.message,
      phase: failure.phase ?? "runtime",
      ...(this.snapshot.cycleId > 0 ? { cycleId: this.snapshot.cycleId } : {}),
      at: new Date().toISOString(),
    };
    this.recordEvent(eventType, failure.message);
  }

  private resetIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.config.idleTimeoutMs <= 0 || this.snapshot.state !== "running" || this.snapshot.currentTool) return;
    const scheduledCycleId = this.snapshot.cycleId;
    this.idleTimer = setTimeout(() => {
      if (this.snapshot.cycleId !== scheduledCycleId) return;
      this.recordEvent("worker_stalled", `No Pi activity for ${this.config.idleTimeoutMs} ms`);
      this.pendingCycleFailure = {
        code: "IDLE_TIMEOUT",
        message: `No Pi activity for ${this.config.idleTimeoutMs} ms`,
        phase: "runtime",
        state: "stalled",
      };
      void this.cancelCurrentCycle(scheduledCycleId);
    }, this.config.idleTimeoutMs);
    this.idleTimer.unref();
  }

  private touchActivity(): void {
    this.snapshot.lastActivityAt = new Date().toISOString();
    this.touch();
  }

  private recordEvent(type: string, message?: string, operation?: string): void {
    const event: WorkerEvent = { at: new Date().toISOString(), type };
    if (message) event.message = redactSecrets(message);
    if (operation) event.operation = operation;
    this.snapshot.recentEvents.push(event);
    if (this.snapshot.recentEvents.length > this.config.maxRecentEvents) {
      this.snapshot.recentEvents.splice(0, this.snapshot.recentEvents.length - this.config.maxRecentEvents);
    }
    this.touchActivity();
  }

  private appendOutput(text: string): void {
    this.output = (this.output + redactSecrets(text)).slice(-OUTPUT_LIMIT);
    this.snapshot.lastOutput = this.output;
    this.touchActivity();
  }

  private failPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private clearTaskTimer(): void {
    if (this.taskTimer) clearTimeout(this.taskTimer);
    this.taskTimer = undefined;
  }

  private clearTimers(): void {
    this.clearTaskTimer();
    this.clearIdleTimer();
    if (this.stdoutCloseTimer) clearTimeout(this.stdoutCloseTimer);
    this.stdoutCloseTimer = undefined;
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = undefined;
  }

  private isProcessGone(): boolean {
    return this.closed || this.child.exitCode !== null;
  }

  private touch(): void {
    this.snapshot.updatedAt = new Date().toISOString();
    this.snapshot.elapsedMs = Date.now() - Date.parse(this.snapshot.startedAt ?? this.snapshot.createdAt);
    this.notifyChange();
  }

  private notifyChange(): void {
    for (const waiter of [...this.waiters]) waiter();
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

export function workerOutput(snapshot: WorkerSnapshot): string {
  return snapshot.lastOutput.slice(-OUTPUT_LIMIT);
}
