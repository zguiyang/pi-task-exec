#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import * as z from "zod/v4";
import { runCli } from "./cli.js";
import { WorkerManager } from "./worker-manager.js";

const cliResult = await runCli(process.argv.slice(2));
if (cliResult !== -1) {
  process.exitCode = cliResult;
} else {
const manager = new WorkerManager();
const server = new McpServer(
  { name: "pi-worker-mcp", version: "0.1.1" },
  {
    instructions:
      "Pi workers are subordinate coding workers. The supervisor owns planning, architecture, delegation and integration decisions, and final review. Delegate bounded work when it saves context or enables useful parallel progress; keep trivial or ambiguous work and architectural decisions yourself. Use multiple workers only for independent tasks, never recursively delegate, and review worker output before accepting it.",
  },
);

function ok(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function fail(error: unknown) {
  const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : undefined;
  const message = error instanceof Error ? error.message : String(error);
  return {
    isError: true,
    ...(code ? { structuredContent: { code, message } } : {}),
    content: [{ type: "text" as const, text: message }],
  };
}

server.registerTool(
  "pi_spawn",
  {
    description: "Delegate one bounded investigation, implementation, test, or mechanical coding task when it saves supervisor context or enables useful parallel work. Keep trivial edits, short questions, architecture decisions, and ambiguous requirements yourself. Spawn multiple workers only for independent tasks; parallel implement workers need separate worktrees and non-overlapping scope. A failed direct worker may leave partial edits; worktree edits are not merged or deleted automatically. You remain responsible for integration and final review. Success means accepted, not completed.",
    inputSchema: {
      task: z.string().min(1).max(20_000).describe("One bounded task with a clear scope and expected result."),
      cwd: z.string().min(1).describe("Absolute working directory inside PI_WORKER_ALLOWED_ROOTS."),
      mode: z.enum(["direct", "worktree"]).describe("direct uses this checkout; worktree isolates edits. Parallel implement workers must use separate worktrees."),
      profile: z.enum(["inspect", "implement"]).default("implement").describe("inspect is read-only and may share a checkout; implement can write files."),
      taskTimeoutMs: z.number().int().min(1_000).max(86_400_000).optional().describe("Optional activity-cycle deadline in milliseconds."),
      model: z.string().min(1).optional().describe("Optional model override for this worker only. When omitted, Pi chooses its locally configured default. The value must resolve to a model available in this worker's local Pi environment."),
    },
  },
  async (args) => {
    try {
      const worker = await manager.spawn(args);
      return ok(worker);
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "pi_status",
  {
    description: "Check a worker's progress, state, and terminal result. Settled means its current activity cycle has ended; it does not mean the result is correct. After failure, inspect the result and decide how to recover or continue related work. Avoid frequent busy polling.",
    inputSchema: { workerId: z.string().uuid().describe("ID returned by pi_spawn or pi_list.") },
  },
  async ({ workerId }) => {
    try {
      return ok(manager.status(workerId));
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "pi_steer",
  {
    description: "Correct the direction of a running worker when its current task is drifting. Use only while it is running; this is not a follow-up. For a related next task after settlement, use pi_continue.",
    inputSchema: { workerId: z.string().uuid().describe("ID of a running worker."), task: z.string().min(1).max(20_000).describe("Concise direction correction for the current task.") },
  },
  async ({ workerId, task }) => {
    try {
      return ok(await manager.steer(workerId, task));
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "pi_continue",
  {
    description: "Give the same worker a related follow-up that benefits from its current context. While running, the follow-up is queued; when settled, it starts a new activity cycle. Accepted/queued is not completed. Use a new worker for unrelated work. Cannot reuse an aborting or terminal worker.",
    inputSchema: { workerId: z.string().uuid().describe("ID of the worker whose context should be reused."), task: z.string().min(1).max(20_000).describe("Related follow-up task with a clear expected result.") },
  },
  async ({ workerId, task }) => {
    try {
      return ok(await manager.continue(workerId, task));
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "pi_abort",
  {
    description: "Stop an incorrect or no-longer-needed worker, or release a settled worker's process and live-worker slot when no follow-up is needed. A terminal worker returns its existing snapshot without further action. Releasing a worker does not revert direct edits or delete its worktree.",
    inputSchema: { workerId: z.string().uuid().describe("ID of the worker to stop and release.") },
  },
  async ({ workerId }) => {
    try {
      return ok(await manager.abort(workerId));
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "pi_list",
  {
    description: "Inspect the current worker fleet before spawning more workers. Results are newest first and include running and settled workers, which still occupy slots, and terminal workers, which cannot be reused. The list does not include the configured worker limit.",
    inputSchema: {},
  },
  async () => ok(manager.list()),
);

console.error("pi-worker-mcp started over MCP stdio");

let shutdownPromise: Promise<void> | undefined;
const stdio = serveStdio(() => server, { onerror: (error) => console.error("pi-worker-mcp transport error:", error) });
function shutdown(): Promise<void> {
  shutdownPromise ??= (async () => {
    try {
      await manager.shutdown();
    } finally {
      await stdio.close();
    }
  })().catch((error) => { console.error("pi-worker-mcp shutdown error:", error); });
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
