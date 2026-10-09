import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import type { WorkerConfig, WorkerEvent, WorkerSnapshot, WorkerStatus } from "./types.js";

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

const TERMINAL_STATES = new Set<WorkerStatus>(["failed", "stalled", "timed_out", "aborted", "crashed"]);
const OUTPUT_LIMIT = 12_000;

export class RpcError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "RpcError";
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

export class PiRpcWorker {
  readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly decoder = new StringDecoder("utf8");
  private buffered = "";
  private output = "";
  private closed = false;
  private expectedExit = false;
  private terminationPromise: Promise<WorkerSnapshot> | undefined;
  private terminationCode: string | undefined;
  private terminationMessage: string | undefined;
  private abortPromise: Promise<void> | undefined;
  private readonly config: WorkerConfig;
  private taskTimer: NodeJS.Timeout | undefined;
  private idleTimer: NodeJS.Timeout | undefined;
  private stdoutCloseTimer: NodeJS.Timeout | undefined;
  private readonly onSpawn = () => {
    if (this.child.pid !== undefined) this.snapshot.pid = this.child.pid;
    this.snapshot.startedAt = new Date().toISOString();
    this.recordEvent("process_started", `Pi process ${this.child.pid ?? "unknown"} started`);
    if (this.expectedExit || this.isTerminal()) {
      this.signalProcessGroup("SIGKILL");
      return;
    }
    this.transition("running");
  };
  private readonly onSettled = () => this.finishCycle("agent_settled", "Pi agent activity cycle settled");

  private finishCycle(eventType: string, message: string): void {
    this.clearTaskTimer();
    this.clearIdleTimer();
    this.snapshot.pendingFollowUps = 0;
    delete this.snapshot.deadlineAt;
    delete this.snapshot.currentOperation;
    delete this.snapshot.currentTool;
    this.recordEvent(eventType, message);
    const wasRunning = this.snapshot.state === "running";
    if (!this.isTerminal()) this.transition("settled");
    if (eventType === "agent_settled" && wasRunning && this.snapshot.state === "settled") {
      const completedAt = this.snapshot.settledAt;
      if (completedAt !== undefined) this.snapshot.completedAt = completedAt;
    }
  }
  private readonly onExit = (code: number | null, signal: NodeJS.Signals | null) => {
    this.closed = true;
    this.expectedExit = true;
    this.clearTimers();
    if (code !== null) this.snapshot.exitCode = code;
    if (signal) this.snapshot.signal = signal;
    this.failPending(new RpcError("PROCESS_EXITED", `Pi exited${signal ? ` after ${signal}` : ` with code ${String(code)}`}`));
    this.recordEvent("process_exit", signal ? `Pi exited after ${signal}` : `Pi exited with code ${String(code)}`);
    if (!this.isTerminal()) {
      if (this.terminationPromise && this.terminationTarget) {
        this.transition(this.terminationTarget, this.terminationCode, this.terminationMessage);
      } else if (code === 0 && this.snapshot.state === "settled") {
        // A clean Pi shutdown after agent_settled preserves the completed run state.
      } else if (code === 0) {
        this.transition("crashed", "UNEXPECTED_EXIT", "Pi exited before the worker was settled");
      } else {
        this.transition("crashed", "PROCESS_CRASHED", `Pi process exited unexpectedly${signal ? ` after ${signal}` : ` with code ${String(code)}`}`);
      }
    }
    this.snapshot.terminatedAt = new Date().toISOString();
    this.touch();
  };
  private readonly onError = (error: Error) => {
    this.transition("crashed", "PROCESS_ERROR", error.message);
    this.failPending(error);
    void this.terminate("crashed", "PROCESS_ERROR", error.message);
  };
  private readonly onStdinError = (error: Error) => {
    this.transition("crashed", "STDIN_ERROR", `Pi stdin failed: ${error.message}`);
    this.failPending(new RpcError("STDIN_ERROR", error.message));
    void this.terminate("crashed", "STDIN_ERROR", error.message);
  };
  private readonly onClose = () => {
    this.closed = true;
    this.child.stdout.removeAllListeners();
    this.child.stderr.removeAllListeners();
    this.child.stdin.removeAllListeners();
    this.child.removeAllListeners();
  };

  private terminationTarget: WorkerStatus | undefined;

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
      if (!this.closed && !this.expectedExit) {
        this.recordEvent("stdout_closed", "Pi stdout closed before process exit");
        this.stdoutCloseTimer = setTimeout(() => {
          if (this.isLive() && !this.isTerminal() && this.snapshot.state !== "settled") {
            this.transition("crashed", "STDOUT_CLOSED", "Pi stdout closed before the worker settled");
            void this.terminate("crashed", "STDOUT_CLOSED", "Pi stdout closed before the worker settled");
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

  async ready(): Promise<void> {
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
          reject(new RpcError("START_TIMEOUT", "Timed out starting Pi process"));
        }, this.config.rpcTimeoutMs);
        timer.unref();
        this.child.once("spawn", onSpawn);
        this.child.once("error", onError);
      });
    } catch (error) {
      await this.failRequest(error);
      throw error;
    }
  }

  async prompt(message: string): Promise<void> {
    await this.runActivityCycle(
      "prompt",
      "prompt",
      message,
      "prompt_handled",
      "Pi handled the prompt without starting an agent activity cycle",
    );
  }

  async initializeModel(requestedModel?: string): Promise<void> {
    try {
      let expected: PiModelIdentity | undefined;
      if (requestedModel !== undefined) {
        let response: RpcResponse;
        try {
          response = await this.send("get_available_models", {});
        } catch (error) {
          throw new RpcError("MODEL_RESOLUTION_FAILED", error instanceof Error ? error.message : String(error));
        }
        const data = response.data as { models?: unknown } | undefined;
        const models = Array.isArray(data?.models)
          ? data.models.map(modelIdentity).filter((model): model is PiModelIdentity => model !== undefined)
          : [];
        const matches = requestedModel.includes("/")
          ? models.filter((model) => canonicalModel(model) === requestedModel)
          : models.filter((model) => model.id === requestedModel);
        if (matches.length === 0) {
          throw new RpcError("MODEL_NOT_AVAILABLE", `Requested model "${requestedModel}" is not available in the local Pi environment for this worker. Check Pi's local model and authentication configuration, then retry. pi-task-exec does not configure providers, credentials, or available models.`);
        }
        if (matches.length > 1) {
          const candidates = matches.map(canonicalModel).sort();
          throw new RpcError("AMBIGUOUS_MODEL", `Requested model "${requestedModel}" is ambiguous in the local Pi environment.\nMatches:\n${candidates.map((candidate) => `- ${candidate}`).join("\n")}\nSpecify the canonical model identifier and retry.`);
        }
        const match = matches[0];
        if (!match) throw new RpcError("MODEL_NOT_AVAILABLE", `Requested model "${requestedModel}" is not available in the local Pi environment for this worker.`);
        expected = match;
        try {
          await this.send("set_model", { provider: match.provider, modelId: match.id });
        } catch (error) {
          throw new RpcError("MODEL_SET_FAILED", error instanceof Error ? error.message : String(error));
        }
      }

      let stateResponse: RpcResponse;
      try {
        stateResponse = await this.send("get_state", {});
      } catch (error) {
        throw new RpcError("MODEL_STATE_FAILED", error instanceof Error ? error.message : String(error));
      }
      const state = stateResponse.data as { model?: unknown; thinkingLevel?: unknown } | undefined;
      const effective = modelIdentity(state?.model);
      if (expected && (!effective || effective.provider !== expected.provider || effective.id !== expected.id)) {
        const observed = effective ? canonicalModel(effective) : "no active model";
        throw new RpcError("MODEL_STATE_MISMATCH", `Pi accepted model "${canonicalModel(expected)}" but get_state reported ${observed}. Worker prompt was not started.`);
      }
      if (effective) this.snapshot.effectiveModel = effective;
      if (typeof state?.thinkingLevel === "string") this.snapshot.thinkingLevel = state.thinkingLevel;
    } catch (error) {
      await this.failRequest(error);
      throw error;
    }
  }

  async steer(message: string): Promise<void> {
    this.assertOperable("steer");
    if (this.snapshot.state !== "running") {
      throw new RpcError("INVALID_STATE", `Cannot steer: worker is ${this.snapshot.state}. pi_steer only corrects a running worker; use pi_continue for a related follow-up after settlement.`);
    }
    try {
      await this.send("steer", { message });
      this.recordEvent("steer_accepted", "Steering instruction accepted");
    } catch (error) {
      await this.failRequest(error);
      throw error;
    }
  }

  async followUp(message: string): Promise<void> {
    this.assertOperable("continue");
    if (this.snapshot.state === "settled") {
      // Pi 1.1.0 treats follow_up as queue-only while idle: it never starts a run or settles on its own.
      // A settled continuation must use prompt, which starts a fresh activity cycle on the same process/session.
      await this.runActivityCycle(
        "prompt",
        "follow_up",
        message,
        "follow_up_handled",
        "Pi handled the follow-up without starting an agent activity cycle",
        "follow_up_accepted",
      );
      return;
    }
    try {
      const response = await this.send("follow_up", { message });
      const disposition = (response.data as { disposition?: string } | undefined)?.disposition;
      this.recordEvent("follow_up_accepted", disposition === "queued"
        ? "Follow-up queued; the current activity cycle continues"
        : "Follow-up accepted by Pi");
    } catch (error) {
      await this.failRequest(error);
      throw error;
    }
  }

  /**
   * Start one activity cycle and hand off the command. Initial prompts and settled continuations share this path so
   * the cycle deadline, disposition handling, and failure teardown stay identical; only the RPC command differs.
   */
  private async runActivityCycle(
    command: "prompt" | "follow_up",
    operation: string,
    message: string,
    handledEvent: string,
    handledMessage: string,
    acceptedEvent?: string,
  ): Promise<void> {
    await this.startRun(operation);
    try {
      const response = await this.send(command, { message });
      const disposition = (response.data as { disposition?: string } | undefined)?.disposition;
      if (acceptedEvent) {
        this.recordEvent(acceptedEvent, disposition === "queued"
          ? "Follow-up queued; the current activity cycle continues"
          : "Follow-up accepted by Pi");
      }
      if (disposition === "handled") this.finishCycle(handledEvent, handledMessage);
      else if (this.snapshot.state !== "settled") this.transition("running");
    } catch (error) {
      await this.failRequest(error);
      throw error;
    }
  }

  abort(): Promise<void> {
    if (this.abortPromise) return this.abortPromise;
    this.abortPromise = this.abortInternal();
    return this.abortPromise;
  }

  private async abortInternal(): Promise<void> {
    if (this.isTerminal() || this.closed) return;
    await this.terminate("aborted", "ABORTED", "Worker was aborted");
  }

  async shutdown(): Promise<void> {
    if (this.closed || this.isTerminal()) return;
    this.transition("aborting", "SERVER_SHUTDOWN", "MCP server is shutting down");
    try {
      this.child.stdin.end();
    } catch (error) {
      this.recordEvent("stdin_close_error", error instanceof Error ? error.message : String(error));
    }
    await this.terminate("aborted", "SERVER_SHUTDOWN", "Worker stopped during MCP server shutdown", false);
  }

  isLive(): boolean {
    return !this.closed && this.child.exitCode === null;
  }

  isTerminal(): boolean {
    return TERMINAL_STATES.has(this.snapshot.state);
  }

  refresh(): WorkerSnapshot {
    this.snapshot.elapsedMs = Date.now() - Date.parse(this.snapshot.startedAt ?? this.snapshot.createdAt);
    this.snapshot.processAlive = this.isLive();
    return this.snapshot;
  }

  private async startRun(operation: string): Promise<void> {
    this.assertOperable(operation);
    this.clearTaskTimer();
    delete this.snapshot.completedAt;
    this.snapshot.currentOperation = operation;
    const runStartedAt = new Date();
    this.snapshot.runStartedAt = runStartedAt.toISOString();
    this.snapshot.deadlineAt = new Date(runStartedAt.getTime() + this.config.taskTimeoutMs).toISOString();
    delete this.snapshot.currentTool;
    this.transition("running");
    this.touchActivity();
    this.taskTimer = setTimeout(() => {
      this.recordEvent("task_timeout", `Task exceeded ${this.config.taskTimeoutMs} ms`);
      void this.terminate("timed_out", "TASK_TIMEOUT", `Task exceeded ${this.config.taskTimeoutMs} ms`);
    }, this.config.taskTimeoutMs);
    this.taskTimer.unref();
  }

  private assertOperable(operation: string): void {
    if (!this.isLive()) throw new RpcError("WORKER_NOT_LIVE", `Cannot ${operation}: Pi process is not running`);
    if (this.isTerminal()) {
      throw new RpcError("WORKER_TERMINAL", `Cannot ${operation}: worker is ${this.snapshot.state}. Inspect pi_status for partial results, then start a new worker if more work is needed.`);
    }
    if (this.snapshot.state === "aborting") throw new RpcError("WORKER_ABORTING", "Cannot operate on a worker while it is aborting");
  }

  private async send(command: string, args: Record<string, unknown>, timeoutMs = this.config.rpcTimeoutMs): Promise<RpcResponse> {
    if (!this.isLive()) throw new RpcError("WORKER_NOT_LIVE", "Pi worker process is not running");
    const id = randomUUID();
    const response = new Promise<RpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RpcError("RPC_TIMEOUT", `Pi RPC ${command} timed out after ${timeoutMs} ms`));
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
            reject(new RpcError("STDIN_BACKPRESSURE_TIMEOUT", `Pi stdin remained blocked during ${command}`));
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
    if (result.success === false) throw new RpcError("RPC_REJECTED", result.error ?? `Pi RPC ${command} failed`);
    return result;
  }

  private async failRequest(error: unknown): Promise<void> {
    const rpcError = error instanceof RpcError ? error : new RpcError("RPC_ERROR", error instanceof Error ? error.message : String(error));
    const state: WorkerStatus = rpcError.code === "RPC_TIMEOUT" || rpcError.code === "START_TIMEOUT" ? "timed_out" : "failed";
    await this.terminate(state, rpcError.code, rpcError.message);
  }

  private terminate(state: WorkerStatus, code: string, message: string, requestAbort = true): Promise<WorkerSnapshot> {
    if (this.terminationPromise) return this.terminationPromise;
    if (this.closed) {
      this.transition(state, code, message);
      return Promise.resolve(this.refresh());
    }
    this.terminationTarget = state;
    this.terminationCode = code;
    this.terminationMessage = message;
    this.expectedExit = true;
    this.transition("aborting", code, message);
    this.clearTimers();
    if (this.stdoutCloseTimer) clearTimeout(this.stdoutCloseTimer);
    this.stdoutCloseTimer = undefined;
    this.failPending(new RpcError(code, message));
    this.terminationPromise = this.terminateProcess(state, code, message, requestAbort).catch(async (error) => {
      this.recordTerminationError(error, "termination_pipeline_error");
      this.signalProcessGroup("SIGKILL");
      const exited = await this.waitForExit(this.config.termGraceMs);
      if (!exited) this.recordTerminationError(new RpcError("PROCESS_STILL_ALIVE", "Pi process remained alive after emergency SIGKILL"), "termination_incomplete");
      return this.finalizeTermination(state, code, message);
    });
    return this.terminationPromise;
  }

  private async terminateProcess(state: WorkerStatus, code: string, message: string, requestAbort: boolean): Promise<WorkerSnapshot> {
    if (requestAbort && this.isLive()) {
      try {
        await this.send("abort", {}, Math.min(this.config.abortGraceMs, this.config.rpcTimeoutMs));
      } catch (error) {
        // The process signals below are the fallback when RPC cannot stop the agent.
        this.recordTerminationError(error, "abort_rpc_failed");
      }
    }
    if (!this.isLive()) return this.finalizeTermination(state, code, message);
    if (this.config.abortGraceMs > 0) await this.delay(this.config.abortGraceMs);
    if (!this.isLive()) return this.finalizeTermination(state, code, message);

    this.signalProcessGroup("SIGTERM");
    if (await this.waitForExit(this.config.termGraceMs)) return this.finalizeTermination(state, code, message);
    this.signalProcessGroup("SIGKILL");
    const exited = await this.waitForExit(Math.max(this.config.termGraceMs, 100));
    if (!exited) this.recordTerminationError(new RpcError("PROCESS_STILL_ALIVE", "Pi process remained alive after SIGKILL"), "termination_incomplete");
    return this.finalizeTermination(state, code, message);
  }

  private finalizeTermination(state: WorkerStatus, code: string, message: string): WorkerSnapshot {
    this.transition(state, code, message);
    this.snapshot.terminatedAt ??= new Date().toISOString();
    this.failPending(new RpcError(code, message));
    this.clearTimers();
    this.touch();
    this.child.stdout.removeAllListeners();
    this.child.stderr.removeAllListeners();
    this.child.stdin.removeAllListeners();
    return this.refresh();
  }

  private signalProcessGroup(signal: NodeJS.Signals): void {
    if (!this.isLive() || this.child.pid === undefined) return;
    try {
      if (process.platform !== "win32") process.kill(-this.child.pid, signal);
      else this.child.kill(signal);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
        const failure = new RpcError(`SIGNAL_${signal}_FAILED`, error instanceof Error ? error.message : String(error));
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
      const id = record.id;
      const pending = typeof id === "string" ? this.pending.get(id) : undefined;
      if (pending) {
        if (typeof record.success !== "boolean") {
          clearTimeout(pending.timer);
          this.pending.delete(id as string);
          pending.reject(new RpcError("MALFORMED_RPC_RESPONSE", `Malformed response for ${pending.command}: success must be boolean`));
          this.recordEvent("malformed_rpc_response", `Malformed response for ${pending.command}`);
          return;
        }
        clearTimeout(pending.timer);
        this.pending.delete(id as string);
        pending.resolve(record as unknown as RpcResponse);
        if (!this.isTerminal() && this.snapshot.state !== "aborting") this.resetIdleTimer();
      } else {
        this.recordEvent("unmatched_rpc_response", "Received a response with no pending request");
      }
      return;
    }
    if (type === "agent_settled") {
      this.onSettled();
      return;
    }
    if (type === "queue_update" && Array.isArray(record.followUp)) {
      this.snapshot.pendingFollowUps = record.followUp.length;
    }
    const eventMessage = [record.finalError, record.errorMessage, record.error]
      .find((value): value is string => typeof value === "string");
    if (type === "auto_retry_end" && record.success === false && eventMessage) {
      this.recordEvent(type, eventMessage);
      void this.terminate("failed", "PI_AGENT_ERROR", eventMessage);
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
    if (type === "queue_update") {
      this.recordEvent(type, `Pending follow-ups: ${this.snapshot.pendingFollowUps}`);
      if (!this.isTerminal() && this.snapshot.state !== "aborting") this.resetIdleTimer();
      return;
    }
    let message: string | undefined;
    const update = record.assistantMessageEvent;
    if (update && typeof update === "object" && "delta" in update && "type" in update && typeof update.delta === "string" && update.type === "text_delta") message = update.delta;
    if (message) {
      this.appendOutput(message);
      this.snapshot.latestMessage = message.slice(-500);
    }
    if (type === "message_end" && record.message && typeof record.message === "object" && "role" in record.message && record.message.role === "assistant") {
      const content = "content" in record.message ? record.message.content : undefined;
      const finalText = typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content.filter((item): item is { type: string; text: string } => Boolean(item) && typeof item === "object" && "type" in item && "text" in item && item.type === "text" && typeof item.text === "string").map((item) => item.text).join("")
          : "";
      if (finalText) this.snapshot.latestMessage = finalText.slice(-500);
    }
    this.recordEvent(type, message?.slice(-300) ?? eventMessage?.slice(-300), operation);
    if (!this.isTerminal() && this.snapshot.state !== "aborting") this.resetIdleTimer();
  }

  private transition(next: WorkerStatus, code?: string, message?: string): void {
    const current = this.snapshot.state;
    if (TERMINAL_STATES.has(current)) {
      if (current === next) this.recordTerminalReason(next, code, message);
      return;
    }
    const allowed: Record<WorkerStatus, WorkerStatus[]> = {
      starting: ["running", "failed", "timed_out", "crashed", "aborting"],
      running: ["settled", "failed", "stalled", "timed_out", "aborting", "crashed"],
      settled: ["running", "aborting", "failed", "stalled", "timed_out", "crashed"],
      aborting: ["aborted", "failed", "stalled", "timed_out", "crashed"],
      failed: [], stalled: [], timed_out: [], aborted: [], crashed: [],
    };
    if (current !== next && !allowed[current].includes(next)) return;
    this.snapshot.state = next;
    this.snapshot.status = next;
    this.recordTerminalReason(next, code, message);
    if (next === "settled") this.snapshot.settledAt = new Date().toISOString();
    if (next === "aborted" || TERMINAL_STATES.has(next)) {
      this.snapshot.terminatedAt ??= new Date().toISOString();
      if (code) this.snapshot.terminationReason = code;
    }
    this.touch();
    this.recordEvent("state", `${current} → ${next}`);
  }

  private recordTerminalReason(state: WorkerStatus, code?: string, message?: string): void {
    if (code) this.snapshot.terminationReason = code;
    if (code && message && ["failed", "stalled", "timed_out", "crashed"].includes(state)) {
      this.snapshot.failure = { code, message, at: new Date().toISOString() };
      this.snapshot.error = message;
    }
  }

  private recordTerminationError(error: unknown, eventType: string): void {
    const failure = error instanceof RpcError
      ? error
      : new RpcError("TERMINATION_ERROR", error instanceof Error ? error.message : String(error));
    this.snapshot.terminationError = { code: failure.code, message: failure.message, at: new Date().toISOString() };
    this.recordEvent(eventType, failure.message);
  }

  private resetIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (this.config.idleTimeoutMs <= 0 || this.snapshot.state !== "running" || this.snapshot.currentTool) return;
    this.idleTimer = setTimeout(() => {
      this.recordEvent("worker_stalled", `No Pi activity for ${this.config.idleTimeoutMs} ms`);
      void this.terminate("stalled", "IDLE_TIMEOUT", `No Pi activity for ${this.config.idleTimeoutMs} ms`);
    }, this.config.idleTimeoutMs);
    this.idleTimer.unref();
  }

  private touchActivity(): void {
    this.snapshot.lastActivityAt = new Date().toISOString();
    this.touch();
  }

  private recordEvent(type: string, message?: string, operation?: string): void {
    const event: WorkerEvent = { at: new Date().toISOString(), type };
    if (message) event.message = message;
    if (operation) event.operation = operation;
    this.snapshot.recentEvents.push(event);
    if (this.snapshot.recentEvents.length > this.config.maxRecentEvents) this.snapshot.recentEvents.splice(0, this.snapshot.recentEvents.length - this.config.maxRecentEvents);
    this.touchActivity();
  }

  private appendOutput(text: string): void {
    this.output = (this.output + text).slice(-OUTPUT_LIMIT);
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

  private touch(): void {
    this.snapshot.updatedAt = new Date().toISOString();
    this.snapshot.elapsedMs = Date.now() - Date.parse(this.snapshot.startedAt ?? this.snapshot.createdAt);
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

export function workerOutput(snapshot: WorkerSnapshot): string {
  return snapshot.lastOutput.slice(-OUTPUT_LIMIT);
}
