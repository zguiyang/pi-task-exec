import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join } from "node:path";

export const PACKAGE_NAME = "@zguiyang/pi-task-exec";
export const SERVER_ID = "pi-task-exec";
export type HostName = "codex" | "zed" | "opencode";
export type Scope = "project" | "global";
export type HostSelection = { host: HostName; scope: Scope };

export type InstallPaths = { home: string; cwd: string; platform?: NodeJS.Platform };

export function launchSpec(version: string) {
  return { command: "npx", args: ["-y", `${PACKAGE_NAME}@${version}`, "mcp", "serve"] };
}

export function supportsScope(_host: HostName, _scope: Scope): boolean {
  // All three hosts have a documented user and project configuration layer.
  return true;
}

export function configPath(selection: HostSelection, paths: InstallPaths): string {
  const platform = paths.platform ?? process.platform;
  if (selection.host === "codex") return selection.scope === "project" ? join(paths.cwd, ".codex", "config.toml") : join(paths.home, ".codex", "config.toml");
  if (selection.host === "opencode") return selection.scope === "project" ? join(paths.cwd, "opencode.json") : join(paths.home, ".config", "opencode", "opencode.json");
  if (selection.scope === "project") return join(paths.cwd, ".zed", "settings.json");
  return platform === "darwin" ? join(paths.home, ".zed", "settings.json") : join(paths.home, ".config", "zed", "settings.json");
}

async function exists(path: string) { try { await access(path, constants.F_OK); return true; } catch { return false; } }
async function readOptional(path: string) { return (await exists(path)) ? readFile(path, "utf8") : undefined; }
async function writeAtomic(path: string, content: string) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.pi-task-exec-${process.pid}.tmp`;
  await writeFile(temporary, content, "utf8");
  await rename(temporary, path);
}

function parseObject(raw: string | undefined, path: string): Record<string, unknown> {
  if (!raw?.trim()) return {};
  try { return JSON.parse(raw) as Record<string, unknown>; }
  catch { throw new Error(`${path} is not strict JSON. Convert JSONC comments/trailing commas before using the installer; no file was changed.`); }
}

function objectAt(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }

function upsertToml(raw: string | undefined, version: string): string {
  const header = `[mcp_servers.${SERVER_ID}]`;
  const block = `${header}\ncommand = "npx"\nargs = ["-y", "${PACKAGE_NAME}@${version}", "mcp", "serve"]\n`;
  const without = removeToml(raw);
  return `${without.trimEnd()}${without?.trim() ? "\n\n" : ""}${block}`;
}

function removeToml(raw: string | undefined): string {
  if (!raw) return "";
  const lines = raw.split(/\r?\n/);
  const start = lines.findIndex((line) => /^\s*\[mcp_servers\.pi-task-exec\]\s*$/.test(line));
  if (start < 0) return raw;
  let end = start + 1;
  while (end < lines.length && !/^\s*\[.+\]\s*$/.test(lines[end] ?? "")) end++;
  lines.splice(start, end - start);
  return lines.join("\n").replace(/\n{3,}/g, "\n\n");
}

export async function install(selection: HostSelection, version: string, paths: InstallPaths): Promise<string> {
  const path = configPath(selection, paths);
  const raw = await readOptional(path);
  if (selection.host === "codex") await writeAtomic(path, upsertToml(raw, version));
  else {
    const root = parseObject(raw, path);
    if (selection.host === "zed") {
      const servers = objectAt(root.context_servers);
      root.context_servers = { ...servers, [SERVER_ID]: launchSpec(version) };
    } else {
      const mcp = objectAt(root.mcp);
      const servers = objectAt(mcp.servers);
      root.mcp = { ...mcp, servers: { ...servers, [SERVER_ID]: { type: "local", command: ["npx", "-y", `${PACKAGE_NAME}@${version}`, "mcp", "serve"] } } };
    }
    await writeAtomic(path, `${JSON.stringify(root, null, 2)}\n`);
  }
  return path;
}

export async function uninstall(selection: HostSelection, paths: InstallPaths): Promise<{ path: string; changed: boolean }> {
  const path = configPath(selection, paths);
  const raw = await readOptional(path);
  if (!raw) return { path, changed: false };
  if (selection.host === "codex") {
    const next = removeToml(raw);
    if (next !== raw) await writeAtomic(path, next);
    return { path, changed: next !== raw };
  }
  const root = parseObject(raw, path);
  const container = selection.host === "zed" ? objectAt(root.context_servers) : objectAt(objectAt(root.mcp).servers);
  if (!(SERVER_ID in container)) return { path, changed: false };
  delete container[SERVER_ID];
  if (selection.host === "zed") root.context_servers = container;
  else root.mcp = { ...objectAt(root.mcp), servers: container };
  await writeAtomic(path, `${JSON.stringify(root, null, 2)}\n`);
  return { path, changed: true };
}

export async function configured(selection: HostSelection, paths: InstallPaths): Promise<boolean> {
  const raw = await readOptional(configPath(selection, paths));
  if (!raw) return false;
  if (selection.host === "codex") return new RegExp(`^\\s*\\[mcp_servers\\.${SERVER_ID.replace(/-/g, "\\-")}\\]\\s*$`, "m").test(raw);
  try {
    const root = parseObject(raw, configPath(selection, paths));
    const container = selection.host === "zed" ? objectAt(root.context_servers) : objectAt(objectAt(root.mcp).servers);
    return SERVER_ID in container;
  } catch { return false; }
}
