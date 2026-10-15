# Pi TaskExec

Pi TaskExec lets a supervising agent assign bounded, independent investigation,
analysis, implementation, and verification tasks to local [Pi](https://pi.dev)
workers through MCP. The agent can also work directly when delegation would
add more overhead than value.

The project grew out of the author's own workflow: using different models or
subscription plans for planning and review versus execution. If you also have
multiple AI coding subscriptions or model resources, you can try this division
of work to make better use of them and keep execution details from crowding
the main agent's context.

The author is still evaluating how this approach affects context usage, total
token consumption, and actual costs; savings are not guaranteed. It addresses
the author's own collaboration needs and may help others with similar
workflows. You're welcome to try it and share your experiences, alternative
views, or suggestions via
[Issues](https://github.com/zguiyang/pi-task-exec/issues).

[English](README.md) | [简体中文](README.zh-CN.md)

## Highlights

- Runs tasks on local Pi using its locally configured default model, with optional per-worker `model` and `thinking` overrides.
- Full worker lifecycle: spawn, status with bounded wait, steer, continue, cancel (`pi_abort`), and release (`pi_release`), plus list.
- Read-only `inspect` (default) and read/write `implement` capability profiles.
- The Supervisor chooses the working directory; the MCP verifies authorization but never creates worktrees or branches.
- One unified MCP + `pi-delegate` Skill setup with keyboard multi-select across Codex, Zed, and OpenCode.

## Requirements

- Node.js >= 22.20
- An installed and configured [`pi`](https://pi.dev) executable

## Quick start

From the project you want to configure, run the unified setup:

```sh
npx -y @zguiyang/pi-task-exec@latest setup
```

> v0.3.1 is the current published release. This checkout updates delegation
> guidance; the next version will be chosen after the planned features are complete.
> The v0.3.0 worker-interface changes still apply;
> if you are upgrading from v0.2.2, follow the
> [v0.3.0 migration notes](docs/usage.md#version-compatibility-v030).

On a TTY it opens a keyboard multi-select for the hosts (`codex`, `zed`,
`opencode`) plus a single scope (`project` or `global`), then runs and prints
a concise result; a routine run does not print the full plan and does not ask
for a `Proceed?` confirmation. Use `--dry-run` for the full plan (paths,
conflicts, warnings) and `--json` for stable machine-readable detail. The
`pi-delegate` Skill is installed from this repository (`skills/pi-delegate`)
at the matching release tag through the pinned Skills CLI `skills@1.7.1`.
Selections can also be given up front: `--host` may be repeated for several
hosts, and exactly one `--scope` applies to the whole run:

```sh
npx -y @zguiyang/pi-task-exec@latest setup --host codex --host zed --scope project
```

Restart each selected host afterward, grant project trust if asked, and
verify that `pi_list` is available inside the host.

## Commands

```sh
npx -y @zguiyang/pi-task-exec@latest update
npx -y @zguiyang/pi-task-exec@latest uninstall
npx -y @zguiyang/pi-task-exec@latest doctor
npx -y @zguiyang/pi-task-exec@latest doctor --probe
```

`setup`, `update`, and `uninstall` share the same keyboard multi-select of
hosts and one scope, and also accept repeated `--host` flags. `update`
replaces the managed MCP entry and Skill files, so previously configured
custom settings must be supplied again.

`uninstall` removes only the managed `pi-task-exec` MCP entries for the
selected hosts and scope. The shared `pi-delegate` Skill is retained by
default; it is removed only when that removal is explicitly requested, which
prints a warning and reports the known hosts that still reference it first.
For a non-interactive run, add `--remove-skill` to request that removal.

The existing `add` and `remove` subcommands (`add mcp`, `add skill`,
`remove mcp`, `remove skill`) remain available as single-target commands.
`doctor` is read-only; `--probe` checks the package runtime only and never
creates a worker.

## Learn more

- Full usage reference: [docs/usage.md](docs/usage.md)
- v0.3.1 release notes: [docs/release-v0.3.1.md](docs/release-v0.3.1.md)
- v0.2.2 → v0.3.0 migration: [docs/usage.md](docs/usage.md#version-compatibility-v030)
- Delegation policy: [skills/pi-delegate/SKILL.md](skills/pi-delegate/SKILL.md)
- License: [LICENSE](LICENSE)

---

[English](README.md) | [简体中文](README.zh-CN.md)
