# Pi TaskExec v0.3.1

v0.3.1 aligns the host-neutral delegation guidance shown to supervising agents.
It does not change the seven MCP tool names, input schemas, Worker profiles, or
activity-cycle behavior introduced in v0.3.0.

## Changes

- The `pi_spawn` tool description and MCP server instructions now match the
  bundled `pi-delegate` Skill: delegate a bounded execution task by default
  once its objective, context, boundary, completion check, and side effects
  are clear. Task size alone is not a gate.
- The descriptions retain the Supervisor's responsibility for requirements,
  architecture, risk, authorization, coordination, integration, and final
  acceptance. An extremely low-cost action may stay with the Supervisor when
  delegation plainly adds no useful execution boundary.
- The Skill's discovery description states its trigger more directly. The
  reference contract and MCP discovery checks use the same policy.

## Updating an existing installation

Update the installed Skill as well as the MCP package, then restart the Host:

```sh
npx -y @zguiyang/pi-task-exec@0.3.1 update
```

An MCP entry using `@latest` can resolve the new runtime while an old copied
Skill remains installed; the update step keeps their guidance aligned. Verify
that `pi_list` is available after restart. The v0.2.2 to v0.3.0 interface
migration still applies to older installations.

## Validation

- Package, CLI, MCP, and Registry metadata versions are synchronized at
  `0.3.1`; the official MCP Registry validator accepts `server.json`.
- The local suite passes 288/288 tests, and typecheck and build pass.
- The release tarball contains the CLI, MCP runtime, Skill, and reference.
  A clean temporary installation reports CLI and MCP version `0.3.1`, exposes
  seven tools, and returns the aligned `pi_spawn` description.
