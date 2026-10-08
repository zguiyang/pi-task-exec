# Pi TaskExec

Pi TaskExec is a planned MCP orchestration and control layer between a main
Agent (the Supervisor) and a local Pi execution layer. It is not an
independent agent. The Supervisor keeps requirement interpretation,
architecture and risk decisions, authorization, task decomposition,
integration, review, and final acceptance; Pi TaskExec is intended to create,
connect to, and supervise bounded Pi workers and return structured status and
results for independent verification.

The intended core flow is: Supervisor → Pi TaskExec MCP → Pi Worker →
structured status/result → Supervisor review and acceptance.
`inspect`/`implement` are tool capability profiles and `direct`/`worktree` are
working-directory modes; neither is an operating-system security sandbox.

> Status: Phase 3 (root `package.json`, lockfile, and `server.json`
> integration) has been prepared in this checkout. The integrated root package
> has not been built or tested and no release has occurred; the `mcp/dist/`
> files already present are migrated module build artifacts, not an
> integrated-root-package build.

## Current status and non-claims

The currently authorized scope adds Phase 3 (root `package.json` and lockfile
integration) to the Phase 2 repository foundation files, the root `.gitignore`,
the root license, and Git initialization. Phase 3 is prepared but not yet
accepted by the Supervisor.

The following are **not** implemented and are **not** claimed by this
repository state:

- no npm packaging or publication;
- no `pi-task-exec` CLI behavior, installer, `setup`, or `doctor`;
- no cross-platform host support or verified installation paths;
- no MCP Registry record, release, or version compatibility promise.

## Provisional names

These are target names. The Phase 1 checks below describe the current state
only; they do not reserve the npm package name or the MCP Registry ID.

| Purpose | Provisional name |
| --- | --- |
| npm package | `@zguiyang/pi-task-exec` |
| CLI (planned, not implemented) | `pi-task-exec` |
| MCP Registry ID (planned, not registered) | `io.github.zguiyang/pi-task-exec` |
| Skill (present in this repository) | `pi-delegate` |

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
Actual Registry OAuth/OIDC publishing was not attempted; that future workflow
will require the `id-token: write` permission. The checks above are evidence
of the current state, not a release commitment, and the project must still
stop rather than fall back to an old name if the target Registry ID is
occupied at publication time.

## Repository layout and responsibilities

| Path | Responsibility |
| --- | --- |
| `mcp/` | MCP worker runtime source (`mcp/src/`), tests (`mcp/tests/`), build config, and module docs. Migrated from the `pi-worker-mcp` project. |
| `skills/pi-delegate/` | The `pi-delegate` delegation-policy Skill and its `references/`. Maintained by JoeyZhao in the `agent-skills` project. |
| `docs/architecture/` | Architecture decision record, implementation plan, and risk register for the migration. |
| `README.md` | This overview. |
| `LICENSE` | Root MIT license for the integrated repository. |
| `.gitignore` | Root ignore rules. |

`mcp/dist/` is generated build output from `mcp/src/` and is intentionally not
tracked. The root `package.json`, `package-lock.json`, and `server.json` now
exist for the interim integration; the integrated build and release flow is not
yet verified.

## Migration and development status

This checkout is being assembled as a single repository from two existing
sources. Migration is in an early, authorized-phase state:

- **Phase 3 (current):** Root `package.json`, lockfile, and `server.json`
  integration, with build/typecheck/test scripts pointing at `mcp/tsconfig.json`
  and `mcp/tests/*.test.mjs`. Phase 2 repository base files remain in place.
- Later phases (Skill packaging, old-name cleanup, CLI implementation,
  multi-platform installers, contract synchronization, CI, tarball acceptance,
  npm/Registry publication, and finally source retirement) are planned but not
  started or not authorized in this checkout.

**Both old projects remain.** The previous repositories and their local
checkouts are not retired, renamed, or deleted. They are only to be retired as
the final migration step, after the new project is published and publicly
accepted, following the order and gates recorded in
[`docs/architecture/implementation-plan.md`](docs/architecture/implementation-plan.md).

## Source attribution

- `mcp/` is migrated from the `pi-worker-mcp` project.
- The `skills/pi-delegate/` Skill is maintained by JoeyZhao in the
  `agent-skills` project.

This repository does not use the old repositories' Git history; it was
initialized fresh in this checkout.

## Licensing

The root [`LICENSE`](LICENSE) is the MIT license for the integrated repository,
with copyright held by `zguiyang`.

[`mcp/LICENSE`](mcp/LICENSE) is preserved as the module-origin license for the
MCP module and remains in effect for that module under the same MIT terms.
There is no separate `NOTICE` file; none is required for the current scope.

## Installation

Installation is future work. There is no published package and no supported
installation route yet. `setup`, `doctor`, and package installation commands
are not implemented; do not rely on any command described in planning
documents.
