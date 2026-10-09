# RELEASE_STANDARD_BASELINE

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
- The package ships the MCP runtime (`mcp/dist/**`) and the `pi-delegate` Skill
  (`skills/pi-delegate/**`). Installer commands (`add`, `setup`, `doctor`,
  `remove`) are planned for a future stage and are not implemented in v0.1.1.

## Host contract

| Host | Global scope | Project scope | Entry shape |
| --- | --- | --- | --- |
| Codex | `~/.codex/config.toml` | `.codex/config.toml` | `[mcp_servers.pi-task-exec]`, command and args |
| Zed | `~/.zed/settings.json` on macOS | `.zed/settings.json` | `context_servers.pi-task-exec`, command and args |
| OpenCode | `~/.config/opencode/opencode.json` | `opencode.json` | `mcp.servers.pi-task-exec`, local command array |

Zed project configuration is real project scope but it is subject to worktree
trust before it may launch a local MCP server. Codex project configuration is
loaded only for trusted projects. OpenCode resolves project configuration with
higher precedence than its global configuration. All host entries must launch
`npx -y @zguiyang/pi-task-exec@<exact-version> mcp serve`.

## Intentional non-unification

The standard MCP protocol specifies transport, not a common host configuration
file or installation scope. Host adapters preserve each host's native format,
scope locations, and trust rules. The `pi-delegate` Skill is distributed inside
this package for the later installer stage but is not installed by v0.1.1.

## Sources

- https://github.com/modelcontextprotocol/registry/blob/main/docs/reference/server-json/generic-server-json.md
- https://docs.npmjs.com/cli/using-npm/package-json/#bin
- https://docs.npmjs.com/cli/commands/npm-pack
- https://developers.openai.com/docs/config-file/config-basic
- https://zed.dev/docs/ai/mcp and https://zed.dev/docs/worktree-trust
- https://opencode.ai/v2/docs/config and https://opencode.ai/v2/docs/mcp-servers
