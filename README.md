# Pi TaskExec

Pi TaskExec is an MCP orchestration and control layer between a main Agent (the
Supervisor) and a local Pi execution layer. It is not an independent agent. The
Supervisor keeps requirement interpretation, architecture and risk decisions,
authorization, task decomposition, integration, review, and final acceptance;
Pi TaskExec creates, connects to, and supervises bounded Pi workers and returns
structured status and results for independent verification.

The core flow is: Supervisor → Pi TaskExec MCP → Pi Worker → structured
status/result → Supervisor review and acceptance. `inspect`/`implement` are
tool capability profiles and `direct`/`worktree` are working-directory modes;
neither is an operating-system security sandbox.

> Status: Phases 6 and 7 have been implemented in this checkout and await
> Supervisor review. Stage 8 real Host configuration adaptation, stage 9 the
> generic `.agents/skills/` installer, and stage 10 MCP/Skill contract
> synchronization and tool renaming have not started. The npm package and MCP
> Registry entry have not been published. For current development, build from
> source and run `node mcp/dist/index.js mcp serve`; `mcp/dist/` is generated
> output from `mcp/src/`.

## CLI surface

`mcp serve` is the single service-start contract used by Host configuration and
the MCP Registry entry. All six MCP tools (`pi_spawn`, `pi_status`,
`pi_steer`, `pi_continue`, `pi_abort`, `pi_list`) are preserved.

| Command | Behavior |
| --- | --- |
| `pi-task-exec` (no arguments) | Prints help and exits `0`; never starts MCP. |
| `pi-task-exec --help` | Prints help and exits `0`. |
| `pi-task-exec --version` | Prints only `0.1.1` and exits `0`. |
| `pi-task-exec mcp serve` | Starts the existing MCP stdio runtime. |
| `pi-task-exec doctor [--json]` | Read-only environment, host, skill, and version-contract check. |
| `pi-task-exec add mcp --host <codex\|zed\|opencode> --scope <project\|global> [--dry-run] [--json] [--yes]` | Plans the host MCP entry. |
| `pi-task-exec remove mcp --host <...> --scope <...>` | Plans removal of the host MCP entry. |
| `pi-task-exec add skill --scope <project\|global>` | Plans the bundled skill through the installer seam. |
| `pi-task-exec remove skill --scope <project\|global>` | Plans skill removal through the installer seam. |
| `pi-task-exec setup --target <mcp\|skill\|both> [--host <...>] --scope <...>` | Plans combined setup. |

The CLI is a pure parser/router over a shared, stable plan model plus a
separately testable plan executor. Every write command first prints a plan with
full absolute paths, creates/updates/removals, conflicts, backups, warnings,
and unsupported capabilities, then revalidates the plan immediately before
executing. `--dry-run` prints the plan and exits without writing; `--json`
emits stable, secret-free JSON; `--yes` may skip confirmation only after the
plan is printed. Any conflict blocks the whole operation, and `--host` and
`--scope` are mandatory for MCP add/remove/setup.

The current `pi_*` MCP tools remain in place; their migration to `task_*` is
planned for stage 10. Stage 7 defers real MCP path/config adaptation to stage 8
and the generic `.agents/skills` installer to stage 9. The registered Codex,
Zed, and OpenCode adapters therefore mark real MCP installation/removal as
unsupported instead of guessing a path or writing unknown config, and skill
operations report pending/unavailable. No host config or skill file is written
by `add`, `remove`, or `setup` in this checkout.

Any unrecognized input, including the removed top-level `serve`, `version`,
`update`, and `uninstall` routes and the unsupported `--all-hosts` flag,
reports an error and exits `1`.

## Current status and non-claims

Phases 6 and 7 are implemented in this checkout and await Supervisor review.
The following are **not** implemented and are **not** claimed:

- the npm tarball has been generated locally, but the package has not been
  published and cannot currently be installed from npm; no MCP Registry record
  has been published;
- stage 8 real Host configuration adaptation has not started: no real host MCP
  install/remove or verified cross-platform host paths/config formats;
- stage 9 generic `.agents/skills/` installer has not started; skill operations
  report pending/unavailable;
- stage 10 tool migration has not started; the existing `pi_*` tools remain
  and migration to `task_*` is planned for that stage;
- `doctor` is read-only and does not prove that a host configuration works;
- no release or version compatibility promise.

## Product identity

| Purpose | Name |
| --- | --- |
| Product | Pi TaskExec |
| npm package | `@zguiyang/pi-task-exec` |
| CLI / `bin` | `pi-task-exec` |
| MCP Registry name | `io.github.zguiyang/pi-task-exec` |
| Skill | `pi-delegate` |

Phase 1 (2026-10-08) resolved the naming, identity, and Skill-licensing
questions with the following evidence:

- `npm view @zguiyang/pi-task-exec` returned **E404**, meaning no package is
  currently published under that exact name. This is a current availability
  fact only, not a reservation, release entitlement, or guarantee against
  future registration.
- Exact MCP Registry search for `io.github.zguiyang/pi-task-exec` returned
  HTTP 200 with `count: 0`; no matching record exists.
- Official `mcp-publisher validate` on the target Registry name and npm package
  identifier passed.
- Publishing identity was confirmed: `gh api user` reports `zguiyang`,
  `gh repo view` reports the repository as PUBLIC with ADMIN access,
  `npm whoami` reports `zhaoguiyang`, and `npm org ls zguiyang` lists that
  account as owner.
- JoeyZhao confirmed direct authorship and copyright of the Skill, MIT
  redistribution, and that no separate NOTICE is required.

Neither the npm package nor any MCP Registry record has been published yet.
Actual Registry OAuth/OIDC publishing has not been attempted; that future
workflow will require the `id-token: write` permission. The checks above are
evidence of the current state, not a release commitment, and the project must
still stop rather than fall back to an old name if the target Registry ID is
occupied at publication time.

## Repository layout and responsibilities

| Path | Responsibility |
| --- | --- |
| `mcp/` | MCP worker runtime source (`mcp/src/`), tests (`mcp/tests/`), build config, and module docs. |
| `skills/pi-delegate/` | The `pi-delegate` delegation-policy Skill and its `references/`. Maintained by JoeyZhao in the `agent-skills` project. |
| `docs/architecture/` | Architecture decision record, implementation plan, and risk register for the migration. |
| `README.md` | This overview. |
| `LICENSE` | Root MIT license for the integrated repository. |
| `.gitignore` | Root ignore rules. |

`mcp/dist/` is generated build output from `mcp/src/` and is intentionally not
tracked. The root `package.json`, `package-lock.json`, and `server.json` carry
the new identity. Phase 6 CLI routing and the integrated test suite are
verified; public npm publication and stage 12 tarball acceptance remain
pending.

## Migration history

This checkout was assembled from two earlier sources. The historical project
names in this section are recorded only as migration provenance; they are not
current product names and must not appear in runtime code, current installation
instructions, or package metadata.

- The `mcp/` module was migrated from the `pi-worker-mcp` project.
- The `pi-delegate` Skill is maintained by JoeyZhao in the `agent-skills`
  project.

**Both old projects remain.** The previous repositories and their local
checkouts are not retired, renamed, or deleted. They are only to be retired as
the final migration step, after the new project is published and publicly
accepted, following the order and gates recorded in
[`docs/architecture/implementation-plan.md`](docs/architecture/implementation-plan.md).

This repository does not use the old repositories' Git history; it was
initialized fresh in this checkout.

## Installation

The npm package has not been published, so it cannot currently be installed
from npm. The `add`/`remove`/`setup` commands currently generate and print plans
only; real host installation is deferred. During current development, build
from source and launch with `node mcp/dist/index.js mcp serve`.

After version `0.1.1` is published, this will be a future npm-based stdio launch
example. This command is executable only after the corresponding version has
been published:

```text
command: npx
args:    -y @zguiyang/pi-task-exec@0.1.1 mcp serve
```

`doctor` is a read-only check and does not modify any host configuration.

## Development from source

```sh
npm install
npm run build
npm test
node mcp/dist/index.js mcp serve
```

`npm test` builds `mcp/src` and then runs the tests under `mcp/tests/`. For
release-equivalent testing, use `npm pack` and execute the resulting `.tgz`
from a clean temporary directory; `npm link` is not package acceptance.

## Licensing

The root [`LICENSE`](LICENSE) is the MIT license for the integrated repository,
with copyright held by `zguiyang`.

[`mcp/LICENSE`](mcp/LICENSE) is preserved as the module-origin license for the
MCP module and remains in effect for that module under the same MIT terms.
There is no separate `NOTICE` file; none is required for the current scope.
