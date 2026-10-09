import type { HostAdapter } from "../hosts/adapters.js";
import { KNOWN_HOST_IDS, findAdapter, isHostId } from "../hosts/adapters.js";
import type { SpawnFunction } from "./doctor.js";
import { formatDoctor, runDoctor } from "./doctor.js";
import { PACKAGE_NAME, PRODUCT_NAME, VERSION } from "../identity.js";
import { defaultIo, type CliIo } from "../io.js";
import {
  formatPlan,
  generatePlan,
  planJson,
  resolveLaunchSpec,
  type HostContext,
  type LaunchMode,
  type PlanOperation,
  type PlanTarget,
  type ReleaseTagPreflight,
  type Scope,
} from "../plan/model.js";
import type { SkillInstaller } from "../installers/skill.js";
import { SKILL_REPOSITORY, skillCliAdditionalRoots, type SkillsCliSpawn } from "../installers/skills-cli.js";
import type { Interaction, InteractionChoice } from "../interactive.js";
import { executePlan, formatExecution, serializeExecution, type SafetyConfirmation } from "../plan/executor.js";

export { PACKAGE_NAME, PRODUCT_NAME, VERSION } from "../identity.js";
export type { CliIo } from "../io.js";

export interface CliOptions {
  host?: string;
  scope?: Scope;
  target?: PlanTarget;
  dryRun: boolean;
  yes: boolean;
  json: boolean;
  help: boolean;
  version: boolean;
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
  ${PRODUCT_NAME} doctor             Read-only environment, host, skill, and version check

Options:
  --help                             Show help and exit
  --version                          Print only the package version and exit
  --dry-run                          Print the plan and exit without writing
  --local-dev                        Explicitly allow installing an absolute source-checkout path (checkout mode only)
  --json                             Print stable machine-readable JSON (missing selections fail without prompting)
  --yes                              Skip confirmation only after the plan is printed
  --interactive, -i                  Force prompting for missing selections (requires a TTY)
  --host <${KNOWN_HOST_IDS.join("|")}>
  --scope <project|global>
  --target <mcp|skill|both>          (setup only; update always inspects both)

Hosts: ${KNOWN_HOST_IDS.join(", ")}. Scopes: project, global.
No arguments prints this help and never starts MCP.
MCP stdio launch: npx -y ${PACKAGE_NAME}@${VERSION} mcp serve`;

function commandHelp(topic: string): string {
  switch (topic) {
    case "mcp serve":
      return `Usage:\n  ${PRODUCT_NAME} mcp serve\n\nStart the MCP stdio runtime. This is the only server-start command and the Registry launch contract.`;
    case "add mcp":
      return `Usage:\n  ${PRODUCT_NAME} add mcp [--host <${KNOWN_HOST_IDS.join("|")}>] [--scope <project|global>] [--dry-run] [--json] [--yes]\n\nPlan and install the pi-task-exec MCP entry. Host-specific paths and formats (Codex TOML, Zed/OpenCode JSONC) are merged safely; unrelated configuration is preserved and conflicts stop the whole operation. On a TTY a missing --host/--scope is prompted; --json fails instead of prompting.`;
    case "add skill":
      return `Usage:\n  ${PRODUCT_NAME} add skill [--host <${KNOWN_HOST_IDS.join("|")}>] [--scope <project|global>] [--dry-run] [--json] [--yes]\n\nPlan and install the bundled pi-delegate Skill through the pinned Vercel Skills CLI v1.7.1 from the fixed GitHub source. --host selects the Skill Agent (prompted on a TTY when omitted). The plan is printed, existing paths require a default-No confirmation, and the real result (files, pinned source/ref, lockfile) is verified.`;
    case "remove mcp":
      return `Usage:\n  ${PRODUCT_NAME} remove mcp --host <${KNOWN_HOST_IDS.join("|")}> --scope <project|global> [--dry-run] [--json] [--yes]\n\nPlan and remove the pi-task-exec MCP entry for an explicit host and scope. Only an entry created by pi-task-exec (managed fingerprint) is removed; user entries are left untouched.`;
    case "remove skill":
      return `Usage:\n  ${PRODUCT_NAME} remove skill --scope <project|global> [--dry-run] [--json] [--yes]\n\nPlan and (when available) remove the managed pi-delegate skill.`;
    case "setup":
      return `Usage:\n  ${PRODUCT_NAME} setup [--target <mcp|skill|both>] [--host <${KNOWN_HOST_IDS.join("|")}>] [--scope <project|global>] [--dry-run] [--json] [--yes]\n\nPlan the unified MCP + Skill setup in one plan (--target is an explicit override). On a TTY a missing Agent/Scope is prompted; --json fails instead of prompting. The MCP write and Skills CLI install run independently and report partial success.`;
    case "update":
      return `Usage:\n  ${PRODUCT_NAME} update [--host <${KNOWN_HOST_IDS.join("|")}>] [--scope <project|global>] [--dry-run] [--json] [--yes]\n\nAlways inspect both installed components (MCP and Skill); there is no component-selection override. Only a provably managed MCP entry and a lockfile-owned Skill are updated; absent components are never installed and point you at setup. On a TTY a missing Agent/Scope is prompted; --json fails instead of prompting. In release mode the exact v<packageVersion> GitHub tag is preflighted before a Skill update and before any MCP write in the same plan.`;
    case "doctor":
      return `Usage:\n  ${PRODUCT_NAME} doctor [--json]\n\nRead-only check of Node, Pi, Git, package/platform/version contract, host adapter capability, and skill target status. Never prints config secrets or file contents.`;
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
  const options: CliOptions = { dryRun: false, yes: false, json: false, help: false, version: false, localDev: false, interactive: false };
  const positionals: string[] = [];
  let sawToken = false;

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
      } else if (name === "--interactive") {
        options.interactive = true;
      } else if (name === "--yes") {
        options.yes = true;
      } else if (name === "--json") {
        options.json = true;
      } else if (name === "--host") {
        const taken = takeValue();
        if (taken.error) return taken.error;
        if (!taken.value || !isHostId(taken.value)) return errorResult("invalid_value", `Unknown --host value: ${taken.value ?? ""}. Expected one of ${KNOWN_HOST_IDS.join(", ")}.`, options.json);
        options.host = taken.value;
      } else if (name === "--scope") {
        const taken = takeValue();
        if (taken.error) return taken.error;
        if (!taken.value || !isScope(taken.value)) return errorResult("invalid_value", `Unknown --scope value: ${taken.value ?? ""}. Expected project or global.`, options.json);
        options.scope = taken.value;
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

  if (first === "mcp") {
    if (second === "serve" && rest.length === 0) return { kind: "serve" };
    return unknown();
  }
  if (first === "add" || first === "remove") {
    if (rest.length > 0) return unknown();
    if (second !== "mcp" && second !== "skill") return unknown();
    if (options.target !== undefined) return errorResult("unexpected_option", `--target is only valid for setup.`, options.json);
    // `remove` is never prompted, and the non-interactive mode keeps the exact
    // missing-selection errors. `add mcp`/`add skill` leave them unset so the
    // runtime can prompt for Agent/Scope.
    if (first === "remove" || !interactive) {
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

function printError(io: CliIo, code: string, message: string, json: boolean): void {
  if (json) {
    io.stdout(`${JSON.stringify({ error: { code, message } }, null, 2)}\n`);
  } else {
    io.stderr(`${message}\n`);
    io.stderr(`${helpText()}\n`);
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
    });
    deps.io.stdout(options.json ? `${JSON.stringify(report, null, 2)}\n` : `${formatDoctor(report)}\n`);
    return { kind: "exit", code: 0 };
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
    printError(deps.io, code, message, options.json);
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

  const { launch, mode: launchMode } = resolveLaunchSpec({
    packageRoot: deps.packageRoot,
    packageVersion: deps.packageVersion,
    env: deps.env,
    ...(deps.launchMode !== undefined ? { mode: deps.launchMode } : {}),
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

  // The plan is always printed before confirmation or any write.
  deps.io.stdout(options.json ? `${planJson(plan)}\n` : `${formatPlan(plan)}\n`);

  const roots = executionRoots(deps, host, scope, target, context);
  const confirm = interaction !== undefined
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

  deps.io.stdout(options.json ? `${JSON.stringify(serializeExecution(result), null, 2)}\n` : `${formatExecution(result)}\n`);
  if (result.status === "cancelled" && interaction !== undefined) return cancelled();
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
        printError(deps.io, parsed.code, parsed.message, parsed.json);
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
    printError(io, code, message, parsedJson(parsed));
    return { kind: "exit", code: 1 };
  }
}
