import { constants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import { posix, win32 } from "node:path";
import type { DoctorCheck, FileWriteOptions, HostAdapter, HostDoctorMetadata, HostId, HostTarget, McpEntryPlanResult, McpLaunchSpec, McpPlanInput, McpRemovalPlanResult, McpUpdatePlanResult } from "./adapters.js";
import type { HostContext, PlanWarning, Scope, UnsupportedCapability } from "../plan/model.js";
import { atomicWriteFile } from "../plan/safety.js";
import { PACKAGE_NAME } from "../identity.js";

export const ALL_PLATFORMS: readonly NodeJS.Platform[] = ["darwin", "linux", "win32"];

/** Path semantics that match `context.platform`, not the host running the CLI. */
export function pathForPlatform(platform: NodeJS.Platform): typeof posix {
  return platform === "win32" ? win32 : posix;
}

export function resolveAgainst(platform: NodeJS.Platform, base: string, value: string): string {
  const path = pathForPlatform(platform);
  return path.normalize(path.isAbsolute(value) ? value : path.join(base, value));
}

/** Read an environment-provided path, resolved against the platform home when relative. */
export function envPath(context: HostContext, name: string): string | undefined {
  const raw = context.env[name];
  if (typeof raw !== "string" || raw.trim() === "") return undefined;
  return resolveAgainst(context.platform, context.home, raw.trim());
}

/** An env override that is an absolute path, with no home-relative guessing. */
export function absoluteEnvPath(context: HostContext, name: string): string | undefined {
  const raw = context.env[name];
  if (typeof raw !== "string" || raw.trim() === "") return undefined;
  const value = raw.trim();
  const path = pathForPlatform(context.platform);
  return path.isAbsolute(value) ? path.normalize(value) : undefined;
}

export function xdgConfigHome(context: HostContext): string {
  const path = pathForPlatform(context.platform);
  const xdg = context.env.XDG_CONFIG_HOME;
  if (typeof xdg === "string" && xdg.trim() !== "") return resolveAgainst(context.platform, context.home, xdg.trim());
  return path.join(context.home, ".config");
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Pick the existing config file among candidates before falling back to the
 * documented default, so an install edits the file the host already reads
 * instead of creating a second one.
 */
export async function pickExisting(candidates: readonly string[], fallback: string): Promise<string> {
  for (const candidate of candidates) {
    if (await pathExists(candidate)) return candidate;
  }
  return fallback;
}

export function platformCapability(host: HostId, scope: Scope, operation: "add" | "remove", platform: NodeJS.Platform): UnsupportedCapability {
  return {
    code: operation === "add" ? "mcp_install_unverified" : "mcp_remove_unverified",
    target: "mcp",
    host,
    scope,
    message: `${host}/${scope} is not verified on ${platform}; the config path is not guessed and no file is written.`,
  };
}

/**
 * Structural JSON equality used to fingerprint a managed entry. The tool owns
 * exactly the entry it writes, so any difference in command, args, version,
 * local path or an extra field is treated as drift, never silently merged.
 */
export function deepEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (typeof left !== typeof right) return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((item, index) => deepEqual(item, right[index]));
  }
  if (left !== null && right !== null && typeof left === "object" && typeof right === "object") {
    const leftKeys = Object.keys(left as Record<string, unknown>).sort();
    const rightKeys = Object.keys(right as Record<string, unknown>).sort();
    if (leftKeys.length !== rightKeys.length) return false;
    if (leftKeys.some((key, index) => key !== rightKeys[index])) return false;
    return leftKeys.every((key) => deepEqual((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key]));
  }
  return false;
}

export type ManagedEntryFormat = "command-args" | "opencode" | "codex";

/** A provably managed launch found in a host config entry. */
export interface ManagedLaunch {
  mode: "npm" | "checkout";
  /** The installed npm token (`@scope/name@semver`) or absolute checkout path. */
  current: string;
}

// The exact package token this tool owns. A different package, a range, or
// `latest` is not a managed entry and must conflict rather than be rewritten.
const PACKAGE_TOKEN = new RegExp(
  `^${PACKAGE_NAME.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}@\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?(?:\\+[0-9A-Za-z.-]+)?$`,
);

function isManagedCheckoutLaunch(value: string): boolean {
  const normalized = value.replace(/\\/g, "/");
  const absolute = normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized) || normalized.startsWith("//");
  return absolute && normalized.endsWith("dist/cli/index.js");
}

/**
 * Decide whether a host config entry is a launch this tool provably manages.
 * The entry must contain exactly the expected fields (no `env`, `enabled`,
 * `environment`, or any other extra field) and match either the pinned npm
 * package token shape or the absolute source-checkout `node` launch shape.
 * Returns the installed version token or checkout path, or null when the entry
 * cannot be proven managed.
 */
export function classifyManagedEntry(entry: Record<string, unknown>, format: ManagedEntryFormat): ManagedLaunch | null {
  let full: unknown[];
  if (format === "command-args" || format === "codex") {
    const keys = Object.keys(entry).filter((key) => !(format === "codex" && key === "required" && entry.required === true)).sort();
    if (keys.length !== 2 || keys[0] !== "args" || keys[1] !== "command") return null;
    if (typeof entry.command !== "string" || !Array.isArray(entry.args)) return null;
    full = [entry.command, ...entry.args];
  } else {
    const keys = Object.keys(entry).sort();
    if (keys.length !== 2 || keys[0] !== "command" || keys[1] !== "type") return null;
    if (entry.type !== "local" || !Array.isArray(entry.command)) return null;
    full = [...entry.command];
  }
  // Isolated npm launches remain recognizable for safe update/removal.
  if (full[0] === "npx" && full[1] === "--prefix" && typeof full[2] === "string" &&
      (posix.isAbsolute(full[2]) || win32.isAbsolute(full[2]))) full = [full[0], ...full.slice(3)];
  if (
    full.length === 5 &&
    full[0] === "npx" &&
    full[1] === "-y" &&
    full[3] === "mcp" &&
    full[4] === "serve" &&
    typeof full[2] === "string" &&
    PACKAGE_TOKEN.test(full[2])
  ) {
    return { mode: "npm", current: full[2] };
  }
  if (
    full.length === 4 &&
    full[0] === "node" &&
    full[2] === "mcp" &&
    full[3] === "serve" &&
    typeof full[1] === "string" &&
    isManagedCheckoutLaunch(full[1])
  ) {
    return { mode: "checkout", current: full[1] };
  }
  return null;
}

export interface HostInspection {
  entryPresent: boolean;
  managed: boolean;
  /** Set when the config file exists but could not be parsed. */
  parseError?: string;
  /** Extra human-readable notes for doctor output. */
  notes: string[];
}

/** Updates retain previously selected runtime/readiness settings. */
export function retainManagedLaunchOptions(entry: Record<string, unknown>, launch: McpLaunchSpec, format: ManagedEntryFormat): McpLaunchSpec {
  const previous = format === "opencode" ? entry.command : entry.args;
  const args = [...launch.args];
  const offset = format === "opencode" ? 1 : 0;
  if (launch.command === "npx" && !args.includes("--prefix") && Array.isArray(previous) && previous[offset] === "--prefix" && typeof previous[offset + 1] === "string") {
    args.unshift("--prefix", previous[offset + 1]);
  }
  return { ...launch, args, ...(format === "codex" && entry.required === true ? { requireReady: true } : {}) };
}

export abstract class BaseHostAdapter implements HostAdapter {
  readonly supportedPlatforms: readonly NodeJS.Platform[] = ALL_PLATFORMS;
  readonly supportedScopes: readonly Scope[] = ["project", "global"];

  abstract readonly id: HostId;
  abstract readonly displayName: string;
  abstract readonly configFormat: "toml" | "jsonc";

  abstract resolveConfigPath(context: HostContext, scope: Scope): string;
  abstract planEntry(input: McpPlanInput): McpEntryPlanResult;
  abstract planRemoval(input: McpPlanInput): McpRemovalPlanResult;
  abstract planUpdate(input: McpPlanInput): McpUpdatePlanResult;
  /** The config key this adapter owns, e.g. `context_servers.pi-task-exec`. */
  protected abstract entryKey(): string;
  protected abstract inspectConfig(context: HostContext, scope: Scope, currentContent: string | null, path: string, launch: McpLaunchSpec): HostInspection;

  /** The host app must be restarted to pick up a changed MCP entry. */
  protected requiresRestart(): boolean {
    return true;
  }

  /** A project entry stays inactive until the user grants host trust. */
  protected requiresTrust(context: HostContext, scope: Scope): boolean {
    return this.trustWarnings(context, scope).length > 0;
  }

  /**
   * Default execution is limited to the user home and the project cwd. An
   * explicit absolute env override (CODEX_HOME, OPENCODE_CONFIG, ...) is a
   * deliberate user choice, so the adapter exposes its directory here instead
   * of letting a generic path_escape failure surprise the user.
   */
  additionalRoots(_context: HostContext, _scope: Scope): readonly string[] {
    return [];
  }

  describe(context: HostContext, scope: Scope, operation: "add" | "remove"): HostTarget {
    const support = operation === "remove" ? this.removeSupport(context, scope) : this.installSupport(context, scope);
    const trust = this.trustWarnings(context, scope);
    const trustNote = trust[0]?.message;
    return {
      host: this.id,
      displayName: this.displayName,
      scope,
      platform: context.platform,
      format: this.configFormat,
      path: this.resolveConfigPath(context, scope),
      key: this.entryKey(),
      supported: support === undefined,
      ...(support ? { support } : {}),
      requiresRestart: this.requiresRestart(),
      requiresTrust: this.requiresTrust(context, scope),
      ...(trustNote ? { trustNote } : {}),
    };
  }

  installSupport(context: HostContext, scope: Scope): UnsupportedCapability | undefined {
    return this.supportedPlatforms.includes(context.platform) ? undefined : platformCapability(this.id, scope, "add", context.platform);
  }

  removeSupport(context: HostContext, scope: Scope): UnsupportedCapability | undefined {
    return this.supportedPlatforms.includes(context.platform) ? undefined : platformCapability(this.id, scope, "remove", context.platform);
  }

  async readConfig(path: string): Promise<string | undefined> {
    try {
      return await readFile(path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  async writeConfig(path: string, content: string, options: FileWriteOptions): Promise<void> {
    await atomicWriteFile(path, content, options);
  }

  protected trustWarnings(_context: HostContext, _scope: Scope): PlanWarning[] {
    return [];
  }

  async doctorChecks(context: HostContext, scope: Scope, launch: McpLaunchSpec): Promise<DoctorCheck[]> {
    const path = this.resolveConfigPath(context, scope);
    const id = `host.${this.id}.${scope}`;
    const label = `${this.displayName} (${scope})`;
    let currentContent: string | null;
    try {
      currentContent = (await this.readConfig(path)) ?? null;
    } catch (error) {
      return [{ id, label, status: "warn", detail: `${this.configFormat} config at ${path} could not be read: ${error instanceof Error ? error.message : String(error)}` }];
    }
    let inspection: HostInspection;
    try {
      inspection = this.inspectConfig(context, scope, currentContent, path, launch);
    } catch (error) {
      inspection = { entryPresent: false, managed: false, parseError: error instanceof Error ? error.message : String(error), notes: [] };
    }
    const trust = this.trustWarnings(context, scope).map((warning) => warning.message);
    const notes = [...inspection.notes, ...trust];
    let status: DoctorCheck["status"];
    let detail: string;
    if (inspection.parseError) {
      status = "warn";
      detail = `${path} (${this.configFormat}) exists but is not safely parseable: ${inspection.parseError}`;
    } else if (!inspection.entryPresent) {
      status = "warn";
      detail = `${path} (${this.configFormat}); the pi-task-exec entry is not installed.`;
    } else if (inspection.managed) {
      status = "pass";
      detail = `${path} (${this.configFormat}); the exact managed pi-task-exec entry is present.`;
    } else {
      status = "warn";
      detail = `${path} (${this.configFormat}); a pi-task-exec entry exists but does not match the exact managed fingerprint (version, path, or entry fields changed).`;
    }
    if (notes.length > 0) detail = `${detail} ${notes.join(" ")}`;
    const host: HostDoctorMetadata = {
      path,
      format: this.configFormat,
      key: this.entryKey(),
      platform: context.platform,
      parseStatus: inspection.parseError ? "unparseable" : currentContent && currentContent.trim() ? "ok" : "absent",
      managedState: !inspection.entryPresent ? "absent" : inspection.managed ? "exact" : "drift",
      requiresTrust: this.requiresTrust(context, scope),
      requiresRestart: this.requiresRestart(),
      ...(trust[0] ? { trustNote: trust[0] } : {}),
    };
    detail = `${detail} [key=${host.key}; parse=${host.parseStatus}; managed=${host.managedState}; restart=${host.requiresRestart ? "required" : "not-required"}; trust=${host.requiresTrust ? "required" : "not-required"}]`;
    return [{ id, label, status, detail, host }];
  }
}
