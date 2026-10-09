import type { HostContext, PlanConflict, PlanWarning, Scope, UnsupportedCapability } from "./plan.js";
import { SERVER_ID } from "./identity.js";
import { SafetyError } from "./safety.js";

export type HostId = "codex" | "zed" | "opencode";

export const KNOWN_HOST_IDS: readonly HostId[] = ["codex", "zed", "opencode"];

export function isHostId(value: string): value is HostId {
  return (KNOWN_HOST_IDS as readonly string[]).includes(value);
}

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

export interface DoctorCheck {
  id: string;
  label: string;
  status: "pass" | "warn" | "fail" | "skip";
  detail: string;
}

/**
 * A Host adapter owns everything host-specific. Stage 7 intentionally keeps
 * the real adapters read-only/deferred: no configuration path is claimed
 * verified and no real write is performed until stage 8 lands path/config
 * adaptation. Tests inject a fully supported fake adapter instead.
 */
export interface HostAdapter {
  readonly id: HostId;
  readonly displayName: string;
  readonly supportedPlatforms: readonly NodeJS.Platform[];
  readonly supportedScopes: readonly Scope[];
  /** Returns a reason when real MCP installation is not verified for the combination. */
  installSupport(context: HostContext, scope: Scope): UnsupportedCapability | undefined;
  removeSupport(context: HostContext, scope: Scope): UnsupportedCapability | undefined;
  /** Resolve the absolute config path. Deferred adapters must throw instead of guessing. */
  resolveConfigPath(context: HostContext, scope: Scope): string;
  readConfig(path: string): Promise<string | undefined>;
  writeConfig(path: string, content: string, options: FileWriteOptions): Promise<void>;
  planEntry(input: McpPlanInput): McpEntryPlanResult;
  planRemoval(input: McpPlanInput): McpRemovalPlanResult;
  doctorChecks(context: HostContext, scope: Scope): Promise<DoctorCheck[]>;
}

interface DeferredHostDefinition {
  id: HostId;
  displayName: string;
  supportedPlatforms: readonly NodeJS.Platform[];
  supportedScopes: readonly Scope[];
}

function deferredUnsupported(host: HostId, scope: Scope, operation: "add" | "remove"): UnsupportedCapability {
  return {
    code: operation === "add" ? "mcp_install_unverified" : "mcp_remove_unverified",
    target: "mcp",
    host,
    scope,
    message: `Real MCP ${operation === "add" ? "installation" : "removal"} for ${host}/${scope} is deferred to stage 8: the config path and format for this platform/scope combination are not verified, so no path is guessed and no file is written.`,
  };
}

class DeferredHostAdapter implements HostAdapter {
  readonly id: HostId;
  readonly displayName: string;
  readonly supportedPlatforms: readonly NodeJS.Platform[];
  readonly supportedScopes: readonly Scope[];

  constructor(definition: DeferredHostDefinition) {
    this.id = definition.id;
    this.displayName = definition.displayName;
    this.supportedPlatforms = definition.supportedPlatforms;
    this.supportedScopes = definition.supportedScopes;
  }

  installSupport(_context: HostContext, scope: Scope): UnsupportedCapability {
    return deferredUnsupported(this.id, scope, "add");
  }

  removeSupport(_context: HostContext, scope: Scope): UnsupportedCapability {
    return deferredUnsupported(this.id, scope, "remove");
  }

  resolveConfigPath(): string {
    throw new SafetyError("config_path_unverified", `The ${this.displayName} config path is not verified for this platform/scope; stage 8 will add it.`);
  }

  async readConfig(): Promise<string | undefined> {
    throw new SafetyError("config_read_unverified", `Reading ${this.displayName} config is not enabled until stage 8.`);
  }

  async writeConfig(): Promise<void> {
    throw new SafetyError("config_write_unverified", `Writing ${this.displayName} config is not enabled until stage 8.`);
  }

  planEntry(input: McpPlanInput): McpEntryPlanResult {
    return { kind: "unsupported", capability: deferredUnsupported(this.id, input.scope, "add") };
  }

  planRemoval(input: McpPlanInput): McpRemovalPlanResult {
    return { kind: "unsupported", capability: deferredUnsupported(this.id, input.scope, "remove") };
  }

  async doctorChecks(_context: HostContext, scope: Scope): Promise<DoctorCheck[]> {
    return [
      {
        id: `host.${this.id}.${scope}`,
        label: `${this.displayName} (${scope})`,
        status: "skip",
        detail: "Path/config adaptation deferred to stage 8; no write capability is claimed.",
      },
    ];
  }
}

export function createDefaultAdapters(): HostAdapter[] {
  // Stage 7 has not verified any platform/scope combination for the real
  // hosts, so the capability lists stay empty. Doctor still enumerates the
  // standard scopes and reports each as deferred instead of claiming support.
  return [
    new DeferredHostAdapter({ id: "codex", displayName: "Codex", supportedPlatforms: [], supportedScopes: [] }),
    new DeferredHostAdapter({ id: "zed", displayName: "Zed", supportedPlatforms: [], supportedScopes: [] }),
    new DeferredHostAdapter({ id: "opencode", displayName: "OpenCode", supportedPlatforms: [], supportedScopes: [] }),
  ];
}

export function findAdapter(adapters: readonly HostAdapter[], host: string): HostAdapter | undefined {
  return adapters.find((adapter) => adapter.id === host);
}

export const STATUSLINE_SERVER_ID = SERVER_ID;
