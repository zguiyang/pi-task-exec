# RELEASE_STANDARD_BASELINE

Checked for Release Engineering V0.1 on 2026-10-08.

## Common distribution contract

- npm exposes `pi-worker-mcp` through the package `bin` map. `npm pack` is the release-equivalent artifact; acceptance installs that `.tgz` into a clean temporary prefix instead of relying on `npm link`.
- The generic stdio launch is `npx -y @zguiyang/pi-worker-mcp@<exact-version> serve`. Setup pins exact versions; a user explicitly running a later CLI may update pins through `update`.
- `server.json` uses the official Registry schema, an `io.github.zguiyang/pi-worker-mcp` server name, and an npm package entry with `transport.type: "stdio"`. The Registry is metadata/discovery, not a requirement for any host configuration.
- No `mcpName` field is included: the current Registry schema identifies the server with `name` and package `identifier`; an unrecognized package.json field would not provide Registry identity.

## Host contract

| Host | Global scope | Project scope | Entry shape |
| --- | --- | --- | --- |
| Codex | `~/.codex/config.toml` | `.codex/config.toml` | `[mcp_servers.pi-worker-mcp]`, command and args |
| Zed | `~/.zed/settings.json` on macOS | `.zed/settings.json` | `context_servers.pi-worker-mcp`, command and args |
| OpenCode | `~/.config/opencode/opencode.json` | `opencode.json` | `mcp.servers.pi-worker-mcp`, local command array |

Zed project configuration is real project scope but it is subject to worktree trust before it may launch a local MCP server. Codex project configuration is loaded only for trusted projects. OpenCode resolves project configuration with higher precedence than its global configuration.

## Intentional non-unification

The standard MCP protocol specifies transport, not a common host configuration file or installation scope. Host adapters preserve each host's native format, scope locations, and trust rules. Future optional Skills remain outside this package and are not installed, downloaded, or bundled by V0.1.

## Sources

- https://github.com/modelcontextprotocol/registry/blob/main/docs/reference/server-json/generic-server-json.md
- https://docs.npmjs.com/cli/using-npm/package-json/#bin
- https://docs.npmjs.com/cli/commands/npm-pack
- https://developers.openai.com/docs/config-file/config-basic
- https://zed.dev/docs/ai/mcp and https://zed.dev/docs/worktree-trust
- https://opencode.ai/v2/docs/config and https://opencode.ai/v2/docs/mcp-servers
