import type { McpLaunchSpec } from "../hosts/adapters.js";

export interface ProbeResult {
  status: "pass" | "fail";
  stage: "launch" | "initialize" | "tools" | "call";
  detail: string;
  elapsedMs: number;
}

/** Official SDK discovery only; never starts a Pi Worker or loads on normal startup. */
export async function probeMcp(launch: McpLaunchSpec, cwd: string, env: NodeJS.ProcessEnv, timeoutMs = 10_000): Promise<ProbeResult> {
  const started = Date.now();
  let stage: ProbeResult["stage"] = "launch";
  const [{ Client }, { StdioClientTransport }] = await Promise.all([
    import("@modelcontextprotocol/client"), import("@modelcontextprotocol/client/stdio"),
  ]);
  const client = new Client({ name: "pi-task-exec-doctor", version: "1" });
  const transport = new StdioClientTransport({
    command: launch.command, args: launch.args, cwd,
    env: Object.fromEntries(Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined)),
    stderr: "ignore", maxBufferSize: 1_048_576,
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const protocolFailure = new Promise<never>((_resolve, reject) => {
    client.onerror = (error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") stage = "launch";
      reject(new Error(`MCP invalid protocol or transport error during ${stage}`));
    };
  });
  const options = { signal: controller.signal, timeout: timeoutMs };
  try {
    const operations = async (): Promise<void> => {
      stage = "initialize";
      await client.connect(transport, options);
      if (!client.getServerCapabilities()?.tools) throw new Error("MCP initialization did not advertise tools");
      stage = "tools";
      const catalog = await client.listTools({}, options);
      if (!catalog.tools.some((tool) => tool.name === "pi_list")) throw new Error("MCP tool catalog does not contain pi_list");
      stage = "call";
      const listed = await client.callTool({ name: "pi_list", arguments: {} }, options);
      if (listed.isError) throw new Error("pi_list probe failed");
    };
    await Promise.race([operations(), protocolFailure]);
    return { status: "pass", stage, detail: "Package runtime: initialize, tools/list and pi_list succeeded. Host tool exposure remains unverified; no Worker created.", elapsedMs: Date.now() - started };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") stage = "launch";
    return { status: "fail", stage, detail: controller.signal.aborted ? `MCP ${stage} timed out after ${timeoutMs} ms` : `MCP ${stage} probe failed (${error instanceof Error ? error.name : "error"}). Check Host stderr locally for details.`, elapsedMs: Date.now() - started };
  } finally {
    clearTimeout(timer);
    controller.abort();
    // SDK closes stdin, waits, then escalates to TERM/KILL on its child process.
    await client.close();
    await transport.close();
  }
}
