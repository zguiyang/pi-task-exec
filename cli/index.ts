import { createInterface } from "node:readline/promises";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { createDefaultAdapters } from "./hosts/adapters.js";
import { runCli, type CliDeps } from "./commands/index.js";
import { spawnProcess } from "./commands/doctor.js";
import { defaultIo } from "./io.js";
import { unavailableSkillInstaller } from "./installers/skill.js";
import { VERSION } from "./identity.js";

async function confirmPlan(): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;
  const readline = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await readline.question("Proceed with the plan above? [y/N] ");
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    readline.close();
  }
}

const home = homedir();
const cwd = process.cwd();
const deps: CliDeps = {
  io: defaultIo,
  env: process.env,
  cwd,
  home,
  platform: process.platform,
  packageRoot: fileURLToPath(new URL("../../", import.meta.url)),
  packageVersion: VERSION,
  adapters: createDefaultAdapters(),
  skillInstaller: unavailableSkillInstaller(),
  now: () => new Date(),
  spawn: spawnProcess,
  confirm: confirmPlan,
  roots: [home, cwd],
};

const action = await runCli(process.argv.slice(2), deps);
if (action.kind === "serve") {
  // Load MCP runtime only after the parser explicitly routes `mcp serve`.
  const { serveMcp } = await import("../mcp/index.js");
  await serveMcp();
} else {
  process.exitCode = action.code;
}
