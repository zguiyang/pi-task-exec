# Pi TaskExec v0.2.0

This release improves local MCP startup diagnostics and CLI interaction while
preserving the six `pi_*` tools and the Host-independent Pi execution layer.

## Changes

- Use Clack for Agent/Scope selection and default-No confirmation. Restore the
  terminal on cancellation, stream errors and handled interruption.
- Keep normal output concise: show destinations and approval risks before
  confirmation, then report the result. Retain detailed JSON and doctor output.
- Support interactive MCP removal with project/global scope selection. Remove
  only the managed entry and preserve unrelated Host settings.
- Add `doctor --probe`: verify initialization, discovery and `pi_list` with the
  official MCP client SDK, without creating a Worker.
- Add optional `--npm-prefix` to isolate npm package resolution without changing
  MCP cwd. This avoids a reproduced same-name/version source-package collision.
- Add opt-in Codex-native `--require-mcp`; other Hosts retain their own readiness
  policies. Updates preserve previously selected launch/readiness options.
- Use standard MCP Roots when advertised by the Host. Explicit
  `PI_WORKER_ALLOWED_ROOTS` takes precedence; invalid, unavailable or empty
  negotiated Roots deny Worker starts. Hosts without Roots retain cwd fallback.

## Install and update

```sh
npx -y @zguiyang/pi-task-exec@0.2.0 setup
```

For an existing managed installation:

```sh
npx -y @zguiyang/pi-task-exec@0.2.0 update
```

Review the plan before approving. Custom or ambiguous configuration changes are
protected and may require manual review. Project/global installation scope does
not grant Workers access to arbitrary directories. Restart/trust the Host as
required and verify `pi_list` there; successful package diagnostics do not prove
that a running Host has exposed the tools.

Requires Node.js >=22.20.0. The bundled `pi-delegate` Skill is distributed from
this repository's matching `v0.2.0` tag; no separate Skill package is published.
