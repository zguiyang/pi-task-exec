# @zguiyang/pi-task-exec

The MCP worker runtime for the [Pi TaskExec](../README.md) product. It is a
host-agnostic stdio MCP server that supervises local [Pi](https://pi.dev)
coding-agent processes over Pi RPC. It is not a hosted service and does not
manage Pi credentials, providers, or default models.

## Quick start

Prerequisites: Node.js 20+, a locally installed and configured `pi` executable,
and Git when using isolated worktrees.

Register the MCP with a stdio host using the launch contract:

```text
command: npx
args:    -y @zguiyang/pi-task-exec@0.1.1 mcp serve
```

The CLI identity and launch route are implemented in this checkout and await
Supervisor review. The npm package and MCP Registry entry have not been
published.

From a source checkout:

```sh
npm install
npm run build
node mcp/dist/index.js mcp serve
```

`mcp serve` is the only service-start route. Running `pi-task-exec` with no
arguments prints help and does not start MCP.

## CLI surface

```text
pi-task-exec              Show help and exit
pi-task-exec --help       Show help and exit
pi-task-exec --version    Print the version and exit
pi-task-exec mcp serve    Start the MCP stdio runtime
```

`add mcp`, `add skill`, `setup`, `doctor`, `remove mcp`, and `remove skill`
are planned for a future stage. They print a future-stage notice, change no
files, and exit without invoking the previous installer behavior.

## Host configuration reference

Host installers are **not implemented** in this build. The table below records
the intended adapter boundaries for the later installer stage and for manual
registration; it is not a supported installation route yet.

| Host | Global | Project | Configuration |
| --- | --- | --- | --- |
| Codex | `~/.codex/config.toml` | `.codex/config.toml` | TOML `mcp_servers` |
| Zed | `~/.zed/settings.json` on macOS | `.zed/settings.json` | JSON `context_servers` |
| OpenCode | `~/.config/opencode/opencode.json` | `opencode.json` | JSON `mcp.servers` |

Zed starts project-defined MCP servers only after the worktree is trusted.
Codex project configuration is loaded only for trusted projects. The runtime
launch entry is `npx -y @zguiyang/pi-task-exec@0.1.1 mcp serve`.

## Model ownership and host independence

Pi owns provider authentication, available models, and its default model. The
worker runtime can validate an optional per-worker override and report the
effective model, but never configures credentials. Core runtime behavior—Pi
RPC, lifecycle, model semantics, concurrency, and permissions—is independent of
Codex, Zed, and OpenCode. Host adapters only read, merge, and remove launch
configuration.

## MCP tools

`pi_spawn`, `pi_status`, `pi_steer`, `pi_continue`, `pi_abort`, and `pi_list`
supervise bounded local workers. Successful spawn/continuation means Pi
accepted work, not that it is correct; the supervising agent must inspect
results and integrate changes. Use `worktree` mode for isolated implementation
work.

## Runtime configuration

| Environment variable | Default | Purpose |
| --- | --- | --- |
| `PI_WORKER_COMMAND` | `pi` | Pi executable |
| `PI_WORKER_MAX_WORKERS` | `4` | Maximum live workers |
| `PI_WORKER_RPC_TIMEOUT_MS` | `15000` | Per-RPC timeout |
| `PI_WORKER_IDLE_TIMEOUT_MS` | `600000` | Idle deadline; `0` disables it |
| `PI_WORKER_TASK_TIMEOUT_MS` | `3600000` | Activity-cycle deadline |
| `PI_WORKER_ALLOWED_ROOTS` | current directory | Path-delimited allowed roots |

No secret environment variable is required; Pi reads its own local
authentication configuration.

## Development from source

Source mode is only for contributors:

```sh
npm install
npm run build
node mcp/dist/index.js mcp serve
```

For release-equivalent testing, use `npm pack` and execute the resulting
`.tgz` from a clean temporary directory. `npm link` is not package acceptance.

## Registry metadata

The root `server.json` follows the official MCP Registry schema and declares an
npm stdio package representation whose `packageArguments` are the positional
arguments `mcp` and `serve`. npm and Registry publication remain separate,
explicit actions and have not occurred.

## License

[MIT](LICENSE)
