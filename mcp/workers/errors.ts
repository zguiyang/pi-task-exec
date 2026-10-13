import type { FailurePhase, WorkerFailure } from "./types.js";
import { redactSecrets } from "./redact.js";

/**
 * A failure with structured semantics that can be surfaced to MCP clients
 * without leaking credentials. `phase` describes where the failure happened
 * and `workerId` is present once a worker exists.
 */
export class WorkerError extends Error {
  readonly code: string;
  readonly phase: FailurePhase;
  readonly workerId: string | undefined;

  constructor(code: string, message: string, phase: FailurePhase, workerId?: string) {
    super(redactSecrets(message));
    this.name = "WorkerError";
    this.code = code;
    this.phase = phase;
    this.workerId = workerId;
  }

  toFailure(): WorkerFailure {
    return {
      code: this.code,
      message: this.message,
      phase: this.phase,
      ...(this.workerId !== undefined ? { workerId: this.workerId } : {}),
      at: new Date().toISOString(),
    };
  }
}

/**
 * Convert an unknown error into a WorkerError, preserving an existing
 * code/phase when present and attaching `workerId` once the worker exists.
 */
export function toWorkerError(
  error: unknown,
  phase: FailurePhase,
  fallbackCode = "WORKER_ERROR",
  workerId?: string,
  preferPhase = false,
): WorkerError {
  if (error instanceof WorkerError) return workerId === undefined || error.workerId !== undefined ? error : new WorkerError(error.code, error.message, error.phase, workerId);
  if (error instanceof Error && "code" in error && typeof (error as { code?: unknown }).code === "string") {
    const coded = error as Error & { code: string; phase?: FailurePhase };
    return new WorkerError(coded.code, coded.message, preferPhase ? phase : (coded.phase ?? phase), workerId);
  }
  return new WorkerError(fallbackCode, error instanceof Error ? error.message : String(error), phase, workerId);
}
