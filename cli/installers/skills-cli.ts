import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, win32 as pathWin32 } from "node:path";
import type { HostId } from "../hosts/adapters.js";
import type { PlanConflict, Scope } from "../plan/model.js";
import { SKILL_NAME } from "../identity.js";
import type {
  SkillCliPlan,
  SkillCliSafetyFinding,
  SkillCliSafetyKind,
  SkillInstaller,
  SkillPlanRequest,
  SkillPlanResult,
  SkillUpdateDiscovery,
} from "./skill.js";

/** Single pinned Skills CLI release. The version is never derived from a range. */
export const SKILLS_CLI_VERSION = "1.7.1";
export const SKILLS_CLI_PACKAGE = `skills@${SKILLS_CLI_VERSION}`;

/** Fixed GitHub-only source. No other repository, registry, or local path is accepted. */
export const SKILL_REPOSITORY = "https://github.com/zguiyang/pi-task-exec";
export const SKILL_SUBPATH = "skills/pi-delegate";
/** Normalized `owner/repo` the CLI records in its JSON and lockfiles. */
export const SKILL_EXPECTED_SOURCE = "zguiyang/pi-task-exec";

/** Only these Skill Agents are supported; no other agent is guessed or passed. */
export const SUPPORTED_SKILL_AGENTS: readonly HostId[] = ["codex", "zed", "opencode"];

/**
 * Checkout/dev validation ref. This is an existing public commit in the fixed
 * repository and is intentionally a full 40-character SHA, not a tag or
 * branch. Release installs use `v${packageVersion}` instead.
 */
export const SKILL_DEV_REF = "f914707fa22fd658f50e059a5091440796ef39e0";

export const SKILL_CLI_TIMEOUT_MS = 600_000;

export type SkillRefKind = "release" | "commit";

export interface SkillRefSelection {
  ref: string;
  refKind: SkillRefKind;
  source: string;
}

/**
 * Explicit source/ref selection. A release install uses the exact package
 * version tag; a source checkout uses the pinned commit. There is no silent
 * fallback to a branch such as `main`.
 */
export function resolveSkillRef(input: { launchMode: "npm" | "checkout"; packageVersion: string; devRef?: string }): SkillRefSelection {
  if (input.launchMode === "checkout") {
    const ref = input.devRef ?? SKILL_DEV_REF;
    return { ref, refKind: "commit", source: `${SKILL_REPOSITORY}/tree/${ref}/${SKILL_SUBPATH}` };
  }
  const ref = `v${input.packageVersion}`;
  return { ref, refKind: "release", source: `${SKILL_REPOSITORY}/tree/${ref}/${SKILL_SUBPATH}` };
}

export interface SkillsCliLaunch {
  command: string;
  args: string[];
}

/**
 * Resolve the launcher used to run `skills@1.7.1`.
 *
 * POSIX uses `npx`. Windows cannot execute `.cmd`/`.bat` shims with
 * `shell: false`, so it runs the npm CLI JavaScript entry through the current
 * Node binary instead. When the npm entry cannot be located on Windows the
 * plan fails closed rather than falling back to a shell.
 */
export function resolveSkillsCliLaunch(input: {
  platform: NodeJS.Platform;
  execPath: string;
  env: NodeJS.ProcessEnv;
  fileExists?: (path: string) => boolean;
}): SkillsCliLaunch | null {
  if (input.platform !== "win32") {
    return { command: "npx", args: ["-y", SKILLS_CLI_PACKAGE] };
  }
  const exists = input.fileExists ?? existsSync;
  const nodeDir = pathWin32.dirname(input.execPath);
  const execPathCandidate = input.env.npm_execpath?.endsWith("npm-cli.js") ? input.env.npm_execpath : undefined;
  const candidates = [
    execPathCandidate,
    pathWin32.join(nodeDir, "node_modules", "npm", "bin", "npm-cli.js"),
    pathWin32.join(nodeDir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    pathWin32.join(nodeDir, "..", "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ].filter((candidate): candidate is string => typeof candidate === "string" && candidate.endsWith("npm-cli.js"));
  const npmCli = candidates.find((candidate) => exists(candidate));
  if (!npmCli) return null;
  return { command: input.execPath, args: [npmCli, "exec", "--yes", "--package", SKILLS_CLI_PACKAGE, "--", "skills"] };
}

/** Full argv for `skills add <source>` with an explicit agent/skill/scope. */
export function buildSkillsCliArgs(input: { source: string; agent: HostId; scope: Scope }): string[] {
  return [
    "add",
    input.source,
    "--agent",
    input.agent,
    ...(input.scope === "global" ? ["--global"] : []),
    "--skill",
    SKILL_NAME,
    "--copy",
    "--json",
  ];
}

export interface SkillCliPathInspection {
  findings: SkillCliSafetyFinding[];
  /** Non-null when the path state cannot be read; the operation must fail closed. */
  fatal: { code: string; message: string } | null;
}

function finding(path: string, kind: SkillCliSafetyKind, message: string): SkillCliSafetyFinding {
  return { path, kind, message };
}

interface LstatResult {
  kind: "missing" | "dir" | "file" | "symlink" | "other";
  error: NodeJS.ErrnoException | null;
}

async function classify(path: string): Promise<LstatResult> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) return { kind: "symlink", error: null };
    if (info.isDirectory()) return { kind: "dir", error: null };
    if (info.isFile()) return { kind: "file", error: null };
    return { kind: "other", error: null };
  } catch (error) {
    const errno = error as NodeJS.ErrnoException;
    if (errno.code === "ENOENT") return { kind: "missing", error: null };
    return { kind: "other", error: errno };
  }
}

/**
 * Inspect every path the pinned CLI may replace. Any existing same-name skill,
 * symlinked ancestor, non-directory target, or non-regular lock path is
 * reported so the plan can require an explicit loss confirmation. An
 * unreadable path is fatal: exact targets cannot be validated, so the caller
 * must fail closed.
 */
export async function inspectSkillCliPaths(input: {
  agentsDir: string;
  skillsRoot: string;
  installDir: string;
  lockFile: string;
}): Promise<SkillCliPathInspection> {
  const findings: SkillCliSafetyFinding[] = [];
  for (const [path, label] of [
    [input.agentsDir, "shared .agents directory"],
    [input.skillsRoot, "shared skills directory"],
  ] as const) {
    const state = await classify(path);
    if (state.error) {
      return { findings, fatal: { code: "skill_path_unreadable", message: `Cannot inspect the ${label} at ${path}: ${state.error.message}` } };
    }
    if (state.kind === "symlink") {
      findings.push(finding(path, "symlink", `The ${label} is a symlink and the CLI would follow it: ${path}`));
    } else if (state.kind !== "missing" && state.kind !== "dir") {
      findings.push(finding(path, "not-directory", `The ${label} exists but is not a directory: ${path}`));
    }
  }

  const installState = await classify(input.installDir);
  if (installState.error) {
    return { findings, fatal: { code: "skill_path_unreadable", message: `Cannot inspect the existing skill path ${input.installDir}: ${installState.error.message}` } };
  }
  if (installState.kind === "symlink") {
    findings.push(finding(input.installDir, "symlink", `An existing same-name skill is a symlink and would be replaced: ${input.installDir}`));
  } else if (installState.kind === "dir") {
    findings.push(finding(input.installDir, "existing-skill", `An existing same-name skill directory would be replaced: ${input.installDir}`));
  } else if (installState.kind !== "missing") {
    findings.push(finding(input.installDir, "not-directory", `An existing same-name path is not a directory and would be replaced: ${input.installDir}`));
  }

  const lockState = await classify(input.lockFile);
  if (lockState.error) {
    return { findings, fatal: { code: "skill_path_unreadable", message: `Cannot inspect the skill lock path ${input.lockFile}: ${lockState.error.message}` } };
  }
  if (lockState.kind === "symlink") {
    findings.push(finding(input.lockFile, "symlink", `The skill lock path is a symlink and would be replaced: ${input.lockFile}`));
  } else if (lockState.kind !== "missing" && lockState.kind !== "file") {
    findings.push(finding(input.lockFile, "lock-conflict", `The skill lock path exists but is not a regular file: ${input.lockFile}`));
  }
  const lockDir = dirname(input.lockFile);
  if (resolve(lockDir) !== resolve(input.agentsDir)) {
    const lockDirState = await classify(lockDir);
    if (lockDirState.error) {
      return { findings, fatal: { code: "skill_path_unreadable", message: `Cannot inspect the skill lock directory ${lockDir}: ${lockDirState.error.message}` } };
    }
    if (lockDirState.kind === "symlink") {
      findings.push(finding(lockDir, "symlink", `The skill lock directory is a symlink and the CLI would follow it: ${lockDir}`));
    } else if (lockDirState.kind !== "missing" && lockDirState.kind !== "dir") {
      findings.push(finding(lockDir, "not-directory", `The skill lock directory exists but is not a directory: ${lockDir}`));
    }
  }

  return { findings, fatal: null };
}

function globalLockFile(home: string, env: NodeJS.ProcessEnv): string {
  const stateHome = env.XDG_STATE_HOME?.trim();
  return stateHome ? join(stateHome, "skills", ".skill-lock.json") : join(home, ".agents", ".skill-lock.json");
}

/** Scope-specific paths the pinned CLI writes for `pi-delegate`. */
export function skillCliTargetPaths(input: { scope: Scope; cwd: string; home: string; env: NodeJS.ProcessEnv }): {
  agentsDir: string;
  skillsRoot: string;
  installDir: string;
  skillFile: string;
  contractFile: string;
  lockFile: string;
} {
  const root = input.scope === "project" ? input.cwd : input.home;
  const agentsDir = join(root, ".agents");
  const skillsRoot = join(agentsDir, "skills");
  const installDir = join(skillsRoot, SKILL_NAME);
  return {
    agentsDir,
    skillsRoot,
    installDir,
    skillFile: join(installDir, "SKILL.md"),
    contractFile: join(installDir, "references", "mcp-contract.md"),
    lockFile: input.scope === "project" ? join(input.cwd, "skills-lock.json") : globalLockFile(input.home, input.env),
  };
}

/**
 * Intentional explicit roots for the Skill install. Project scope writes only
 * under cwd. Global scope writes under home, except the lockfile which follows
 * the documented `XDG_STATE_HOME` override; that override is an explicit root
 * just like a host adapter's env override. Anything not covered here must be
 * rejected by the executor's root assertion.
 */
export function skillCliAdditionalRoots(input: { scope: Scope; env: NodeJS.ProcessEnv }): string[] {
  if (input.scope !== "global") return [];
  const stateHome = input.env.XDG_STATE_HOME?.trim();
  if (!stateHome || !isAbsolute(stateHome)) return [];
  return [resolve(stateHome)];
}

export interface SkillsCliSpawnOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
}

export interface SkillsCliProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
  error?: string;
  timedOut?: boolean;
}

export type SkillsCliSpawn = (command: string, args: string[], options: SkillsCliSpawnOptions) => Promise<SkillsCliProcessResult>;

/** Structural, shell-free spawn used for the pinned Skills CLI. */
export function spawnSkillsCli(command: string, args: string[], options: SkillsCliSpawnOptions): Promise<SkillsCliProcessResult> {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, {
      shell: false,
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, options.timeoutMs);
    timer.unref?.();
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolvePromise({ code: null, stdout, stderr, error: error.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise(timedOut ? { code, stdout, stderr, error: "timeout", timedOut: true } : { code, stdout, stderr });
    });
  });
}

/** Telemetry is disabled and env values are never printed. */
export function skillsCliSpawnEnv(env: NodeJS.ProcessEnv, home: string): NodeJS.ProcessEnv {
  return {
    ...env,
    HOME: home,
    USERPROFILE: home,
    DO_NOT_TRACK: "1",
    DISABLE_TELEMETRY: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
}

const SECRET_KEY = /token|secret|key|password|passwd|credential|auth/i;

/** Best-effort masking so a child diagnostic can never echo an env secret. */
export function maskSecrets(text: string, env: NodeJS.ProcessEnv): string {
  let masked = text;
  for (const [key, value] of Object.entries(env)) {
    if (!value || value.length < 8 || !SECRET_KEY.test(key)) continue;
    masked = masked.split(value).join("***");
  }
  return masked;
}

export interface SkillCliVerificationInput {
  cli: SkillCliPlan;
  exitCode: number | null;
  spawnError?: string;
  timedOut?: boolean;
  stdout: string;
  stderr: string;
  /** Package root; bundled skills/pi-delegate is the expected byte content. */
  packageRoot: string;
  env: NodeJS.ProcessEnv;
}

export interface SkillCliVerificationResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

interface CliJsonEntry {
  name?: unknown;
  status?: unknown;
  source?: unknown;
  ref?: unknown;
  path?: unknown;
  scope?: unknown;
}

function samePath(left: string, right: string, platform: NodeJS.Platform): boolean {
  const a = resolve(left);
  const b = resolve(right);
  return platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

async function readRegularFile(path: string): Promise<Buffer | null> {
  try {
    const info = await lstat(path);
    if (!info.isFile()) return null;
    return await readFile(path);
  } catch {
    return null;
  }
}

/**
 * Verify the real install, not just the exit code. The pinned CLI can exit 0
 * after swallowing a lockfile failure, so missing files, wrong content, or a
 * missing/invalid lockfile are treated as failure.
 */
export async function verifySkillsCliInstall(input: SkillCliVerificationInput): Promise<SkillCliVerificationResult> {
  const errors: string[] = [];
  const warnings: string[] = ["The Skills CLI install is not transactional; no rollback is performed."];
  if (input.spawnError) {
    errors.push(input.timedOut ? `Skills CLI timed out after ${SKILL_CLI_TIMEOUT_MS}ms` : `Skills CLI failed to start: ${maskSecrets(input.spawnError, input.env)}`);
    return { ok: false, errors, warnings };
  }
  if (input.exitCode !== 0) {
    const detail = maskSecrets(input.stderr.trim().split("\n").slice(-3).join(" "), input.env).slice(0, 400);
    errors.push(`Skills CLI exited with code ${input.exitCode ?? "unknown"}${detail ? `: ${detail}` : ""}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(input.stdout.trim());
  } catch {
    errors.push("Skills CLI did not return parseable --json output.");
    return { ok: false, errors, warnings };
  }
  const entries: CliJsonEntry[] = Array.isArray(parsed)
    ? (parsed as CliJsonEntry[])
    : typeof parsed === "object" && parsed !== null
      ? [parsed as CliJsonEntry]
      : [];
  const entry = entries.find((candidate) => candidate.name === SKILL_NAME);
  if (!entry) {
    errors.push("Skills CLI JSON did not report the pi-delegate skill.");
    return { ok: false, errors, warnings };
  }
  if (entry.status !== "installed") errors.push(`Skills CLI reported status "${String(entry.status)}" for pi-delegate.`);
  if (entry.source !== SKILL_EXPECTED_SOURCE) errors.push(`Skills CLI reported source "${String(entry.source)}" instead of ${SKILL_EXPECTED_SOURCE}.`);
  if (entry.ref !== input.cli.ref) errors.push(`Skills CLI reported ref "${String(entry.ref)}" instead of the pinned ${input.cli.ref}.`);
  if (typeof entry.path !== "string" || !samePath(entry.path, input.cli.installDir, process.platform)) {
    errors.push(`Skills CLI installed to "${String(entry.path)}" instead of the expected path ${input.cli.installDir}.`);
  }
  if (entry.scope !== input.cli.scope) errors.push(`Skills CLI reported scope "${String(entry.scope)}" instead of ${input.cli.scope}.`);

  const installedSkill = await readRegularFile(input.cli.skillFile);
  const installedContract = await readRegularFile(input.cli.contractFile);
  if (!installedSkill) errors.push(`Installed skill file is missing or not a regular file: ${input.cli.skillFile}`);
  if (!installedContract) errors.push(`Installed contract file is missing or not a regular file: ${input.cli.contractFile}`);

  const bundledSkillPath = join(input.packageRoot, "skills", "pi-delegate", "SKILL.md");
  const bundledContractPath = join(input.packageRoot, "skills", "pi-delegate", "references", "mcp-contract.md");
  const bundledSkill = await readRegularFile(bundledSkillPath);
  const bundledContract = await readRegularFile(bundledContractPath);
  // Absent reference bytes are an explicit failure: the pinned-source check
  // must never be silently skipped.
  if (!bundledSkill) errors.push(`Bundled reference SKILL.md is missing or unreadable: ${bundledSkillPath}`);
  if (!bundledContract) errors.push(`Bundled reference references/mcp-contract.md is missing or unreadable: ${bundledContractPath}`);
  if (installedSkill && bundledSkill && !installedSkill.equals(bundledSkill)) {
    errors.push(`Installed SKILL.md does not match the pinned GitHub source/ref content for ${input.cli.ref}.`);
  }
  if (installedContract && bundledContract && !installedContract.equals(bundledContract)) {
    errors.push(`Installed references/mcp-contract.md does not match the pinned GitHub source/ref content for ${input.cli.ref}.`);
  }
  if (installedSkill && !/^---\r?\nname:\s*pi-delegate\s*$/m.test(installedSkill.toString("utf8"))) {
    errors.push("Installed SKILL.md is missing the pi-delegate frontmatter.");
  }

  const lockRaw = await readRegularFile(input.cli.lockFile);
  if (!lockRaw) {
    errors.push(`Skills CLI lockfile is missing or not a regular file: ${input.cli.lockFile}`);
  } else {
    try {
      const lock = JSON.parse(lockRaw.toString("utf8")) as { skills?: Record<string, { source?: unknown; ref?: unknown }> };
      const record = lock.skills?.[SKILL_NAME];
      if (!record) errors.push(`Skills CLI lockfile does not record pi-delegate at ${input.cli.lockFile}.`);
      else {
        if (record.source !== SKILL_EXPECTED_SOURCE) errors.push(`Skills CLI lockfile records source "${String(record.source)}" instead of ${SKILL_EXPECTED_SOURCE}.`);
        if (record.ref !== input.cli.ref) errors.push(`Skills CLI lockfile records ref "${String(record.ref)}" instead of the pinned ${input.cli.ref}.`);
      }
    } catch {
      errors.push(`Skills CLI lockfile is not valid JSON: ${input.cli.lockFile}`);
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

/**
 * Read the `pi-delegate` record from a Skills CLI lockfile without mutating
 * anything. A missing lockfile is reported as an absent record; a symlinked or
 * non-regular lockfile cannot be safely followed and is an error, as is an
 * unreadable or malformed lockfile, so ownership cannot be misread.
 */
export async function readSkillLockRecord(
  lockFile: string,
): Promise<{ ok: true; record: { present: boolean; source?: string; ref?: string } } | { ok: false; message: string }> {
  let info: Awaited<ReturnType<typeof lstat>>;
  try {
    info = await lstat(lockFile);
  } catch (error) {
    const errno = error as NodeJS.ErrnoException;
    if (errno.code === "ENOENT") return { ok: true, record: { present: false } };
    return { ok: false, message: `Cannot inspect the skill lockfile at ${lockFile}: ${errno.message}` };
  }
  if (info.isSymbolicLink()) {
    return { ok: false, message: `The skill lockfile at ${lockFile} is a symlink; refusing to follow it.` };
  }
  if (!info.isFile()) {
    return { ok: false, message: `The skill lockfile at ${lockFile} is not a regular file; ownership cannot be verified.` };
  }
  let raw: string;
  try {
    raw = await readFile(lockFile, "utf8");
  } catch (error) {
    const errno = error as NodeJS.ErrnoException;
    if (errno.code === "ENOENT") return { ok: true, record: { present: false } };
    return { ok: false, message: `Cannot read the skill lockfile at ${lockFile}: ${errno.message}` };
  }
  try {
    const parsed = JSON.parse(raw) as { skills?: Record<string, { source?: unknown; ref?: unknown }> };
    const record = parsed.skills?.[SKILL_NAME];
    if (!record || typeof record !== "object") return { ok: true, record: { present: false } };
    return {
      ok: true,
      record: {
        present: true,
        ...(typeof record.source === "string" ? { source: record.source } : {}),
        ...(typeof record.ref === "string" ? { ref: record.ref } : {}),
      },
    };
  } catch {
    return { ok: false, message: `The skill lockfile at ${lockFile} is not valid JSON; ownership cannot be verified.` };
  }
}

export type SkillUpdateDetection =
  | { kind: "ok"; selection: SkillUpdateDiscovery }
  | { kind: "conflict"; conflict: PlanConflict };

/**
 * Detect an installed skill for `update`. It requires both the expected skill
 * directory and a lock record whose source is the fixed repository with a
 * current ref. Every other combination is a conflict: an unknown owner, a
 * missing lock, a lock without an install, or an unreadable path. Only when
 * both are absent is the component treated as not installed.
 */
export async function detectSkillUpdate(input: {
  installDir: string;
  lockFile: string;
  expectedSource: string;
  desiredRef: string;
}): Promise<SkillUpdateDetection> {
  const installState = await classify(input.installDir);
  if (installState.error) {
    return {
      kind: "conflict",
      conflict: {
        code: "skill_path_unreadable",
        path: input.installDir,
        message: `Cannot inspect the installed skill path ${input.installDir}: ${installState.error.message}`,
      },
    };
  }
  if (installState.kind === "symlink") {
    return {
      kind: "conflict",
      conflict: {
        code: "skill_path_symlink",
        path: input.installDir,
        message: `The installed skill path ${input.installDir} is a symlink; refusing to follow or replace it.`,
      },
    };
  }
  if (installState.kind !== "missing" && installState.kind !== "dir") {
    return {
      kind: "conflict",
      conflict: {
        code: "skill_path_not_directory",
        path: input.installDir,
        message: `The installed skill path ${input.installDir} exists but is not a directory; refusing to replace it.`,
      },
    };
  }
  const lock = await readSkillLockRecord(input.lockFile);
  if (!lock.ok) {
    return { kind: "conflict", conflict: { code: "skill_lock_unreadable", path: input.lockFile, message: lock.message } };
  }
  const record = lock.record;
  const installPresent = installState.kind !== "missing";
  const base = { installDir: input.installDir, lockFile: input.lockFile, desiredRef: input.desiredRef };
  if (!installPresent && !record.present) return { kind: "ok", selection: { state: "absent", ...base } };
  if (!installPresent && record.present) {
    return {
      kind: "conflict",
      conflict: {
        code: "skill_install_missing",
        path: input.installDir,
        message: `The lockfile records pi-delegate but ${input.installDir} does not exist; ownership is inconsistent.`,
      },
    };
  }
  if (installPresent && !record.present) {
    return {
      kind: "conflict",
      conflict: {
        code: "skill_lock_missing",
        path: input.lockFile,
        message: `A skill directory exists at ${input.installDir} but the lockfile does not record pi-delegate; ownership cannot be proven.`,
      },
    };
  }
  if (record.source !== input.expectedSource) {
    return {
      kind: "conflict",
      conflict: {
        code: "skill_ownership_conflict",
        path: input.lockFile,
        message: `The lockfile records source "${record.source ?? "unknown"}" instead of ${input.expectedSource}; refusing to replace a skill owned by another source.`,
      },
    };
  }
  if (typeof record.ref !== "string" || record.ref === "") {
    return {
      kind: "conflict",
      conflict: {
        code: "skill_ref_unknown",
        path: input.lockFile,
        message: `The lockfile does not record a current ref for pi-delegate; ownership cannot be proven.`,
      },
    };
  }
  if (record.ref === input.desiredRef) return { kind: "ok", selection: { state: "no-op", currentRef: record.ref, ...base } };
  return { kind: "ok", selection: { state: "update", currentRef: record.ref, ...base } };
}

/**
 * Installer seam implementation backed by the pinned Vercel Skills CLI. It
 * plans `add skill`, the unified `update`, and an agent-selected `setup`. Plan
 * generation is side-effect-free: it inspects paths and resolves argv but
 * never runs npm, the network, or writes a lockfile.
 */
export class SkillsCliInstaller implements SkillInstaller {
  readonly id = "skills-cli";
  private readonly platform: NodeJS.Platform;
  private readonly execPath: string;
  private readonly fileExists: (path: string) => boolean;
  private readonly devRef: string | undefined;

  constructor(options: { platform?: NodeJS.Platform; execPath?: string; fileExists?: (path: string) => boolean; devRef?: string } = {}) {
    this.platform = options.platform ?? process.platform;
    this.execPath = options.execPath ?? process.execPath;
    this.fileExists = options.fileExists ?? existsSync;
    this.devRef = options.devRef;
  }

  async plan(request: SkillPlanRequest): Promise<SkillPlanResult> {
    // `add skill`, the unified `update`, and an agent-selected unified `setup`
    // install. A skill-only `setup` without an explicit agent (and
    // `remove skill`) stay deferred.
    const installable =
      request.operation === "add" ||
      request.operation === "update" ||
      (request.operation === "setup" && request.host !== undefined);
    if (!installable) {
      return {
        kind: "unsupported",
        capability: {
          code: "skill_installer_deferred",
          target: "skill",
          scope: request.scope,
          message: `The Skills CLI installer is implemented for \`add skill\`, \`update\`, and an agent-selected unified \`setup\`; \`${request.operation}\` skill is deferred.`,
        },
      };
    }
    const agent = request.host;
    if (!agent || !SUPPORTED_SKILL_AGENTS.includes(agent)) {
      return {
        kind: "unsupported",
        capability: {
          code: "skill_agent_required",
          target: "skill",
          scope: request.scope,
          message: `Skill installation requires an explicit --host ${SUPPORTED_SKILL_AGENTS.join("|")} to select the Skill Agent; no agent is guessed.`,
        },
      };
    }
    if (!["darwin", "linux", "win32"].includes(request.context.platform)) {
      return {
        kind: "unsupported",
        capability: {
          code: "skill_platform_unverified",
          target: "skill",
          scope: request.scope,
          message: `Skill installation is not verified for platform "${request.context.platform}".`,
        },
      };
    }

    const launch = resolveSkillsCliLaunch({
      platform: this.platform,
      execPath: this.execPath,
      env: request.context.env,
      fileExists: this.fileExists,
    });
    if (!launch) {
      return {
        kind: "unsupported",
        capability: {
          code: "skill_cli_launch_unavailable",
          target: "skill",
          scope: request.scope,
          message: "Cannot safely resolve the npm/npx launcher on this platform; no shell fallback is used.",
        },
      };
    }

    const selected = resolveSkillRef({
      launchMode: request.launchMode,
      packageVersion: request.packageVersion,
      ...(this.devRef !== undefined ? { devRef: this.devRef } : {}),
    });
    const paths = skillCliTargetPaths({ scope: request.scope, cwd: request.context.cwd, home: request.context.home, env: request.context.env });
    const inspection = await inspectSkillCliPaths(paths);
    const pathWarnings = inspection.findings.map((item) => ({
      code: `skill_path_${item.kind.replace(/-/g, "_")}`,
      message: item.message,
    }));

    if (request.operation === "update") {
      if (inspection.fatal) {
        return {
          kind: "ok",
          plan: {
            directory: paths.installDir,
            writes: [],
            removals: [],
            conflicts: [{ code: inspection.fatal.code, path: paths.installDir, message: inspection.fatal.message }],
            warnings: pathWarnings,
          },
        };
      }
      // A symlinked/non-directory ancestor, install path, or lock path, and a
      // non-regular lock path, are unsafe for the third-party CLI. They are
      // conflicts before any read or spawn so they can never be mistaken for
      // an absent or already-current no-op.
      const unsafeFindings = inspection.findings.filter((item) => item.kind !== "existing-skill");
      if (unsafeFindings.length > 0) {
        return {
          kind: "ok",
          plan: {
            directory: paths.installDir,
            writes: [],
            removals: [],
            conflicts: unsafeFindings.map((item) => ({
              code: `skill_path_${item.kind.replace(/-/g, "_")}`,
              path: item.path,
              message: item.message,
            })),
            warnings: pathWarnings,
          },
        };
      }
      const detection = await detectSkillUpdate({
        installDir: paths.installDir,
        lockFile: paths.lockFile,
        expectedSource: SKILL_EXPECTED_SOURCE,
        desiredRef: selected.ref,
      });
      if (detection.kind === "conflict") {
        return {
          kind: "ok",
          plan: { directory: paths.installDir, writes: [], removals: [], conflicts: [detection.conflict], warnings: pathWarnings },
        };
      }
      const discovery = detection.selection;
      if (discovery.state === "absent") {
        return {
          kind: "ok",
          plan: {
            directory: paths.installDir,
            writes: [],
            removals: [],
            conflicts: [],
            warnings: [
              ...pathWarnings,
              {
                code: "skill_not_installed",
                message: `The pi-delegate skill is not installed at ${paths.installDir} and the lockfile does not record it; run pi-task-exec setup to install it.`,
              },
            ],
            update: discovery,
          },
        };
      }
      if (discovery.state === "no-op") {
        return {
          kind: "ok",
          plan: {
            directory: paths.installDir,
            writes: [],
            removals: [],
            conflicts: [],
            warnings: [
              ...pathWarnings,
              { code: "skill_already_up_to_date", message: `pi-delegate is already at ${selected.ref} at ${paths.installDir}; the Skills CLI is not invoked.` },
            ],
            update: discovery,
          },
        };
      }
      const cli = this.describeCli(request, agent, selected, launch, paths, inspection.findings, discovery.currentRef);
      return {
        kind: "ok",
        plan: { directory: paths.installDir, writes: [], removals: [], conflicts: [], warnings: pathWarnings, cli, update: discovery },
      };
    }

    if (inspection.fatal) {
      return {
        kind: "ok",
        plan: {
          directory: paths.installDir,
          writes: [],
          removals: [],
          conflicts: [{ code: inspection.fatal.code, path: paths.installDir, message: inspection.fatal.message }],
          warnings: [],
          cli: this.describeCli(request, agent, selected, launch, paths, inspection.findings),
        },
      };
    }

    const cli = this.describeCli(request, agent, selected, launch, paths, inspection.findings);
    return {
      kind: "ok",
      plan: { directory: paths.installDir, writes: [], removals: [], conflicts: [], warnings: pathWarnings, cli },
    };
  }

  private describeCli(
    request: SkillPlanRequest,
    agent: HostId,
    selected: SkillRefSelection,
    launch: SkillsCliLaunch,
    paths: ReturnType<typeof skillCliTargetPaths>,
    safety: SkillCliSafetyFinding[],
    currentRef?: string,
  ): SkillCliPlan {
    return {
      installer: "skills-cli",
      cliVersion: SKILLS_CLI_VERSION,
      agent,
      scope: request.scope,
      repository: SKILL_REPOSITORY,
      subpath: SKILL_SUBPATH,
      source: selected.source,
      ref: selected.ref,
      refKind: selected.refKind,
      command: launch.command,
      args: [...launch.args, ...buildSkillsCliArgs({ source: selected.source, agent, scope: request.scope })],
      cwd: request.context.cwd,
      home: request.context.home,
      installDir: paths.installDir,
      skillFile: paths.skillFile,
      contractFile: paths.contractFile,
      lockFile: paths.lockFile,
      expectedSource: SKILL_EXPECTED_SOURCE,
      expectedRef: selected.ref,
      ...(currentRef !== undefined ? { currentRef } : {}),
      safety,
      lossWarning: safety.length > 0,
    };
  }
}

export function skillsCliInstaller(options?: ConstructorParameters<typeof SkillsCliInstaller>[0]): SkillInstaller {
  return new SkillsCliInstaller(options);
}
