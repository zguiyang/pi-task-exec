# RELEASE_STANDARD_BASELINE

Historical release baseline checked on 2026-10-08. Directory and command
references below are updated for the approved 2026-10-09 root layout; detailed
current ownership boundaries are recorded in `architecture/decision-record.md`.

Checked for Release Engineering V0.1 on 2026-10-08. Product identity updated for
Pi TaskExec v0.1.1.

## Common distribution contract

- npm exposes `pi-task-exec` through the package `bin` map of the root
  `@zguiyang/pi-task-exec` package. `npm pack` is the release-equivalent
  artifact; acceptance installs that `.tgz` into a clean temporary prefix
  instead of relying on `npm link`.
- The generic stdio launch is
  `npx -y @zguiyang/pi-task-exec@<exact-version> mcp serve`. `pi-task-exec mcp serve`
  is the only service-start contract; running `pi-task-exec` with no arguments
  prints help and does not start MCP.
- `server.json` uses the official Registry schema with the server name
  `io.github.zguiyang/pi-task-exec` and an npm package entry
  (`@zguiyang/pi-task-exec`) with `transport.type: "stdio"` and positional
  `packageArguments` `mcp` and `serve`. The Registry is metadata/discovery, not
  a requirement for any host configuration.
- The root `package.json` carries `mcpName: io.github.zguiyang/pi-task-exec` to
  match `server.json.name`; `package.json.version`, `server.json.version`, and
  `server.json.packages[].version` must stay identical and exact.
- The package ships the root build output (`dist/**`), including the MCP
  runtime (`dist/mcp/**`) and the CLI (`dist/cli/**`), plus the `pi-delegate`
  Skill (`skills/pi-delegate/**`). The CLI supports MCP `add`, `remove`,
  `setup`, and `doctor`, plus `add skill`; the combined `setup`/`update` flows
  and `remove skill` remain deferred. The package engine floor is Node
  `>=22.20.0`, matching the pinned `skills@1.7.1` Skill installer.

## Host contract

| Host | Global scope | Project scope | Entry shape |
| --- | --- | --- | --- |
| Codex | `~/.codex/config.toml` | `.codex/config.toml` | `[mcp_servers.pi-task-exec]`, command and args |
| Zed | `~/.config/zed/settings.json` (or `$XDG_CONFIG_HOME/zed/settings.json`) | `.zed/settings.json` | `context_servers.pi-task-exec`, command and args |
| OpenCode | `~/.config/opencode/opencode.json` | `opencode.json` | `mcp.pi-task-exec`, local command array |

Zed project configuration is real project scope but it is subject to worktree
trust before it may launch a local MCP server. Codex project configuration is
loaded only for trusted projects. OpenCode resolves project configuration with
higher precedence than its global configuration. All host entries must launch
`npx -y @zguiyang/pi-task-exec@<exact-version> mcp serve`.

## Intentional non-unification

The standard MCP protocol specifies transport, not a common host configuration
file or installation scope. Host adapters preserve each host's native format,
scope locations, and trust rules.

## Skill distribution contract

`pi-task-exec add skill --host <codex|zed|opencode> --scope <project|global>`
installs `pi-delegate` through the pinned Vercel Skills CLI `skills@1.7.1` from
the fixed GitHub source `https://github.com/zguiyang/pi-task-exec` (`skills/pi-delegate`
subpath). The release ref is `v${packageVersion}`; source-checkout validation
uses the full commit `f914707fa22fd658f50e059a5091440796ef39e0`. The CLI is
always invoked with `shell: false`, explicit `--agent`/`--copy`/`--yes`/`--json`,
and telemetry disabled. The job is only complete when the installed files and
the lockfile record the requested source/ref; exit code alone is not accepted.
The install is not transactional and no rollback is promised.

## Sources

- https://github.com/modelcontextprotocol/registry/blob/main/docs/reference/server-json/generic-server-json.md
- https://docs.npmjs.com/cli/using-npm/package-json/#bin
- https://docs.npmjs.com/cli/commands/npm-pack
- https://developers.openai.com/docs/config-file/config-basic
- https://zed.dev/docs/ai/mcp and https://zed.dev/docs/worktree-trust
- https://opencode.ai/v2/docs/config and https://opencode.ai/v2/docs/mcp-servers
