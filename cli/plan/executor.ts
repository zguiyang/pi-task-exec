import type { HostAdapter } from "../hosts/adapters.js";
import { dirname } from "node:path";
import type { CliIo } from "../io.js";
import { MANAGED_BY, type InstallPlan, type PlannedRemoval, type PlannedWrite } from "./model.js";
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
import {
  SKILL_CLI_TIMEOUT_MS,
  inspectSkillCliPaths,
  skillsCliSpawnEnv,
  spawnSkillsCli,
  verifySkillsCliInstall,
  type SkillCliPathInspection,
  type SkillsCliSpawn,
} from "../installers/skills-cli.js";
import type { SkillCliPlan, SkillCliSafetyFinding } from "../installers/skill.js";

export type ExecutionStatus = "dry-run" | "success" | "no-op" | "unsupported" | "conflict" | "cancelled" | "failed" | "partial";

export interface ExecutionError {
  code: string;
  message: string;
}

/**
 * Independent result for one target of a combined plan. A combined
 * MCP + Skills CLI plan runs each target separately so a failure in one part
 * never discards the other part's successful mutations.
 */
export interface ExecutionPart {
  target: "mcp" | "skill";
  status: ExecutionStatus;
  performed: string[];
  removed: string[];
  backups: Array<{ path: string; backupPath: string | null }>;
  errors: ExecutionError[];
  rollback: "none" | "restored" | "skipped";
  warnings: string[];
}

export interface ExecutionResult {
  status: ExecutionStatus;
  performed: string[];
  removed: string[];
  backups: Array<{ path: string; backupPath: string | null }>;
  errors: ExecutionError[];
  rollback: "none" | "restored" | "skipped";
  warnings: string[];
  /** Per-target results. Populated for combined plans and for the active target. */
  parts: ExecutionPart[];
}

export interface SafetyConfirmation {
  reason: "skill-path-safety";
  message: string;
}

export interface ExecutorOptions {
  /** Absolute roots the executor may touch. */
  roots: readonly string[];
  backupDir?: string;
  adapters: readonly HostAdapter[];
  io: CliIo;
  yes: boolean;
  /** Interactive confirmation; only consulted when `yes` is false, or when a
   * path-safety finding requires a default-No confirmation that `yes` cannot
   * bypass. */
  confirm?: (plan: InstallPlan, safety?: SafetyConfirmation) => Promise<boolean>;
  now?: () => Date;
  /** Test hook invoked after each successful write. */
  afterWrite?: (path: string, index: number) => Promise<void>;
  /** Injectable Skills CLI spawn; defaults to a structural shell-free spawn. */
  skillSpawn?: SkillsCliSpawn;
  /** Environment for the Skills CLI child (values are never printed). */
  skillEnv?: NodeJS.ProcessEnv;
  /** HOME/USERPROFILE override so the CLI resolves the injected home. */
  skillHome?: string;
  /** Package root holding the bundled skills/pi-delegate reference bytes. */
  skillPackageRoot?: string;
  skillTimeoutMs?: number;
  /**
   * Combined-plan Skill preflight already asked the default-No replacement
   * confirmation for this exact inspection signature. The Skill executor
   * re-inspects and skips the duplicate prompt only when the findings are
   * unchanged; any drift still blocks the spawn.
   */
  preconfirmedSkillSignature?: string;
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

function emptyResult(status: ExecutionStatus): ExecutionResult {
  return { status, performed: [], removed: [], backups: [], errors: [], rollback: "none", warnings: [], parts: [] };
}

function partOf(target: "mcp" | "skill", result: ExecutionResult): ExecutionPart {
  return {
    target,
    status: result.status,
    performed: [...result.performed],
    removed: [...result.removed],
    backups: [...result.backups],
    errors: [...result.errors],
    rollback: result.rollback,
    warnings: [...result.warnings],
  };
}

function unsupportedResult(capabilities: readonly { code: string; message: string }[]): ExecutionResult {
  return {
    ...emptyResult("unsupported"),
    errors: capabilities.map((capability) => ({ code: capability.code, message: capability.message })),
  };
}

function isSuccessStatus(status: ExecutionStatus): boolean {
  return status === "success" || status === "no-op" || status === "dry-run";
}

function combineParts(parts: readonly ExecutionPart[]): ExecutionResult {
  const performed = parts.flatMap((part) => part.performed);
  const removed = parts.flatMap((part) => part.removed);
  const backups = parts.flatMap((part) => part.backups);
  const errors = parts.flatMap((part) => part.errors);
  const warnings = parts.flatMap((part) => part.warnings);
  const rollback = parts.some((part) => part.rollback === "restored")
    ? "restored"
    : parts.some((part) => part.rollback === "skipped")
      ? "skipped"
      : "none";
  const successes = parts.filter((part) => isSuccessStatus(part.status));
  const failures = parts.filter((part) => !isSuccessStatus(part.status));
  let status: ExecutionStatus;
  if (failures.length === 0) {
    status = performed.length > 0 || removed.length > 0 ? "success" : "no-op";
  } else if (successes.length > 0) {
    status = "partial";
  } else if (failures.some((part) => part.status === "failed")) {
    status = "failed";
  } else if (failures.some((part) => part.status === "conflict")) {
    status = "conflict";
  } else if (failures.some((part) => part.status === "unsupported")) {
    status = "unsupported";
  } else if (failures.some((part) => part.status === "cancelled")) {
    status = "cancelled";
  } else if (failures.some((part) => part.status === "dry-run")) {
    status = "dry-run";
  } else {
    status = "no-op";
  }
  return { status, performed, removed, backups, errors, rollback, warnings, parts: [...parts] };
}

function inspectionSignature(inspection: SkillCliPathInspection): string {
  if (inspection.fatal) return `fatal:${inspection.fatal.code}:${inspection.fatal.message}`;
  return inspection.findings
    .map((item) => `${item.kind}:${item.path}`)
    .sort()
    .join("|");
}

/**
 * Inspect every path the Skills CLI may touch and decide whether execution may
 * continue. Root escape and any symlink/non-directory/lock-conflict finding is
 * a hard conflict that `--yes` cannot override. An ordinary existing skill
 * directory is allowed but flagged so the caller can require a default-No
 * confirmation.
 */
interface SkillTargetInspection {
  ok: boolean;
  error?: ExecutionError;
  signature?: string;
  replacement?: boolean;
  findings?: SkillCliSafetyFinding[];
}

async function inspectSkillExecutionTargets(cli: SkillCliPlan, options: ExecutorOptions): Promise<SkillTargetInspection> {
  // The Skills CLI is a third-party process that writes outside the plan/executor
  // seam. Assert every target it may touch is inside the explicitly allowed
  // roots before any inspection, confirmation, or spawn. `assertPathWithinRoots`
  // resolves the nearest existing ancestor, so a symlinked ancestor that
  // redirects outside the roots fails closed with `symlink_escape`.
  for (const target of [cli.installDir, cli.lockFile]) {
    try {
      await assertPathWithinRoots(target, { roots: options.roots });
    } catch (error) {
      if (error instanceof SafetyError) return { ok: false, error: { code: error.code, message: error.message } };
      throw error;
    }
  }

  const skillsRoot = dirname(cli.installDir);
  const agentsDir = dirname(skillsRoot);
  const inspection = await inspectSkillCliPaths({ agentsDir, skillsRoot, installDir: cli.installDir, lockFile: cli.lockFile });
  if (inspection.fatal) {
    return { ok: false, error: { code: inspection.fatal.code, message: inspection.fatal.message } };
  }
  // The plan's safety findings are conservative if paths changed since
  // planning; current findings below determine whether execution can continue.
  const findings = inspection.findings.length > 0 ? inspection.findings : cli.safety;
  // Only an ordinary, existing same-name skill directory can be replaced with
  // explicit consent. Symlinks, non-directory targets, and lock conflicts are
  // unsafe regardless of `--yes` or an affirmative prompt: the third-party CLI
  // must never be allowed to follow or replace those paths.
  const unsafe = findings.filter((item) => item.kind !== "existing-skill");
  if (unsafe.length > 0) {
    return {
      ok: false,
      error: {
        code: "unsafe_skill_path",
        message: `Refusing to run the Skills CLI for unsafe target paths:\n${unsafe.map((item) => `  - ${item.path} (${item.kind})`).join("\n")}`,
      },
    };
  }
  return {
    ok: true,
    signature: inspectionSignature(inspection),
    replacement: findings.some((item) => item.kind === "existing-skill"),
    findings,
  };
}

function skillReplacementConfirmation(findings: readonly SkillCliSafetyFinding[]): SafetyConfirmation {
  return {
    reason: "skill-path-safety",
    message: `The Skills CLI would replace existing skill directories:\n${findings.filter((item) => item.kind === "existing-skill").map((item) => `  - ${item.path} (existing-skill)`).join("\n")}`,
  };
}

/**
 * Execute the pinned Skills CLI after the same preflight/confirmation seam as
 * config writes. The CLI install is intentionally not treated as atomic: no
 * rollback is attempted and the caller is warned.
 */
async function executeSkillCli(plan: InstallPlan, cli: SkillCliPlan, options: ExecutorOptions): Promise<ExecutionResult> {
  const base: ExecutionResult = emptyResult("success");

  const pre = await inspectSkillExecutionTargets(cli, options);
  if (!pre.ok) {
    return { ...base, status: "conflict", errors: [pre.error as ExecutionError] };
  }
  const initialSignature = pre.signature as string;
  const replacement = pre.replacement === true;

  // A combined plan asks the replacement confirmation before any MCP write and
  // passes the inspected signature here. Re-ask only when the signature does
  // not match (including when `--yes` was requested but a replacement needs an
  // explicit default-No answer).
  const preconfirmed = options.preconfirmedSkillSignature !== undefined && options.preconfirmedSkillSignature === initialSignature;
  if (!preconfirmed && (!options.yes || replacement)) {
    if (!options.confirm) return { ...base, status: "cancelled" };
    const safety = replacement ? skillReplacementConfirmation(pre.findings ?? []) : undefined;
    const confirmed = await options.confirm(plan, safety);
    if (!confirmed) return { ...base, status: "cancelled" };
  }

  // Re-inspect immediately before the third-party spawn. A target created,
  // removed, or swapped while the prompt (or an MCP write in a combined plan)
  // was in progress changes the safety findings; refuse to run the CLI so no
  // third-party process can act on a drifted path.
  const afterConfirmation = await inspectSkillExecutionTargets(cli, options);
  if (!afterConfirmation.ok) {
    return { ...base, status: "conflict", errors: [afterConfirmation.error as ExecutionError] };
  }
  if (afterConfirmation.signature !== initialSignature) {
    return {
      ...base,
      status: "conflict",
      errors: [{ code: "skill_targets_changed", message: "The skill target paths changed during confirmation; refusing to run the Skills CLI." }],
    };
  }

  const spawn = options.skillSpawn ?? spawnSkillsCli;
  const env = skillsCliSpawnEnv(options.skillEnv ?? {}, options.skillHome ?? cli.home);
  const result = await spawn(cli.command, [...cli.args, "--yes"], {
    // Add Skills CLI's non-interactive confirmation only after the plan has
    // been explicitly accepted (or `--yes` accepted the printed plan).
    // The plan itself never carries this flag.
    //
    // The leading `npx -y` is only npm's package-install prompt. Keep argv as
    // an array; no shell interpolation is used.
    cwd: cli.cwd,
    env,
    timeoutMs: options.skillTimeoutMs ?? SKILL_CLI_TIMEOUT_MS,
  });
  const verification = await verifySkillsCliInstall({
    cli,
    exitCode: result.code,
    ...(result.error !== undefined ? { spawnError: result.error } : {}),
    ...(result.timedOut !== undefined ? { timedOut: result.timedOut } : {}),
    stdout: result.stdout,
    stderr: result.stderr,
    packageRoot: options.skillPackageRoot ?? "",
    env,
  });
  if (!verification.ok) {
    return {
      ...base,
      status: "failed",
      errors: verification.errors.map((message) => ({ code: "skill_cli_verification_failed", message })),
      warnings: [...verification.warnings],
    };
  }
  return { ...base, status: "success", performed: [cli.installDir], warnings: [...verification.warnings] };
}

/**
 * Apply the config/file part of a plan (MCP entry writes plus any legacy
 * atomic skill-file writes). Extracted so a combined plan can run this target
 * independently from the Skills CLI.
 */
async function executeConfigWrites(plan: InstallPlan, options: ExecutorOptions): Promise<ExecutionResult> {
  const base: ExecutionResult = emptyResult("success");

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

/**
 * Execute a generated plan. Dry-run and real execution share the same plan
 * generator; this function revalidates every base hash before confirmation and
 * again immediately before every write/removal, and rolls back all mutations
 * on any later failure.
 *
 * A plan that installs both a config target (MCP entry) and the Skills CLI
 * runs the two targets independently: each gets its own status, performed
 * paths, errors, and warnings, and the combined status is `partial` when one
 * succeeds and the other does not. A failure in one target never discards the
 * other target's successful mutations.
 */
export async function executePlan(plan: InstallPlan, options: ExecutorOptions): Promise<ExecutionResult> {
  if (plan.dryRun) return emptyResult("dry-run");
  if (plan.conflicts.length > 0) return emptyResult("conflict");

  const skillCli = plan.skillCli;
  const hasConfigWrites = plan.creates.length + plan.updates.length + plan.removals.length > 0;
  const mcpUnsupported = plan.unsupported.filter((item) => item.target === "mcp");
  const skillUnsupported = plan.unsupported.filter((item) => item.target === "skill");

  // Combined MCP/config + Skills CLI plan: run both targets independently and
  // preserve partial success. This runs even when MCP has no writes (already
  // configured) so the MCP no-op is reported next to the Skill outcome and a
  // failed Skill cannot hide the actual MCP state. The plan is confirmed once
  // here; the two parts then run without a second plan prompt. An `update`
  // plan always reports both components so every installed/absent permutation
  // is visible.
  if (plan.target === "both" && (skillCli !== undefined || plan.operation === "update")) {
    const hasMutation = hasConfigWrites || skillCli !== undefined;
    // A plan with no mutations (both components absent or already at target)
    // is a clear no-op. Never ask the operator to confirm a plan that writes
    // nothing; the plan warnings point at `setup`.
    if (hasMutation && !options.yes) {
      if (!options.confirm) return combineParts([partOf("mcp", emptyResult("cancelled")), partOf("skill", emptyResult("cancelled"))]);
      const confirmed = await options.confirm(plan);
      if (!confirmed) return combineParts([partOf("mcp", emptyResult("cancelled")), partOf("skill", emptyResult("cancelled"))]);
    }

    // Inspect the Skill target and ask any replacement-safety confirmation
    // before an MCP write can happen. `--yes` cannot bypass the default-No
    // replacement prompt, and unsafe paths abort the whole plan with no MCP
    // mutation.
    let preconfirmedSkillSignature: string | undefined;
    if (skillCli) {
      const pre = await inspectSkillExecutionTargets(skillCli, options);
      if (!pre.ok) {
        const error = pre.error as ExecutionError;
        const mcpPart = { ...emptyResult("no-op"), warnings: ["No MCP changes were applied because the Skill preflight failed."] };
        const skillPart = { ...emptyResult("conflict"), errors: [error] };
        return { ...emptyResult("conflict"), errors: [error], warnings: [...mcpPart.warnings], parts: [partOf("mcp", mcpPart), partOf("skill", skillPart)] };
      }
      preconfirmedSkillSignature = pre.signature;
      if (pre.replacement) {
        if (!options.confirm) return combineParts([partOf("mcp", emptyResult("cancelled")), partOf("skill", emptyResult("cancelled"))]);
        const confirmed = await options.confirm(plan, skillReplacementConfirmation(pre.findings ?? []));
        if (!confirmed) return combineParts([partOf("mcp", emptyResult("cancelled")), partOf("skill", emptyResult("cancelled"))]);
      }
    }

    const partOptions: ExecutorOptions = {
      ...options,
      yes: true,
      ...(preconfirmedSkillSignature !== undefined ? { preconfirmedSkillSignature } : {}),
    };
    const configResult =
      mcpUnsupported.length > 0
        ? unsupportedResult(mcpUnsupported)
        : hasConfigWrites
          ? await executeConfigWrites(plan, partOptions)
          : { ...emptyResult("no-op"), warnings: ["No MCP changes were planned."] };
    const skillResult =
      skillUnsupported.length > 0
        ? unsupportedResult(skillUnsupported)
        : skillCli
          ? await executeSkillCli(plan, skillCli, partOptions)
          : { ...emptyResult("no-op"), warnings: ["No Skill changes were planned."] };
    return combineParts([partOf("mcp", configResult), partOf("skill", skillResult)]);
  }

  if (plan.unsupported.length > 0) return unsupportedResult(plan.unsupported);
  if (skillCli) return executeSkillCli(plan, skillCli, options);
  return executeConfigWrites(plan, options);
}

export { MANAGED_BY };

export function serializeExecution(result: ExecutionResult): Record<string, unknown> {
  const sortBackups = (backups: ReadonlyArray<{ path: string; backupPath: string | null }>) =>
    [...backups].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return {
    status: result.status,
    performed: [...result.performed].sort(),
    removed: [...result.removed].sort(),
    backups: sortBackups(result.backups),
    rollback: result.rollback,
    errors: result.errors.map((error) => ({ code: error.code, message: error.message })),
    warnings: [...result.warnings].sort(),
    parts: result.parts.map((part) => ({
      target: part.target,
      status: part.status,
      performed: [...part.performed].sort(),
      removed: [...part.removed].sort(),
      backups: sortBackups(part.backups),
      rollback: part.rollback,
      errors: part.errors.map((error) => ({ code: error.code, message: error.message })),
      warnings: [...part.warnings].sort(),
    })),
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
  if (result.parts.length > 1) {
    section("Parts", result.parts.map((part) => `${part.target}: ${part.status}`));
  }
  lines.push(`Rollback: ${result.rollback}`);
  return lines.join("\n");
}
