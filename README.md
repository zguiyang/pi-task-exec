# Pi TaskExec

Pi TaskExec delegates well-defined coding tasks to local [Pi](https://pi.dev)
workers through MCP, letting the main agent focus on planning, decisions, and
review while reducing the hassle of switching between agents and manually
copying context.

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

- Runs tasks on local Pi using its locally configured default model.
- Full worker lifecycle: spawn, status, steer, continue, abort, and list.
- Read-only `inspect` and read/write `implement` capability profiles.
- `direct` in-place or isolated `worktree` working-directory modes.
- One unified MCP + `pi-delegate` Skill setup for Codex, Zed, and OpenCode.

## Requirements

- Node.js >= 22.20
- An installed and configured [`pi`](https://pi.dev) executable
- Git when using `worktree` mode

## Quick start

From the project you want to configure, run the unified setup:

```sh
npx -y @zguiyang/pi-task-exec@latest setup
```

It prompts for host and scope, prints the planned MCP and Skill writes, and
asks for confirmation. To specify the selections up front (confirmation still
applies):

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
- Delegation policy: [skills/pi-delegate/SKILL.md](skills/pi-delegate/SKILL.md)
- License: [LICENSE](LICENSE)

---

[English](README.md) | [简体中文](README.zh-CN.md)
