export type WorkerStatus =
  | "starting"
  | "running"
  | "settled"
  | "failed"
  | "stalled"
  | "timed_out"
  | "aborting"
  | "aborted"
  | "crashed";

export type WorkerProfile = "inspect" | "implement";
/** Reasoning levels accepted by Pi 1.1.0 `set_thinking_level`; the active model may support only a subset. */
export type WorkerThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/**
 * Where a failure was observed. The phase lets a client tell a spawn/model
 * preflight failure apart from a runtime cycle failure or a release failure.
 */
export type FailurePhase =
  | "spawn"
  | "model"
  | "thinking"
  | "prompt"
  | "follow_up"
  | "steer"
  | "runtime"
  | "abort"
  | "release"
  | "shutdown";

export interface WorkerFailure {
  code: string;
  message: string;
  phase: FailurePhase;
  workerId?: string;
  cycleId?: number;
  at: string;
}

export interface WorkerEvent {
  at: string;
  type: string;
  message?: string;
  operation?: string;
}

/**
 * Authoritative final assistant message for one activity cycle. It is built
 * only from Pi's finalized `message_end` assistant message, never from text
 * deltas or stderr. `text` is the full message unless a configured size limit
 * forced truncation, in which case `truncated` is true and `chars` reports the
 * original length.
 */
export interface WorkerResult {
  cycleId: number;
  text: string;
  truncated: boolean;
  chars: number;
  completedAt: string;
  stopReason?: string;
}

/** Bounded archive of a completed activity cycle. */
export interface WorkerCycle {
  cycleId: number;
  state: WorkerStatus;
  operation?: string;
  startedAt: string;
  endedAt: string;
  result: WorkerResult;
  failure?: WorkerFailure;
}

export interface WorkerSnapshot {
  id: string;
  task: string;
  cwd: string;
  profile: WorkerProfile;
  requestedModel?: string;
  requestedThinking?: WorkerThinkingLevel;
  effectiveModel?: { provider: string; id: string };
  thinkingLevel?: string;
  sessionMode: "no-session";
  /** `status` is retained for clients of the original 0.1 API. */
  status: WorkerStatus;
  state: WorkerStatus;
  processAlive: boolean;
  pid?: number;
  createdAt: string;
  startedAt?: string;
  updatedAt: string;
  lastActivityAt: string;
  taskTimeoutMs: number;
  /** Follow-up queue length as last reported by Pi's queue_update event. */
  pendingFollowUps: number;
  runStartedAt?: string;
  deadlineAt?: string;
  settledAt?: string;
  completedAt?: string;
  terminatedAt?: string;
  elapsedMs: number;
  currentOperation?: string;
  currentTool?: string;
  latestMessage?: string;
  recentEvents: WorkerEvent[];
  /** Raw diagnostics: streamed deltas and stderr. Never the authoritative result. */
  lastOutput: string;
  /** Monotonic positive activity-cycle counter, 0 before the first cycle starts. */
  cycleId: number;
  /** Authoritative result for the latest completed cycle. */
  result?: WorkerResult;
  /** Failure for the latest failed cycle, or a spawn/model/release failure. */
  failure?: WorkerFailure;
  /** Bounded archive of previous cycles, newest first. */
  cycles: WorkerCycle[];
  /** True once pi_release terminated the process and freed its live slot. */
  released: boolean;
  releasedAt?: string;
  /** Set when a release attempt could not confirm process termination; release can be retried. */
  releaseError?: WorkerFailure;
  terminationReason?: string;
  terminationError?: WorkerFailure;
  /** `error` is retained as the original human-readable error field. */
  error?: string;
  exitCode?: number;
  signal?: NodeJS.Signals;
}

export interface WorkerConfig {
  rpcTimeoutMs: number;
  idleTimeoutMs: number;
  taskTimeoutMs: number;
  abortGraceMs: number;
  termGraceMs: number;
  maxRecentEvents: number;
  maxResultChars: number;
  maxCycles: number;
  maxArchivedWorkers: number;
}

export const DEFAULT_WORKER_CONFIG: WorkerConfig = {
  rpcTimeoutMs: 15_000,
  idleTimeoutMs: 10 * 60_000,
  taskTimeoutMs: 60 * 60_000,
  abortGraceMs: 2_000,
  termGraceMs: 2_000,
  maxRecentEvents: 40,
  maxResultChars: 256_000,
  maxCycles: 10,
  maxArchivedWorkers: 25,
};

/** States in which the current activity cycle has ended. */
export const CYCLE_TERMINAL_STATES: ReadonlySet<WorkerStatus> = new Set<WorkerStatus>([
  "settled",
  "failed",
  "stalled",
  "timed_out",
  "aborted",
  "crashed",
]);

/** Failure states that carry a structured `failure` object. */
export const FAILURE_STATES: ReadonlySet<WorkerStatus> = new Set<WorkerStatus>([
  "failed",
  "stalled",
  "timed_out",
  "crashed",
]);
