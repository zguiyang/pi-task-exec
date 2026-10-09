import { spawn } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import type { DoctorCheck, HostAdapter } from "./adapters.js";
import type { HostContext, Scope } from "./plan.js";
import { skillTargetDir } from "./plan.js";
import type { SkillInstaller } from "./skill.js";
import { PACKAGE_NAME, SERVER_NAME, SKILL_NAME, VERSION } from "./identity.js";

export interface ProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
  error?: string;
}

export type SpawnFunction = (command: string, args: string[], options: { timeoutMs: number; env: NodeJS.ProcessEnv }) => Promise<ProcessResult>;

/**
 * Structured process check. Uses `spawn(command, args)` with `shell: false`;
 * no argument ever passes through a shell string.
 */
export function spawnProcess(command: string, args: string[], options: { timeoutMs: number; env: NodeJS.ProcessEnv }): Promise<ProcessResult> {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, { shell: false, env: options.env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
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
      resolvePromise({ code, stdout, stderr });
    });
  });
}

export interface DoctorDependencies {
  adapters: readonly HostAdapter[];
  skillInstaller: SkillInstaller;
  context: HostContext;
  spawn: SpawnFunction;
  now: () => Date;
  packageRoot: string;
  packageVersion: string;
}

export interface DoctorReport {
  schema: "pi-task-exec.doctor.v1";
  generatedAt: string;
  platform: { os: string; release: string; arch: string; node: string; cwd: string; home: string };
  package: { name: string; version: string };
  versions: { ok: boolean; checks: DoctorCheck[] };
  tools: DoctorCheck[];
  hosts: DoctorCheck[];
  skill: DoctorCheck[];
  ok: boolean;
}

async function readJson(path: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Inspect the skill target without reading file bodies, so no skill or config
 * content can leak into the report. Names and counts are safe; content is
 * reported as unknown until the managed installer records a manifest.
 */
async function skillTargetState(directory: string, installerId: string): Promise<{ status: DoctorCheck["status"]; detail: string }> {
  if (!(await directoryExists(directory))) {
    return { status: "warn", detail: `${directory} not installed (content state: absent)` };
  }
  let entries: string[] = [];
  try {
    entries = await readdir(directory);
  } catch {
    entries = [];
  }
  const hasSkillFile = entries.includes("SKILL.md");
  const contentState = installerId === "unavailable"
    ? "content state unknown (generic installer deferred)"
    : "content state unknown (no managed manifest recorded)";
  return {
    status: "warn",
    detail: `${directory} exists (${entries.length} ${entries.length === 1 ? "entry" : "entries"}, SKILL.md ${hasSkillFile ? "present" : "missing"}); ${contentState}`,
  };
}

function processCheck(id: string, label: string, result: ProcessResult): DoctorCheck {
  if (result.error) return { id, label, status: "warn", detail: `not found (${result.error})` };
  if (result.code !== 0) return { id, label, status: "warn", detail: `exited ${result.code ?? "unknown"}` };
  const version = result.stdout.trim().split("\n")[0] ?? "";
  return { id, label, status: "pass", detail: version || "(no version output)" };
}

async function versionChecks(deps: DoctorDependencies): Promise<{ ok: boolean; checks: DoctorCheck[] }> {
  const checks: DoctorCheck[] = [];
  const pkg = await readJson(join(deps.packageRoot, "package.json"));
  const server = await readJson(join(deps.packageRoot, "server.json"));
  const expected = deps.packageVersion;

  const packageVersion = typeof pkg?.version === "string" ? pkg.version : null;
  checks.push({
    id: "version.package",
    label: "package.json version",
    status: packageVersion === expected ? "pass" : "fail",
    detail: packageVersion ? `${packageVersion}` : "package.json not readable",
  });

  const serverVersion = typeof server?.version === "string" ? server.version : null;
  checks.push({
    id: "version.server",
    label: "server.json version",
    status: serverVersion === expected ? "pass" : "fail",
    detail: serverVersion ?? "server.json not readable",
  });

  const serverName = typeof server?.name === "string" ? server.name : null;
  checks.push({
    id: "version.registryName",
    label: "server.json registry name",
    status: serverName === SERVER_NAME ? "pass" : "fail",
    detail: serverName ?? "server.json not readable",
  });

  const packages = Array.isArray(server?.packages) ? (server.packages as Array<Record<string, unknown>>) : [];
  const first = packages[0];
  const entryVersion = typeof first?.version === "string" ? first.version : null;
  checks.push({
    id: "version.registryPackage",
    label: "server.json package version",
    status: entryVersion === expected ? "pass" : "fail",
    detail: entryVersion ?? "server.json packages[0] not readable",
  });

  const skillPath = join(deps.packageRoot, "skills", SKILL_NAME, "SKILL.md");
  let skillPresent = false;
  try {
    skillPresent = (await readFile(skillPath, "utf8")).includes(`name: ${SKILL_NAME}`);
  } catch {
    skillPresent = false;
  }
  checks.push({
    id: "version.skill",
    label: "bundled skill",
    status: skillPresent ? "pass" : "fail",
    detail: skillPresent ? skillPath : `${skillPath} not readable`,
  });

  return { ok: checks.every((check) => check.status === "pass"), checks };
}

export async function runDoctor(deps: DoctorDependencies): Promise<DoctorReport> {
  const { context } = deps;
  const versions = await versionChecks(deps);
  const pi = await deps.spawn("pi", ["--version"], { timeoutMs: 5_000, env: context.env });
  const git = await deps.spawn("git", ["--version"], { timeoutMs: 5_000, env: context.env });
  const tools: DoctorCheck[] = [
    { id: "runtime.node", label: "Node", status: "pass", detail: process.version },
    processCheck("tool.pi", "Pi", pi),
    processCheck("tool.git", "Git", git),
  ];

  const hosts: DoctorCheck[] = [];
  for (const adapter of deps.adapters) {
    const scopes: Scope[] = adapter.supportedScopes.length > 0 ? [...adapter.supportedScopes] : ["project", "global"];
    for (const scope of scopes) {
      // A host that has not verified this platform must never have its config
      // read: report the deferred/skipped status and stop there.
      if (adapter.supportedPlatforms.length > 0 && !adapter.supportedPlatforms.includes(context.platform)) {
        hosts.push({
          id: `host.${adapter.id}.${scope}`,
          label: `${adapter.displayName} (${scope})`,
          status: "skip",
          detail: `${context.platform} is outside the verified platforms for ${adapter.id}; the config path is deferred and is not guessed or read.`,
        });
        continue;
      }
      const support = adapter.installSupport(context, scope);
      if (support) {
        hosts.push({ id: `host.${adapter.id}.${scope}`, label: `${adapter.displayName} (${scope})`, status: "warn", detail: support.message });
        continue;
      }
      const checks = await adapter.doctorChecks(context, scope);
      hosts.push(...checks);
    }
  }

  const skill: DoctorCheck[] = [];
  for (const scope of ["project", "global"] as const) {
    const directory = skillTargetDir(scope, context);
    const state = await skillTargetState(directory, deps.skillInstaller.id);
    skill.push({ id: `skill.${scope}`, label: `pi-delegate (${scope})`, status: state.status, detail: state.detail });
  }
  skill.push({
    id: "skill.installer",
    label: "skill installer adapter",
    status: deps.skillInstaller.id === "unavailable" ? "warn" : "pass",
    detail: deps.skillInstaller.id === "unavailable" ? "unavailable (generic installer deferred)" : `available (${deps.skillInstaller.id})`,
  });

  const ok = tools.every((check) => check.status !== "fail") && versions.ok && hosts.every((check) => check.status !== "fail") && skill.every((check) => check.status !== "fail");
  return {
    schema: "pi-task-exec.doctor.v1",
    generatedAt: deps.now().toISOString(),
    platform: {
      os: context.platform,
      release: process.release?.name ?? "unknown",
      arch: process.arch,
      node: process.version,
      cwd: context.cwd,
      home: context.home,
    },
    package: { name: PACKAGE_NAME, version: VERSION },
    versions,
    tools,
    hosts,
    skill,
    ok,
  };
}

export function formatDoctor(report: DoctorReport): string {
  const lines: string[] = [];
  lines.push(`pi-task-exec doctor (${report.schema})`);
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push(`Platform: ${report.platform.os} ${report.platform.arch}; Node ${report.platform.node}`);
  lines.push(`Package: ${report.package.name}@${report.package.version}`);
  lines.push(`CWD: ${report.platform.cwd}`);
  lines.push(`Home: ${report.platform.home}`);
  const section = (title: string, checks: DoctorCheck[]) => {
    lines.push(`${title}:`);
    if (checks.length === 0) lines.push("  (none)");
    for (const check of checks) lines.push(`  [${check.status}] ${check.label}: ${check.detail}`);
  };
  section("Version contract", report.versions.checks);
  section("Tools", report.tools);
  section("Host adapters", report.hosts);
  section("Skill targets", report.skill);
  lines.push(`Overall: ${report.ok ? "ok" : "attention required"}`);
  return lines.join("\n");
}
