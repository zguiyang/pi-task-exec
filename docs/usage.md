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
| `setup` | Keyboard multi-select of hosts and one scope; plan and install the MCP entry and/or `pi-delegate` Skill. |
| `update` | Keyboard multi-select of hosts and one scope; in-place update of already-installed MCP and Skill components. |
| `uninstall` | Remove the managed `pi-task-exec` MCP entries only; the shared Skill is retained unless explicitly requested. |
| `add mcp` | Plan and write the MCP entry for one host. |
| `remove mcp` | Remove the managed MCP entry only, for one host. |
| `add skill` | Install the `pi-delegate` Skill. |
| `remove skill` | Not supported yet; reports as unsupported. |
| `doctor` | Read-only environment, host, and version check. |

### Common options

| Option | Applies to | Purpose |
| --- | --- | --- |
| `--host <name>` | setup/update/uninstall/add/remove | One of `codex`, `zed`, `opencode`. Repeatable for `setup`, `update`, and `uninstall` (one host per flag); `add`/`remove` take one host per run. |
| `--scope <name>` | setup/update/uninstall/add/remove | Exactly one of `project` or `global` per run, shared by every selected host. |
| `--remove-skill` | `uninstall` only | Explicitly remove the shared `pi-delegate` Skill after an ownership check. |
| `--target <name>` | `setup` only | `mcp`, `skill`, or `both`; overrides the combined plan. |
| `--dry-run` | write commands | Print the full plan and exit without writing. |
| `--json` | all commands | Stable machine-readable output; never prompts. |
| `--yes` | write commands | Non-interactive compatibility flag; never overrides unsafe-path checks. |
| `--interactive`, `-i` | write commands | Force prompting for missing selections on a TTY. |
| `--local-dev` | source checkout | Allow an absolute local checkout launch entry. |
| `--npm-prefix <dir>` | MCP install/update | Independent npm resolution directory without `package.json` or `node_modules`. |
| `--require-mcp` | Codex MCP install/update | Write the native `required = true` field. |
| `--probe` | `doctor` only | Handshake with the package MCP; never creates a worker. |

On a TTY, `setup`, `update`, and `uninstall` open a keyboard multi-select for
the hosts (`codex`, `zed`, `opencode`) and a single selection for `project` or
`global`; `--host` and `--scope` prefill those selections. A routine TTY run
prints a concise result per selected host — what changed, the final status,
and the next step (restart the host and verify `pi_list`) — and does not print
the full plan or ask for a `Proceed?` confirmation.

`--dry-run` prints the full plan with absolute paths, conflicts, backups, and
warnings, then exits without writing. A conflict blocks the affected target.
`--json` prints the stable machine-readable plan and result and never prompts.
Without a TTY, selections must come from the flags, where a missing `--host`
or `--scope` is an error instead of a prompt. Unsafe Skill replacement is
reported rather than silently approved by `--yes`.

## Manual launch and host configuration

The published launch contract is:

```text
command: npx
args:    -y @zguiyang/pi-task-exec@latest mcp serve
```

> v0.3.1 is the current published release. This checkout updates delegation
> guidance without selecting the next release version; `@latest` still resolves
> to the published version.
> The worker API documented here is unchanged from that release; upgrading
> from v0.2.2 requires the migration below.

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

## Skill installation and version

`setup` and `add skill` install the bundled `pi-delegate` Skill through the
pinned Vercel Skills CLI `skills@1.7.1` (launched as
`npx -y skills@1.7.1 ...`), with structured arguments and `shell: false`. The
fixed source is `https://github.com/zguiyang/pi-task-exec` (normalized
`zguiyang/pi-task-exec`), subpath `skills/pi-delegate`. A release install uses
the exact `v<packageVersion>` tag for a published package; a source checkout uses
the pinned commit `f914707fa22fd658f50e059a5091440796ef39e0`. There is no
fallback to `main` or `@latest`. The installer verifies the installed
`SKILL.md` frontmatter and the lockfile source/ref before reporting success;
the copy is not transactional and provides no rollback. The bundled Skill
carries MCP-metadata `version: "6"` for the updated delegation policy. `remove skill` is
not supported yet; removing the shared Skill is only offered through
`uninstall` as an explicit, opt-in step (see
[Uninstalling](#uninstalling)).

## Uninstalling

`uninstall` removes only the managed `pi-task-exec` MCP entries for the
selected hosts and one scope. Unrelated MCP servers and the rest of each
host's configuration are left untouched. It accepts repeated `--host` flags,
exactly one `--scope`, `--remove-skill` for explicit shared Skill removal, and
the usual `--dry-run` and `--json` output modes.

The shared `pi-delegate` Skill is retained by default: other projects and
hosts may rely on the same copy. Nothing about the Skill changes unless its
removal is explicitly requested in the uninstall flow. When it is explicitly
requested, the CLI prints a warning that the Skill is shared, detects
references in the known Codex, Zed, and OpenCode configuration locations,
reports which known hosts still reference it. Choosing Skill removal is the
explicit approval; there is no second confirmation prompt.

`add` and `remove` remain available as the single-target subcommands;
`remove mcp` still removes only the managed MCP entry for one host.

## Choosing whether to delegate

Use Pi when a bounded task benefits from independent context, investigation,
review, or a separate model. Give it one goal, the relevant context and scope,
an expected result, and a stopping condition. The worker may reason and choose
steps within that scope. The supervisor decides any broader change and reviews
the result. Match verification to risk; a task does not require every stage of
a development lifecycle.

| Situation | Practical choice |
| --- | --- |
| A simple UI defect is already located | Fix it directly and run a focused check. |
| A module fails for an unknown reason | Delegate an `inspect` investigation; request code evidence and a conclusion. |
| Two technical approaches need comparison | Delegate read-only analysis; request tradeoffs and risks without edits. |
| A backend endpoint has a settled contract | Delegate `implement` in an authorized cwd; request the endpoint and relevant checks only. |
| Related work was interrupted and its worker is still live | Use `pi_continue` with that worker ID and avoid repeating settled investigation. |

`inspect` cannot run shell commands. For shell-based checks, authorize
`implement` and account for possible writes. A worker does not create or manage
worktrees. Stop once the requested result is reached; record unrelated findings
for a separate decision.

## Worker tools

| Tool | Purpose |
| --- | --- |
| `pi_spawn` | Start a bounded worker with a task, absolute cwd, optional profile, model, thinking, and task timeout. |
| `pi_status` | Read the current snapshot and optional cycle result, optionally waiting up to 30000 ms. |
| `pi_steer` | Correct the current task of a running worker. |
| `pi_continue` | Queue a related follow-up into the running cycle, or start a new cycle once settled/failed. |
| `pi_abort` | Cancel the running cycle only; keeps the process continuable. |
| `pi_release` | Terminate the process and free the live-worker slot, preserving a completed result. |
| `pi_list` | Return a snapshot of live workers. |

Profiles: `inspect` (default) exposes only read-only tools (`read`, `grep`,
`find`, `ls`); `implement` adds `edit`, `write`, and `bash`. The Supervisor
chooses `cwd`; the MCP verifies the real path against the allowed roots but
never creates a worktree or branch. Optional per-worker `model` and `thinking`
overrides are validated and applied when the worker starts. A successful spawn
or continuation means Pi accepted the work, not that the result is correct;
the supervising agent must inspect the authoritative `result` before
acceptance.

Cycles: each activity run ends at `agent_settled` and carries a positive,
monotonically increasing `cycleId`. A `pi_continue` while the worker is running
is queued into the **same** current cycle; only a `pi_continue` after settlement
or a failed cycle starts a **new** cycle. `pi_status.cycleId` (>= 1) waits for
that cycle's boundary but always returns the current snapshot, so read the
matching entry from the bounded `cycles` history (or the current `result`).
`pi_abort` cancels the running cycle and keeps the process continuable; a
completed idle cycle is unchanged. `pi_release` terminates the process and
frees the slot while preserving a completed result. Only a released worker or a
dead process cannot be continued. The `result` is reset when a new cycle
starts; up to `maxCycles` (default 10) previous cycles are archived, and result
text is capped at `maxResultChars` (default 256000) characters with a
`truncated` flag and original `chars` count.

## Runtime environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `PI_WORKER_COMMAND` | `pi` | Pi executable. |
| `PI_WORKER_MAX_WORKERS` | `4` | Maximum live workers. |
| `PI_WORKER_RPC_TIMEOUT_MS` | `15000` | Per-RPC timeout. |
| `PI_WORKER_IDLE_TIMEOUT_MS` | `600000` | Idle deadline; `0` disables it. |
| `PI_WORKER_TASK_TIMEOUT_MS` | `3600000` | Activity-cycle deadline. |
| `PI_WORKER_MAX_RESULT_CHARS` | `256000` | Maximum authoritative `result` text; longer results set `truncated` and keep the original `chars`. |
| `PI_WORKER_MAX_CYCLES` | `10` | Maximum previous cycles retained per worker snapshot. |
| `PI_WORKER_MAX_ARCHIVED` | `25` | Maximum released worker snapshots retained in `pi_list`. |
| `PI_WORKER_ALLOWED_ROOTS` | Host Roots, else server cwd | Explicit allowed-roots override. |

Host config locations can be overridden with `CODEX_HOME`, `XDG_CONFIG_HOME`,
`OPENCODE_CONFIG`, and `OPENCODE_CONFIG_DIR`. Pi reads its own local
authentication configuration; no secret environment variable is needed here.

## Current limitations

- `remove skill` is not supported yet and reports as unsupported.
- `uninstall` retains the shared `pi-delegate` Skill by default; the Skill is
  untouched unless its removal is explicitly requested.
- Skill installation is not transactional; no rollback is provided.
- Saving a configuration does not establish a live host connection; verify
  `pi_list` in the host. `doctor --probe` checks only the package runtime.
- Profiles are not an operating-system security sandbox. There is no
  `allowedWriteScope` parameter; the file boundary is textual in the task and
  must be verified after the worker runs.
- Workers are in-memory and are not durable across an MCP restart or host
  reconnection. Release a completed worker with `pi_release`; `pi_abort`
  cancels the current execution only.
- Global install scope does not grant workers access to all projects.
- `update` replaces the managed MCP entry and Skill files; previously set
  custom options must be supplied again.

## Version compatibility (v0.3.0)

v0.3.0 introduced an intentional breaking interface change from v0.2.2,
which used the older `mode` interface and six tools. It remains in this checkout.
The MCP now exposes seven tools: `pi_spawn`, `pi_status`, `pi_steer`, `pi_continue`,
`pi_abort`, `pi_release`, and `pi_list`.

- The `pi_spawn` `mode` parameter is removed. Pass the desired absolute `cwd`
  directly; the MCP never creates a worktree or branch. It does not delete any
  existing worktree.
- `pi_spawn` gains an optional `thinking` level, and `profile` now defaults to
  `inspect`. Pass `implement` explicitly for writes or shell commands.
- `pi_status` gains optional `waitMs` (bounded wait) and `cycleId`; `pi_abort`
  cancels the running cycle only (keeping the process continuable, and a
  no-op that preserves a completed idle result); `pi_release` terminates the
  process and frees the slot, preserving a completed result.
- Task outcome is reported as a cycle `result` separate from diagnostics, reset
  when a new cycle starts and archived in a bounded `cycles` history.

Old callers must drop `mode` and update their Skill copy; previously installed
Skill files are replaced by `update`. Old `workerId` values are in-memory only
and cannot be recovered across an MCP restart or instance, so start a new
Worker. Existing Git worktrees or branches created by an older runtime are not
automatically removed. See [release-v0.3.0.md](release-v0.3.0.md) for the full
change list.

See the delegation policy in
[skills/pi-delegate/SKILL.md](../skills/pi-delegate/SKILL.md) and the license in
[LICENSE](../LICENSE).

---

[English](../README.md) | [简体中文](../README.zh-CN.md)
