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
- One unified MCP + `pi-delegate` Skill setup for Codex, Zed, and OpenCode.

## Requirements

- Node.js >= 22.20
- An installed and configured [`pi`](https://pi.dev) executable

## Quick start

From the project you want to configure, run the unified setup:

```sh
npx -y @zguiyang/pi-task-exec@latest setup
```

> v0.3.1 is the current published release. This checkout prepares v0.3.2 with
> optional delegation guidance. The v0.3.0 worker-interface changes still apply;
> if you are upgrading from v0.2.2, follow the
> [v0.3.0 migration notes](docs/usage.md#version-compatibility-v030).

It prompts for host and scope, prints the planned MCP and Skill writes, and
asks for confirmation. The `pi-delegate` Skill is installed from this
repository (`skills/pi-delegate`) at the matching release tag through
the pinned Skills CLI `skills@1.7.1`. To specify the selections up front
(confirmation still applies):

```sh
npx -y @zguiyang/pi-task-exec@latest setup --host codex --scope project
```

Restart the host afterward, grant project trust if asked, and verify that
`pi_list` is available inside the host.

## Commands

```sh
npx -y @zguiyang/pi-task-exec@latest update
npx -y @zguiyang/pi-task-exec@latest doctor
npx -y @zguiyang/pi-task-exec@latest doctor --probe
```

`update` replaces the managed MCP entry and Skill files, so previously
configured custom settings must be supplied again. `doctor` is read-only;
`--probe` checks the package runtime only and never creates a worker.

## Learn more

- Full usage reference: [docs/usage.md](docs/usage.md)
- v0.3.2 release preparation: [docs/release-v0.3.2.md](docs/release-v0.3.2.md)
- v0.3.1 release notes: [docs/release-v0.3.1.md](docs/release-v0.3.1.md)
- v0.2.2 → v0.3.0 migration: [docs/usage.md](docs/usage.md#version-compatibility-v030)
- Delegation policy: [skills/pi-delegate/SKILL.md](skills/pi-delegate/SKILL.md)
- License: [LICENSE](LICENSE)

---

[English](README.md) | [简体中文](README.zh-CN.md)
