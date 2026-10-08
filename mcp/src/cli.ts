import { access } from "node:fs/promises";
import { delimiter } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { PACKAGE_NAME, type HostName, type Scope, type HostSelection, configured, install, uninstall } from "./hosts.js";

export const VERSION = "0.1.1";
const HOSTS: HostName[] = ["codex", "zed", "opencode"];
const SCOPES: Scope[] = ["project", "global"];
type CliPaths = { home: string; cwd: string; platform?: NodeJS.Platform };

function parseSelections(args: string[]): HostSelection[] {
  const hosts = args.filter((_, index) => args[index - 1] === "--host") as HostName[];
  const scope = args[args.indexOf("--scope") + 1] as Scope | undefined;
  if (!hosts.every((host) => HOSTS.includes(host))) throw new Error("--host must be codex, zed, or opencode");
  if (scope && !SCOPES.includes(scope)) throw new Error("--scope must be project or global");
  return (hosts.length ? hosts : HOSTS).map((host) => ({ host, scope: scope ?? "global" }));
}

async function piAvailable(): Promise<boolean> {
  const paths = (process.env.PATH ?? "").split(delimiter);
  for (const path of paths) { try { await access(`${path}/pi`); return true; } catch { /* continue */ } }
  return false;
}

function help() { return `pi-worker-mcp ${VERSION}\n\nCommands:\n  serve                 Start the MCP stdio runtime\n  setup [--host H] [--scope S]  Configure supported hosts (defaults: all, global)\n  doctor [--host H] [--scope S] Check Node, Pi, and selected configuration\n  update [--host H] [--scope S] Update selected config pins to this CLI version\n  uninstall [--host H] [--scope S] Remove only this server entry\n  version               Print version\n\nHosts: codex, zed, opencode. Scopes: project, global.\nManual stdio launch: npx -y ${PACKAGE_NAME}@${VERSION} serve`; }

async function interactiveSelection(paths: CliPaths): Promise<HostSelection[]> {
  if (!input.isTTY) return parseSelections([]);
  const rl = createInterface({ input, output });
  try {
    const hostAnswer = (await rl.question("MCP hosts (comma-separated: codex,zed,opencode; default all): ")).trim();
    const scopeAnswer = (await rl.question("Scope (project/global; default global): ")).trim() || "global";
    return parseSelections([...(hostAnswer ? hostAnswer.split(",").flatMap((host) => ["--host", host.trim()]) : []), "--scope", scopeAnswer]);
  } finally { rl.close(); }
}

export async function runCli(args: string[], paths: CliPaths = { home: process.env.HOME ?? process.cwd(), cwd: process.cwd() }): Promise<number> {
  const command = args[0] ?? "serve";
  if (["--help", "-h", "help"].includes(command)) { console.log(help()); return 0; }
  if (["version", "--version", "-v"].includes(command)) { console.log(VERSION); return 0; }
  if (command === "serve") return -1;
  try {
    const selections = args.some((arg) => arg === "--host" || arg === "--scope") ? parseSelections(args.slice(1)) : await interactiveSelection(paths);
    if (command === "setup" || command === "update") {
      if (command === "setup") console.log(`Pi executable: ${await piAvailable() ? "found" : "not found (install and configure Pi before using workers)"}`);
      for (const selection of selections) console.log(`${command === "setup" ? "Configured" : "Updated"} ${selection.host} (${selection.scope}): ${await install(selection, VERSION, paths)}`);
      return 0;
    }
    if (command === "uninstall") {
      for (const selection of selections) { const result = await uninstall(selection, paths); console.log(`${result.changed ? "Removed" : "Not configured"} ${selection.host} (${selection.scope}): ${result.path}`); }
      return 0;
    }
    if (command === "doctor") {
      console.log(`Node: ${process.version}`);
      console.log(`Pi executable: ${await piAvailable() ? "found" : "not found"}`);
      for (const selection of selections) console.log(`${selection.host} (${selection.scope}): ${await configured(selection, paths) ? "configured" : "not configured"}`);
      return (await piAvailable()) ? 0 : 1;
    }
    throw new Error(`Unknown command: ${command}`);
  } catch (error) { console.error(error instanceof Error ? error.message : String(error)); return 1; }
}
