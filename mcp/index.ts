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
