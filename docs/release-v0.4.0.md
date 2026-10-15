# Pi TaskExec v0.4.0 — release candidate

This release candidate includes the changes accumulated since v0.3.1. The MCP
Worker API remains the same seven tools with the same schemas and lifecycle.

## Changes

- Pi is optional for bounded independent investigation, analysis,
  implementation, and verification. Supervisors can work directly when
  delegation adds more overhead than value. The Skill, MCP discovery guidance,
  usage guide, and references now follow this policy.
- `setup`, `update`, and `uninstall` support keyboard multi-select across
  Codex, Zed, and OpenCode, repeated `--host` flags, and one shared scope.
- `uninstall` removes managed MCP entries and retains the shared
  `pi-delegate` Skill by default. Skill removal is explicit and checks known
  host references first.
- The TTY flows print concise results by default; `--dry-run` and `--json`
  provide detailed output.

## Manual release checks

The package build and tarball generation succeeded locally. The test suite and
typecheck have not been run. From the repository root, run the checks before
publishing; regenerate the tarball after tests if any source files change:

```sh
npm test
npm run typecheck
npm pack
```

Inspect the generated tarball for the CLI, MCP runtime, Skill, references,
README files, license, and `server.json`. Commit and push the candidate source,
then push tag `v0.4.0` before publishing because the installer fetches the Skill
from that release ref. After checking that the npm package and Registry ID are
still available, publish the tarball to npm, create the GitHub release, and
publish the matching `server.json` to MCP Registry:

```sh
npm publish ./zguiyang-pi-task-exec-0.4.0.tgz --access public
gh release create v0.4.0 --title "Pi TaskExec v0.4.0" --notes-file docs/release-v0.4.0.md
mcp-publisher validate ./server.json
mcp-publisher publish ./server.json
```

After publication, use `@zguiyang/pi-task-exec@0.4.0 update` for managed
installations and restart each host. Confirm that `pi_list` is available.
