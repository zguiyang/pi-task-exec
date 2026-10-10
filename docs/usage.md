# Pi TaskExec usage guide

Detailed, user-facing reference for the `pi-task-exec` CLI, manual host
configuration, worker tools, runtime environment, and current limits. For the
product overview and quick start see [README](../README.md).

## Commands

| Command | Purpose |
| --- | --- |
| `pi-task-exec` / `--help` | Print help and exit; never starts MCP. |
| `--version` | Print the package version and exit. |
| `mcp serve` | Start the MCP stdio runtime (only server-start command). |
| `setup` | Plan and install the MCP entry and/or `pi-delegate` Skill. |
| `update` | In-place update of already-installed MCP and Skill components. |
| `add mcp` | Plan and write the MCP entry. |
| `remove mcp` | Remove the managed MCP entry only. |
| `add skill` | Install the `pi-delegate` Skill. |
| `remove skill` | Not supported yet; reports as unsupported. |
| `doctor` | Read-only environment, host, and version check. |

### Common options

| Option | Applies to | Purpose |
| --- | --- | --- |
| `--host <name>` | install/remove/setup/update | One of `codex`, `zed`, `opencode`. |
| `--scope <name>` | install/remove/setup/update | `project` or `global`. |
| `--target <name>` | `setup` only | `mcp`, `skill`, or `both`; overrides the combined plan. |
| `--dry-run` | write commands | Print the plan and exit without writing. |
| `--json` | all commands | Stable machine-readable output; never prompts. |
| `--yes` | write commands | Skip confirmation after the plan is printed. |
| `--interactive`, `-i` | write commands | Force prompting for missing selections on a TTY. |
| `--local-dev` | source checkout | Allow an absolute local checkout launch entry. |
| `--npm-prefix <dir>` | MCP install/update | Independent npm resolution directory without `package.json` or `node_modules`. |
| `--require-mcp` | Codex MCP install/update | Write the native `required = true` field. |
| `--probe` | `doctor` only | Handshake with the package MCP; never creates a worker. |

Write commands print a plan with absolute paths, conflicts, backups, and
warnings, then revalidate before writing. Conflicts block the whole operation.
On a TTY, missing `--host`/`--scope` are prompted. With `--json`, missing
selections are an error instead of a prompt. `--yes` cannot bypass the
existing-Skill replacement confirmation.

## Manual launch and host configuration

The published launch contract is:

```text
command: npx
args:    -y @zguiyang/pi-task-exec@latest mcp serve
```

Add the equivalent entry to each host's config file. Restart the host and
verify `pi_list` inside it after any change.

| Host | Global config | Project config |
| --- | --- | --- |
| Codex | `$CODEX_HOME/config.toml`, else `~/.codex/config.toml` | `.codex/config.toml` |
| Zed | `$XDG_CONFIG_HOME/zed/settings.json`, else `~/.config/zed/settings.json`; Windows `%APPDATA%\Zed\settings.json` | `.zed/settings.json` |
| OpenCode | `$OPENCODE_CONFIG`, else `$OPENCODE_CONFIG_DIR/opencode.json`, else `$XDG_CONFIG_HOME/opencode/opencode.json`, else `~/.config/opencode/opencode.json` | `opencode.json`, or an existing `opencode.jsonc` |

### Codex (`.codex/config.toml`)

```toml
[mcp_servers.pi-task-exec]
command = "npx"
args = ["-y", "@zguiyang/pi-task-exec@latest", "mcp", "serve"]
```

### Zed (`.zed/settings.json`)

```json
{
  "context_servers": {
    "pi-task-exec": {
      "command": "npx",
      "args": ["-y", "@zguiyang/pi-task-exec@latest", "mcp", "serve"]
    }
  }
}
```

### OpenCode (`opencode.json`)

```json
{
  "mcp": {
    "pi-task-exec": {
      "type": "local",
      "command": ["npx", "-y", "@zguiyang/pi-task-exec@latest", "mcp", "serve"],
      "enabled": true
    }
  }
}
```

Codex loads a project config only for trusted projects, and Zed Restricted
Mode ignores project MCP servers until the worktree is trusted. The installer
does not grant that trust. From a source checkout, build first and pass
`--local-dev` to write a local `node .../dist/cli/index.js mcp serve` entry;
without it the plan reports `local_dev_required` and writes nothing.

## Worker tools

| Tool | Purpose |
| --- | --- |
| `pi_spawn` | Start a bounded worker with a task, cwd, mode, and profile. |
| `pi_status` | Read a worker's progress and terminal result. |
| `pi_steer` | Correct the current task of a running worker. |
| `pi_continue` | Continue a related follow-up in the same worker. |
| `pi_abort` | Stop or release a worker. |
| `pi_list` | Return a snapshot of live workers. |

Profiles: `inspect` exposes only read-only tools (`read`, `grep`, `find`,
`ls`); `implement` adds `edit`, `write`, and `bash`. Modes: `direct` writes in
place; `worktree` creates an isolated Git worktree. A successful spawn or
continuation means Pi accepted the work, not that the result is correct; the
supervising agent must inspect results before acceptance.

## Runtime environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `PI_WORKER_COMMAND` | `pi` | Pi executable. |
| `PI_WORKER_MAX_WORKERS` | `4` | Maximum live workers. |
| `PI_WORKER_RPC_TIMEOUT_MS` | `15000` | Per-RPC timeout. |
| `PI_WORKER_IDLE_TIMEOUT_MS` | `600000` | Idle deadline; `0` disables it. |
| `PI_WORKER_TASK_TIMEOUT_MS` | `3600000` | Activity-cycle deadline. |
| `PI_WORKER_ALLOWED_ROOTS` | Host Roots, else server cwd | Explicit allowed-roots override. |

Host config locations can be overridden with `CODEX_HOME`, `XDG_CONFIG_HOME`,
`OPENCODE_CONFIG`, and `OPENCODE_CONFIG_DIR`. Pi reads its own local
authentication configuration; no secret environment variable is needed here.

## Current limitations

- `remove skill` is not supported yet and reports as unsupported.
- Skill installation is not transactional; no rollback is provided.
- Saving a configuration does not establish a live host connection; verify
  `pi_list` in the host. `doctor --probe` checks only the package runtime.
- Profiles and modes are not an operating-system security sandbox.
- `worktree` starts from Git `HEAD`; uncommitted and untracked changes are not
  included, and the worktree is not merged or deleted automatically.
- There is no `allowedWriteScope` parameter; the file boundary is textual in
  the task and must be verified after the worker runs.
- Workers are in-memory and are not durable across an MCP restart or host
  reconnection.
- Global install scope does not grant workers access to all projects.
- `update` replaces the managed MCP entry and Skill files; previously set
  custom options must be supplied again.

See the delegation policy in
[skills/pi-delegate/SKILL.md](../skills/pi-delegate/SKILL.md) and the license in
[LICENSE](../LICENSE).

---

[English](../README.md) | [简体中文](../README.zh-CN.md)
