import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { WorkerManager } from "./workers/manager.js";
import { registerTools } from "./tools/register.js";
import { MCP_SERVER_NAME, MCP_SERVER_VERSION } from "./runtime/identity.js";

export async function serveMcp(): Promise<void> {
  const manager = new WorkerManager();
  const server = new McpServer(
    { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
    {
      instructions:
        "Pi workers are subordinate coding workers. The supervisor owns planning, architecture, delegation and integration decisions, and final review. Delegate bounded work when its objective, context, boundary, completion check, and side effects are clear. Use multiple workers only for independent tasks, never recursively delegate, and review worker output before accepting it.",
    },
  );
  registerTools(server, manager);

  const refreshRoots = (): void => {
    if (!server.server.getClientCapabilities()?.roots) return;
    void manager.refreshClientRoots(async () => {
      const result = await server.server.listRoots(undefined, { timeout: 5_000 });
      return result.roots.map((root) => root.uri);
    }).catch((error) => console.error(`${MCP_SERVER_NAME} workspace roots unavailable:`, error instanceof Error ? error.message : String(error)));
  };
  server.server.oninitialized = refreshRoots;
  server.server.setNotificationHandler("notifications/roots/list_changed", refreshRoots);

  console.error(`${MCP_SERVER_NAME} started over MCP stdio`);
  let shutdownPromise: Promise<void> | undefined;
  const stdio = serveStdio(() => server, { onerror: (error) => console.error(`${MCP_SERVER_NAME} transport error:`, error) });
  function shutdown(): Promise<void> {
    shutdownPromise ??= (async () => {
      try {
        await manager.shutdown();
      } finally {
        await stdio.close();
      }
    })().catch((error) => { console.error(`${MCP_SERVER_NAME} shutdown error:`, error); });
    return shutdownPromise;
  }

  process.stdin.once("end", () => { void shutdown(); });
  process.stdin.once("close", () => { void shutdown(); });
  process.stdout.once("error", () => { void shutdown(); });
  process.stdout.once("close", () => { void shutdown(); });
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      void shutdown().finally(() => process.exit(0));
    });
  }
}
