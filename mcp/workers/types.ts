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

export type WorkerMode = "direct" | "worktree";
export type WorkerProfile = "inspect" | "implement";

export interface WorkerFailure {
  code: string;
  message: string;
  at: string;
}

export interface WorkerEvent {
  at: string;
  type: string;
  message?: string;
  operation?: string;
}

export interface WorkerSnapshot {
  id: string;
  task: string;
  cwd: string;
  mode: WorkerMode;
  profile: WorkerProfile;
  requestedModel?: string;
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
  lastOutput: string;
  terminationReason?: string;
  failure?: WorkerFailure;
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
  worktreeSetupTimeoutMs: number;
  maxRecentEvents: number;
}

export const DEFAULT_WORKER_CONFIG: WorkerConfig = {
  rpcTimeoutMs: 15_000,
  idleTimeoutMs: 10 * 60_000,
  taskTimeoutMs: 60 * 60_000,
  abortGraceMs: 2_000,
  termGraceMs: 2_000,
  worktreeSetupTimeoutMs: 30_000,
  maxRecentEvents: 40,
};
