import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { access, copyFile, lstat, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/**
 * Raised by the safety primitives. `code` is a stable machine-readable value
 * so CLI/plan layers can turn it into an exact JSON error without leaking
 * filesystem contents.
 */
export class SafetyError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "SafetyError";
    this.code = code;
  }
}

export interface RootOptions {
  /** Absolute roots every touched path must stay inside. */
  roots: readonly string[];
}

export function sha256(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * Lexical containment check. Both arguments are resolved first, so `..`
 * traversal cannot escape.
 */
export function isWithin(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target));
  if (rel === "") return true;
  if (isAbsolute(rel)) return false;
  return rel !== ".." && !rel.startsWith(`..${sep}`);
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function nearestExisting(path: string): Promise<string> {
  let current = resolve(path);
  // Walk up until an ancestor exists so `realpath` can be applied to detect
  // symlink escapes even when the leaf has not been created yet.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (await exists(current)) return current;
    const parent = dirname(current);
    if (parent === current) return current;
    current = parent;
  }
}

/**
 * Resolve `target`, reject lexical traversal outside `roots`, and reject
 * symlink escapes by realpath-ing the nearest existing ancestor.
 */
export async function assertPathWithinRoots(target: string, options: RootOptions): Promise<string> {
  if (options.roots.length === 0) throw new SafetyError("no_roots", "No allowed roots were configured.");
  const absolute = resolve(target);
  if (!options.roots.some((root) => isWithin(root, absolute))) {
    throw new SafetyError("path_escape", `Refusing to touch a path outside the allowed roots: ${absolute}`);
  }
  const { realpath } = await import("node:fs/promises");
  const realRoots = await Promise.all(
    options.roots.map(async (root) => {
      const ancestor = await nearestExisting(resolve(root));
      try {
        return await realpath(ancestor);
      } catch {
        return ancestor;
      }
    }),
  );
  const ancestor = await nearestExisting(absolute);
  let realAncestor: string;
  try {
    realAncestor = await realpath(ancestor);
  } catch {
    realAncestor = ancestor;
  }
  if (!realRoots.some((root) => isWithin(root, realAncestor))) {
    throw new SafetyError("symlink_escape", `Refusing to follow a symlink outside the allowed roots: ${absolute}`);
  }
  return absolute;
}

/** Reject a target that is itself a symlink (a symlink replace attack). */
export async function assertNotSymlink(target: string): Promise<void> {
  try {
    const info = await lstat(target);
    if (info.isSymbolicLink()) {
      throw new SafetyError("symlink_target", `Refusing to replace a symlink: ${target}`);
    }
  } catch (error) {
    if (error instanceof SafetyError) throw error;
  }
}

export interface AtomicWriteOptions extends RootOptions {
  /** Explicit mode; when omitted the existing file's mode is preserved. */
  mode?: number;
}

async function fileMode(path: string): Promise<number | undefined> {
  try {
    return (await stat(path)).mode & 0o777;
  } catch {
    return undefined;
  }
}

/**
 * Write `content` through a same-directory temporary file and an atomic
 * rename. Never uses shell interpolation and never leaves a temporary file
 * behind on failure.
 */
export async function atomicWriteFile(path: string, content: string, options: AtomicWriteOptions): Promise<void> {
  const absolute = await assertPathWithinRoots(path, options);
  await assertNotSymlink(absolute);
  const directory = dirname(absolute);
  await mkdir(directory, { recursive: true });
  await assertPathWithinRoots(absolute, options);
  const mode = options.mode ?? (await fileMode(absolute)) ?? 0o644;
  const temporary = join(directory, `.${basename(absolute)}.pi-task-exec-${process.pid}-${randomBytes(6).toString("hex")}.tmp`);
  try {
    await writeFile(temporary, content, { encoding: "utf8", mode });
    await rename(temporary, absolute);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

export type ContentClassification = "missing" | "unchanged" | "different";

export async function classifyContent(path: string, desired: string): Promise<ContentClassification> {
  let current: string;
  try {
    current = await readFile(path, "utf8");
  } catch {
    return "missing";
  }
  return current === desired ? "unchanged" : "different";
}

export interface BackupOptions extends RootOptions {
  /** Directory for the backup copy; defaults to the target directory. */
  backupDir?: string;
  now?: () => Date;
}

export interface BackupResult {
  path: string;
  backupPath: string | null;
  existed: boolean;
}

/**
 * Copy an existing file to a timestamped backup before it is mutated. The
 * backup directory (and therefore the copy) is validated against the allowed
 * roots, and creation is collision-safe: two backups taken with the same clock
 * value never overwrite each other.
 */
export async function backupFile(path: string, options: BackupOptions): Promise<BackupResult> {
  const absolute = await assertPathWithinRoots(path, options);
  if (!(await exists(absolute))) return { path: absolute, backupPath: null, existed: false };
  const directory = options.backupDir ?? dirname(absolute);
  await assertPathWithinRoots(directory, options);
  await mkdir(directory, { recursive: true });
  await assertPathWithinRoots(directory, options);
  const stamp = (options.now?.() ?? new Date()).toISOString().replace(/[:.]/g, "-");
  const stem = `${basename(absolute)}.backup-${stamp}`;
  // `COPYFILE_EXCL` makes creation atomic: if the candidate already exists we
  // try the next counter instead of silently overwriting someone's backup.
  for (let attempt = 0; ; attempt += 1) {
    const backupPath = join(directory, attempt === 0 ? stem : `${stem}-${attempt}`);
    try {
      await copyFile(absolute, backupPath, constants.COPYFILE_EXCL);
      return { path: absolute, backupPath, existed: true };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw error;
    }
  }
}

/**
 * Restore a backup over its original path using an atomic copy/rename. Both
 * the backup source and the target are validated against the allowed roots,
 * and the target itself must not be a symlink.
 */
export async function restoreBackup(backupPath: string, target: string, options: RootOptions): Promise<void> {
  const absolute = await assertPathWithinRoots(target, options);
  await assertNotSymlink(absolute);
  const absoluteBackup = await assertPathWithinRoots(backupPath, options);
  await assertNotSymlink(absoluteBackup);
  const directory = dirname(absolute);
  await mkdir(directory, { recursive: true });
  const temporary = join(directory, `.${basename(absolute)}.pi-task-exec-restore-${process.pid}-${randomBytes(6).toString("hex")}.tmp`);
  await copyFile(absoluteBackup, temporary);
  try {
    await rename(temporary, absolute);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

export interface ManagedRecord {
  path: string;
  sha256: string;
  managedBy: string;
}

export async function readManaged(path: string): Promise<{ content: string; sha256: string }> {
  const content = await readFile(path, "utf8");
  return { content, sha256: sha256(content) };
}

/**
 * Return the current content/hash, or null only when the file does not exist.
 *
 * Only `ENOENT` is treated as missing. Permission and I/O errors propagate so
 * an unreadable file can never be misclassified as absent and overwritten,
 * and non-regular paths (directories, symlinks, devices) are rejected before
 * any read.
 */
export async function snapshotFile(path: string): Promise<{ content: string; sha256: string } | null> {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (!info.isFile()) {
    throw new SafetyError("not_regular_file", `Refusing to treat a non-regular file as a managed file: ${path}`);
  }
  try {
    return await readManaged(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** Remove a file after a root check; refuses symlinks. */
export async function removeFile(path: string, options: RootOptions): Promise<void> {
  const absolute = await assertPathWithinRoots(path, options);
  await assertNotSymlink(absolute);
  await rm(absolute, { force: false });
}

/**
 * A removal is only allowed when the file is explicitly recorded as managed by
 * this tool and its hash still matches the recorded hash.
 */
export function assertManaged(record: ManagedRecord, current: { content: string; sha256: string }): void {
  if (record.managedBy !== "pi-task-exec") {
    throw new SafetyError("not_managed", `Refusing to remove an unmanaged file: ${record.path}`);
  }
  if (record.sha256 !== current.sha256) {
    throw new SafetyError("managed_content_drifted", `Refusing to remove a managed file whose content changed: ${record.path}`);
  }
}

export function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) diff |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return diff === 0;
}
