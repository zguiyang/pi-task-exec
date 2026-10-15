# Pi TaskExec v0.3.2 — release preparation

This patch release changes delegation guidance. Pi is an optional independent
task executor for investigation, analysis, implementation, and verification.
The supervising agent may complete simple or context-dependent work directly.

## Changes

- The Skill defines an atomic task by its goal, scope, expected result, and
  stopping condition. Workers can reason within that boundary and return
  broader suggestions for a separate decision.
- MCP discovery text gives concise tool-selection guidance. No tool name,
  input schema, Worker profile, session behavior, or worktree responsibility
  changes.
- The README and usage guide show direct execution, read-only investigation,
  technical comparison, bounded implementation, and related session
  continuation.
- Verification is matched to task risk rather than a mandatory full lifecycle.

## Before publishing

- Confirm that v0.3.2 is unused on npm, GitHub Releases, and MCP Registry.
  At preparation time, npm and GitHub both showed v0.3.1 as their latest
  release; the MCP Registry lookup did not complete.
- Run the full test suite, typecheck, build, and package-content check.
- Publish npm first, then create the GitHub Release and publish `server.json`
  to MCP Registry in a separate, authorized release operation.
- Update installed Skills along with the MCP package; old copied Skill files
  do not change automatically.
