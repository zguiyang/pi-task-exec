/**
 * Bounded, safe removal of the shared `pi-delegate` Skill.
 *
 * The capability is split into two helpers so the destructive choice stays in
 * the caller:
 *
 * - {@link planSkillRemoval} is strictly read-only. It inspects the scope's
 *   Skill directory and Skills CLI lockfile and returns a discriminated
 *   `absent` / `ready` / `conflict` plan carrying only safe metadata (paths,
 *   hashes, owner identity - never environment values or file contents).
 *   The caller performs the explicit user confirmation; this module never
 *   prompts.
 * - {@link executeSkillRemoval} consumes a previously produced plan and only
 *   mutates when the current lock bytes and Skill directory still match the
 *   planned snapshot. It takes recoverable backups of both the Skill directory
 *   and the lock file, rewrites the lock by removing only the `pi-delegate`
 *   entry (all other entries and fields are preserved), removes the Skill
 *   directory without ever following a symlink, and rolls both targets back if
 *   any mutation step fails.
 *
 * Safety rules enforced here:
 *
 * - The lock must record `pi-delegate` with source `zguiyang/pi-task-exec`;
 *   any other owner (or an unprovable owner) is a conflict, never a removal.
 * - The target directory must be real: no symlink is accepted in the target,
 *   its scoped ancestors, or anywhere under the Skill directory, so nothing is
 *   ever followed during planning, backup, or deletion.
 * - The lock file must be a regular, valid-JSON file.
 * - Every touched path must stay inside the caller-provided roots.
 * - No network access, no third-party CLI, no shell: only local filesystem
 *   operations through the shared safety primitives.
 */

import { copyFile, lstat, mkdir, readdir, readFile, rm, rmdir } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { SKILL_NAME } from "../identity.js";
import { MANAGED_BY, type HostContext, type PlanConflict, type Scope } from "../plan/model.js";
import {
  SafetyError,
  assertPathWithinRoots,
  atomicWriteFile,
  backupFile,
  isWithin,
  removeFile,
  restoreBackup,
  sha256,
} from "../plan/safety.js";
import { SKILL_EXPECTED_SOURCE, skillCliTargetPaths } from "./skills-cli.js";

/** Input for the read-only removal planner. */
export interface SkillRemovalInput {
  scope: Scope;
  context: HostContext;
}

/**
 * Safe, printable identity of what the plan is about. It contains no
 * environment values, no file contents, and no secrets, so it can be shown to
 * the user as part of the confirmation the caller owns.
 */
export interface SkillRemovalMetadata {
  /** Tool recorded as the manager of this removal (`pi-task-exec`). */
  managedBy: string;
  /** Skill being removed (`pi-delegate`). */
  skill: string;
  /** Required lock owner (`zguiyang/pi-task-exec`). */
  owner: string;
  /** Ref recorded by the lock for this Skill, when one is present. */
  ref: string | null;
}

interface SkillRemovalPlanFields {
  scope: Scope;
  skill: string;
  source: string;
  installDir: string;
  lockFile: string;
  /** sha256 of the lock file bytes at plan time; null when no lock file exists. */
  lockSha256: string | null;
  metadata: SkillRemovalMetadata;
}

/** Nothing to remove: no Skill directory and no lock record. */
export interface SkillRemovalAbsentPlan extends SkillRemovalPlanFields {
  kind: "absent";
  reason: string;
}

/** Provably owned, symlink-free removal target ready for execution. */
export interface SkillRemovalReadyPlan extends SkillRemovalPlanFields {
  kind: "ready";
  /** sha256 of the lock file bytes; execution refuses if it changes. */
  lockSha256: string;
  /**
   * sha256 over the recursive listing of the Skill directory (entry kinds,
   * relative paths, and file content hashes). Execution refuses if it changes.
   */
  dirFingerprint: string;
  /** Every ancestor and target path verified at plan time; re-checked before mutation. */
  checkedPaths: string[];
}

/** Removal must not proceed; the conflict names the blocking path. */
export interface SkillRemovalConflictPlan extends SkillRemovalPlanFields {
  kind: "conflict";
  conflict: PlanConflict;
}

export type SkillRemovalPlan = SkillRemovalAbsentPlan | SkillRemovalReadyPlan | SkillRemovalConflictPlan;

export interface SkillRemovalExecutionOptions {
  /** Absolute roots every touched path (targets and backups) must stay inside. */
  roots: readonly string[];
  /** Clock used for backup timestamps; defaults to `new Date()`. */
  now?: () => Date;
}

export type SkillRemovalStatus = "absent" | "success" | "conflict" | "failed";

export interface SkillRemovalResult {
  status: SkillRemovalStatus;
  /** Paths rewritten in place (the lock file). */
  performed: string[];
  /** Paths fully removed (the Skill directory). */
  removed: string[];
  /** Backups taken before any mutation, so a removal is always recoverable. */
  backups: Array<{ path: string; backupPath: string | null }>;
  errors: Array<{ code: string; message: string }>;
  rollback: "none" | "restored" | "skipped";
  warnings: string[];
}

/** Conflict code: a path in the target chain is a symlink and is never followed. */
export const SKILL_REMOVAL_CONFLICT_SYMLINK = "skill_path_symlink";
/** Conflict code: the lock bytes changed between plan and execution. */
export const SKILL_REMOVAL_LOCK_DRIFT = "skill_removal_lock_drift";
/** Conflict code: the Skill directory contents changed between plan and execution. */
export const SKILL_REMOVAL_DIR_DRIFT = "skill_removal_dir_drift";
/** Conflict code: an expected path vanished between plan and execution. */
export const SKILL_REMOVAL_PATH_DRIFT = "skill_removal_path_drift";

type PathState =
  | { kind: "missing" }
  | { kind: "dir" }
  | { kind: "file" }
  | { kind: "symlink" }
  | { kind: "other" }
  | { kind: "error"; message: string };

/** `lstat`-based classification that never follows the final component. */
async function lstatKind(path: string): Promise<PathState> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) return { kind: "symlink" };
    if (info.isDirectory()) return { kind: "dir" };
    if (info.isFile()) return { kind: "file" };
    return { kind: "other" };
  } catch (error) {
    const errno = error as NodeJS.ErrnoException;
    if (errno.code === "ENOENT") return { kind: "missing" };
    return { kind: "error", message: errno.message };
  }
}

/**
 * Component-by-component chain from the longest covering anchor (the scope
 * root, or `XDG_STATE_HOME` for a global lock) down to `target`. Walking
 * component by component is what makes an intermediate symlink visible;
 * `lstat(target)` alone would silently follow it.
 */
function chainFromAnchor(anchors: readonly string[], target: string): string[] | null {
  const absolute = resolve(target);
  let anchor: string | null = null;
  for (const candidate of anchors) {
    const root = resolve(candidate);
    if (!isWithin(root, absolute)) continue;
    if (anchor === null || root.length > anchor.length) anchor = root;
  }
  if (anchor === null) return null;
  const parts = relative(anchor, absolute).split(sep).filter((part) => part !== "" && part !== ".");
  const chain = [anchor];
  let current = anchor;
  for (const part of parts) {
    current = join(current, part);
    chain.push(current);
  }
  return chain;
}

interface LockShape {
  parsed: Record<string, unknown>;
  skills: Record<string, unknown> | null;
  record: Record<string, unknown> | null;
}

type LockShapeResult = { ok: true; shape: LockShape } | { ok: false; code: string; message: string };

/**
 * Parse the lock file into its structural parts. Invalid JSON, a non-object
 * document, a non-object `skills` map, or a non-object `pi-delegate` record
 * are all rejected so ownership can never be misread from malformed input.
 */
function readLockShape(raw: string, lockFile: string): LockShapeResult {
  const malformed = (detail: string): LockShapeResult => ({
    ok: false,
    code: "skill_lock_malformed",
    message: `The skill lockfile at ${lockFile} ${detail}; ownership cannot be verified.`,
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return malformed("is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return malformed("is not a JSON object");
  }
  const document = parsed as Record<string, unknown>;
  const skillsValue = document.skills;
  if (skillsValue === undefined || skillsValue === null) {
    return { ok: true, shape: { parsed: document, skills: null, record: null } };
  }
  if (typeof skillsValue !== "object" || Array.isArray(skillsValue)) {
    return malformed(`records a "skills" field that is not an object`);
  }
  const skills = skillsValue as Record<string, unknown>;
  const recordValue = skills[SKILL_NAME];
  if (recordValue === undefined) {
    return { ok: true, shape: { parsed: document, skills, record: null } };
  }
  if (typeof recordValue !== "object" || recordValue === null || Array.isArray(recordValue)) {
    return { ok: false, code: "skill_lock_malformed", message: `The ${SKILL_NAME} record in the lockfile at ${lockFile} is not an object; ownership cannot be verified.` };
  }
  return { ok: true, shape: { parsed: document, skills, record: recordValue as Record<string, unknown> } };
}

function recordSource(record: Record<string, unknown> | null): string | null {
  const source = record?.source;
  return typeof source === "string" && source !== "" ? source : null;
}

function recordRef(record: Record<string, unknown> | null): string | null {
  const ref = record?.ref;
  return typeof ref === "string" && ref !== "" ? ref : null;
}

interface LockSnapshot {
  ok: boolean;
  missing: boolean;
  raw: string | null;
  sha256: string | null;
  message: string;
}

/** Read the lock file bytes without ever following a symlink. */
async function readLockSnapshot(path: string): Promise<LockSnapshot> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) return { ok: false, missing: false, raw: null, sha256: null, message: `the lock file at ${path} is a symlink` };
    if (!info.isFile()) return { ok: false, missing: false, raw: null, sha256: null, message: `the lock path at ${path} is not a regular file` };
    const raw = await readFile(path, "utf8");
    return { ok: true, missing: false, raw, sha256: sha256(raw), message: "" };
  } catch (error) {
    const errno = error as NodeJS.ErrnoException;
    if (errno.code === "ENOENT") return { ok: false, missing: true, raw: null, sha256: null, message: `the lock file at ${path} does not exist` };
    return { ok: false, missing: false, raw: null, sha256: null, message: `the lock file at ${path} cannot be read (${errno.message})` };
  }
}

class SkillTreeError extends Error {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string, message: string) {
    super(message);
    this.name = "SkillTreeError";
    this.code = code;
    this.path = path;
  }
}

interface FingerprintResult {
  ok: boolean;
  code: string;
  path: string;
  message: string;
  value: string;
}

/**
 * Hash the full recursive content of the Skill directory. Any symlink (a
 * symlink is never followed), non-regular entry, or unreadable path makes the
 * fingerprint fail, which surfaces as a conflict instead of a plan.
 */
async function fingerprintSkillDirectory(dir: string): Promise<FingerprintResult> {
  const lines: string[] = [];
  const walk = async (current: string, prefix: string): Promise<void> => {
    let names: string[];
    try {
      names = (await readdir(current)).sort();
    } catch (error) {
      const errno = error as NodeJS.ErrnoException;
      throw new SkillTreeError("skill_path_unreadable", current, `Cannot read the skill directory ${current}: ${errno.message}`);
    }
    for (const name of names) {
      const full = join(current, name);
      const rel = prefix === "" ? name : `${prefix}/${name}`;
      let info;
      try {
        info = await lstat(full);
      } catch (error) {
        const errno = error as NodeJS.ErrnoException;
        throw new SkillTreeError("skill_path_unreadable", full, `Cannot inspect ${full}: ${errno.message}`);
      }
      if (info.isSymbolicLink()) {
        throw new SkillTreeError(SKILL_REMOVAL_CONFLICT_SYMLINK, full, `A symlink exists under the skill directory; refusing to follow it: ${full}`);
      }
      if (info.isDirectory()) {
        lines.push(`dir\t${rel}`);
        await walk(full, rel);
        continue;
      }
      if (!info.isFile()) {
        throw new SkillTreeError("skill_path_not_directory", full, `A non-regular entry exists under the skill directory: ${full}`);
      }
      let content: Buffer;
      try {
        content = await readFile(full);
      } catch (error) {
        const errno = error as NodeJS.ErrnoException;
        throw new SkillTreeError("skill_path_unreadable", full, `Cannot read ${full}: ${errno.message}`);
      }
      lines.push(`file\t${rel}\t${sha256(content)}`);
    }
  };
  try {
    await walk(dir, "");
  } catch (error) {
    if (error instanceof SkillTreeError) {
      return { ok: false, code: error.code, path: error.path, message: error.message, value: "" };
    }
    const errno = error as NodeJS.ErrnoException;
    return { ok: false, code: "skill_path_unreadable", path: dir, message: `Cannot fingerprint the skill directory ${dir}: ${errno.message}`, value: "" };
  }
  return { ok: true, code: "", path: dir, message: "", value: sha256(`${lines.join("\n")}\n`) };
}

function conflictPlan(fields: SkillRemovalPlanFields, conflict: PlanConflict): SkillRemovalConflictPlan {
  return { ...fields, kind: "conflict", conflict };
}

/**
 * Read-only removal plan for the shared `pi-delegate` Skill at project or
 * global scope. Never writes, never prompts, never spawns a process.
 *
 * Returns:
 * - `absent`: no Skill directory and no lock record - nothing to remove.
 * - `ready`: the lock records `pi-delegate` from `zguiyang/pi-task-exec`, the
 *   directory and its scoped ancestors are real (no symlinks), the lock is
 *   valid JSON, and nothing under the Skill directory is a symlink. The plan
 *   carries the lock snapshot hash, the directory fingerprint, the verified
 *   path chain, and safe metadata.
 * - `conflict`: anything unprovable - malformed lock, foreign lock source,
 *   missing counterpart, symlink in the chain or under the Skill directory,
 *   or an unreadable path.
 */
export async function planSkillRemoval(input: SkillRemovalInput): Promise<SkillRemovalPlan> {
  const scope = input.scope;
  const paths = skillCliTargetPaths({ scope, cwd: input.context.cwd, home: input.context.home, env: input.context.env });
  const scopeRoot = resolve(scope === "project" ? input.context.cwd : input.context.home);
  const anchors: string[] = [scopeRoot];
  const stateHome = input.context.env.XDG_STATE_HOME?.trim();
  if (scope === "global" && stateHome && isAbsolute(stateHome)) anchors.push(resolve(stateHome));

  const fields: SkillRemovalPlanFields = {
    scope,
    skill: SKILL_NAME,
    source: SKILL_EXPECTED_SOURCE,
    installDir: paths.installDir,
    lockFile: paths.lockFile,
    lockSha256: null,
    metadata: { managedBy: MANAGED_BY, skill: SKILL_NAME, owner: SKILL_EXPECTED_SOURCE, ref: null },
  };

  // 1. Verify every ancestor from the scope root down to both targets,
  //    component by component, so a symlinked ancestor is a conflict rather
  //    than a path that would be silently followed.
  const targets = [paths.agentsDir, paths.skillsRoot, paths.installDir, dirname(paths.lockFile), paths.lockFile];
  const checkedPaths: string[] = [];
  const seen = new Set<string>();
  for (const target of targets) {
    const chain = chainFromAnchor(anchors, target);
    if (chain === null) {
      return conflictPlan(fields, {
        code: "skill_path_unsupported",
        path: target,
        message: `Refusing to plan a removal for ${target} because it is outside the scope root; ownership cannot be verified.`,
      });
    }
    for (const path of chain) {
      if (seen.has(path)) continue;
      seen.add(path);
      checkedPaths.push(path);
    }
  }
  for (const path of checkedPaths) {
    const state = await lstatKind(path);
    if (state.kind === "error") {
      return conflictPlan(fields, { code: "skill_path_unreadable", path, message: `Cannot inspect ${path}: ${state.message}` });
    }
    if (state.kind === "symlink") {
      return conflictPlan(fields, { code: SKILL_REMOVAL_CONFLICT_SYMLINK, path, message: `Path ${path} is a symlink; refusing to follow it.` });
    }
  }

  // 2. The Skill directory must be a real directory or absent.
  const installState = await lstatKind(paths.installDir);
  if (installState.kind === "error") {
    return conflictPlan(fields, { code: "skill_path_unreadable", path: paths.installDir, message: `Cannot inspect ${paths.installDir}: ${installState.message}` });
  }
  if (installState.kind !== "missing" && installState.kind !== "dir") {
    return conflictPlan(fields, {
      code: "skill_path_not_directory",
      path: paths.installDir,
      message: `The skill path ${paths.installDir} exists but is not a directory; refusing to remove it.`,
    });
  }

  // 3. The lock must be a regular file (or absent) and valid JSON.
  const lockSnapshot = await readLockSnapshot(paths.lockFile);
  if (!lockSnapshot.ok && !lockSnapshot.missing) {
    return conflictPlan(fields, {
      code: "skill_lock_unreadable",
      path: paths.lockFile,
      message: `Cannot verify skill ownership: ${lockSnapshot.message}.`,
    });
  }
  let record: Record<string, unknown> | null = null;
  if (lockSnapshot.ok && lockSnapshot.raw !== null) {
    fields.lockSha256 = lockSnapshot.sha256;
    const shape = readLockShape(lockSnapshot.raw, paths.lockFile);
    if (!shape.ok) {
      return conflictPlan(fields, { code: shape.code, path: paths.lockFile, message: shape.message });
    }
    record = shape.shape.record;
    fields.metadata = { ...fields.metadata, ref: recordRef(record) };
  }

  const installPresent = installState.kind === "dir";

  // 4. A record only counts when its source is the fixed repository; any other
  //    owner (or no owner at all) can never be removed by this helper.
  const source = recordSource(record);
  if (record !== null && source === null) {
    return conflictPlan(fields, {
      code: "skill_ownership_conflict",
      path: paths.lockFile,
      message: `The lockfile record for ${SKILL_NAME} at ${paths.lockFile} does not name a source; ownership cannot be proven.`,
    });
  }
  if (record !== null && source !== SKILL_EXPECTED_SOURCE) {
    return conflictPlan(fields, {
      code: "skill_ownership_conflict",
      path: paths.lockFile,
      message: `The lockfile records source "${source ?? "unknown"}" instead of ${SKILL_EXPECTED_SOURCE}; refusing to remove a skill owned by another source.`,
    });
  }

  // 5. Presence matrix: both absent is `absent`; any mismatch is a conflict.
  if (!installPresent && record === null) {
    const reason =
      lockSnapshot.ok || lockSnapshot.missing
        ? `The ${SKILL_NAME} skill is not installed at ${paths.installDir} and the lockfile at ${paths.lockFile} does not record it.`
        : `The ${SKILL_NAME} skill is not installed at ${paths.installDir}.`;
    return { ...fields, kind: "absent", reason };
  }
  if (!installPresent && record !== null) {
    return conflictPlan(fields, {
      code: "skill_install_missing",
      path: paths.installDir,
      message: `The lockfile records ${SKILL_NAME} but ${paths.installDir} does not exist; ownership is inconsistent.`,
    });
  }
  if (installPresent && record === null) {
    return conflictPlan(fields, {
      code: "skill_lock_missing",
      path: paths.lockFile,
      message: `A skill directory exists at ${paths.installDir} but the lockfile does not record ${SKILL_NAME}; ownership cannot be proven.`,
    });
  }

  // 6. Ready requires a symlink-free, fully hashed Skill directory.
  const fingerprint = await fingerprintSkillDirectory(paths.installDir);
  if (!fingerprint.ok) {
    return conflictPlan(fields, { code: fingerprint.code, path: fingerprint.path, message: fingerprint.message });
  }

  return {
    ...fields,
    kind: "ready",
    lockSha256: fields.lockSha256 ?? "",
    dirFingerprint: fingerprint.value,
    checkedPaths,
  };
}

type StripResult = { ok: true; content: string; ref: string | null } | { ok: false; code: string; message: string };

/**
 * Produce the new lock content by deleting only the `pi-delegate` entry.
 * Every other entry and every other top-level field is preserved byte-for-byte
 * at the JSON value level; nothing else is touched, added, or reordered.
 */
function stripSkillLockEntry(raw: string, lockFile: string): StripResult {
  const shape = readLockShape(raw, lockFile);
  if (!shape.ok) return { ok: false, code: shape.code, message: shape.message };
  const { parsed, skills, record } = shape.shape;
  if (skills === null || record === null) {
    return { ok: false, code: "skill_lock_missing", message: `The lockfile at ${lockFile} no longer records ${SKILL_NAME}; the removal state changed.` };
  }
  const source = recordSource(record);
  if (source !== SKILL_EXPECTED_SOURCE) {
    return {
      ok: false,
      code: "skill_ownership_conflict",
      message: `The lockfile at ${lockFile} no longer records ${SKILL_NAME} from ${SKILL_EXPECTED_SOURCE}; refusing to modify it.`,
    };
  }
  delete skills[SKILL_NAME];
  return { ok: true, content: `${JSON.stringify(parsed, null, 2)}\n`, ref: recordRef(record) };
}

/** Recursive copy that refuses symlinks on both sides and stays inside roots. */
async function copyTree(source: string, destination: string, options: { roots: readonly string[] }): Promise<void> {
  await assertPathWithinRoots(source, { roots: options.roots });
  await assertPathWithinRoots(destination, { roots: options.roots });
  const info = await lstat(source);
  if (info.isSymbolicLink()) throw new SafetyError("symlink_target", `Refusing to copy a symlink: ${source}`);
  if (!info.isDirectory()) throw new SafetyError("not_directory", `Refusing to copy a non-directory: ${source}`);
  const destinationState = await lstatKind(destination);
  if (destinationState.kind === "symlink") throw new SafetyError("symlink_target", `Refusing to write through a symlink: ${destination}`);
  await mkdir(destination, { recursive: true });
  await assertPathWithinRoots(destination, { roots: options.roots });
  const names = (await readdir(source)).sort();
  for (const name of names) {
    const from = join(source, name);
    const to = join(destination, name);
    const entry = await lstat(from);
    if (entry.isSymbolicLink()) throw new SafetyError("symlink_target", `Refusing to follow a symlink under ${source}: ${from}`);
    if (entry.isDirectory()) {
      await copyTree(from, to, options);
      continue;
    }
    if (!entry.isFile()) throw new SafetyError("not_regular_file", `Refusing to copy a non-regular entry: ${from}`);
    await copyFile(from, to);
  }
}

/**
 * Copy the whole Skill directory beside `skills/`, outside the directory
 * agents scan for installed Skills. Creation is collision-safe.
 */
async function backupSkillDirectory(dir: string, options: { roots: readonly string[]; now?: () => Date }): Promise<string> {
  const stamp = (options.now?.() ?? new Date()).toISOString().replace(/[:.]/g, "-");
  const stem = `${basename(dir)}.backup-${stamp}`;
  const parent = dirname(dirname(dir));
  for (let attempt = 0; ; attempt += 1) {
    const candidate = join(parent, attempt === 0 ? stem : `${stem}-${attempt}`);
    let created = false;
    try {
      await assertPathWithinRoots(candidate, { roots: options.roots });
      // Non-recursive on purpose: EEXIST means this backup name is taken and
      // an existing backup must never be clobbered.
      await mkdir(candidate);
      created = true;
      await copyTree(dir, candidate, { roots: options.roots });
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      if (created) await rm(candidate, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }
}

/** Remove a directory tree without ever following a symlink. */
async function removeTree(path: string, options: { roots: readonly string[] }): Promise<void> {
  await assertPathWithinRoots(path, { roots: options.roots });
  const info = await lstat(path);
  if (info.isSymbolicLink()) throw new SafetyError("symlink_target", `Refusing to remove a symlink: ${path}`);
  if (info.isDirectory()) {
    for (const name of (await readdir(path)).sort()) {
      await removeTree(join(path, name), options);
    }
    await rmdir(path);
    return;
  }
  if (!info.isFile()) throw new SafetyError("not_regular_file", `Refusing to remove a non-regular entry: ${path}`);
  await removeFile(path, { roots: options.roots });
}

function errorInfo(error: unknown): { code: string; message: string } {
  if (error instanceof SafetyError) return { code: error.code, message: error.message };
  if (error instanceof SkillTreeError) return { code: error.code, message: error.message };
  return { code: "skill_removal_failed", message: error instanceof Error ? error.message : String(error) };
}

function conflictResult(conflict: PlanConflict): SkillRemovalResult {
  return {
    status: "conflict",
    performed: [],
    removed: [],
    backups: [],
    errors: [{ code: conflict.code, message: conflict.message }],
    rollback: "none",
    warnings: [],
  };
}

/**
 * Execute a plan produced by {@link planSkillRemoval}. The caller must have
 * already obtained the user's explicit choice to delete; this helper never
 * prompts.
 *
 * Before any mutation the current lock bytes, the Skill directory fingerprint,
 * and the verified path chain must still match the plan; any mismatch is a
 * `conflict` result with no changes made. A ready plan is executed by taking
 * recoverable backups of the Skill directory and the lock file, rewriting the
 * lock with only the `pi-delegate` entry removed, and deleting the Skill
 * directory. If any step fails, both targets are rolled back from the backups.
 */
export async function executeSkillRemoval(plan: SkillRemovalPlan, options: SkillRemovalExecutionOptions): Promise<SkillRemovalResult> {
  if (plan.kind === "absent") {
    return { status: "absent", performed: [], removed: [], backups: [], errors: [], rollback: "none", warnings: [] };
  }
  if (plan.kind === "conflict") return conflictResult(plan.conflict);

  const roots = options.roots.map((root) => resolve(root));
  const clock = options.now !== undefined ? options.now : undefined;

  // --- Preflight: nothing below mutates. ---

  try {
    await assertPathWithinRoots(plan.installDir, { roots });
    await assertPathWithinRoots(plan.lockFile, { roots });
  } catch (error) {
    const info = errorInfo(error);
    return conflictResult({ code: info.code, path: plan.installDir, message: info.message });
  }

  for (const path of plan.checkedPaths) {
    const state = await lstatKind(path);
    if (state.kind === "missing") {
      return conflictResult({
        code: SKILL_REMOVAL_PATH_DRIFT,
        path,
        message: `The verified path ${path} no longer exists; the planned removal state changed.`,
      });
    }
    if (state.kind === "error") {
      return conflictResult({ code: "skill_path_unreadable", path, message: `Cannot inspect ${path}: ${state.message}` });
    }
    if (state.kind === "symlink") {
      return conflictResult({ code: SKILL_REMOVAL_CONFLICT_SYMLINK, path, message: `Path ${path} is a symlink; refusing to follow it.` });
    }
  }

  const lockNow = await readLockSnapshot(plan.lockFile);
  if (!lockNow.ok || lockNow.raw === null) {
    return conflictResult({ code: SKILL_REMOVAL_LOCK_DRIFT, path: plan.lockFile, message: `The lock file at ${plan.lockFile} can no longer be verified: ${lockNow.message}.` });
  }
  if (lockNow.sha256 !== plan.lockSha256) {
    return conflictResult({ code: SKILL_REMOVAL_LOCK_DRIFT, path: plan.lockFile, message: `The lock file at ${plan.lockFile} changed after the removal was planned; re-plan before executing.` });
  }

  const fingerprint = await fingerprintSkillDirectory(plan.installDir);
  if (!fingerprint.ok) {
    if (fingerprint.code === SKILL_REMOVAL_CONFLICT_SYMLINK) return conflictResult({ code: fingerprint.code, path: fingerprint.path, message: fingerprint.message });
    return conflictResult({ code: SKILL_REMOVAL_DIR_DRIFT, path: plan.installDir, message: `The skill directory at ${plan.installDir} can no longer be verified: ${fingerprint.message}` });
  }
  if (fingerprint.value !== plan.dirFingerprint) {
    return conflictResult({ code: SKILL_REMOVAL_DIR_DRIFT, path: plan.installDir, message: `The skill directory at ${plan.installDir} changed after the removal was planned; re-plan before executing.` });
  }

  const stripped = stripSkillLockEntry(lockNow.raw, plan.lockFile);
  if (!stripped.ok) {
    return conflictResult({ code: stripped.code, path: plan.lockFile, message: stripped.message });
  }

  // --- Mutation, guarded by backups. ---

  const backups: Array<{ path: string; backupPath: string | null }> = [];
  let lockBackupPath: string | null = null;
  let dirBackupPath: string | null = null;
  let lockMutated = false;
  let dirMutationStarted = false;

  try {
    const lockBackup = await backupFile(plan.lockFile, { roots, ...(clock !== undefined ? { now: clock } : {}) });
    lockBackupPath = lockBackup.backupPath;
    backups.push({ path: plan.lockFile, backupPath: lockBackupPath });

    dirBackupPath = await backupSkillDirectory(plan.installDir, { roots, ...(clock !== undefined ? { now: clock } : {}) });
    backups.push({ path: plan.installDir, backupPath: dirBackupPath });

    await atomicWriteFile(plan.lockFile, stripped.content, { roots });
    lockMutated = true;

    dirMutationStarted = true;
    await removeTree(plan.installDir, { roots });

    return {
      status: "success",
      performed: [plan.lockFile],
      removed: [plan.installDir],
      backups,
      errors: [],
      rollback: "none",
      warnings: [],
    };
  } catch (error) {
    const info = errorInfo(error);
    const warnings: string[] = [];
    if (!lockMutated && !dirMutationStarted) {
      return { status: "failed", performed: [], removed: [], backups, errors: [info], rollback: "none", warnings };
    }

    let restored = false;
    let skipped = false;
    if (dirMutationStarted) {
      if (dirBackupPath === null) {
        skipped = true;
        warnings.push(`Skipped rollback because no skill directory backup is available: ${plan.installDir}`);
      } else {
        try {
          await copyTree(dirBackupPath, plan.installDir, { roots });
          restored = true;
        } catch (rollbackError) {
          skipped = true;
          warnings.push(`Rollback of ${plan.installDir} failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
        }
      }
    }
    if (lockMutated) {
      if (lockBackupPath === null) {
        skipped = true;
        warnings.push(`Skipped rollback because no lock backup is available: ${plan.lockFile}`);
      } else {
        try {
          await restoreBackup(lockBackupPath, plan.lockFile, { roots });
          restored = true;
        } catch (rollbackError) {
          skipped = true;
          warnings.push(`Rollback of ${plan.lockFile} failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
        }
      }
    }

    return {
      status: "failed",
      performed: lockMutated ? [plan.lockFile] : [],
      removed: [],
      backups,
      errors: [info],
      rollback: skipped ? "skipped" : restored ? "restored" : "none",
      warnings,
    };
  }
}
