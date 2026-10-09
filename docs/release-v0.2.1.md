# Pi TaskExec v0.2.1

Updates no longer reject a recognized Pi TaskExec MCP launcher because the Host
added settings such as `enabled`. The updater replaces the launcher while
preserving existing Host settings, environment, directory restrictions and
every unrelated MCP entry. Existing Skill updates retain the matching-release
source, plan and replacement confirmation.

New MCP configurations use `@latest`. Updating a historical pinned configuration
migrates it to `@latest`, so later MCP starts follow the current npm release
without manually changing a version number. Restart the Host to launch a new
process; Skill files change only when setup/update is run. GitHub tags, npm
package versions and MCP Registry records still identify exact releases.

```sh
npx -y @zguiyang/pi-task-exec@latest update
```

Select the Agent and scope, review the MCP/Skill plan, then confirm. Backups,
path checks and malformed/unrelated-command protection remain in place.
