import type { HostAdapter } from "../hosts/adapters.js";
import { KNOWN_HOST_IDS, findAdapter, isHostId } from "../hosts/adapters.js";
import type { SpawnFunction } from "./doctor.js";
import { formatDoctor, runDoctor } from "./doctor.js";
import { PACKAGE_NAME, PRODUCT_NAME, VERSION } from "../identity.js";
import { defaultIo, type CliIo } from "../io.js";
import { highlight } from "../presentation.js";
import {
  formatPlan,
  generatePlan,
  appendSkillCliAgents,
  planJson,
  serializePlan,
  resolveLaunchSpec,
  type HostContext,
  type LaunchMode,
  type PlanOperation,
  type PlanTarget,
  type ReleaseTagPreflight,
  type Scope,
  type InstallPlan,
} from "../plan/model.js";
import type { SkillInstaller } from "../installers/skill.js";
import { SKILL_REPOSITORY, skillCliAdditionalRoots, type SkillsCliSpawn } from "../installers/skills-cli.js";
import type { Interaction, InteractionChoice } from "../interactive.js";
import { executePlan, formatExecution, serializeExecution, type SafetyConfirmation } from "../plan/executor.js";
import { executeSkillRemoval, planSkillRemoval, type SkillRemovalPlan } from "../installers/skill-removal.js";

export { PACKAGE_NAME, PRODUCT_NAME, VERSION } from "../identity.js";
export type { CliIo } from "../io.js";

export interface CliOptions {
  npmPrefix?: string;
  requireMcp?: boolean;
  probe?: boolean;
  host?: string;
  scope?: Scope;
  target?: PlanTarget;
  removeSkill: boolean;
  dryRun: boolean;
  yes: boolean;
  json: boolean;
  help: boolean;
  version: boolean;
  /** Deduped, ordered `--host` selections (repeatable for setup/update/uninstall). */
  hosts: string[];
  /** Explicit opt-in before writing an absolute local checkout launch path. */
  localDev: boolean;
  /** Explicit opt-in to the interactive Agent/Scope/Yes-No flow. */
  interactive: boolean;
}

export type ParsedCli =
  | { kind: "help"; topic: string | null }
  | { kind: "version" }
  | { kind: "serve" }
  | { kind: "command"; operation: PlanOperation; target: PlanTarget; options: CliOptions }
  | { kind: "error"; code: string; message: string; json: boolean };

/** Parsing mode. Interactive prompts are only reachable when a TTY/injected interaction exists. */
export interface ParseOptions {
  interactive?: boolean;
}

export interface CliDeps {
  color?: boolean;
  io: CliIo;
  env: NodeJS.ProcessEnv;
  cwd: string;
  home: string;
  platform: NodeJS.Platform;
  packageRoot: string;
  packageVersion: string;
  /** Explicit launch-mode override; otherwise detected from the package root/env. */
  launchMode?: LaunchMode;
  adapters: readonly HostAdapter[];
  skillInstaller: SkillInstaller;
  /** Injectable arrow-key interaction (Agent/Scope/Yes-No); absent without a TTY. */
  interaction?: Interaction;
  /** Injectable Skills CLI spawn for the pinned skill installer. */
  skillSpawn?: SkillsCliSpawn;
  now: () => Date;
  spawn: SpawnFunction;
  /** Injectable read-only exact release-tag preflight; defaults to `git ls-remote`. */
  releaseTagPreflight?: ReleaseTagPreflight;
  confirm?: (plan: import("../plan/model.js").InstallPlan, safety?: SafetyConfirmation) => Promise<boolean>;
  roots?: readonly string[];
  backupDir?: string;
}

export type CliAction = { kind: "serve" } | { kind: "exit"; code: number };

const GLOBAL_HELP = `Usage:
  ${PRODUCT_NAME} [command] [options]

Commands:
  ${PRODUCT_NAME} mcp serve          Start the MCP stdio runtime (the only server-start command)
  ${PRODUCT_NAME} add mcp            Plan/install the MCP entry for an explicit host and scope
  ${PRODUCT_NAME} add skill          Plan/install the pi-delegate skill for an explicit host and scope
  ${PRODUCT_NAME} remove mcp         Plan/remove the MCP entry for an explicit host and scope
  ${PRODUCT_NAME} remove skill       Plan/remove the pi-delegate skill for an explicit scope
  ${PRODUCT_NAME} setup              Plan combined MCP and/or skill setup
  ${PRODUCT_NAME} update             Plan an in-place update of already-installed MCP and/or Skill components
  ${PRODUCT_NAME} uninstall          Remove this project's MCP entries; optionally remove the shared Skill
  ${PRODUCT_NAME} doctor             Read-only environment, host, skill, and version check

Options:
  --help                             Show help and exit
  --version                          Print only the package version and exit
  --dry-run                          Print the plan and exit without writing
  --local-dev                        Explicitly allow installing an absolute source-checkout path (checkout mode only)
  --json                             Print stable machine-readable JSON (missing selections fail without prompting)
  --yes                              Legacy non-interactive confirmation flag
  --interactive, -i                  Force prompting for missing selections (requires a TTY)
  --host <${KNOWN_HOST_IDS.join("|")}>       Repeatable for setup/update/uninstall (one host per flag); add/remove take one host per run
  --remove-skill                     Uninstall only: also remove the shared pi-delegate Skill
  --probe                            Doctor only: probe package MCP handshake and tools; no Worker
  --npm-prefix <absolute-directory>   Isolate npm resolution while preserving MCP cwd
  --require-mcp                      Codex only: wait for MCP; failed startup blocks Host
  --scope <project|global>
  --target <mcp|skill|both>          (setup only; update always inspects both)

Hosts: ${KNOWN_HOST_IDS.join(", ")}. Scopes: project, global.
No arguments prints this help and never starts MCP.
MCP stdio launch: npx -y ${PACKAGE_NAME}@latest mcp serve`;

function commandHelp(topic: string): string {
  switch (topic) {
    case "mcp serve":
      return `Usage:\n  ${PRODUCT_NAME} mcp serve\n\nStart the MCP stdio runtime. This is the only server-start command and the Registry launch contract.`;
    case "add mcp":
      return `Usage:\n  ${PRODUCT_NAME} add mcp [--host <${KNOWN_HOST_IDS.join("|")}>] [--scope <project|global>] [--dry-run] [--json] [--yes]\n\nPlan and install the pi-task-exec MCP entry. Host-specific paths and formats (Codex TOML, Zed/OpenCode JSONC) are merged safely; unrelated configuration is preserved and conflicts stop the whole operation. On a TTY a missing --host/--scope is prompted; --json fails instead of prompting.`;
    case "add skill":
      return `Usage:\n  ${PRODUCT_NAME} add skill [--host <${KNOWN_HOST_IDS.join("|")}>] [--scope <project|global>] [--dry-run] [--json] [--yes]\n\nPlan and install the bundled pi-delegate Skill through the pinned Vercel Skills CLI v1.7.1 from the fixed GitHub source. --host selects the Skill Agent (prompted on a TTY when omitted). The plan is printed, existing paths require a default-No confirmation, and the real result (files, pinned source/ref, lockfile) is verified.`;
    case "remove mcp":
      return `Usage:\n  ${PRODUCT_NAME} remove mcp [--host <${KNOWN_HOST_IDS.join("|")}>] [--scope <project|global>] [--dry-run] [--json] [--yes]\n\nOn a TTY, select Agent and Scope, review the removal plan, then confirm. Non-interactive and --json commands require explicit selections. Only the managed pi-task-exec MCP entry is removed; unrelated settings are preserved.`;
    case "remove skill":
      return `Usage:\n  ${PRODUCT_NAME} remove skill --scope <project|global> [--dry-run] [--json] [--yes]\n\nPlan and (when available) remove the managed pi-delegate skill.`;
    case "setup":
      return `Usage:\n  ${PRODUCT_NAME} setup [--target <mcp|skill|both>] [--host <${KNOWN_HOST_IDS.join("|")}> ...] [--scope <project|global>] [--dry-run] [--json]\n\nSelect platforms and one scope, then install. Routine runs show only the result; --dry-run shows the full plan.`;
    case "update":
      return `Usage:\n  ${PRODUCT_NAME} update [--host <${KNOWN_HOST_IDS.join("|")}> ...] [--scope <project|global>] [--dry-run] [--json]\n\nUpdate managed MCP entries and the shared Skill once per scope. Absent components are not installed. Routine runs show only the result.`;
    case "uninstall":
      return `Usage:\n  ${PRODUCT_NAME} uninstall [--host <${KNOWN_HOST_IDS.join("|")}> ...] [--scope <project|global>] [--remove-skill] [--dry-run] [--json]\n\nRemove only this project's MCP entries from the selected platforms. The shared Skill is kept unless selected in the terminal or requested with --remove-skill.`;
    case "doctor":
      return `Usage:\n  ${PRODUCT_NAME} doctor [--json] [--probe]\n\nRead-only check of Node, Pi, Git, package/platform/version contract, host adapter capability, and skill target status. Never prints config secrets or file contents. --probe explicitly starts the package MCP for initialize, tools/list and pi_list, never a Worker.`;
    default:
      return helpText();
  }
}

export function helpText(): string {
  return `${PRODUCT_NAME} ${VERSION}\n\n${GLOBAL_HELP}`;
}

function errorResult(code: string, message: string, json: boolean): ParsedCli {
  return { kind: "error", code, message, json };
}

function isScope(value: string): value is Scope {
  return value === "project" || value === "global";
}

function isTarget(value: string): value is PlanTarget {
  return value === "mcp" || value === "skill" || value === "both";
}

/**
 * Pure argument parser. Unknown or malformed input always becomes an error.
 * `setup` always defaults to MCP + Skill. With `interactive`, missing Agent or
 * Scope selections are left unset so `runCommand` can prompt; otherwise they
 * become explicit errors.
 */
export function parseCli(args: string[], parseOptions: ParseOptions = {}): ParsedCli {
  const interactive = parseOptions.interactive === true;
  const options: CliOptions = { dryRun: false, yes: false, json: false, help: false, version: false, localDev: false, interactive: false, hosts: [], removeSkill: false };
  const positionals: string[] = [];
  const hostList: string[] = [];
  let sawToken = false;
  let sawScope = false;

  for (let index = 0; index < args.length; index += 1) {
    const token = args[index] ?? "";
    if (token === "--") {
      positionals.push(...args.slice(index + 1));
      break;
    }
    if (token.startsWith("--")) {
      sawToken = true;
      const equals = token.indexOf("=");
      const name = equals >= 0 ? token.slice(0, equals) : token;
      const inline = equals >= 0 ? token.slice(equals + 1) : undefined;
      const takeValue = (): { value?: string; error?: ParsedCli } => {
        if (inline !== undefined) {
          if (inline === "") return { error: errorResult("missing_value", `${name} requires a value.`, options.json) };
          return { value: inline };
        }
        const next = args[index + 1];
        if (next === undefined) return { error: errorResult("missing_value", `${name} requires a value.`, options.json) };
        index += 1;
        return { value: next };
      };
      if (name === "--help") {
        options.help = true;
      } else if (name === "--version") {
        options.version = true;
      } else if (name === "--dry-run") {
        options.dryRun = true;
      } else if (name === "--local-dev") {
        options.localDev = true;
      } else if (name === "--npm-prefix") {
        const taken = takeValue();
        if (taken.error) return taken.error;
        if (taken.value !== undefined) options.npmPrefix = taken.value;
      } else if (name === "--require-mcp") {
        options.requireMcp = true;
      } else if (name === "--probe") {
        options.probe = true;
      } else if (name === "--interactive") {
        options.interactive = true;
      } else if (name === "--yes") {
        options.yes = true;
      } else if (name === "--remove-skill") {
        options.removeSkill = true;
      } else if (name === "--json") {
        options.json = true;
      } else if (name === "--host") {
        const taken = takeValue();
        if (taken.error) return taken.error;
        if (!taken.value || !isHostId(taken.value)) return errorResult("invalid_value", `Unknown --host value: ${taken.value ?? ""}. Expected one of ${KNOWN_HOST_IDS.join(", ")}.`, options.json);
        hostList.push(taken.value);
      } else if (name === "--scope") {
        if (sawScope) return errorResult("duplicate_scope", "--scope may be specified only once.", options.json);
        const taken = takeValue();
        if (taken.error) return taken.error;
        if (!taken.value || !isScope(taken.value)) return errorResult("invalid_value", `Unknown --scope value: ${taken.value ?? ""}. Expected project or global.`, options.json);
        options.scope = taken.value;
        sawScope = true;
      } else if (name === "--target") {
        const taken = takeValue();
        if (taken.error) return taken.error;
        if (!taken.value || !isTarget(taken.value)) return errorResult("invalid_value", `Unknown --target value: ${taken.value ?? ""}. Expected mcp, skill, or both.`, options.json);
        options.target = taken.value;
      } else {
        return errorResult("unknown_flag", `Unknown option: ${name}`, options.json);
      }
      continue;
    }
    if (token === "-h") {
      options.help = true;
      sawToken = true;
      continue;
    }
    if (token === "-y") {
      options.yes = true;
      sawToken = true;
      continue;
    }
    if (token === "-i") {
      options.interactive = true;
      sawToken = true;
      continue;
    }
    if (token.startsWith("-") && token.length > 1) {
      return errorResult("unknown_flag", `Unknown option: ${token}`, options.json);
    }
    positionals.push(token);
    sawToken = true;
  }

  // Repeated `--host` flags dedupe while keeping the first-seen order, so a
  // single `--host` behaves exactly as before (`options.host` stays the first
  // selection and the only one when there is one).
  options.hosts = [...new Set(hostList)];
  const firstHost = hostList[0];
  if (firstHost !== undefined) options.host = firstHost;

  if (options.help) {
    const topic = positionals.length > 0 ? positionals.join(" ") : null;
    return { kind: "help", topic };
  }
  if (options.version) {
    if (positionals.length > 0) return errorResult("unexpected_arguments", `--version does not accept a command: ${positionals.join(" ")}`, options.json);
    return { kind: "version" };
  }
  if (positionals.length === 0) {
    if (!sawToken) return { kind: "help", topic: null };
    return errorResult("missing_command", "No command was provided. Run with --help to see the available commands.", options.json);
  }

  const [first, second, ...rest] = positionals;
  const unknown = (): ParsedCli => errorResult("unknown_command", `Unknown command: ${positionals.join(" ")}`, options.json);

  if (options.probe && first !== "doctor") return errorResult("unexpected_option", "--probe is only valid for doctor.", options.json);
  if (options.removeSkill && first !== "uninstall") return errorResult("unexpected_option", "--remove-skill is only valid for uninstall.", options.json);
  if (options.requireMcp && (first === "doctor" || first === "remove" || first === "uninstall" || first === "mcp")) return errorResult("unexpected_option", "--require-mcp is only valid when installing/updating an MCP entry.", options.json);
  if (options.npmPrefix !== undefined && (first === "mcp" || first === "uninstall" || (first === "add" && second === "skill"))) return errorResult("unexpected_option", "--npm-prefix applies only to MCP installation/update or doctor.", options.json);
  if (first === "mcp") {
    if (second === "serve" && rest.length === 0) return { kind: "serve" };
    return unknown();
  }
  if (first === "add" || first === "remove") {
    if (rest.length > 0) return unknown();
    if (second !== "mcp" && second !== "skill") return unknown();
    if (options.target !== undefined) return errorResult("unexpected_option", `--target is only valid for setup.`, options.json);
    // add/remove are single-target commands; repeated --host belongs to
    // setup, update, and uninstall.
    if (options.hosts.length > 1) return errorResult("too_many_hosts", `${first} ${second} accepts a single --host per run; setup, update, and uninstall repeat --host for multiple hosts.`, options.json);
    // Interactive MCP removal selects Agent/Scope before plan confirmation.
    // Parameter-only removal still requires explicit targets.
    if (!interactive || (first === "remove" && second === "skill")) {
      if (second === "mcp") {
        if (options.host === undefined) return errorResult("missing_host", `${first} mcp requires an explicit --host ${KNOWN_HOST_IDS.join("|")}.`, options.json);
        if (options.scope === undefined) return errorResult("missing_scope", `${first} mcp requires an explicit --scope project|global.`, options.json);
      } else {
        if (options.scope === undefined) return errorResult("missing_scope", `${first} skill requires an explicit --scope project|global.`, options.json);
        if (first === "add" && options.host === undefined) return errorResult("missing_host", `add skill requires an explicit --host ${KNOWN_HOST_IDS.join("|")} to select the Skill Agent.`, options.json);
      }
    }
    return { kind: "command", operation: first, target: second, options };
  }
  if (first === "uninstall") {
    if (second !== undefined) return unknown();
    if (options.target !== undefined) return errorResult("unexpected_option", `--target is only valid for setup.`, options.json);
    // `uninstall` removes the managed MCP entry for each selected host; the
    // shared Skill is retained. Selections mirror `remove mcp`: required
    // explicitly without a TTY, prompted when an interaction exists.
    if (!interactive) {
      if (options.host === undefined) return errorResult("missing_host", `uninstall requires an explicit --host ${KNOWN_HOST_IDS.join("|")}.`, options.json);
      if (options.scope === undefined) return errorResult("missing_scope", "uninstall requires an explicit --scope project|global.", options.json);
    }
    return { kind: "command", operation: "uninstall", target: "mcp", options };
  }
  if (first === "setup") {
    if (second !== undefined) return unknown();
    // `setup` is always the unified MCP + Skill plan; `--target` is only an
    // explicit override. A missing --target is never an error.
    const effectiveTarget = options.target ?? "both";
    if (!interactive) {
      if (effectiveTarget !== "skill" && options.host === undefined) {
        return errorResult("missing_host", `setup requires an explicit --host ${KNOWN_HOST_IDS.join("|")}.`, options.json);
      }
      if (options.scope === undefined) return errorResult("missing_scope", "setup requires an explicit --scope project|global.", options.json);
    }
    return { kind: "command", operation: "setup", target: effectiveTarget, options };
  }
  if (first === "update") {
    if (second !== undefined) return unknown();
    // Unified in-place update always inspects both installed components.
    // Component selection is intentionally not offered.
    if (options.target !== undefined) {
      return errorResult(
        "unexpected_option",
        "update does not accept --target; it always inspects both MCP and Skill. Use setup --target <mcp|skill|both> to select components.",
        options.json,
      );
    }
    const effectiveTarget: PlanTarget = "both";
    if (!interactive) {
      if (options.host === undefined) {
        return errorResult("missing_host", `update requires an explicit --host ${KNOWN_HOST_IDS.join("|")}.`, options.json);
      }
      if (options.scope === undefined) return errorResult("missing_scope", "update requires an explicit --scope project|global.", options.json);
    }
    return { kind: "command", operation: "update", target: effectiveTarget, options };
  }
  if (first === "doctor") {
    if (second !== undefined) return unknown();
    if (options.target !== undefined) return errorResult("unexpected_option", "--target is only valid for setup.", options.json);
    return { kind: "command", operation: "doctor", target: "both", options };
  }
  return unknown();
}

function parsedJson(parsed: ParsedCli): boolean {
  if (parsed.kind === "error") return parsed.json;
  if (parsed.kind === "command") return parsed.options.json;
  return false;
}

function printError(io: CliIo, code: string, message: string, json: boolean, color = false): void {
  if (json) {
    io.stdout(`${JSON.stringify({ error: { code, message } }, null, 2)}\n`);
  } else {
    io.stderr(`${highlight(`Error: ${message}`, "red", color)}\n`);
    io.stderr(`Run ${PRODUCT_NAME} --help for usage.\n`);
  }
}

/**
 * Default read-only release-tag preflight: an exact `git ls-remote` lookup of
 * `refs/tags/<tag>` against the fixed GitHub repository. It never queries npm
 * and never fetches or mutates anything.
 */
function defaultReleaseTagPreflight(spawn: SpawnFunction, env: NodeJS.ProcessEnv): ReleaseTagPreflight {
  return async (tag) => {
    const result = await spawn("git", ["ls-remote", SKILL_REPOSITORY, `refs/tags/${tag}`], { timeoutMs: 15_000, env });
    if (result.error) return { ok: false, message: `Release tag preflight could not run: ${result.error}` };
    if (result.code !== 0) return { ok: false, message: `Release tag preflight exited with code ${result.code ?? "unknown"}.` };
    const refs = result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim().split(/\s+/)[1])
      .filter((ref): ref is string => typeof ref === "string" && ref.length > 0);
    return refs.includes(`refs/tags/${tag}`)
      ? { ok: true }
      : { ok: false, message: `The exact release tag refs/tags/${tag} was not found on GitHub; refusing to update and never falling back to main.` };
  };
}

function ensureDeps(deps: Partial<CliDeps> | undefined): CliDeps {
  if (!deps || !deps.io || !deps.adapters || !deps.skillInstaller || !deps.spawn || !deps.now || !deps.packageRoot || !deps.packageVersion) {
    throw new Error("runCli requires fully specified dependencies (io, adapters, skillInstaller, spawn, now, packageRoot, packageVersion).");
  }
  const env = deps.env ?? process.env;
  return {
    ...deps,
    env,
    cwd: deps.cwd ?? process.cwd(),
    home: deps.home ?? "",
    platform: deps.platform ?? process.platform,
    releaseTagPreflight: deps.releaseTagPreflight ?? defaultReleaseTagPreflight(deps.spawn, env),
  } as CliDeps;
}

/**
 * Compute the roots the executor may touch. This mirrors the non-interactive
 * path: host env overrides are explicit roots, and the documented
 * `XDG_STATE_HOME` global Skill lock override is an explicit root as well.
 * Any Skill target outside these roots fails closed in the executor.
 */
function executionRoots(deps: CliDeps, host: string | undefined, scope: Scope | undefined, target: PlanTarget, context: HostContext): string[] {
  const baseRoots = deps.roots ?? [deps.home, deps.cwd];
  const extra: string[] = [];
  const selectionAdapter = host !== undefined ? findAdapter(deps.adapters, host) : undefined;
  if (selectionAdapter && scope !== undefined) extra.push(...selectionAdapter.additionalRoots(context, scope));
  if ((target === "skill" || target === "both") && scope !== undefined) {
    extra.push(...skillCliAdditionalRoots({ scope, env: deps.env }));
  }
  return [...baseRoots, ...extra];
}

const INTERACTIVE_HOSTS: readonly InteractionChoice<string>[] = KNOWN_HOST_IDS.map((id) => ({ value: id, label: id }));

const INTERACTIVE_SCOPES: readonly InteractionChoice<Scope>[] = [
  { value: "project", label: "project" },
  { value: "global", label: "global" },
];

/** The streamlined path used by setup, update, and uninstall. */
async function runUnifiedCommand(parsed: Extract<ParsedCli, { kind: "command" }>, deps: CliDeps): Promise<CliAction> {
  const { operation, target, options } = parsed;
  const context: HostContext = { home: deps.home, cwd: deps.cwd, platform: deps.platform, env: deps.env };
  const interaction = options.json ? undefined : deps.interaction;
  const cancelled = (): CliAction => ({ kind: "exit", code: 0 });
  const fail = (code: string, message: string): CliAction => {
    printError(deps.io, code, message, options.json, deps.color);
    return { kind: "exit", code: 1 };
  };

  let hosts = [...options.hosts];
  if (hosts.length === 0) {
    if (!interaction) return fail("missing_host", `${operation} requires an explicit --host ${KNOWN_HOST_IDS.join("|")}.`);
    // The production interaction supports multi-select. The select fallback
    // keeps injected legacy interactions usable by existing callers.
    if (typeof interaction.multiSelect === "function") {
      const selected = await interaction.multiSelect("Platforms", INTERACTIVE_HOSTS, ["codex"]);
      if (selected === null) return cancelled();
      hosts = [...selected];
    } else {
      const selected = await interaction.select("Platform", INTERACTIVE_HOSTS, "codex");
      if (selected === null) return cancelled();
      hosts = [selected];
    }
  }
  hosts = [...new Set(hosts)];
  if (hosts.length === 0) return fail("missing_host", "Select at least one platform.");

  let scope = options.scope;
  if (!scope) {
    if (!interaction) return fail("missing_scope", `${operation} requires an explicit --scope project|global.`);
    const selected = await interaction.select("Scope", INTERACTIVE_SCOPES, "project");
    if (selected === null) return cancelled();
    scope = selected;
  }
  if (options.requireMcp && (target === "skill" || hosts.some((host) => host !== "codex"))) {
    return fail("unsupported_readiness", "--require-mcp requires a Codex MCP target.");
  }

  const { launch, mode: launchMode } = resolveLaunchSpec({
    packageRoot: deps.packageRoot,
    packageVersion: deps.packageVersion,
    env: deps.env,
    ...(deps.launchMode !== undefined ? { mode: deps.launchMode } : {}),
    ...(options.npmPrefix !== undefined ? { npmPrefix: options.npmPrefix } : {}),
    ...(options.requireMcp ? { requireReady: true } : {}),
  });

  // A Skill is shared within one scope. It is planned once and, when
  // installed, one Skills CLI invocation receives every selected agent.
  const dependencies = {
    adapters: deps.adapters,
    skillInstaller: deps.skillInstaller,
    context,
    now: deps.now,
    packageVersion: deps.packageVersion,
    packageRoot: deps.packageRoot,
    launch,
    launchMode,
    localDev: options.localDev,
    ...(deps.releaseTagPreflight !== undefined ? { releaseTagPreflight: deps.releaseTagPreflight } : {}),
  };
  const mcpPlans: Array<{ host: string; plan: InstallPlan }> = [];
  if (target !== "skill") {
    for (const host of hosts) {
      const plan = await generatePlan({ operation, target: "mcp", host, scope, dryRun: options.dryRun }, dependencies);
      mcpPlans.push({ host, plan });
    }
  }
  let skillPlan: InstallPlan | undefined;
  if (operation !== "uninstall" && target !== "mcp") {
    skillPlan = await generatePlan({ operation, target: "skill", ...(hosts[0] !== undefined ? { host: hosts[0] } : {}), scope, dryRun: options.dryRun }, dependencies);
    if (skillPlan.skillCli) skillPlan.skillCli.args = appendSkillCliAgents(skillPlan.skillCli.args, hosts.slice(1));
  }

  let removeSkill = options.removeSkill;
  let referencedBy: string[] = [];
  if (operation === "uninstall") {
    if (interaction || options.removeSkill) {
      for (const adapter of deps.adapters) {
        if (hosts.includes(adapter.id)) continue;
        try {
          const checks = await adapter.doctorChecks(context, scope, launch);
          if (checks.some((check) => check.host && check.host.managedState !== "absent")) referencedBy.push(adapter.displayName);
        } catch {
          // A best-effort reference check must never prevent MCP removal.
          // The shared-use warning remains visible even when a host cannot
          // be inspected.
        }
      }
    }
    if (interaction && !options.removeSkill) {
      const note = referencedBy.length ? ` ${referencedBy.join(", ")} still has this MCP.` : "";
      removeSkill = await interaction.confirm(`Remove shared pi-delegate Skill? Other tools may use it.${note}`, false);
    }
  }
  const skillRemoval: SkillRemovalPlan | undefined = removeSkill && operation === "uninstall"
    ? await planSkillRemoval({ scope, context })
    : undefined;

  if (options.removeSkill && !options.json && !options.dryRun) {
    const remaining = referencedBy.length ? ` Known remaining platforms: ${referencedBy.join(", ")}.` : "";
    deps.io.stdout(`Removing the shared Skill may affect other tools.${remaining}\n`);
  }

  if (options.dryRun) {
    if (options.json) {
      deps.io.stdout(`${JSON.stringify({ schema: "pi-task-exec.multi.v1", operation, target, scope, hosts,
        mcp: mcpPlans.map(({ host, plan }) => ({ host, plan: serializePlan(plan) })),
        skill: skillPlan ? serializePlan(skillPlan) : null,
        skillRemoval: skillRemoval ?? null, referencedBy }, null, 2)}\n`);
    } else {
      for (const { plan } of mcpPlans) deps.io.stdout(`${formatPlan(plan, deps.color)}\n`);
      if (skillPlan) deps.io.stdout(`${formatPlan(skillPlan, deps.color)}\n`);
      if (skillRemoval) deps.io.stdout(`\nShared Skill: ${skillRemoval.kind} · ${skillRemoval.installDir}\n`);
    }
    return { kind: "exit", code: mcpPlans.some(({ plan }) => plan.conflicts.length || plan.unsupported.length) ||
      Boolean(skillPlan && (skillPlan.conflicts.length || skillPlan.unsupported.length)) || skillRemoval?.kind === "conflict" ? 1 : 0 };
  }

  // The exact release tag and Skill ownership are checked before any update
  // writes. A failed Skill preflight blocks the update rather than leaving
  // MCP and Skill on different versions.
  if (operation === "update" && skillPlan && (skillPlan.conflicts.length || skillPlan.unsupported.length)) {
    const issue = skillPlan.conflicts[0]?.message ?? skillPlan.unsupported[0]?.message ?? "Skill preflight failed.";
    return fail("skill_preflight_failed", issue);
  }

  const mcpResults: Array<{ host: string; plan: InstallPlan; result: Awaited<ReturnType<typeof executePlan>> }> = [];
  for (const { host, plan } of mcpPlans) {
    const result = await executePlan(plan, {
      roots: executionRoots(deps, host, scope, "mcp", context), adapters: deps.adapters,
      io: deps.io, yes: true, now: deps.now,
      ...(deps.backupDir !== undefined ? { backupDir: deps.backupDir } : {}),
    });
    mcpResults.push({ host, plan, result });
  }

  let skillResult: Awaited<ReturnType<typeof executePlan>> | undefined;
  if (skillPlan) {
    const existing = skillPlan.skillCli?.safety.some((item) => item.kind === "existing-skill") === true;
    if (operation === "setup" && existing) {
      const ownership = await planSkillRemoval({ scope, context });
      const current = ownership.kind === "ready" && ownership.metadata.ref === skillPlan.skillCli?.ref;
      skillResult = { status: current ? "no-op" : "conflict", performed: [], removed: [], backups: [], rollback: "none", parts: [],
        errors: current ? [] : [{ code: "skill_already_installed", message: ownership.kind === "conflict"
          ? ownership.conflict.message : "The shared Skill already exists at another version; use update to replace it." }], warnings: [] };
    } else {
      skillResult = await executePlan(skillPlan, {
        roots: executionRoots(deps, hosts[0], scope, "skill", context), adapters: deps.adapters,
        io: deps.io, yes: true, now: deps.now,
        ...(operation === "update" ? { autoManagedSkillUpdate: true } : {}),
        ...(deps.skillSpawn !== undefined ? { skillSpawn: deps.skillSpawn } : {}),
        skillEnv: context.env, skillHome: context.home, skillPackageRoot: deps.packageRoot,
      });
    }
  }

  const removalResult = skillRemoval
    ? await executeSkillRemoval(skillRemoval, { roots: executionRoots(deps, hosts[0], scope, "both", context), now: deps.now })
    : undefined;

  if (options.json) {
    deps.io.stdout(`${JSON.stringify({ schema: "pi-task-exec.multi.v1", operation, target, scope, hosts,
      mcp: mcpResults.map(({ host, plan, result }) => ({ host, plan: serializePlan(plan), result: serializeExecution(result) })),
      skill: skillPlan ? { plan: serializePlan(skillPlan), result: skillResult ? serializeExecution(skillResult) : null } : null,
      skillRemoval: skillRemoval ? { plan: skillRemoval, result: removalResult } : null,
      referencedBy }, null, 2)}\n`);
  } else {
    for (const { host, plan, result } of mcpResults) {
      const issue = result.errors[0]?.message ?? plan.conflicts[0]?.message ?? plan.unsupported[0]?.message;
      const changed = result.performed.length + result.removed.length > 0;
      const action = operation === "uninstall" ? "removed" : operation === "update" ? "updated" : "installed";
      const failed = !["success", "no-op"].includes(result.status);
      deps.io.stdout(`${host}: MCP ${issue ? `failed — ${issue}` : failed ? result.status : changed ? action : "unchanged"}\n`);
    }
    if (skillResult) {
      const issue = skillResult.errors[0]?.message ?? skillPlan?.conflicts[0]?.message ?? skillPlan?.unsupported[0]?.message;
      const failed = !["success", "no-op"].includes(skillResult.status);
      deps.io.stdout(`Skill: ${issue ? `failed — ${issue}` : failed ? skillResult.status : skillResult.performed.length ? operation === "update" ? "updated" : "installed" : "unchanged"}\n`);
      if (failed) for (const backup of skillResult.backups) {
        if (backup.backupPath) deps.io.stdout(`Skill backup: ${backup.backupPath}\n`);
      }
    }
    if (operation === "uninstall") {
      if (skillRemoval) {
        const issue = removalResult?.errors[0]?.message;
        deps.io.stdout(`Skill: ${issue ? `kept — ${issue}` : removalResult?.status === "success" ? "removed" : "already absent"}\n`);
        if (removalResult && !["success", "absent"].includes(removalResult.status)) {
          for (const backup of removalResult.backups) {
            if (backup.backupPath) deps.io.stdout(`Skill backup: ${backup.backupPath}\n`);
          }
          for (const warning of removalResult.warnings) deps.io.stdout(`${warning}\n`);
        }
        if (referencedBy.length && !options.removeSkill) deps.io.stdout(`Other platforms may still use this Skill: ${referencedBy.join(", ")}\n`);
      } else deps.io.stdout("Skill: kept (shared)\n");
    } else if (mcpResults.some(({ result }) => result.performed.length > 0) || (skillResult?.performed.length ?? 0) > 0) {
      const changedHosts = mcpResults.filter(({ result }) => result.performed.length > 0).map(({ host }) => host);
      const restart = skillResult?.performed.length ? hosts : changedHosts;
      deps.io.stdout(`Restart ${restart.join(", ")}, then verify pi_list.\n`);
    }
  }
  const mcpFailed = mcpResults.some(({ result }) => !["success", "no-op"].includes(result.status));
  const skillFailed = skillResult !== undefined && !["success", "no-op"].includes(skillResult.status);
  const removalFailed = removalResult !== undefined && !["success", "absent"].includes(removalResult.status);
  return { kind: "exit", code: mcpFailed || skillFailed || removalFailed ? 1 : 0 };
}

/**
 * Run an add/setup command. When a required Agent/Scope/Target is missing and
 * an injectable interaction is available, arrow-key prompts fill it in;
 * `--json` never prompts and reports the exact missing-selection error instead.
 * Cancellation at any prompt exits 0 with no filesystem changes.
 */
async function runCommand(parsed: Extract<ParsedCli, { kind: "command" }>, deps: CliDeps): Promise<CliAction> {
  const { operation, target: parsedTarget, options } = parsed;
  const context: HostContext = { home: deps.home, cwd: deps.cwd, platform: deps.platform, env: deps.env };

  if (operation === "doctor") {
    const report = await runDoctor({
      adapters: deps.adapters,
      skillInstaller: deps.skillInstaller,
      context,
      spawn: deps.spawn,
      now: deps.now,
      packageRoot: deps.packageRoot,
      packageVersion: deps.packageVersion,
      probe: options.probe === true,
      ...(options.npmPrefix !== undefined ? { npmPrefix: options.npmPrefix } : {}),
    });
    deps.io.stdout(options.json ? `${JSON.stringify(report, null, 2)}\n` : `${formatDoctor(report)}\n`);
    return { kind: "exit", code: report.probe?.status === "fail" ? 1 : 0 };
  }

  const legacyDetailedSingle = (operation === "setup" || operation === "update") &&
    options.hosts.length <= 1 && (options.json || (options.dryRun && options.hosts.length === 1));
  const streamlined = ["uninstall", "setup", "update"].includes(operation) && !legacyDetailedSingle;
  if (streamlined) {
    return runUnifiedCommand(parsed, deps);
  }

  const interaction = deps.interaction;
  const canPrompt = interaction !== undefined && !options.json;
  if (operation === "setup" && canPrompt) deps.io.stdout("Pi TaskExec Setup\n\n");
  if (operation === "update" && canPrompt) deps.io.stdout("Pi TaskExec Update\n\n");
  const cancelled = (): CliAction => {
    deps.io.stdout("Cancelled: no changes were made.\n");
    return { kind: "exit", code: 0 };
  };
  const missing = (code: string, message: string): CliAction => {
    printError(deps.io, code, message, options.json, deps.color);
    return { kind: "exit", code: 1 };
  };

  // `setup` is always unified MCP + Skill; `update` discovers both installed
  // components by default. Only Agent/Scope are prompted.
  const target = parsedTarget;
  let host = options.host;
  let scope = options.scope;
  const hostRequired =
    operation === "add" ||
    operation === "update" ||
    operation === "uninstall" ||
    (operation === "setup" && target !== "skill") ||
    (operation === "remove" && target === "mcp");
  const hostPromptable = hostRequired || operation === "setup";
  if (host === undefined && hostPromptable) {
    if (canPrompt) {
      const chosen = await interaction.select("Which Agent?", INTERACTIVE_HOSTS, "codex");
      if (chosen === null) return cancelled();
      host = chosen;
    } else if (hostRequired) {
      return missing(
        "missing_host",
        operation === "add" && target === "skill"
          ? `add skill requires an explicit --host ${KNOWN_HOST_IDS.join("|")} to select the Skill Agent.`
          : operation === "uninstall"
            ? `uninstall requires an explicit --host ${KNOWN_HOST_IDS.join("|")}.`
            : `${operation} ${target} requires an explicit --host ${KNOWN_HOST_IDS.join("|")}.`,
      );
    }
  }

  // A unified `setup`/`update` keeps its operation; the installer accepts
  // `setup` when an agent is present and `update` for managed replacement.
  const planOperation: PlanOperation = operation;
  if (scope === undefined) {
    if (!canPrompt) {
      return missing("missing_scope", `${operation}${operation === "setup" ? ` --target ${target}` : ""} requires an explicit --scope project|global.`);
    }
    const chosen = await interaction.select("Which scope?", INTERACTIVE_SCOPES, "project");
    if (chosen === null) return cancelled();
    scope = chosen;
  }

  if (options.requireMcp && (host !== "codex" || target === "skill")) {
    return missing("unsupported_readiness", "--require-mcp requires a Codex MCP target; other Hosts use their own native readiness policy.");
  }
  const { launch, mode: launchMode } = resolveLaunchSpec({
    packageRoot: deps.packageRoot,
    packageVersion: deps.packageVersion,
    env: deps.env,
    ...(deps.launchMode !== undefined ? { mode: deps.launchMode } : {}),
    ...(options.npmPrefix !== undefined ? { npmPrefix: options.npmPrefix } : {}),
    ...(options.requireMcp ? { requireReady: true } : {}),
  });

  const plan = await generatePlan(
    {
      operation: planOperation,
      target,
      ...(host !== undefined ? { host } : {}),
      ...(scope !== undefined ? { scope } : {}),
      dryRun: options.dryRun,
    },
    {
      adapters: deps.adapters,
      skillInstaller: deps.skillInstaller,
      context,
      now: deps.now,
      packageVersion: deps.packageVersion,
      packageRoot: deps.packageRoot,
      launch,
      launchMode,
      localDev: options.localDev,
      ...(deps.releaseTagPreflight !== undefined ? { releaseTagPreflight: deps.releaseTagPreflight } : {}),
    },
  );

  if (options.requireMcp) plan.warnings.push({ code: "required_mcp", message: "Codex will wait for this MCP. If initialization fails, Host startup/resume fails too. Other MCP entries are unaffected." });
  if (options.npmPrefix) plan.warnings.push({ code: "npm_resolution_prefix", message: `npm package resolution uses ${options.npmPrefix}; MCP cwd is unchanged. This directory must exist on every machine using this configuration.` });
  // The plan is always printed before confirmation or any write.
  deps.io.stdout(options.json ? `${planJson(plan)}\n` : `${formatPlan(plan, deps.color)}\n`);

  const roots = executionRoots(deps, host, scope, target, context);
  const confirm = interaction !== undefined && !options.json
    ? async (confirmPlan: import("../plan/model.js").InstallPlan, safety?: SafetyConfirmation): Promise<boolean> => {
        if (safety) deps.io.stdout(`${safety.message}\n`);
        return interaction.confirm(safety ? "Replace the listed path(s)?" : "Proceed with this plan?", false);
      }
    : deps.confirm;

  const result = await executePlan(plan, {
    roots,
    adapters: deps.adapters,
    io: deps.io,
    yes: options.yes,
    ...(deps.backupDir !== undefined ? { backupDir: deps.backupDir } : {}),
    ...(confirm !== undefined ? { confirm } : {}),
    now: deps.now,
    ...(deps.skillSpawn !== undefined ? { skillSpawn: deps.skillSpawn } : {}),
    skillEnv: context.env,
    skillHome: context.home,
    skillPackageRoot: deps.packageRoot,
  });

  const execution = serializeExecution(result);
  if (target !== "skill" && operation !== "remove" && operation !== "uninstall") execution.mcpVerification = { connection: "not-tested", hostToolExposure: "not-tested" };
  deps.io.stdout(options.json ? `${JSON.stringify(execution, null, 2)}\n` : `${formatExecution(result, deps.color)}\n`);
  if (!options.json && target !== "skill" && operation !== "remove" && ["success", "partial"].includes(result.status) && (result.parts.length ? result.parts.some((part) => part.target === "mcp" && part.performed.length > 0) : result.performed.length > 0)) {
    deps.io.stdout(`Restart ${plan.hostTarget?.displayName ?? host}, then verify pi_list there.\n`);
  }
  if (result.status === "cancelled" && canPrompt) return { kind: "exit", code: 0 };
  const code = result.status === "success" || result.status === "no-op" || result.status === "dry-run" ? 0 : 1;
  return { kind: "exit", code };
}

export async function runCli(args: string[], depsInput?: Partial<CliDeps>): Promise<CliAction> {
  const interactive = depsInput?.interaction !== undefined || args.includes("--interactive") || args.includes("-i");
  const parsed = parseCli(args, { interactive });
  try {
    const deps = ensureDeps(depsInput);
    switch (parsed.kind) {
      case "error":
        printError(deps.io, parsed.code, parsed.message, parsed.json, deps.color);
        return { kind: "exit", code: 1 };
      case "help":
        deps.io.stdout(`${parsed.topic ? commandHelp(parsed.topic) : helpText()}\n`);
        return { kind: "exit", code: 0 };
      case "version":
        deps.io.stdout(`${deps.packageVersion}\n`);
        return { kind: "exit", code: 0 };
      case "serve":
        return { kind: "serve" };
      case "command":
        return await runCommand(parsed, deps);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : "internal_error";
    const io = depsInput?.io ?? defaultIo;
    printError(io, code, message, parsedJson(parsed), depsInput?.color);
    return { kind: "exit", code: 1 };
  }
}
