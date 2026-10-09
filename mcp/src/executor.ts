import type { HostAdapter } from "./adapters.js";
import type { CliIo } from "./io.js";
import { MANAGED_BY, type InstallPlan, type PlannedRemoval, type PlannedWrite } from "./plan.js";
import {
  SafetyError,
  assertManaged,
  assertPathWithinRoots,
  atomicWriteFile,
  backupFile,
  removeFile,
  restoreBackup,
  snapshotFile,
} from "./safety.js";

export type ExecutionStatus = "dry-run" | "success" | "no-op" | "unsupported" | "conflict" | "cancelled" | "failed";

export interface ExecutionError {
  code: string;
  message: string;
}

export interface ExecutionResult {
  status: ExecutionStatus;
  performed: string[];
  removed: string[];
  backups: Array<{ path: string; backupPath: string | null }>;
  errors: ExecutionError[];
  rollback: "none" | "restored" | "skipped";
  warnings: string[];
}

export interface ExecutorOptions {
  /** Absolute roots the executor may touch. */
  roots: readonly string[];
  backupDir?: string;
  adapters: readonly HostAdapter[];
  io: CliIo;
  yes: boolean;
  /** Interactive confirmation; only consulted when `yes` is false. */
  confirm?: (plan: InstallPlan) => Promise<boolean>;
  now?: () => Date;
  /** Test hook invoked after each successful write. */
  afterWrite?: (path: string, index: number) => Promise<void>;
}

function adaptersFor(adapters: readonly HostAdapter[], host: string | undefined): HostAdapter | undefined {
  return host === undefined ? undefined : adapters.find((adapter) => adapter.id === host);
}

function mergeRoots(options: ExecutorOptions, extra?: readonly string[]): string[] {
  return extra ? [...options.roots, ...extra] : [...options.roots];
}

function writeOptions(write: PlannedWrite, options: ExecutorOptions) {
  return {
    roots: mergeRoots(options),
    ...(write.mode !== undefined ? { mode: write.mode } : {}),
  };
}

function errorCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return undefined;
}

function snapshotError(error: unknown): ExecutionError {
  if (error instanceof SafetyError) return { code: error.code, message: error.message };
  return {
    code: errorCode(error) ?? "snapshot_failed",
    message: error instanceof Error ? error.message : String(error),
  };
}

type SnapshotResult = { ok: true; current: { content: string; sha256: string } | null } | { ok: false; error: ExecutionError };

/**
 * Read the current file state without ever treating an I/O error as absence.
 * A failure to inspect a path is surfaced to the caller instead of being
 * silently reported as a missing file.
 */
async function trySnapshot(path: string): Promise<SnapshotResult> {
  try {
    return { ok: true, current: await snapshotFile(path) };
  } catch (error) {
    return { ok: false, error: snapshotError(error) };
  }
}

async function performWrite(write: PlannedWrite, options: ExecutorOptions): Promise<void> {
  if (write.target === "mcp") {
    const adapter = adaptersFor(options.adapters, write.host);
    if (!adapter) throw new SafetyError("unknown_host", `No adapter is registered for host "${write.host ?? "unknown"}".`);
    await adapter.writeConfig(write.path, write.content, writeOptions(write, options));
    return;
  }
  await atomicWriteFile(write.path, write.content, writeOptions(write, options));
}

async function validateRemoval(removal: PlannedRemoval, options: ExecutorOptions): Promise<ExecutionError | null> {
  try {
    await assertPathWithinRoots(removal.path, { roots: mergeRoots(options) });
  } catch (error) {
    if (error instanceof SafetyError) return { code: error.code, message: error.message };
    throw error;
  }
  const snapshot = await trySnapshot(removal.path);
  if (!snapshot.ok) return snapshot.error;
  const current = snapshot.current;
  if (current === null) return null;
  try {
    assertManaged({ path: removal.path, sha256: removal.sha256, managedBy: removal.managedBy }, current);
  } catch (error) {
    if (error instanceof SafetyError) return { code: error.code, message: error.message };
    throw error;
  }
  return null;
}

interface JournalEntry {
  kind: "write" | "remove";
  path: string;
  /** Content written for a create; null for updates and removals. */
  plannedContent: string | null;
  backupPath: string | null;
  existed: boolean;
}

async function checkWriteBase(write: PlannedWrite, options: ExecutorOptions): Promise<ExecutionError | null> {
  try {
    await assertPathWithinRoots(write.path, { roots: mergeRoots(options) });
  } catch (error) {
    if (error instanceof SafetyError) return { code: error.code, message: error.message };
    throw error;
  }
  const snapshot = await trySnapshot(write.path);
  if (!snapshot.ok) return snapshot.error;
  const current = snapshot.current;
  const currentSha = current === null ? null : current.sha256;
  if (currentSha !== write.baseSha256) {
    return { code: "plan_stale", message: `The file changed after the plan was generated: ${write.path}` };
  }
  return null;
}

/**
 * Validate every write base hash and every managed removal before a byte is
 * mutated. Any drift aborts the whole plan so one stale file cannot partially
 * apply a multi-file operation.
 */
async function preflight(writes: readonly PlannedWrite[], removals: readonly PlannedRemoval[], options: ExecutorOptions): Promise<ExecutionError | null> {
  for (const write of writes) {
    const error = await checkWriteBase(write, options);
    if (error) return error;
  }
  for (const removal of removals) {
    const error = await validateRemoval(removal, options);
    if (error) return error;
  }
  return null;
}

/**
 * Undo a partially applied plan in reverse order. Created files are deleted
 * only while their content still matches the planned write. Pre-existing
 * writes are restored only while the file still holds exactly what this run
 * wrote, and removed files are restored only while the path is still absent.
 * Any drift means the user has taken over the file, so it is preserved and
 * the rollback is reported as skipped.
 */
async function rollbackJournal(journal: readonly JournalEntry[], options: ExecutorOptions): Promise<{ rollback: ExecutionResult["rollback"]; warnings: string[] }> {
  const warnings: string[] = [];
  let rolledBack = false;
  let skipped = false;
  for (let index = journal.length - 1; index >= 0; index -= 1) {
    const entry = journal[index];
    if (!entry) continue;
    if (!entry.existed) {
      const snapshot = await trySnapshot(entry.path);
      if (!snapshot.ok) {
        skipped = true;
        warnings.push(`Skipped rollback because the current content could not be read: ${entry.path} (${snapshot.error.message})`);
        continue;
      }
      const current = snapshot.current;
      if (current === null) {
        rolledBack = true;
        continue;
      }
      if (entry.plannedContent !== null && current.content === entry.plannedContent) {
        try {
          await removeFile(entry.path, { roots: mergeRoots(options) });
          rolledBack = true;
        } catch (error) {
          skipped = true;
          warnings.push(`Rollback failed for ${entry.path}: ${error instanceof Error ? error.message : String(error)}`);
        }
      } else {
        skipped = true;
        warnings.push(`Skipped rollback because created content drifted: ${entry.path}`);
      }
      continue;
    }
    if (entry.backupPath === null) {
      skipped = true;
      warnings.push(`Skipped rollback because no backup is available: ${entry.path}`);
      continue;
    }
    const snapshot = await trySnapshot(entry.path);
    if (!snapshot.ok) {
      skipped = true;
      warnings.push(`Skipped rollback because the current content could not be read: ${entry.path} (${snapshot.error.message})`);
      continue;
    }
    const current = snapshot.current;
    if (entry.kind === "write") {
      // Only restore an updated file while it still holds exactly the bytes
      // this run wrote. If the user changed or removed it, leave it alone.
      if (current === null || entry.plannedContent === null || current.content !== entry.plannedContent) {
        skipped = true;
        warnings.push(`Skipped rollback because updated content drifted or is missing: ${entry.path}`);
        continue;
      }
    } else if (current !== null) {
      // A file appeared after the removal: it is not ours to delete, so the
      // backup is not restored over it.
      skipped = true;
      warnings.push(`Skipped rollback because a file reappeared at the removed path: ${entry.path}`);
      continue;
    }
    try {
      await restoreBackup(entry.backupPath, entry.path, { roots: mergeRoots(options) });
      rolledBack = true;
    } catch (error) {
      skipped = true;
      warnings.push(`Rollback failed for ${entry.path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { rollback: skipped ? "skipped" : rolledBack ? "restored" : "none", warnings };
}

/**
 * Execute a generated plan. Dry-run and real execution share the same plan
 * generator; this function revalidates every base hash before confirmation and
 * again immediately before every write/removal, and rolls back all mutations
 * on any later failure.
 */
export async function executePlan(plan: InstallPlan, options: ExecutorOptions): Promise<ExecutionResult> {
  const base: ExecutionResult = {
    status: "success",
    performed: [],
    removed: [],
    backups: [],
    errors: [],
    rollback: "none",
    warnings: [],
  };

  if (plan.dryRun) return { ...base, status: "dry-run" };
  if (plan.conflicts.length > 0) return { ...base, status: "conflict" };
  if (plan.unsupported.length > 0) return { ...base, status: "unsupported" };

  const writes = [...plan.creates, ...plan.updates];
  if (writes.length === 0 && plan.removals.length === 0) return { ...base, status: "no-op" };

  // Revalidate before the confirmation prompt so the user sees accurate state.
  const beforeConfirmation = await preflight(writes, plan.removals, options);
  if (beforeConfirmation) return { ...base, status: "conflict", errors: [beforeConfirmation] };

  if (!options.yes) {
    if (!options.confirm) return { ...base, status: "cancelled" };
    const confirmed = await options.confirm(plan);
    if (!confirmed) return { ...base, status: "cancelled" };
  }

  // The user may have changed files while the prompt was open. Re-check every
  // base hash again; a stale file blocks all planned writes before any write.
  const afterConfirmation = await preflight(writes, plan.removals, options);
  if (afterConfirmation) return { ...base, status: "conflict", errors: [afterConfirmation] };

  const performed: string[] = [];
  const removed: string[] = [];
  const backups: Array<{ path: string; backupPath: string | null }> = [];
  const warnings: string[] = [];
  const journal: JournalEntry[] = [];

  try {
    for (let index = 0; index < writes.length; index += 1) {
      const write = writes[index];
      if (!write) continue;
      // Compare existence/hash to the plan immediately before touching this
      // file. A create planned with baseSha256 null must never clobber a file
      // that appeared after planning.
      const stale = await checkWriteBase(write, options);
      if (stale) throw new SafetyError(stale.code, stale.message);

      const current = await snapshotFile(write.path);
      if (current !== null && current.content === write.content) {
        warnings.push(`Already up to date: ${write.path}`);
        continue;
      }
      let backupPath: string | null = null;
      let existed = false;
      if (current !== null) {
        existed = true;
        const backup = await backupFile(write.path, {
          roots: mergeRoots(options),
          ...(options.backupDir !== undefined ? { backupDir: options.backupDir } : {}),
          ...(options.now !== undefined ? { now: options.now } : {}),
        });
        backupPath = backup.backupPath;
      }
      journal.push({ kind: "write", path: write.path, plannedContent: write.content, backupPath, existed });
      await performWrite(write, options);
      performed.push(write.path);
      if (backupPath !== null) backups.push({ path: write.path, backupPath });
      if (options.afterWrite) await options.afterWrite(write.path, index);
    }

    for (const removal of plan.removals) {
      const current = await snapshotFile(removal.path);
      if (current === null) {
        warnings.push(`Already absent: ${removal.path}`);
        continue;
      }
      // Ownership is re-checked immediately before deletion: the preflight
      // only proves the file was managed when the plan was generated.
      assertManaged({ path: removal.path, sha256: removal.sha256, managedBy: removal.managedBy }, current);
      const backup = await backupFile(removal.path, {
        roots: mergeRoots(options),
        ...(options.backupDir !== undefined ? { backupDir: options.backupDir } : {}),
        ...(options.now !== undefined ? { now: options.now } : {}),
      });
      journal.push({ kind: "remove", path: removal.path, plannedContent: null, backupPath: backup.backupPath, existed: true });
      await removeFile(removal.path, { roots: mergeRoots(options) });
      removed.push(removal.path);
      if (backup.backupPath !== null) backups.push({ path: removal.path, backupPath: backup.backupPath });
    }
  } catch (error) {
    const failure = error instanceof SafetyError ? { code: error.code, message: error.message } : { code: "write_failed", message: error instanceof Error ? error.message : String(error) };
    const rollback = await rollbackJournal(journal, options);
    warnings.push(...rollback.warnings);
    return {
      ...base,
      status: "failed",
      performed: [...performed],
      removed: [...removed],
      backups,
      errors: [failure],
      rollback: rollback.rollback,
      warnings,
    };
  }

  return {
    ...base,
    status: performed.length > 0 || removed.length > 0 ? "success" : "no-op",
    performed,
    removed,
    backups,
    warnings,
  };
}

export { MANAGED_BY };

export function serializeExecution(result: ExecutionResult): Record<string, unknown> {
  return {
    status: result.status,
    performed: [...result.performed].sort(),
    removed: [...result.removed].sort(),
    backups: [...result.backups].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0)),
    rollback: result.rollback,
    errors: result.errors.map((error) => ({ code: error.code, message: error.message })),
    warnings: [...result.warnings].sort(),
  };
}

export function formatExecution(result: ExecutionResult): string {
  const lines: string[] = [`Execution: ${result.status}`];
  const section = (title: string, entries: string[]) => {
    lines.push(`${title}:`);
    if (entries.length === 0) lines.push("  (none)");
    else for (const entry of entries) lines.push(`  - ${entry}`);
  };
  section("Performed", result.performed);
  section("Removed", result.removed);
  section("Backups", result.backups.map((item) => `${item.path} -> ${item.backupPath ?? "(created file, no backup)"}`));
  section("Errors", result.errors.map((error) => `${error.code}: ${error.message}`));
  section("Warnings", result.warnings);
  lines.push(`Rollback: ${result.rollback}`);
  return lines.join("\n");
}
