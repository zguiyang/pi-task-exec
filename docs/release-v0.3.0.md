# Pi TaskExec v0.3.0

v0.3.0 is a breaking interface release. It removes MCP-side worktree
management, makes the calling agent supply the working directory, and replaces
the previous six `pi_*` tools with a seven-tool, cycle-based lifecycle.

## Changes

- `pi_spawn` no longer accepts `mode`. `task` and an absolute `cwd` are
  required; the MCP only verifies that the real path exists inside the allowed
  roots. It never creates, clones, or removes a worktree, branch, or directory,
  and never changes the supplied directory.
- `profile` now defaults to `inspect`. `inspect` exposes only read-only tools
  (`read`, `grep`, `find`, `ls`); pass `implement` explicitly for `edit`,
  `write`, `bash`, or any shell-based verification.
- Optional per-worker `thinking` level: `off`, `minimal`, `low`, `medium`,
  `high`, `xhigh`, `max`. The requested level is validated against the active
  model, applied, and read back before the task starts; an unsupported level, a
  rejected change, or a readback mismatch fails the spawn with a structured
  error instead of being silently ignored.
- Optional per-worker `model` override must resolve uniquely in the Worker's
  local Pi environment; an unavailable or ambiguous value fails the spawn
  rather than guessing.
- Activity cycles: each run ends at `agent_settled` and carries a positive,
  monotonically increasing `cycleId`. A `pi_continue` while a worker is running
  is queued into the same current cycle; only a `pi_continue` after settlement
  or a failed cycle starts a new cycle on the same process.
- Authoritative results are separated from diagnostics: the `result` is the
  full final assistant message for the latest completed cycle, independent of
  streamed deltas, stderr, or progress events. It is reset when a new cycle
  starts, and previous cycles remain in a bounded `cycles` archive
  (`maxCycles`, default 10). Result text is capped at `maxResultChars`
  (default 256000) characters, with a `truncated` flag and the original `chars`.
- `pi_status` returns an immediate snapshot by default and gains a bounded
  `waitMs` (0-30000) and an optional positive `cycleId` (>= 1) to wait for a
  cycle boundary. It always returns the current snapshot; a wait timeout never
  cancels the worker.
- `pi_abort` cancels only the current running cycle, without releasing the
  process or the live-worker slot. A worker with no running cycle is returned
  unchanged, preserving its completed result, and a continuable worker can be
  continued after abort while its process is alive.
- New `pi_release` terminates the process and frees the live-worker slot.
  Releasing a settled or failed worker preserves its authoritative result and
  failure; releasing a running worker cancels and terminates it. Release is
  idempotent, and a failed release can be retried.
- The MCP exposes exactly seven tools: `pi_spawn`, `pi_status`, `pi_steer`,
  `pi_continue`, `pi_abort`, `pi_release`, and `pi_list`.
- The bundled `pi-delegate` Skill metadata moves to `version: "5"` to match the
  seven-tool contract. The Skill and contract are installed from this repository
  at the matching release tag.

## Breaking changes and migration from v0.2.2

- Remove `mode` from every `pi_spawn` call and pass the intended absolute `cwd`.
  The MCP no longer creates a worktree or branch.
- Replace `mode: "worktree"` usage with your own directory or Git worktree
  management.
- Pass `profile: "implement"` for any code change or shell-based verification;
  the default `inspect` profile is read-only.
- Run `update` to refresh the installed `pi-delegate` Skill; an old Skill copy
  still describes the `mode` interface.
- Old `workerId` values are in-memory only and cannot be recovered across an
  MCP restart or host reconnection; start a new worker.
- Existing Git worktrees or branches created by an older runtime are not
  removed automatically.

## Validation and compatibility

The v0.3.0 Skill contract is checked against the registered MCP tool names and
input schemas. The release requires Node.js >=22.20.0 and a configured local
`pi` executable. It supports the existing Codex, Zed, and OpenCode setup flows;
after updating, restart the Host and verify `pi_list` is available. This
release does not change the npm package or MCP Registry version beyond v0.3.0.

## Install and update

```sh
npx -y @zguiyang/pi-task-exec@0.3.0 setup
```

For an existing managed installation:

```sh
npx -y @zguiyang/pi-task-exec@0.3.0 update
```

MCP launch configurations continue to use `@latest`, which resolves to v0.3.0.
The runtime requires Node.js >=22.20.0 and a configured local `pi` executable.
Restart and trust the Host as required, then verify `pi_list` there.
