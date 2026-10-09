import type { McpEntryPlanResult, McpPlanInput, McpRemovalPlanResult, McpUpdatePlanResult } from "./adapters.js";
import { SERVER_ID } from "../identity.js";
import type { HostContext, PlanConflict, PlanWarning, Scope } from "../plan/model.js";
import { BaseHostAdapter, absoluteEnvPath, classifyManagedUpdateEntry, retainManagedLaunchOptions, deepEqual, envPath, pathForPlatform, type HostInspection } from "./shared.js";
import { parseToml, readTomlEntry, removeTomlTable, TomlEditError, upsertTomlTable } from "./toml.js";

const TABLE_PATH = ["mcp_servers", SERVER_ID] as const;

function conflict(path: string, code: string, message: string): PlanConflict {
  return { code, path, message };
}

export class CodexHostAdapter extends BaseHostAdapter {
  readonly id = "codex" as const;
  readonly displayName = "Codex";
  readonly configFormat = "toml" as const;

  resolveConfigPath(context: HostContext, scope: Scope): string {
    const path = pathForPlatform(context.platform);
    if (scope === "project") return path.join(context.cwd, ".codex", "config.toml");
    const codexHome = envPath(context, "CODEX_HOME") ?? path.join(context.home, ".codex");
    return path.join(codexHome, "config.toml");
  }

  protected trustWarnings(_context: HostContext, scope: Scope): PlanWarning[] {
    if (scope !== "project") return [];
    return [
      {
        code: "project_trust_required",
        message:
          "Codex loads project .codex/config.toml only for projects it trusts. This installer does not grant that trust, so the entry stays inactive until you trust the project in Codex.",
      },
    ];
  }

  private canonicalEntry(launch: McpPlanInput["launch"]): Record<string, unknown> {
    return { command: launch.command, args: [...launch.args], ...(launch.requireReady ? { required: true } : {}) };
  }

  protected entryKey(): string {
    return `mcp_servers.${SERVER_ID}`;
  }

  additionalRoots(context: HostContext, scope: Scope): readonly string[] {
    if (scope !== "global") return [];
    const codexHome = absoluteEnvPath(context, "CODEX_HOME");
    return codexHome ? [codexHome] : [];
  }

  private entryFrom(input: McpPlanInput, path: string): { ok: true; entry: Record<string, unknown> | undefined } | { ok: false; conflict: PlanConflict } {
    if (!input.currentContent || !input.currentContent.trim()) return { ok: true, entry: undefined };
    try {
      const root = parseToml(input.currentContent);
      return { ok: true, entry: readTomlEntry(root, TABLE_PATH) };
    } catch (error) {
      const code = error instanceof TomlEditError ? error.code : "config_unparseable";
      return { ok: false, conflict: conflict(path, code, error instanceof Error ? error.message : String(error)) };
    }
  }

  planEntry(input: McpPlanInput): McpEntryPlanResult {
    const path = this.resolveConfigPath(input.context, input.scope);
    const warnings = this.trustWarnings(input.context, input.scope);
    const parsed = this.entryFrom(input, path);
    if (!parsed.ok) return { kind: "conflict", conflict: parsed.conflict };
    const existing = parsed.entry;
    const canonical = this.canonicalEntry(existing ? retainManagedLaunchOptions(existing, input.launch, "codex") : input.launch);
    if (existing) {
      if (!deepEqual(existing, canonical)) {
        return {
          kind: "conflict",
          conflict: conflict(
            path,
            "mcp_entry_conflict",
            `An existing mcp_servers.${SERVER_ID} entry at ${path} does not match the exact entry this tool manages (version, local path, or entry fields differ); refusing to overwrite it.`,
          ),
        };
      }
      // Exact same managed content: idempotent, no write planned.
      return { kind: "ok", path, content: input.currentContent ?? "", warnings };
    }
    try {
      const content = upsertTomlTable(input.currentContent ?? "", TABLE_PATH, canonical, ["command", "args"]);
      return { kind: "ok", path, content, warnings };
    } catch (error) {
      const code = error instanceof TomlEditError ? error.code : "config_unparseable";
      return { kind: "conflict", conflict: conflict(path, code, error instanceof Error ? error.message : String(error)) };
    }
  }

  planUpdate(input: McpPlanInput): McpUpdatePlanResult {
    const path = this.resolveConfigPath(input.context, input.scope);
    const warnings = this.trustWarnings(input.context, input.scope);
    const parsed = this.entryFrom(input, path);
    if (!parsed.ok) return { kind: "conflict", conflict: parsed.conflict };
    const existing = parsed.entry;
    if (!existing) return { kind: "absent", path };
    const managed = classifyManagedUpdateEntry(existing, "codex");
    if (!managed) {
      return {
        kind: "conflict",
        conflict: conflict(
          path,
          "mcp_entry_conflict",
          `An existing mcp_servers.${SERVER_ID} entry at ${path} does not have a recognized Pi TaskExec launcher; refusing to replace another command.`,
        ),
      };
    }
    const canonical = this.canonicalEntry(input.launch);
    try {
      const clean = removeTomlTable(input.currentContent ?? "", TABLE_PATH).content;
      const content = upsertTomlTable(clean, TABLE_PATH, canonical, ["command", "args"]);
      return { kind: "update", path, content, current: managed.current, warnings };
    } catch (error) {
      const code = error instanceof TomlEditError ? error.code : "config_unparseable";
      return { kind: "conflict", conflict: conflict(path, code, error instanceof Error ? error.message : String(error)) };
    }
  }

  planRemoval(input: McpPlanInput): McpRemovalPlanResult {
    const path = this.resolveConfigPath(input.context, input.scope);
    const warnings = this.trustWarnings(input.context, input.scope);
    if (!input.currentContent || !input.currentContent.trim()) return { kind: "ok", path, content: input.currentContent ?? "", changed: false, warnings };
    const parsed = this.entryFrom(input, path);
    if (!parsed.ok) return { kind: "conflict", conflict: parsed.conflict };
    if (!parsed.entry) return { kind: "ok", path, content: input.currentContent, changed: false, warnings };
    if (!deepEqual(parsed.entry, this.canonicalEntry(retainManagedLaunchOptions(parsed.entry, input.launch, "codex")))) {
      return {
        kind: "conflict",
        conflict: conflict(
          path,
          "mcp_entry_not_managed",
          `The mcp_servers.${SERVER_ID} entry at ${path} does not match the exact managed fingerprint (version, local path, or entry fields changed); refusing to remove it.`,
        ),
      };
    }
    try {
      const removed = removeTomlTable(input.currentContent, TABLE_PATH);
      return { kind: "ok", path, content: removed.content, changed: removed.found, warnings };
    } catch (error) {
      const code = error instanceof TomlEditError ? error.code : "config_unparseable";
      return { kind: "conflict", conflict: conflict(path, code, error instanceof Error ? error.message : String(error)) };
    }
  }

  protected inspectConfig(_context: HostContext, _scope: Scope, currentContent: string | null, _path: string, launch: McpPlanInput["launch"]): HostInspection {
    if (!currentContent || !currentContent.trim()) return { entryPresent: false, managed: false, notes: [] };
    let entry: Record<string, unknown> | undefined;
    try {
      entry = readTomlEntry(parseToml(currentContent), TABLE_PATH);
    } catch (error) {
      return { entryPresent: false, managed: false, parseError: error instanceof Error ? error.message : String(error), notes: [] };
    }
    if (!entry) return { entryPresent: false, managed: false, notes: [] };
    const managed = classifyManagedUpdateEntry(entry, "codex") !== null && deepEqual(entry, { ...entry, ...this.canonicalEntry(retainManagedLaunchOptions(entry, launch, "codex")) });
    const notes = managed ? [] : [`Existing mcp_servers.${SERVER_ID} entry does not match the exact managed fingerprint.`];
    return { entryPresent: true, managed, notes };
  }

}

export function createCodexAdapter(): CodexHostAdapter {
  return new CodexHostAdapter();
}
