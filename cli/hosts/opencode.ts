import { existsSync } from "node:fs";
import type { McpEntryPlanResult, McpPlanInput, McpRemovalPlanResult, McpUpdatePlanResult } from "./adapters.js";
import { SERVER_ID } from "../identity.js";
import type { HostContext, PlanConflict, PlanWarning, Scope } from "../plan/model.js";
import { editJsonc, JsoncEditError, parseJsoncRoot, requireObjectContainer, type JsonRecord } from "./jsonc.js";
import { BaseHostAdapter, absoluteEnvPath, classifyManagedEntry, deepEqual, envPath, pathForPlatform, type HostInspection, xdgConfigHome } from "./shared.js";

const CONTAINER = "mcp";

function conflict(path: string, code: string, message: string): PlanConflict {
  return { code, path, message };
}

function pickFirstExisting(candidates: readonly string[], fallback: string): string {
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return fallback;
}

function isTruthy(value: string | undefined): boolean {
  if (typeof value !== "string" || value.trim() === "") return false;
  return !["0", "false", "no", "off"].includes(value.trim().toLowerCase());
}

export class OpenCodeHostAdapter extends BaseHostAdapter {
  readonly id = "opencode" as const;
  readonly displayName = "OpenCode";
  readonly configFormat = "jsonc" as const;

  resolveConfigPath(context: HostContext, scope: Scope): string {
    const path = pathForPlatform(context.platform);
    if (scope === "project") {
      return pickFirstExisting([path.join(context.cwd, "opencode.jsonc"), path.join(context.cwd, "opencode.json")], path.join(context.cwd, "opencode.json"));
    }
    // `OPENCODE_CONFIG` is the documented custom config file override. When it
    // is not set, `OPENCODE_CONFIG_DIR` relocates the global config directory
    // (default `$XDG_CONFIG_HOME/opencode` or `~/.config/opencode`).
    const customFile = envPath(context, "OPENCODE_CONFIG");
    if (customFile) return customFile;
    const directory = envPath(context, "OPENCODE_CONFIG_DIR") ?? path.join(xdgConfigHome(context), "opencode");
    return pickFirstExisting(
      [path.join(directory, "opencode.jsonc"), path.join(directory, "opencode.json")],
      path.join(directory, "opencode.json"),
    );
  }

  protected trustWarnings(context: HostContext, scope: Scope): PlanWarning[] {
    const warnings: PlanWarning[] = [];
    if (scope === "global" && envPath(context, "OPENCODE_CONFIG")) {
      warnings.push({
        code: "custom_config_path",
        message: "OPENCODE_CONFIG is set; the entry is written to that custom config file, which OpenCode loads between global and project config.",
      });
    }
    if (scope === "global" && envPath(context, "OPENCODE_CONFIG_DIR")) {
      warnings.push({
        code: "custom_config_dir",
        message: "OPENCODE_CONFIG_DIR is set; it relocates the OpenCode config directory used for this global entry.",
      });
    }
    if (isTruthy(context.env.OPENCODE_CONFIG_CONTENT)) {
      warnings.push({
        code: "inline_config_override",
        message:
          "OPENCODE_CONFIG_CONTENT is set; that inline config is loaded last and overrides file config at runtime, so this file entry may be shadowed. The installer never writes inline config.",
      });
    }
    if (scope === "project" && isTruthy(context.env.OPENCODE_DISABLE_PROJECT_CONFIG)) {
      warnings.push({
        code: "project_config_disabled",
        message: "OPENCODE_DISABLE_PROJECT_CONFIG is set; OpenCode will not load the project opencode.json this entry is written to.",
      });
    }
    return warnings;
  }

  private canonicalEntry(launch: McpPlanInput["launch"]): JsonRecord {
    return { type: "local", command: [launch.command, ...launch.args] };
  }

  protected entryKey(): string {
    return `mcp.${SERVER_ID}`;
  }

  additionalRoots(context: HostContext, scope: Scope): readonly string[] {
    if (scope !== "global") return [];
    const path = pathForPlatform(context.platform);
    const roots: string[] = [];
    const configFileRaw = context.env.OPENCODE_CONFIG;
    if (typeof configFileRaw === "string" && configFileRaw.trim() !== "") {
      const customFile = absoluteEnvPath(context, "OPENCODE_CONFIG");
      if (customFile) roots.push(path.dirname(customFile));
      return roots;
    }
    const configDirRaw = context.env.OPENCODE_CONFIG_DIR;
    if (typeof configDirRaw === "string" && configDirRaw.trim() !== "") {
      const customDir = absoluteEnvPath(context, "OPENCODE_CONFIG_DIR");
      if (customDir) roots.push(customDir);
      return roots;
    }
    // The global path uses XDG_CONFIG_HOME only when neither override is set.
    const xdg = absoluteEnvPath(context, "XDG_CONFIG_HOME");
    if (xdg) roots.push(xdg);
    return roots;
  }

  private entryFrom(input: McpPlanInput, path: string): { ok: true; existing: JsonRecord | undefined } | { ok: false; conflict: PlanConflict } {
    try {
      const root = input.currentContent && input.currentContent.trim() ? parseJsoncRoot(input.currentContent) : {};
      const container = requireObjectContainer(root, [CONTAINER]);
      if (!container.ok) return { ok: false, conflict: conflict(path, "config_shape_conflict", container.reason) };
      const existing = container.value?.[SERVER_ID];
      if (existing !== undefined && (existing === null || typeof existing !== "object" || Array.isArray(existing))) {
        return { ok: false, conflict: conflict(path, "config_shape_conflict", `mcp.${SERVER_ID} is not an object.`) };
      }
      return { ok: true, existing: existing as JsonRecord | undefined };
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
            `An existing mcp.${SERVER_ID} entry at ${path} does not match the exact entry this tool manages (version, local path, or entry fields differ); refusing to overwrite it.`,
          ),
        };
      }
      return { kind: "ok", path, content: input.currentContent ?? "", warnings };
    }
    const content = editJsonc(input.currentContent ?? "", [CONTAINER, SERVER_ID], canonical);
    return { kind: "ok", path, content, warnings };
  }

  planUpdate(input: McpPlanInput): McpUpdatePlanResult {
    const path = this.resolveConfigPath(input.context, input.scope);
    const warnings = this.trustWarnings(input.context, input.scope);
    const parsed = this.entryFrom(input, path);
    if (!parsed.ok) return { kind: "conflict", conflict: parsed.conflict };
    const existing = parsed.existing;
    if (!existing) return { kind: "absent", path };
    const managed = classifyManagedEntry(existing, "opencode");
    if (!managed) {
      return {
        kind: "conflict",
        conflict: conflict(
          path,
          "mcp_entry_conflict",
          `An existing mcp.${SERVER_ID} entry at ${path} cannot be proven managed (unknown fields, env, or changed args); refusing to update it.`,
        ),
      };
    }
    const canonical = this.canonicalEntry(input.launch);
    if (deepEqual(existing, canonical)) return { kind: "no-op", path, current: managed.current, warnings };
    try {
      const content = editJsonc(input.currentContent ?? "", [CONTAINER, SERVER_ID], canonical);
      return { kind: "update", path, content, current: managed.current, warnings };
    } catch (error) {
      const code = error instanceof JsoncEditError ? error.code : "config_unparseable";
      return { kind: "conflict", conflict: conflict(path, code, error instanceof Error ? error.message : String(error)) };
    }
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
          `The mcp.${SERVER_ID} entry at ${path} does not match the exact managed fingerprint (version, local path, or entry fields changed); refusing to remove it.`,
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
        return { entryPresent: false, managed: false, notes: [`mcp.${SERVER_ID} is not an object.`] };
      }
      existing = value as JsonRecord | undefined;
    } catch (error) {
      return { entryPresent: false, managed: false, parseError: error instanceof Error ? error.message : String(error), notes: [] };
    }
    if (!existing) return { entryPresent: false, managed: false, notes: [] };
    const managed = deepEqual(existing, this.canonicalEntry(launch));
    return { entryPresent: true, managed, notes: managed ? [] : [`Existing mcp.${SERVER_ID} entry does not match the exact managed fingerprint.`] };
  }
}

export function createOpenCodeAdapter(): OpenCodeHostAdapter {
  return new OpenCodeHostAdapter();
}
