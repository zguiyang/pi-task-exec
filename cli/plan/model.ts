import { existsSync } from "node:fs";
import { join } from "node:path";
import type { HostAdapter, HostId, HostTarget, McpLaunchSpec, McpPlanInput } from "../hosts/adapters.js";
import type { SkillCliPlan, SkillInstaller } from "../installers/skill.js";
import { PACKAGE_NAME, SKILL_NAME } from "../identity.js";
import { sha256 } from "./safety.js";

export const PLAN_SCHEMA = "pi-task-exec.plan.v1";
export const MANAGED_BY = "pi-task-exec";

export type PlanOperation = "add" | "remove" | "setup" | "update" | "doctor";
export type PlanTarget = "mcp" | "skill" | "both";
export type Scope = "project" | "global";

export interface HostContext {
  home: string;
  cwd: string;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
}

export interface PlanWarning {
  code: string;
  message: string;
}

export interface UnsupportedCapability {
  code: string;
  message: string;
  target: "mcp" | "skill";
  host?: string;
  scope?: Scope;
}

export interface PlanConflict {
  code: string;
  message: string;
  path: string;
}

export interface PlanBackup {
  path: string;
  /**
   * Stable, truthful description of where the executor will write the backup
   * at run time. It is a sibling pattern, not a fixed file: the executor adds
   * a timestamp and a collision suffix, so two runs never clobber a backup.
   */
  backupPath: string;
  /** Machine-readable backup strategy shared with the executor. */
  strategy: string;
  reason: string;
}

/** Internal write instruction. `content` is never serialized. */
export interface PlannedWrite {
  path: string;
  kind: "create" | "update";
  target: "mcp" | "skill";
  host?: string;
  content: string;
  /** Hash of the pre-existing content, or null when the file did not exist. */
  baseSha256: string | null;
  summary: string;
  mode?: number;
}

export interface PlannedRemoval {
  path: string;
  target: "mcp" | "skill";
  host?: string;
  managedBy: string;
  sha256: string;
  summary: string;
}

export interface ResolvedPaths {
  config?: string;
  skillDir?: string;
}

/**
 * Side-effect-free preview of one discovered component for an `update` plan.
 * It carries the current and target version/ref so the operator can see
 * exactly what will change before any write. File contents are never included.
 */
export interface UpdateComponentPreview {
  target: "mcp" | "skill";
  /** `update` writes, `no-op` is already at target, `absent` is not installed. */
  state: "update" | "no-op" | "absent";
  /** Managed config key for MCP, or the skill name. */
  key?: string;
  /** Absolute config path (MCP) or absolute skill directory (Skill). */
  path?: string;
  /** Installed version token/ref, when discovered and provably managed. */
  current?: string;
  /** Target version token/ref this run converges to. */
  desired?: string;
  /** Whether replacing the existing Skill directory may discard local edits. */
  lossWarning?: boolean;
}

/**
 * Read-only release-tag check injected into update planning. The default uses
 * `git ls-remote` against the fixed GitHub repository; tests inject a stub.
 */
export type ReleaseTagPreflight = (tag: string) => Promise<{ ok: boolean; message?: string }>;

export interface InstallPlan {
  schema: typeof PLAN_SCHEMA;
  operation: PlanOperation;
  target: PlanTarget;
  host?: string;
  scope?: Scope;
  dryRun: boolean;
  createdAt: string;
  launchMode: LaunchMode;
  resolvedPaths: ResolvedPaths;
  hostTarget?: HostTarget;
  creates: PlannedWrite[];
  updates: PlannedWrite[];
  removals: PlannedRemoval[];
  conflicts: PlanConflict[];
  backups: PlanBackup[];
  warnings: PlanWarning[];
  unsupported: UnsupportedCapability[];
  supported: boolean;
  /** Present for the pinned Skills CLI `add skill` install. */
  skillCli?: SkillCliPlan;
  /** Discovered installed components and their current/target refs for `update`. */
  updatePreview?: UpdateComponentPreview[];
}

export interface PlanRequest {
  operation: PlanOperation;
  target: PlanTarget;
  host?: string;
  scope?: Scope;
  dryRun: boolean;
}

export interface PlanDependencies {
  adapters: readonly HostAdapter[];
  skillInstaller: SkillInstaller;
  context: HostContext;
  now: () => Date;
  packageVersion: string;
  packageRoot: string;
  launch: McpLaunchSpec;
  launchMode: LaunchMode;
  /** Explicit opt-in required before writing a local checkout launch path. */
  localDev: boolean;
  /** Read-only exact release-tag preflight; required for release-mode updates. */
  releaseTagPreflight?: ReleaseTagPreflight;
}

export type LaunchMode = "npm" | "checkout";

/** Production npm install launch contract. */
export function npmLaunchSpec(version: string): McpLaunchSpec {
  return { command: "npx", args: ["-y", `${PACKAGE_NAME}@${version}`, "mcp", "serve"] };
}

/** Source-checkout launch contract: an absolute local path, never an npm package. */
export function checkoutLaunchSpec(packageRoot: string): McpLaunchSpec {
  return { command: "node", args: [join(packageRoot, "dist", "cli", "index.js"), "mcp", "serve"] };
}

function hasGitCheckout(packageRoot: string): boolean {
  try {
    return existsSync(join(packageRoot, ".git"));
  } catch {
    // Treat an unreadable marker as absent rather than guessing.
    return false;
  }
}

/**
 * A real `.git` checkout always reports checkout mode. The env override may
 * only choose checkout when no marker is present; it can never force npm mode
 * while a checkout is detected, so this unpublished version is never written
 * as the published `npx` package. `--local-dev` is the only route to the
 * local `node` launch path.
 */
export function detectLaunchMode(packageRoot: string, env: NodeJS.ProcessEnv): LaunchMode {
  if (hasGitCheckout(packageRoot)) return "checkout";
  const override = env.PI_TASK_EXEC_LAUNCH_MODE;
  if (override === "npm" || override === "checkout") return override;
  return "npm";
}

export function resolveLaunchSpec(input: {
  packageRoot: string;
  packageVersion: string;
  env: NodeJS.ProcessEnv;
  mode?: LaunchMode;
}): { mode: LaunchMode; launch: McpLaunchSpec } {
  const mode = hasGitCheckout(input.packageRoot) ? "checkout" : (input.mode ?? detectLaunchMode(input.packageRoot, input.env));
  return { mode, launch: mode === "checkout" ? checkoutLaunchSpec(input.packageRoot) : npmLaunchSpec(input.packageVersion) };
}

/** @deprecated use {@link npmLaunchSpec}; retained for the stage 7 plan model. */
export function launchSpec(version: string): { command: string; args: string[] } {
  return npmLaunchSpec(version);
}

export function skillTargetDir(scope: Scope, context: HostContext): string {
  return scope === "project"
    ? join(context.cwd, ".agents", "skills", SKILL_NAME)
    : join(context.home, ".agents", "skills", SKILL_NAME);
}

function byPath<T extends { path: string }>(left: T, right: T): number {
  return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
}

function byCode<T extends { code: string }>(left: T, right: T): number {
  return left.code < right.code ? -1 : left.code > right.code ? 1 : 0;
}

/**
 * Stable, secret-free printable projection of a plan. File contents and
 * resolved config bodies are intentionally omitted.
 */
export function serializePlan(plan: InstallPlan): Record<string, unknown> {
  const write = (item: PlannedWrite) => ({
    kind: item.kind,
    target: item.target,
    host: item.host ?? null,
    path: item.path,
    summary: item.summary,
  });
  const removal = (item: PlannedRemoval) => ({
    target: item.target,
    host: item.host ?? null,
    path: item.path,
    managedBy: item.managedBy,
    sha256: item.sha256,
    summary: item.summary,
  });
  return {
    schema: plan.schema,
    operation: plan.operation,
    target: plan.target,
    host: plan.host ?? null,
    scope: plan.scope ?? null,
    dryRun: plan.dryRun,
    createdAt: plan.createdAt,
    launchMode: plan.launchMode,
    supported: plan.supported,
    backupStrategy: plan.backups.length > 0 ? (plan.backups[0]?.strategy ?? "none") : "none",
    hostTarget: plan.hostTarget
      ? {
          host: plan.hostTarget.host,
          displayName: plan.hostTarget.displayName,
          scope: plan.hostTarget.scope,
          platform: plan.hostTarget.platform,
          format: plan.hostTarget.format,
          path: plan.hostTarget.path,
          key: plan.hostTarget.key,
          supported: plan.hostTarget.supported,
          support: plan.hostTarget.support ? { code: plan.hostTarget.support.code, message: plan.hostTarget.support.message } : null,
          requiresRestart: plan.hostTarget.requiresRestart,
          requiresTrust: plan.hostTarget.requiresTrust,
          trustNote: plan.hostTarget.trustNote ?? null,
        }
      : null,
    resolvedPaths: {
      config: plan.resolvedPaths.config ?? null,
      skillDir: plan.resolvedPaths.skillDir ?? null,
    },
    updatePreview: (plan.updatePreview ?? []).map((item) => ({
      target: item.target,
      state: item.state,
      key: item.key ?? null,
      path: item.path ?? null,
      current: item.current ?? null,
      desired: item.desired ?? null,
      lossWarning: item.lossWarning ?? false,
    })),
    creates: [...plan.creates].sort(byPath).map(write),
    updates: [...plan.updates].sort(byPath).map(write),
    removals: [...plan.removals].sort(byPath).map(removal),
    conflicts: [...plan.conflicts].sort(byPath).map((conflict) => ({ code: conflict.code, path: conflict.path, message: conflict.message })),
    backups: [...plan.backups].sort(byPath).map((backup) => ({ path: backup.path, backupPath: backup.backupPath, strategy: backup.strategy, reason: backup.reason })),
    warnings: [...plan.warnings].sort(byCode).map((warning) => ({ code: warning.code, message: warning.message })),
    skillCli: plan.skillCli
      ? {
          installer: plan.skillCli.installer,
          cliVersion: plan.skillCli.cliVersion,
          agent: plan.skillCli.agent,
          scope: plan.skillCli.scope,
          repository: plan.skillCli.repository,
          subpath: plan.skillCli.subpath,
          source: plan.skillCli.source,
          ref: plan.skillCli.ref,
          refKind: plan.skillCli.refKind,
          currentRef: plan.skillCli.currentRef ?? null,
          command: plan.skillCli.command,
          args: [...plan.skillCli.args],
          cwd: plan.skillCli.cwd,
          installDir: plan.skillCli.installDir,
          skillFile: plan.skillCli.skillFile,
          contractFile: plan.skillCli.contractFile,
          lockFile: plan.skillCli.lockFile,
          expectedSource: plan.skillCli.expectedSource,
          expectedRef: plan.skillCli.expectedRef,
          lossWarning: plan.skillCli.lossWarning,
          safety: plan.skillCli.safety.map((item) => ({ path: item.path, kind: item.kind, message: item.message })),
        }
      : null,
    unsupported: [...plan.unsupported].sort(byCode).map((item) => ({
      code: item.code,
      target: item.target,
      host: item.host ?? null,
      scope: item.scope ?? null,
      message: item.message,
    })),
  };
}

export function planJson(plan: InstallPlan): string {
  return JSON.stringify(serializePlan(plan), null, 2);
}

export function formatPlan(plan: InstallPlan): string {
  const lines: string[] = [];
  lines.push(`${plan.schema}`);
  lines.push(`Operation: ${plan.operation}${plan.target === "both" ? " (mcp + skill)" : ` (${plan.target})`}`);
  lines.push(`Host: ${plan.host ?? "n/a"}`);
  lines.push(`Scope: ${plan.scope ?? "n/a"}`);
  lines.push(`Dry run: ${plan.dryRun ? "yes" : "no"}`);
  lines.push(`Launch mode: ${plan.launchMode}`);
  if (plan.hostTarget) {
    const target = plan.hostTarget;
    lines.push(`Host target: ${target.host} (${target.displayName})`);
    lines.push(`Platform: ${target.platform}`);
    lines.push(`Config format: ${target.format}`);
    lines.push(`Config key: ${target.key}`);
    lines.push(`Config path: ${target.path}`);
    lines.push(`Support: ${target.supported ? "supported" : `unsupported (${target.support?.code ?? "unknown"})`}`);
    lines.push(`Restart required: ${target.requiresRestart ? "yes" : "no"}`);
    lines.push(`Trust required: ${target.requiresTrust ? "yes" : "no"}${target.trustNote ? ` — ${target.trustNote}` : ""}`);
  }
  lines.push(`Backup strategy: ${plan.backups.length > 0 ? (plan.backups[0]?.strategy ?? "none") : "none"}`);
  if (plan.resolvedPaths.config) lines.push(`Config path: ${plan.resolvedPaths.config}`);
  if (plan.resolvedPaths.skillDir) lines.push(`Skill path: ${plan.resolvedPaths.skillDir}`);
  if (plan.skillCli) {
    const cli = plan.skillCli;
    lines.push(`Skill installer: ${cli.installer}@${cli.cliVersion}`);
    lines.push(`Skill agent: ${cli.agent}`);
    lines.push(`Skill source: ${cli.repository} (${cli.subpath})`);
    lines.push(`Skill ref: ${cli.ref} (${cli.refKind})`);
    if (cli.currentRef) lines.push(`Skill current ref: ${cli.currentRef}`);
    lines.push(`Skill command: ${cli.command} ${cli.args.join(" ")}`);
    lines.push(`Skill install path: ${cli.installDir}`);
    lines.push(`Skill lock path: ${cli.lockFile}`);
  }
  if (plan.target !== "mcp" && plan.scope) {
    lines.push(
      `Skill scope: ${plan.scope}${
        plan.scope === "global" ? " (shared .agents/skills across projects for this home)" : " (project-local .agents/skills)"
      }`,
    );
  }
  const section = (title: string, entries: string[]) => {
    lines.push(`${title}:`);
    if (entries.length === 0) lines.push("  (none)");
    else for (const entry of entries) lines.push(`  - ${entry}`);
  };
  section("Creates", plan.creates.map((item) => `${item.path} — ${item.summary}`));
  section("Updates", plan.updates.map((item) => `${item.path} — ${item.summary}`));
  section("Removals", plan.removals.map((item) => `${item.path} — ${item.summary}`));
  section("Backups", plan.backups.map((item) => `${item.path} -> ${item.backupPath} (${item.strategy}; ${item.reason})`));
  if ((plan.updatePreview ?? []).length > 0) {
    section(
      "Update",
      (plan.updatePreview ?? []).map((item) => {
        const key = item.key ? ` [${item.key}]` : "";
        const path = item.path ? ` ${item.path}` : "";
        const current = item.current ? ` (current: ${item.current})` : "";
        const desired = item.desired ? ` (target: ${item.desired})` : "";
        const loss = item.lossWarning ? " — existing local changes may be lost" : "";
        return `${item.target}: ${item.state}${key}${path}${current}${desired}${loss}`;
      }),
    );
  }
  section("Conflicts", plan.conflicts.map((item) => `${item.path} — ${item.message}`));
  section("Skill safety", (plan.skillCli?.safety ?? []).map((item) => `${item.path} — ${item.message}`));
  section("Unsupported", plan.unsupported.map((item) => `${item.target}${item.host ? `/${item.host}` : ""} — ${item.message}`));
  section("Warnings", plan.warnings.map((item) => `${item.code} — ${item.message}`));
  return lines.join("\n");
}

/**
 * Backup strategy understood by both the plan renderer and the executor. The
 * executor writes `<basename>.backup-<timestamp>` (plus a `-N` suffix on
 * collision) either next to the file or inside the configured backup dir.
 */
export const BACKUP_STRATEGY = "timestamped-sibling";

/** Stable, truthful sibling pattern the executor will use for a backup. */
function plannedBackupPath(path: string): string {
  return `${path}.backup-<timestamp>`;
}

function desiredLaunchLabel(deps: PlanDependencies): string {
  return deps.launchMode === "checkout" ? (deps.launch.args[0] ?? deps.launch.command) : (deps.launch.args[1] ?? "");
}

/**
 * Update planning for one already-installed MCP entry. It never creates an
 * entry: an absent entry becomes a no-op warning that points at `setup`. A
 * recognized managed entry whose only difference is the pinned npm semver
 * token (or the current checkout launch) is rewritten; anything else conflicts.
 */
function planMcpUpdate(
  plan: InstallPlan,
  request: PlanRequest,
  deps: PlanDependencies,
  adapter: HostAdapter,
  target: HostTarget,
  configPath: string,
  currentContent: string | null,
  input: McpPlanInput,
): void {
  const host = request.host as string;
  const scope = request.scope as Scope;
  const desired = desiredLaunchLabel(deps);
  const result = adapter.planUpdate(input);
  if (result.kind === "unsupported") {
    plan.unsupported.push(result.capability);
    return;
  }
  if (result.kind === "conflict") {
    plan.conflicts.push(result.conflict);
    return;
  }
  if (result.kind === "absent") {
    plan.updatePreview?.push({ target: "mcp", state: "absent", key: target.key, path: configPath, desired });
    plan.warnings.push({
      code: "not_installed",
      message: `No managed pi-task-exec MCP entry exists in ${adapter.displayName} at ${configPath}; run pi-task-exec setup to install it.`,
    });
    return;
  }
  if (result.kind === "no-op") {
    for (const warning of result.warnings) plan.warnings.push(warning);
    plan.updatePreview?.push({ target: "mcp", state: "no-op", key: target.key, path: configPath, current: result.current, desired });
    plan.warnings.push({ code: "already_up_to_date", message: `${adapter.displayName} already has the managed pi-task-exec MCP entry at ${configPath}.` });
    return;
  }
  // The entry is provably managed and differs from the target launch. A
  // checkout target still requires the explicit source-checkout opt-in.
  if (deps.launchMode === "checkout") {
    if (!deps.localDev) {
      plan.conflicts.push({
        code: "local_dev_required",
        path: configPath,
        message:
          "The CLI is running from a source checkout. Writing an absolute local launch path requires explicit opt-in with --local-dev; the published npm package is the default launch entry.",
      });
      return;
    }
    plan.warnings.push({
      code: "local_checkout_launch",
      message: `This entry launches the local checkout at ${deps.launch.args[0] ?? deps.launch.command} with node, not a published npm package. The npm package is not published; re-run from an installed package before sharing this configuration.`,
    });
  }
  for (const warning of result.warnings) plan.warnings.push(warning);
  plan.updates.push({
    path: configPath,
    kind: "update",
    target: "mcp",
    host,
    content: result.content,
    baseSha256: currentContent === null ? null : sha256(currentContent),
    summary: `Update the pi-task-exec MCP entry in ${adapter.displayName}.`,
  });
  plan.backups.push({ path: configPath, backupPath: plannedBackupPath(configPath), strategy: BACKUP_STRATEGY, reason: "update mcp entry" });
  plan.updatePreview?.push({ target: "mcp", state: "update", key: target.key, path: configPath, current: result.current, desired });
}

async function planMcp(plan: InstallPlan, request: PlanRequest, deps: PlanDependencies): Promise<void> {
  const host = request.host;
  const scope = request.scope;
  if (!host || !scope) {
    plan.conflicts.push({
      code: "missing_selection",
      path: "",
      message: "MCP operations require an explicit --host and --scope.",
    });
    return;
  }
  const adapter = deps.adapters.find((candidate) => candidate.id === host);
  if (!adapter) {
    plan.unsupported.push({
      code: "unknown_host",
      target: "mcp",
      host,
      scope,
      message: `No host adapter is registered for "${host}".`,
    });
    return;
  }

  const target = adapter.describe(deps.context, scope, request.operation === "remove" ? "remove" : "add");
  plan.hostTarget = target;
  plan.resolvedPaths.config = target.path;
  if (target.support) {
    plan.unsupported.push(target.support);
    return;
  }

  const configPath = target.path;
  if (request.operation !== "remove" && request.operation !== "update" && deps.launchMode === "checkout") {
    if (!deps.localDev) {
      plan.conflicts.push({
        code: "local_dev_required",
        path: configPath,
        message:
          "The CLI is running from a source checkout. Writing an absolute local launch path requires explicit opt-in with --local-dev; the published npm package is the default launch entry.",
      });
      return;
    }
    plan.warnings.push({
      code: "local_checkout_launch",
      message: `This entry launches the local checkout at ${deps.launch.args[0] ?? deps.launch.command} with node, not a published npm package. The npm package is not published; re-run from an installed package before sharing this configuration.`,
    });
  }
  const currentContent = (await adapter.readConfig(configPath)) ?? null;
  const input = { context: deps.context, scope, serverId: "pi-task-exec", launch: deps.launch, currentContent };

  if (request.operation === "update") {
    planMcpUpdate(plan, request, deps, adapter, target, configPath, currentContent, input);
    return;
  }

  if (request.operation === "remove") {
    const result = adapter.planRemoval(input);
    if (result.kind === "unsupported") {
      plan.unsupported.push(result.capability);
      return;
    }
    if (result.kind === "conflict") {
      plan.conflicts.push(result.conflict);
      return;
    }
    for (const warning of result.warnings) plan.warnings.push(warning);
    if (!result.changed) {
      plan.warnings.push({ code: "not_configured", message: `${adapter.displayName} already has no ${deps.packageVersion} entry at ${configPath}.` });
      return;
    }
    plan.updates.push({
      path: configPath,
      kind: "update",
      target: "mcp",
      host,
      content: result.content,
      baseSha256: currentContent === null ? null : sha256(currentContent),
      summary: `Remove the pi-task-exec MCP entry from ${adapter.displayName}.`,
    });
    plan.backups.push({ path: configPath, backupPath: plannedBackupPath(configPath), strategy: BACKUP_STRATEGY, reason: "remove mcp entry" });
    return;
  }

  const result = adapter.planEntry(input);
  if (result.kind === "unsupported") {
    plan.unsupported.push(result.capability);
    return;
  }
  if (result.kind === "conflict") {
    plan.conflicts.push(result.conflict);
    return;
  }
  for (const warning of result.warnings) plan.warnings.push(warning);
  if (currentContent !== null && currentContent === result.content) {
    plan.warnings.push({ code: "already_configured", message: `${adapter.displayName} already has the pi-task-exec MCP entry at ${configPath}.` });
    return;
  }
  const kind = currentContent === null ? "create" : "update";
  plan[kind === "create" ? "creates" : "updates"].push({
    path: configPath,
    kind,
    target: "mcp",
    host,
    content: result.content,
    baseSha256: currentContent === null ? null : sha256(currentContent),
    summary: `${kind === "create" ? "Create" : "Update"} the pi-task-exec MCP entry in ${adapter.displayName}.`,
  });
  // A create has no pre-existing file to back up, so only report a backup for
  // an update. This keeps the plan's backup list aligned with what the
  // executor actually does.
  if (kind === "update") {
    plan.backups.push({ path: configPath, backupPath: plannedBackupPath(configPath), strategy: BACKUP_STRATEGY, reason: "write mcp entry" });
  }
}

async function planSkill(plan: InstallPlan, request: PlanRequest, deps: PlanDependencies): Promise<void> {
  const scope = request.scope;
  if (!scope) {
    plan.conflicts.push({ code: "missing_selection", path: "", message: "Skill operations require an explicit --scope." });
    return;
  }
  const host = request.host;
  if (request.operation === "add" || request.operation === "update") {
    if (!host) {
      plan.conflicts.push({
        code: "missing_agent",
        path: "",
        message: `${request.operation} skill requires an explicit --host codex|zed|opencode to select the Skill Agent.`,
      });
      return;
    }
    if (!deps.adapters.some((adapter) => adapter.id === host)) {
      plan.unsupported.push({
        code: "unknown_host",
        target: "skill",
        host,
        scope,
        message: `No Skill Agent is registered for "${host}".`,
      });
      return;
    }
  }
  const directory = skillTargetDir(scope, deps.context);
  plan.resolvedPaths.skillDir = directory;
  const result = await deps.skillInstaller.plan({
    operation: request.operation,
    scope,
    context: deps.context,
    ...(host !== undefined ? { host: host as HostId } : {}),
    sourceDir: join(deps.packageRoot, "skills", SKILL_NAME),
    packageVersion: deps.packageVersion,
    currentContent: null,
    launchMode: deps.launchMode,
  });
  if (result.kind === "unsupported") {
    plan.unsupported.push(result.capability);
    return;
  }
  for (const warning of result.plan.warnings) plan.warnings.push(warning);
  for (const conflict of result.plan.conflicts) plan.conflicts.push(conflict);
  if (result.plan.cli) plan.skillCli = result.plan.cli;
  if (result.plan.update) {
    const discovery = result.plan.update;
    plan.updatePreview?.push({
      target: "skill",
      state: discovery.state,
      key: SKILL_NAME,
      path: discovery.installDir,
      ...(discovery.currentRef !== undefined ? { current: discovery.currentRef } : {}),
      desired: discovery.desiredRef,
      lossWarning: result.plan.cli?.lossWarning === true,
    });
  }
  for (const write of result.plan.writes) {
    const kind = write.baseSha256 === null ? "create" : "update";
    plan[kind === "create" ? "creates" : "updates"].push({
      path: write.path,
      kind,
      target: "skill",
      content: write.content,
      baseSha256: write.baseSha256,
      summary: write.summary,
    });
    // Only pre-existing files are backed up by the executor.
    if (write.baseSha256 !== null) {
      plan.backups.push({ path: write.path, backupPath: plannedBackupPath(write.path), strategy: BACKUP_STRATEGY, reason: "write skill file" });
    }
  }
  for (const removal of result.plan.removals) {
    plan.removals.push({
      path: removal.path,
      target: "skill",
      managedBy: removal.managedBy,
      sha256: removal.sha256,
      summary: removal.summary,
    });
  }
}

export async function generatePlan(request: PlanRequest, deps: PlanDependencies): Promise<InstallPlan> {
  const plan: InstallPlan = {
    schema: PLAN_SCHEMA,
    operation: request.operation,
    target: request.target,
    ...(request.host !== undefined ? { host: request.host } : {}),
    ...(request.scope !== undefined ? { scope: request.scope } : {}),
    dryRun: request.dryRun,
    createdAt: deps.now().toISOString(),
    launchMode: deps.launchMode,
    resolvedPaths: {},
    creates: [],
    updates: [],
    removals: [],
    conflicts: [],
    backups: [],
    warnings: [],
    unsupported: [],
    supported: true,
    updatePreview: [],
  };

  if (request.operation === "doctor") {
    plan.supported = true;
    return plan;
  }

  const targets: Array<"mcp" | "skill"> = request.target === "both" ? ["mcp", "skill"] : [request.target];
  for (const target of targets) {
    if (target === "mcp") await planMcp(plan, request, deps);
    else await planSkill(plan, request, deps);
  }

  // A release-mode Skill update depends on the exact `v${packageVersion}`
  // GitHub tag. The read-only preflight runs during planning, so a missing or
  // unverifiable tag conflicts the whole plan before the executor can write the
  // MCP entry or invoke the Skills CLI. It is only required when a Skill update
  // is actually planned: an MCP-only update (Skill absent or already current)
  // and a checkout-mode commit Skill update are never blocked by an unrelated
  // GitHub tag. There is never a fallback to a branch such as `main`, and no
  // npm `latest` query is performed.
  const skillUpdatePlanned = plan.skillCli !== undefined && plan.skillCli.refKind === "release";
  if (request.operation === "update" && plan.conflicts.length === 0 && skillUpdatePlanned) {
    const tag = `v${deps.packageVersion}`;
    const preflight = deps.releaseTagPreflight;
    if (!preflight) {
      plan.conflicts.push({
        code: "release_tag_unverified",
        path: "",
        message: `No release tag preflight is available to verify ${tag}; refusing to plan a release update.`,
      });
    } else {
      const tagCheck = await preflight(tag);
      if (!tagCheck.ok) {
        plan.conflicts.push({
          code: "release_tag_missing",
          path: "",
          message: tagCheck.message ?? `The release tag ${tag} could not be verified; refusing to update and never falling back to main.`,
        });
      }
    }
  }

  plan.supported = plan.unsupported.length === 0;
  return plan;
}
