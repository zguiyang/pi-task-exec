export const VERSION = "0.1.1";
export const PRODUCT_NAME = "pi-task-exec";
export const PACKAGE_NAME = "@zguiyang/pi-task-exec";

/**
 * `serve` asks the entrypoint to start the MCP stdio runtime. Every other route
 * only prints a message and returns an explicit process exit code.
 */
export type CliAction = { kind: "serve" } | { kind: "exit"; code: number };

export interface CliIo {
  stdout(text: string): void;
  stderr(text: string): void;
}

const defaultIo: CliIo = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
};

export function helpText(): string {
  return `${PRODUCT_NAME} ${VERSION}

Usage:
  ${PRODUCT_NAME}                 Show this help and exit
  ${PRODUCT_NAME} --help          Show this help and exit
  ${PRODUCT_NAME} --version       Print the version and exit
  ${PRODUCT_NAME} mcp serve       Start the MCP stdio runtime

Planned for a future stage (not implemented in this build):
  ${PRODUCT_NAME} add mcp         Configure a host MCP entry
  ${PRODUCT_NAME} add skill       Install the pi-delegate skill
  ${PRODUCT_NAME} setup           Preview and configure the MCP and skill
  ${PRODUCT_NAME} doctor          Check Node, Pi, Git, host config, and skill files
  ${PRODUCT_NAME} remove mcp      Remove this host MCP entry
  ${PRODUCT_NAME} remove skill    Remove the installed pi-delegate skill

Hosts: codex, zed, opencode. Scopes: project, global.
MCP stdio launch: npx -y ${PACKAGE_NAME}@${VERSION} mcp serve`;
}

function futureStageNotice(command: string): string {
  return `${PRODUCT_NAME} ${command} is planned for a future stage and is not implemented in this build (${VERSION}). No host configuration or files were changed.`;
}

function unknownCommand(args: string[], io: CliIo): CliAction {
  io.stderr(`Unknown command: ${args.join(" ")}\n\n`);
  io.stderr(`${helpText()}\n`);
  return { kind: "exit", code: 1 };
}

export function runCli(args: string[], io: CliIo = defaultIo): CliAction {
  if (args.length === 0) {
    io.stdout(`${helpText()}\n`);
    return { kind: "exit", code: 0 };
  }

  const command = args[0];
  if (command === "--help") {
    io.stdout(`${helpText()}\n`);
    return { kind: "exit", code: 0 };
  }
  if (command === "--version") {
    io.stdout(`${VERSION}\n`);
    return { kind: "exit", code: 0 };
  }

  // The only real service-start route is `pi-task-exec mcp serve`.
  if (command === "mcp") {
    if (args.length === 3 && args[1] === "serve" && args[2] === "--help") {
      io.stdout(`Usage:\n  ${PRODUCT_NAME} mcp serve\n\nStart the MCP stdio runtime.\n`);
      return { kind: "exit", code: 0 };
    }
    if (args.length === 2 && args[1] === "serve") return { kind: "serve" };
    return unknownCommand(args, io);
  }

  // These commands are authorized for a later stage. They must never fall back
  // to the previous installer/uninstaller behavior or write any files.
  if (command === "add" && (args[1] === "mcp" || args[1] === "skill")) {
    io.stdout(`${futureStageNotice(`add ${args[1]}`)}\n`);
    return { kind: "exit", code: 1 };
  }
  if (command === "remove" && (args[1] === "mcp" || args[1] === "skill")) {
    io.stdout(`${futureStageNotice(`remove ${args[1]}`)}\n`);
    return { kind: "exit", code: 1 };
  }
  if (command === "setup" || command === "doctor") {
    io.stdout(`${futureStageNotice(command)}\n`);
    return { kind: "exit", code: 1 };
  }

  return unknownCommand(args, io);
}
