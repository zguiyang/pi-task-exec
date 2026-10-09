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

Stages 6–8 are implemented in this checkout and await Supervisor review: the
CLI identity/launch route plus real Codex, Zed, and OpenCode MCP install/remove.
The npm package and MCP Registry entry have not been published.

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

`add mcp`, `remove mcp`, `setup`, and `doctor` are implemented. Every write
command first prints a plan with resolved absolute paths, platform, config
format, modified config key, support status, backup strategy, and the
restart/trust requirement, then revalidates it before executing. `--dry-run`
prints the plan and writes nothing; `--yes` skips confirmation only after the
plan is printed. `add`/`remove`/`setup` merge or remove only the `pi-task-exec`
entry, preserve unrelated values and comments, refuse malformed or conflicting
config, and back up an existing file before an update. An install is idempotent
only for the exact managed entry: an existing entry with a different version,
local path, or extra/modified entry fields is fingerprint drift and is never
overwritten or deleted. A source-checkout install additionally requires
`--local-dev`; without it the plan reports `local_dev_required` and writes
nothing. `add skill` and `remove skill` remain deferred to the generic
`.agents/skills/` installer stage; they report pending/unavailable and write
nothing.

## Host configuration reference

Host installers are implemented for Codex, Zed, and OpenCode. The table records
the paths each adapter resolves; every write is path-boundary and symlink
checked, written through a same-directory temporary file with an atomic rename,
and backed up before an update. `remove` deletes only an entry that matches the
`pi-task-exec` managed fingerprint.

| Host | User/global config | Project config | Entry |
| --- | --- | --- | --- |
| Codex | `$CODEX_HOME/config.toml`, else `~/.codex/config.toml` | `.codex/config.toml` | TOML `[mcp_servers.pi-task-exec]` with a `command` string and `args` array |
| Zed | macOS/Linux: `$XDG_CONFIG_HOME/zed/settings.json`, else `~/.config/zed/settings.json`; Windows: `%APPDATA%\Zed\settings.json` | `.zed/settings.json` | JSONC `context_servers.pi-task-exec` with a `command` string, `args` array, and optional `env` |
| OpenCode | `OPENCODE_CONFIG`, else `$OPENCODE_CONFIG_DIR/opencode.json`, else `$XDG_CONFIG_HOME/opencode/opencode.json`, else `~/.config/opencode/opencode.json` | `opencode.json`, or an existing `opencode.jsonc` | JSONC `mcp.pi-task-exec` with `type: "local"`, a `command` array, and optional `enabled`/`environment` |

OpenCode's current supported config file names are `opencode.json` and
`opencode.jsonc`; no other name is read or written.

Codex loads project `.codex/config.toml` only for projects it trusts, and Zed
Restricted Mode ignores project `.zed/settings.json` MCP servers until the
worktree is trusted. The installer surfaces this in the plan and `doctor`, and
does not grant either trust. OpenCode reads a custom config file from
`OPENCODE_CONFIG` and a custom config directory from `OPENCODE_CONFIG_DIR`; the
inline `OPENCODE_CONFIG_CONTENT` value is never written and is reported as a
runtime override. `OPENCODE_DISABLE_PROJECT_CONFIG` disables the project file.
Skill installation still reports pending/unavailable.

The runtime launch entry depends on how the CLI is run. From an installed
package it is `npx -y @zguiyang/pi-task-exec@<version> mcp serve`. From a source
checkout it is `node <absolute-checkout>/mcp/dist/index.js mcp serve`, and the
install is refused unless `--local-dev` is passed; the installer never
represents that local path as the published npm package. An explicit absolute
`CODEX_HOME`, `OPENCODE_CONFIG`, `OPENCODE_CONFIG_DIR`, or `XDG_CONFIG_HOME`
override is honoured as that user's chosen config location rather than failing
with a generic path error.

| Environment variable | Used by | Purpose |
| --- | --- | --- |
| `PI_TASK_EXEC_LAUNCH_MODE` | launcher | Force `npm` or `checkout` launch mode instead of auto-detection |
| `CODEX_HOME` | Codex | User config directory (default `~/.codex`) |
| `XDG_CONFIG_HOME` | Zed, OpenCode | Base config directory when the host-specific override is unset |
| `APPDATA` | Zed (Windows) | Windows user config base for `Zed\settings.json` |
| `OPENCODE_CONFIG` | OpenCode | Custom config file path |
| `OPENCODE_CONFIG_DIR` | OpenCode | Custom global config directory |
| `OPENCODE_CONFIG_CONTENT` | OpenCode | Inline runtime config; never written, only reported |
| `OPENCODE_DISABLE_PROJECT_CONFIG` | OpenCode | Ignore the project `opencode.json` |

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
