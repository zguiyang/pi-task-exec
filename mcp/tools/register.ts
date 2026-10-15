import type { McpServer } from "@modelcontextprotocol/server";
import * as z from "zod/v4";
import type { WorkerManager } from "../workers/manager.js";

export function registerTools(server: McpServer, manager: WorkerManager): void {
function ok(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function fail(error: unknown) {
  const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : undefined;
  const phase = error && typeof error === "object" && "phase" in error && typeof error.phase === "string" ? error.phase : undefined;
  const workerId = error && typeof error === "object" && "workerId" in error && typeof error.workerId === "string" ? error.workerId : undefined;
  const message = error instanceof Error ? error.message : String(error);
  const structuredContent = code
    ? { code, message, ...(phase ? { phase } : {}), ...(workerId ? { workerId } : {}) }
    : undefined;
  return {
    isError: true,
    ...(structuredContent ? { structuredContent } : {}),
    content: [{ type: "text" as const, text: message }],
  };
}

server.registerTool(
  "pi_spawn",
  {
    description: "Start one bounded independent investigation, analysis, implementation, or verification task when delegation offers a useful benefit. Give a clear goal, context, scope, expected result, and stopping condition. Simple or context-dependent work can be done directly. Use inspect for read-only work; implement permits writes and shell commands only within authorized scope. The supervisor retains global decisions and final review. A failed implement worker may leave partial edits. Success means accepted, not completed.",
    inputSchema: {
      task: z.string().min(1).max(20_000).describe("One bounded task with a clear scope and expected result."),
      cwd: z.string().min(1).describe("Absolute working directory inside PI_WORKER_ALLOWED_ROOTS. The worker runs in exactly this directory."),
      profile: z.enum(["inspect", "implement"]).default("inspect").describe("inspect is read-only and may share a checkout; implement can write files."),
      taskTimeoutMs: z.number().int().min(1_000).max(86_400_000).optional().describe("Optional activity-cycle deadline in milliseconds."),
      model: z.string().min(1).optional().describe("Optional model override for this worker only. When omitted, Pi chooses its locally configured default. The value must resolve to a model available in this worker's local Pi environment."),
      thinking: z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]).optional().describe("Optional reasoning level for this worker only. When omitted, Pi keeps its configured default. Must be supported by the active model; an unsupported level is reported instead of being silently ignored."),
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
    description: "Check a worker's progress, state, and the authoritative result of its current activity cycle. The result comes only from Pi's final assistant message and is independent of streamed diagnostics. Settled means the cycle ended; it does not mean the result is correct. Use waitMs to block, event driven, until the cycle settles or fails; a wait timeout does not cancel the worker. Avoid frequent busy polling.",
    inputSchema: {
      workerId: z.string().uuid().describe("ID returned by pi_spawn or pi_list."),
      waitMs: z.number().int().min(0).max(30_000).optional().describe("Optional bounded wait in milliseconds (0-30000). Returns as soon as the current cycle settles, fails, or the process exits. Defaults to an immediate snapshot."),
      cycleId: z.number().int().min(1).optional().describe("Optional activity cycle to wait for. Returns once that cycle has ended, even if a newer cycle has already started."),
    },
  },
  async ({ workerId, waitMs, cycleId }) => {
    try {
      return ok(await manager.waitStatus(workerId, { ...(waitMs !== undefined ? { waitMs } : {}), ...(cycleId !== undefined ? { cycleId } : {}) }));
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
    description: "Give the same worker a related follow-up that benefits from its current context. While running, the follow-up is queued and delivered inside the current activity cycle; once the cycle has settled (or failed), it starts a new cycle on the same process. Accepted/queued is not completed. Use a new worker for unrelated work. Cannot reuse a released or crashed worker.",
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
    description: "Cancel the current activity cycle of a running worker without releasing its process or live-worker slot. The worker can be continued afterwards when its process is still alive. A worker with no running cycle returns its existing snapshot unchanged. Use pi_release to terminate the process and free the slot.",
    inputSchema: { workerId: z.string().uuid().describe("ID of the worker whose current cycle should be cancelled.") },
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
  "pi_release",
  {
    description: "Release a worker's process and live-worker slot without reverting its edits or deleting files. Releasing a settled or failed worker preserves its authoritative result and failure. Releasing a running worker cancels and terminates it. Release is idempotent; if termination cannot be confirmed the snapshot carries releaseError and pi_release can be retried.",
    inputSchema: { workerId: z.string().uuid().describe("ID of the worker to release.") },
  },
  async ({ workerId }) => {
    try {
      return ok(await manager.release(workerId));
    } catch (error) {
      return fail(error);
    }
  },
);

server.registerTool(
  "pi_list",
  {
    description: "Inspect the current worker fleet before spawning more workers. Results are newest first and include live workers (running, settled, or cycle-failed), which still occupy slots and can be continued or released, plus bounded released/crashed snapshots, which cannot be reused. The list does not include the configured worker limit.",
    inputSchema: {},
  },
  async () => ok(manager.list()),
);

}
