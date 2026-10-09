import type { HostContext, PlanConflict, PlanWarning, Scope, UnsupportedCapability } from "../plan/model.js";
import { SERVER_ID } from "../identity.js";
import { CodexHostAdapter } from "./codex.js";
import { OpenCodeHostAdapter } from "./opencode.js";
import { ZedHostAdapter } from "./zed.js";

export type HostId = "codex" | "zed" | "opencode";

export const KNOWN_HOST_IDS: readonly HostId[] = ["codex", "zed", "opencode"];

export function isHostId(value: string): value is HostId {
  return (KNOWN_HOST_IDS as readonly string[]).includes(value);
}

export type ConfigFormat = "toml" | "jsonc";

export interface McpLaunchSpec {
  command: string;
  args: string[];
}

export interface McpPlanInput {
  context: HostContext;
  scope: Scope;
  serverId: string;
  launch: McpLaunchSpec;
  currentContent: string | null;
}

export type McpEntryPlanResult =
  | { kind: "ok"; path: string; content: string; warnings: PlanWarning[] }
  | { kind: "conflict"; conflict: PlanConflict }
  | { kind: "unsupported"; capability: UnsupportedCapability };

export type McpRemovalPlanResult =
  | { kind: "ok"; path: string; content: string; changed: boolean; warnings: PlanWarning[] }
  | { kind: "conflict"; conflict: PlanConflict }
  | { kind: "unsupported"; capability: UnsupportedCapability };

export interface FileWriteOptions {
  roots: readonly string[];
  mode?: number;
}

export interface HostTarget {
  host: HostId;
  displayName: string;
  scope: Scope;
  platform: NodeJS.Platform;
  format: ConfigFormat;
  /** Absolute resolved config path. */
  path: string;
  /** The config key this operation modifies, e.g. `mcp_servers.pi-task-exec`. */
  key: string;
  supported: boolean;
  support?: UnsupportedCapability;
  /** The host must be restarted to pick up a changed MCP entry. */
  requiresRestart: boolean;
  /** The host requires an explicit trust grant before it loads the entry. */
  requiresTrust: boolean;
  trustNote?: string;
}

export interface HostDoctorMetadata {
  path: string;
  format: ConfigFormat;
  key: string;
  platform: NodeJS.Platform;
  parseStatus: "ok" | "unparseable" | "absent";
  managedState: "absent" | "exact" | "drift";
  requiresTrust: boolean;
  requiresRestart: boolean;
  trustNote?: string;
}

export interface DoctorCheck {
  id: string;
  label: string;
  status: "pass" | "warn" | "fail" | "skip";
  detail: string;
  host?: HostDoctorMetadata;
}

/**
 * A Host adapter owns everything host-specific: the config path for a
 * platform/scope, the config format, safe merge/removal for that format, and
 * read-only doctor checks. Stage 8 registers real Codex, Zed and OpenCode
 * adapters; the executor and plan model are unchanged.
 */
export interface HostAdapter {
  readonly id: HostId;
  readonly displayName: string;
  readonly configFormat: ConfigFormat;
  readonly supportedPlatforms: readonly NodeJS.Platform[];
  readonly supportedScopes: readonly Scope[];
  /** Returns a reason when real MCP installation is not verified for the combination. */
  installSupport(context: HostContext, scope: Scope): UnsupportedCapability | undefined;
  removeSupport(context: HostContext, scope: Scope): UnsupportedCapability | undefined;
  /** Resolve the absolute config path. */
  resolveConfigPath(context: HostContext, scope: Scope): string;
  /** Structured metadata for plan/JSON output; never includes config secrets. */
  describe(context: HostContext, scope: Scope, operation: "add" | "remove"): HostTarget;
  /** Explicit, absolute env-override directories the executor may also write to. */
  additionalRoots(context: HostContext, scope: Scope): readonly string[];
  readConfig(path: string): Promise<string | undefined>;
  writeConfig(path: string, content: string, options: FileWriteOptions): Promise<void>;
  planEntry(input: McpPlanInput): McpEntryPlanResult;
  planRemoval(input: McpPlanInput): McpRemovalPlanResult;
  doctorChecks(context: HostContext, scope: Scope, launch: McpLaunchSpec): Promise<DoctorCheck[]>;
}

export function createDefaultAdapters(): HostAdapter[] {
  return [new CodexHostAdapter(), new ZedHostAdapter(), new OpenCodeHostAdapter()];
}

export function findAdapter(adapters: readonly HostAdapter[], host: string): HostAdapter | undefined {
  return adapters.find((adapter) => adapter.id === host);
}

export const STATUSLINE_SERVER_ID = SERVER_ID;
