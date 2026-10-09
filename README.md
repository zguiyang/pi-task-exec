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

> Status: Phase 6 (old CLI and old product-identifier cleanup) plus the
> authorized CLI routing work have been implemented in this checkout at version
> `0.1.1`. The changes await Supervisor review; the dry-run package manifest was
> verified, but nothing has been published. `mcp/dist/` is generated build
> output from `mcp/src/`.

## CLI surface

The only real CLI behaviors in this build are:

| Command | Behavior |
| --- | --- |
| `pi-task-exec` (no arguments) | Prints help and exits `0` without starting MCP. |
| `pi-task-exec --help` | Prints help and exits `0`. |
| `pi-task-exec --version` | Prints `0.1.1` and exits `0`. |
| `pi-task-exec mcp serve` | Starts the existing MCP stdio runtime. |

`mcp serve` is the single service-start contract used by Host configuration and
the MCP Registry entry. All six MCP tools (`pi_spawn`, `pi_status`,
`pi_steer`, `pi_continue`, `pi_abort`, `pi_list`) are preserved.

The following commands are authorized for a later stage. They print a clear
future-stage notice, change no files, and exit `1`; they never fall back to the
previous CLI behavior:

- `pi-task-exec add mcp`
- `pi-task-exec add skill`
- `pi-task-exec setup`
- `pi-task-exec doctor`
- `pi-task-exec remove mcp`
- `pi-task-exec remove skill`

Any other input, including the removed top-level `serve`, `version`, `update`,
and `uninstall` routes, reports `Unknown command` plus help and exits `1`.

## Current status and non-claims

Phase 6 is implemented in this checkout and awaits Supervisor review. The
following are **not** implemented and are **not** claimed:

- no npm packaging or publication, and no MCP Registry record;
- no host or skill installer; `add`, `setup`, `doctor`, and `remove` only print
  future-stage notices;
- no cross-platform host support or verified installation paths;
- no release or version compatibility promise.

## Product identity

| Purpose | Name |
| --- | --- |
| Product | Pi TaskExec |
| npm package | `@zguiyang/pi-task-exec` |
| CLI / `bin` | `pi-task-exec` |
| MCP Registry ID | `io.github.zguiyang/pi-task-exec` |
| MCP server name | `pi-task-exec` |
| Skill | `pi-delegate` |

Phase 1 (2026-10-08) resolved the naming, identity, and Skill-licensing
questions with the following evidence:

- `npm view @zguiyang/pi-task-exec` returned **E404**, meaning no package is
  currently published under that exact name. This is a current availability
  fact only, not a reservation, release entitlement, or guarantee against
  future registration.
- Exact MCP Registry search for `io.github.zguiyang/pi-task-exec` returned
  HTTP 200 with `count: 0`; no matching record exists.
- Official `mcp-publisher validate` on the target server name and npm package
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
verified; npm packaging and publication remain pending.

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

There is no published package and no supported installation route yet. Until a
host installer command is implemented, register the MCP with a stdio client
using the launch contract:

```text
command: npx
args:    -y @zguiyang/pi-task-exec@0.1.1 mcp serve
```

`setup`, `doctor`, `add`, and `remove` are not implemented; do not rely on any
command described in planning documents.

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
