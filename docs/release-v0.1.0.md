# Pi TaskExec v0.1.0

Pi TaskExec's first public release brings the CLI, MCP runtime, and
`pi-delegate` Skill together in one product.

## Highlights

- Supports Codex, Zed, and OpenCode with project or global MCP and Skill setup.
- Provides one interactive `setup` flow and an in-place `update` flow for
  already-installed components.
- Exposes the existing six `pi_*` MCP tools for supervising local Pi Worker
  processes, including spawn, status, continuation, steering, listing, and
  release.
- Uses Pi's configured model and credentials; the Worker runtime does not
  replace Pi's model configuration.
- Requires Node.js `>=22.20.0`.
- Maintains the MCP-coupled `pi-delegate` Skill in this repository.

## Install

Run the unified setup from the project where the MCP and Skill should be
configured:

```sh
npx -y @zguiyang/pi-task-exec@0.1.0 setup
```

The setup flow prompts for Agent and scope when needed. To start the MCP
directly, use:

```sh
npx -y @zguiyang/pi-task-exec@0.1.0 mcp serve
```
