import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { createDefaultAdapters } from "./hosts/adapters.js";
import { runCli, type CliDeps } from "./commands/index.js";
import { spawnProcess } from "./commands/doctor.js";
import { defaultIo } from "./io.js";
import { skillsCliInstaller } from "./installers/skills-cli.js";
import { createArrowInteraction } from "./interactive.js";
import type { SafetyConfirmation } from "./plan/executor.js";
import { VERSION } from "./identity.js";

async function confirmPlan(_plan: unknown, safety?: SafetyConfirmation): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
  if (safety) process.stdout.write(`${safety.message}\n`);
  return createArrowInteraction({ input: process.stdin, output: process.stdout }).confirm(
    safety ? "Replace the listed path(s)?" : "Proceed with the plan above?", false,
  );
}

const home = homedir();
const cwd = process.cwd();
// Arrow-key selection is only available on a real terminal. Non-TTY callers
// (pipes, CI, tests) fall back to the existing flag-driven confirmation.
const interaction =
  process.stdin.isTTY && process.stdout.isTTY ? createArrowInteraction({ input: process.stdin, output: process.stdout }) : undefined;
const deps: CliDeps = {
  color: process.stdout.isTTY === true && process.env.NO_COLOR === undefined && process.env.TERM !== "dumb" && process.env.FORCE_COLOR !== "0",
  io: defaultIo,
  env: process.env,
  cwd,
  home,
  platform: process.platform,
  packageRoot: fileURLToPath(new URL("../../", import.meta.url)),
  packageVersion: VERSION,
  adapters: createDefaultAdapters(),
  skillInstaller: skillsCliInstaller(),
  now: () => new Date(),
  spawn: spawnProcess,
  ...(process.argv.slice(2).some((arg) => arg.split("=")[0] === "--json") ? {} : { confirm: confirmPlan }),
  ...(interaction !== undefined ? { interaction } : {}),
  roots: [home, cwd],
};

try {
  const action = await runCli(process.argv.slice(2), deps);
  if (action.kind === "serve") {
    // Load MCP runtime only after the parser explicitly routes `mcp serve`.
    const { serveMcp } = await import("../mcp/index.js");
    await serveMcp();
  } else {
    process.exitCode = action.code;
  }

} catch (error) {
  console.error(`Pi TaskExec startup failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
