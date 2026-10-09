import { win32 } from "node:path";
import type { McpEntryPlanResult, McpPlanInput, McpRemovalPlanResult } from "./adapters.js";
import { SERVER_ID } from "../identity.js";
import type { HostContext, PlanConflict, PlanWarning, Scope } from "../plan/model.js";
import { editJsonc, JsoncEditError, parseJsoncRoot, requireObjectContainer, type JsonRecord } from "./jsonc.js";
import { BaseHostAdapter, absoluteEnvPath, deepEqual, pathForPlatform, type HostInspection, xdgConfigHome } from "./shared.js";

const CONTAINER = "context_servers";

function conflict(path: string, code: string, message: string): PlanConflict {
  return { code, path, message };
}

export class ZedHostAdapter extends BaseHostAdapter {
  readonly id = "zed" as const;
  readonly displayName = "Zed";
  readonly configFormat = "jsonc" as const;

  resolveConfigPath(context: HostContext, scope: Scope): string {
    const platform = pathForPlatform(context.platform);
    if (scope === "project") return platform.join(context.cwd, ".zed", "settings.json");
    if (context.platform === "win32") {
      // Windows uses %APPDATA%\Zed\settings.json.
      const raw = typeof context.env.APPDATA === "string" ? context.env.APPDATA.trim() : "";
      const appData = raw === ""
        ? win32.join(context.home, "AppData", "Roaming")
        : win32.isAbsolute(raw) ? win32.normalize(raw) : win32.join(context.home, raw);
      return win32.join(appData, "Zed", "settings.json");
    }
    // macOS and Linux both document ~/.config/zed/settings.json; honour
    // XDG_CONFIG_HOME when the user has redirected it.
    return platform.join(xdgConfigHome(context), "zed", "settings.json");
  }

  protected trustWarnings(_context: HostContext, scope: Scope): PlanWarning[] {
    if (scope !== "project") return [];
    return [
      {
        code: "restricted_mode",
        message:
          "Zed Restricted Mode ignores project .zed/settings.json MCP servers until the worktree is trusted. This installer does not grant that trust.",
      },
    ];
  }

  private canonicalEntry(launch: McpPlanInput["launch"]): JsonRecord {
    return { command: launch.command, args: [...launch.args] };
  }

  protected entryKey(): string {
    return `context_servers.${SERVER_ID}`;
  }

  additionalRoots(context: HostContext, scope: Scope): readonly string[] {
    if (scope !== "global") return [];
    if (context.platform === "win32") {
      const raw = typeof context.env.APPDATA === "string" ? context.env.APPDATA.trim() : "";
      return raw !== "" && win32.isAbsolute(raw) ? [win32.normalize(raw)] : [];
    }
    const xdg = absoluteEnvPath(context, "XDG_CONFIG_HOME");
    return xdg ? [xdg] : [];
  }

  private entryFrom(input: McpPlanInput, path: string): { ok: true; root: JsonRecord; existing: JsonRecord | undefined } | { ok: false; conflict: PlanConflict } {
    try {
      const root = input.currentContent && input.currentContent.trim() ? parseJsoncRoot(input.currentContent) : {};
      const container = requireObjectContainer(root, [CONTAINER]);
      if (!container.ok) return { ok: false, conflict: conflict(path, "config_shape_conflict", container.reason) };
      const existing = container.value?.[SERVER_ID];
      if (existing !== undefined && (existing === null || typeof existing !== "object" || Array.isArray(existing))) {
        return { ok: false, conflict: conflict(path, "config_shape_conflict", `context_servers.${SERVER_ID} is not an object.`) };
      }
      return { ok: true, root, existing: existing as JsonRecord | undefined };
    } catch (error) {
      const code = error instanceof JsoncEditError ? error.code : "config_unparseable";
      return { ok: false, conflict: conflict(path, code, error instanceof Error ? error.message : String(error)) };
    }
  }

  planEntry(input: McpPlanInput): McpEntryPlanResult {
    const path = this.resolveConfigPath(input.context, input.scope);
    const warnings = this.trustWarnings(input.context, input.scope);
    const parsed = this.entryFrom(input, path);
    if (!parsed.ok) return { kind: "conflict", conflict: parsed.conflict };
    const existing = parsed.existing;
    const canonical = this.canonicalEntry(input.launch);
    if (existing) {
      if (!deepEqual(existing, canonical)) {
        return {
          kind: "conflict",
          conflict: conflict(
            path,
            "mcp_entry_conflict",
            `An existing context_servers.${SERVER_ID} entry at ${path} does not match the exact entry this tool manages (version, local path, or entry fields differ); refusing to overwrite it.`,
          ),
        };
      }
      return { kind: "ok", path, content: input.currentContent ?? "", warnings };
    }
    const content = editJsonc(input.currentContent ?? "", [CONTAINER, SERVER_ID], canonical);
    return { kind: "ok", path, content, warnings };
  }

  planRemoval(input: McpPlanInput): McpRemovalPlanResult {
    const path = this.resolveConfigPath(input.context, input.scope);
    const warnings = this.trustWarnings(input.context, input.scope);
    if (!input.currentContent || !input.currentContent.trim()) return { kind: "ok", path, content: input.currentContent ?? "", changed: false, warnings };
    const parsed = this.entryFrom(input, path);
    if (!parsed.ok) return { kind: "conflict", conflict: parsed.conflict };
    if (!parsed.existing) return { kind: "ok", path, content: input.currentContent, changed: false, warnings };
    if (!deepEqual(parsed.existing, this.canonicalEntry(input.launch))) {
      return {
        kind: "conflict",
        conflict: conflict(
          path,
          "mcp_entry_not_managed",
          `The context_servers.${SERVER_ID} entry at ${path} does not match the exact managed fingerprint (version, local path, or entry fields changed); refusing to remove it.`,
        ),
      };
    }
    const content = editJsonc(input.currentContent, [CONTAINER, SERVER_ID], undefined);
    return { kind: "ok", path, content, changed: true, warnings };
  }

  protected inspectConfig(_context: HostContext, _scope: Scope, currentContent: string | null, _path: string, launch: McpPlanInput["launch"]): HostInspection {
    if (!currentContent || !currentContent.trim()) return { entryPresent: false, managed: false, notes: [] };
    let existing: JsonRecord | undefined;
    try {
      const container = requireObjectContainer(parseJsoncRoot(currentContent), [CONTAINER]);
      if (!container.ok) return { entryPresent: false, managed: false, notes: [container.reason] };
      const value = container.value?.[SERVER_ID];
      if (value !== undefined && (value === null || typeof value !== "object" || Array.isArray(value))) {
        return { entryPresent: false, managed: false, notes: [`context_servers.${SERVER_ID} is not an object.`] };
      }
      existing = value as JsonRecord | undefined;
    } catch (error) {
      return { entryPresent: false, managed: false, parseError: error instanceof Error ? error.message : String(error), notes: [] };
    }
    if (!existing) return { entryPresent: false, managed: false, notes: [] };
    const managed = deepEqual(existing, this.canonicalEntry(launch));
    return { entryPresent: true, managed, notes: managed ? [] : [`Existing context_servers.${SERVER_ID} entry does not match the exact managed fingerprint.`] };
  }
}

export function createZedAdapter(): ZedHostAdapter {
  return new ZedHostAdapter();
}
