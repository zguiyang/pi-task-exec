# @zguiyang/pi-worker-mcp

A host-agnostic MCP worker runtime for supervising local [Pi](https://pi.dev) coding-agent processes. It uses local stdio MCP and Pi RPC; it is not a hosted service and does not manage Pi credentials, providers, or default models.

## Quick start

Prerequisites: Node.js 20+, a locally installed and configured `pi` executable, and Git when using isolated worktrees.

```sh
npx -y @zguiyang/pi-worker-mcp@latest setup
```

The setup command selects supported hosts and pins their launch configuration to the exact CLI version. A host never silently drifts to a new release.

## Supported hosts and scope

| Host | Global | Project | Configuration |
| --- | --- | --- | --- |
| Codex | `~/.codex/config.toml` | `.codex/config.toml` | TOML `mcp_servers` |
| Zed | `~/.zed/settings.json` on macOS | `.zed/settings.json` | JSON `context_servers` |
| OpenCode | `~/.config/opencode/opencode.json` | `opencode.json` | JSON `mcp.servers` |

Project scope is relative to the directory where `setup` runs. Zed starts project-defined MCP servers only after the worktree is trusted. Existing configuration is minimally merged; uninstall removes only this server’s entry.

```sh
npx -y @zguiyang/pi-worker-mcp@0.1.1 setup --host codex --scope project
npx -y @zguiyang/pi-worker-mcp@0.1.1 setup --host opencode --scope global
```

## Manual / generic MCP configuration

Any stdio MCP client can launch:

```text
command: npx
args:    -y @zguiyang/pi-worker-mcp@0.1.1 serve
```

This is the release configuration. Do not point user installations at a checkout’s `dist/` directory.

## Commands

```text
pi-worker-mcp serve
pi-worker-mcp setup [--host codex|zed|opencode] [--scope project|global]
pi-worker-mcp doctor [--host …] [--scope …]
pi-worker-mcp update [--host …] [--scope …]
pi-worker-mcp uninstall [--host …] [--scope …]
pi-worker-mcp version
```

`doctor` checks Node, the local Pi executable, and selected host configuration without starting a model task or exposing credentials. `update` is not a package manager: run a newer CLI via npm/npx and it updates only selected configuration pins. `uninstall` never removes a whole host config, Pi config, Skills, or npm cache.

## Model ownership and host independence

Pi owns provider authentication, available models, and its default model. The worker runtime can validate an optional per-worker override and report the effective model, but never configures credentials. Core runtime behavior—Pi RPC, lifecycle, model semantics, concurrency, and permissions—is independent of Codex, Zed, and OpenCode. Host adapters only read, merge, and remove launch configuration.

## MCP tools

`pi_spawn`, `pi_status`, `pi_steer`, `pi_continue`, `pi_abort`, and `pi_list` supervise bounded local workers. Successful spawn/continuation means Pi accepted work, not that it is correct; the supervising agent must inspect results and integrate changes. Use `worktree` mode for isolated implementation work.

## Runtime configuration

| Environment variable | Default | Purpose |
| --- | --- | --- |
| `PI_WORKER_COMMAND` | `pi` | Pi executable |
| `PI_WORKER_MAX_WORKERS` | `4` | Maximum live workers |
| `PI_WORKER_RPC_TIMEOUT_MS` | `15000` | Per-RPC timeout |
| `PI_WORKER_IDLE_TIMEOUT_MS` | `600000` | Idle deadline; `0` disables it |
| `PI_WORKER_TASK_TIMEOUT_MS` | `3600000` | Activity-cycle deadline |
| `PI_WORKER_ALLOWED_ROOTS` | current directory | Path-delimited allowed roots |

No secret environment variable is required; Pi reads its own local authentication configuration.

## Development from source

Source mode is only for contributors:

```sh
npm install
npm run build
node dist/index.js serve
```

For release-equivalent testing, use `npm pack` and execute the resulting `.tgz` from a clean temporary directory. `npm link` is not package acceptance.

## Registry metadata

`server.json` follows the official MCP Registry schema and declares an npm stdio package representation. npm and Registry publication remain separate, explicit actions.

## License

[MIT](LICENSE)
