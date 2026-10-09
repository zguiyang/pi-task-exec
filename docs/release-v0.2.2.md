# Pi TaskExec v0.2.2

Confirmed updates replace the complete Pi TaskExec MCP entry with the current
configuration rather than merging old fields. Old environment, cwd, timeouts,
enabled/readiness fields and npm prefixes are removed; specify desired launch
options on the update command. Other MCP entries remain untouched, and the
configuration is backed up before writing.

Installed Skills are fully reinstalled even when their release ref is already
current. The existing Skills CLI copy workflow clears the target directory,
removing obsolete files before copying the matching release. Project/global
scope, ownership checks, path safety, dry-run and replacement confirmation
remain supported across Codex, Zed and OpenCode.

```sh
npx -y @zguiyang/pi-task-exec@latest update
```

Select Agent and Scope, review and confirm the replacement, then restart the
Host. MCP launch configurations continue to use `@latest`; release metadata
and the matching Skill source identify the exact v0.2.2 release.
