# Pi TaskExec

Pi TaskExec is an MCP orchestration and control layer between a main Agent (the
Supervisor) and a local Pi execution layer. It is not an independent agent. The
Supervisor keeps requirement interpretation, architecture and risk decisions,
authorization, task decomposition, integration, review, and final acceptance;
Pi TaskExec creates, connects to, and supervises bounded Pi workers and returns
structured status and results for independent verification.

The product is a host-agnostic stdio MCP server that supervises local
[Pi](https://pi.dev) coding-agent processes over Pi RPC. It is not a hosted
service and does not manage Pi credentials, providers, or default models.

The core flow is: Supervisor → Pi TaskExec MCP → Pi Worker → structured
status/result → Supervisor review and acceptance. `inspect`/`implement` are
tool capability profiles and `direct`/`worktree` are working-directory modes;
neither is an operating-system security sandbox.

> Status: Phases 6–8 and the 2026-10-09 root-level directory refactor (layout
> A: root `cli/`, `mcp/`, `skills/`, `tests/`, `docs/`, and root `dist/`) are
> implemented in this checkout. Stage 8 adds real Codex, Zed, and OpenCode MCP
> install/remove with safe TOML/JSONC merging, backups, and managed-entry
> removal. Stage 9A adds `add skill`: it installs `pi-delegate` through the
> pinned Vercel Skills CLI v1.7.1 from the fixed GitHub source. The combined
> `setup`/`update` flows and `remove skill` remain deferred. Stage 10
> (MCP/Skill contract synchronization and tool renaming) has not started. The
> npm package and MCP Registry entry have not been published. Local tarball
> prepack, archive-content checks, and a separate clean npm prefix installation
> with full MCP initialize/list-tools smoke have passed for the current `pi_*`
> contract. For current development, build from
> source and run `node dist/cli/index.js mcp serve`; `dist/` is generated
> output from `cli/` and `mcp/`. When run from this checkout the installer
> writes a `node <absolute-checkout>/dist/cli/index.js mcp serve` launch entry
> only when `--local-dev` is passed, and never represents that local path as the
> published npm package.

## CLI surface

`mcp serve` is the single service-start contract used by Host configuration and
the MCP Registry entry. All six MCP tools (`pi_spawn`, `pi_status`,
`pi_steer`, `pi_continue`, `pi_abort`, `pi_list`) are preserved.

| Command | Behavior |
| --- | --- |
| `pi-task-exec` (no arguments) | Prints help and exits `0`; never starts MCP. |
| `pi-task-exec --help` | Prints help and exits `0`; never starts MCP. |
| `pi-task-exec --version` | Prints only `0.1.1` and exits `0`; never starts MCP. |
| `pi-task-exec mcp serve` | Starts the existing MCP stdio runtime. |
| `pi-task-exec doctor [--json]` | Read-only environment, host, skill, and version-contract check; never starts MCP. |
| `pi-task-exec add mcp [--host <codex\|zed\|opencode>] [--scope <project\|global>] [--dry-run] [--json] [--yes]` | Plans and safely merges the host MCP entry (stage 8); never starts MCP. On a TTY, a missing `--host`/`--scope` is an arrow-key prompt; `--json` fails instead of prompting. |
| `pi-task-exec remove mcp --host <...> --scope <...>` | Plans removal of only the managed host MCP entry; never starts MCP. |
| `pi-task-exec add skill [--host <codex\|zed\|opencode>] [--scope <project\|global>] [--dry-run] [--json] [--yes]` | Plans and installs the `pi-delegate` Skill through the pinned Vercel Skills CLI v1.7.1 from the fixed GitHub source; never starts MCP. On a TTY, a missing `--host`/`--scope` is an arrow-key prompt. |
| `pi-task-exec remove skill --scope <project\|global>` | Plans skill removal through the installer seam; stage 9A leaves this deferred. |
| `pi-task-exec setup [--target <mcp\|skill\|both>] [--host <...>] [--scope <...>]` | Plans the unified MCP + Skill setup in one plan by default. On a TTY, only missing Agent/Scope are arrow-key prompts; `--target` is an explicit non-interactive override. |

Only the explicit `mcp serve` route initializes and starts the MCP runtime.
Ordinary `help`, `--version`, `add`, `remove`, `setup`, and `doctor` do not
start MCP. Running `pi-task-exec` with no arguments prints help and does not
start MCP.

The CLI is a pure parser/router over a shared, stable plan model plus a
separately testable plan executor. Every write command first prints a plan with
full absolute paths, creates/updates/removals, conflicts, backups, warnings,
and unsupported capabilities, then revalidates the plan immediately before
executing. `--dry-run` prints the plan and exits without writing; `--json`
emits stable, secret-free JSON and never prompts, so a missing selection is an
error; `--yes` may skip confirmation only after the plan is printed. On a TTY,
`add mcp`, `add skill`, and `setup` prompt for missing Agent/Scope with arrow
keys, then ask a default-No Yes/No confirmation; `setup` is always the unified
MCP + Skill plan unless an explicit `--target` overrides it, and `--json` fails
for missing Agent/Scope without prompting. The prompts are injectable and
cancellation performs no writes. Any conflict blocks
the whole operation, and `--host`/`--scope` remain mandatory for non-interactive
MCP add/remove/setup.

A unified `setup` builds one plan containing both the MCP config write and the
Skills CLI install. The two targets run independently and report their own
status and errors: if one succeeds and the other fails, the result status is
`partial` and the successful mutations are preserved.

The current `pi_*` MCP tools remain in place; their migration to `task_*` is
planned for stage 10. Stage 8 implements the Codex (TOML), Zed (JSONC), and
OpenCode (JSONC) adapters. Stage 9A implements `add skill` through the pinned
Vercel Skills CLI v1.7.1; `setup` now installs the Skill when an Agent is
selected, while the `update` flow and `remove skill` remain deferred, so those
operations report unsupported. Every real
MCP write is path-boundary and symlink checked, writes through a same-directory
temporary file with an atomic rename, backs up an existing config before an
update, refuses malformed or conflicting config, and removes only an entry that
matches the pi-task-exec managed fingerprint. The fingerprint is exact: an entry
with a different package version, local checkout path, or extra/modified entry
fields is treated as drift, reported as a conflict, and never overwritten or
deleted. A source-checkout install additionally requires an explicit
`--local-dev` opt-in; the default is the published npm launch entry. Automatic
`.git` checkout detection always wins: the launch mode cannot be forced to npm
while a checkout is present, so an unpublished checkout is never written as an
`npx` package, and `--local-dev` is the only route to the local `node` path.
Project-level MCP entries carry a trust warning: Codex loads `.codex/config.toml`
only for trusted projects and
Zed Restricted Mode ignores `.zed/settings.json` MCP servers until the worktree
is trusted; the installer does not grant either trust.

Any unrecognized input, including the removed top-level `serve`, `version`,
`update`, and `uninstall` routes and the unsupported `--all-hosts` flag,
reports an error and exits `1`.

## Installation and launch contract

Prerequisites: Node.js 22.20+, a locally installed and configured `pi` executable,
and Git when using isolated worktrees. The Skill installer invokes the pinned
`skills@1.7.1` CLI, which also requires Node.js 22.20+.

The npm package has not been published, so it cannot currently be installed
from npm. The `add`/`remove`/`setup` commands perform real host configuration
writes, after printing the plan and revalidating it.

From an installed package the launch entry is the npm stdio contract:

```text
command: npx
args:    -y @zguiyang/pi-task-exec@<version> mcp serve
```

After version `0.1.1` is published, the same launch is:

```text
command: npx
args:    -y @zguiyang/pi-task-exec@0.1.1 mcp serve
```

From this source checkout, build first and launch the compiled CLI directly:

```sh
node dist/cli/index.js mcp serve
```

or use the thin package launcher, which only imports `dist/cli/index.js`:

```sh
node bin/pi-task-exec.mjs mcp serve
```

When run from this checkout the installer detects the checkout and, with the
explicit `--local-dev` opt-in, writes a
`node <absolute-checkout>/dist/cli/index.js mcp serve` launch entry; without
`--local-dev` the plan reports `local_dev_required` and writes nothing. The
installer never represents that local path as the published npm package. From
an installed package it writes the
`npx -y @zguiyang/pi-task-exec@<version> mcp serve` entry. `doctor` is a
read-only check and does not modify any host configuration.

## Host configuration reference

Host installers are implemented for Codex, Zed, and OpenCode. The table records
the paths each adapter resolves and the shape of the managed entry. Every write
is path-boundary and symlink checked, written through a same-directory
temporary file with an atomic rename, and backed up before an update. `remove`
deletes only an entry that matches the `pi-task-exec` managed fingerprint.

| Host | User/global config | Project config | Entry |
| --- | --- | --- | --- |
| Codex | `$CODEX_HOME/config.toml`, else `~/.codex/config.toml` | `.codex/config.toml` | TOML `[mcp_servers.pi-task-exec]` with a `command` string and `args` array |
| Zed | macOS/Linux: `$XDG_CONFIG_HOME/zed/settings.json`, else `~/.config/zed/settings.json`; Windows: `%APPDATA%\Zed\settings.json` | `.zed/settings.json` | JSONC `context_servers.pi-task-exec` with a `command` string, `args` array, and optional `env` |
| OpenCode | `OPENCODE_CONFIG`, else `$OPENCODE_CONFIG_DIR/opencode.json`, else `$XDG_CONFIG_HOME/opencode/opencode.json`, else `~/.config/opencode/opencode.json` | `opencode.json`, or an existing `opencode.jsonc` | JSONC `mcp.pi-task-exec` with `type: "local"`, a `command` array, and optional `enabled`/`environment` |

OpenCode's current supported config file names are `opencode.json` and
`opencode.jsonc`; no other name is read or written. The runtime launch entry
depends on how the CLI is run: from an installed package it is
`npx -y @zguiyang/pi-task-exec@<version> mcp serve`; from a source checkout it
is `node <absolute-checkout>/dist/cli/index.js mcp serve`, and the install is
refused unless `--local-dev` is passed. An explicit absolute `CODEX_HOME`,
`OPENCODE_CONFIG`, `OPENCODE_CONFIG_DIR`, or `XDG_CONFIG_HOME` override is
honoured as that user's chosen config location rather than failing with a
generic path error.

Codex loads project `.codex/config.toml` only for projects it trusts, and Zed
Restricted Mode ignores project `.zed/settings.json` MCP servers until the
worktree is trusted. The installer surfaces this in the plan and `doctor`, and
does not grant either trust. OpenCode reads a custom config file from
`OPENCODE_CONFIG` and a custom config directory from `OPENCODE_CONFIG_DIR`; the
inline `OPENCODE_CONFIG_CONTENT` value is never written and is reported as a
runtime override. `OPENCODE_DISABLE_PROJECT_CONFIG` disables the project file.

## Skill installation (stage 9A)

`add skill` installs the bundled `pi-delegate` Skill by invoking the pinned
Vercel Skills CLI `skills@1.7.1`. It is GitHub-only and never accepts a local
path or another registry:

- Source repository: `https://github.com/zguiyang/pi-task-exec`
- Subpath: `skills/pi-delegate`
- Release ref: `v${packageVersion}` (an exact tag, never a silent fallback to
  `main`)
- Source-checkout/dev ref: the existing full commit
  `f914707fa22fd658f50e059a5091440796ef39e0`

`--host` is mandatory and selects the Skill Agent (`codex`, `zed`, or
`opencode`); the agent is never guessed. `--scope project` installs under
`<cwd>/.agents/skills/pi-delegate`, and `--scope global` under
`<home>/.agents/skills/pi-delegate`. For the three supported agents the Skills
CLI records the shared canonical `.agents/skills` location (not `~/.codex/skills`
or `~/.config/opencode/skills`), and the project lockfile is `skills-lock.json`
while the global lockfile is `$XDG_STATE_HOME/skills/.skill-lock.json` or
`~/.agents/.skill-lock.json`.

Plan generation is side-effect-free: it resolves the pinned argv and inspects
every target path but never runs npm, the network, or writes a lockfile. The
plan is always printed first. Before running the CLI the executor re-inspects
the `.agents`, `skills`, install, and lock paths; an existing same-name skill,
symlinked ancestor, non-directory target, or non-regular lock is displayed as a
loss warning and requires a default-No confirmation that `--yes` cannot bypass.
An unreadable path fails closed. The CLI runs with `child_process.spawn`
(`shell: false`), passes `--agent`, the fixed source, scope, `--copy`, `--yes`,
and `--json`, disables telemetry (`DO_NOT_TRACK=1`, `DISABLE_TELEMETRY=1`), and
never prints environment values. On Windows the npm entry is launched through
Node so no `.cmd` shim or shell is used.

The wrapper verifies the real result beyond the exit code: `SKILL.md` and
`references/mcp-contract.md` must exist, the installed bytes must match the
bundled pinned source/ref content, and the lockfile must record the requested
source and ref. A CLI exit code of `0` with missing files or a missing/invalid
lockfile is reported as a failure. The Skills CLI install is **not** a
transaction; no rollback is claimed or attempted.

## Environment variables

| Environment variable | Used by | Purpose |
| --- | --- | --- |
| `PI_TASK_EXEC_LAUNCH_MODE` | launcher | Force `npm` or `checkout` launch mode instead of auto-detection |
| `DO_NOT_TRACK`, `DISABLE_TELEMETRY` | Skill installer child | Set to `1` to disable Skills CLI telemetry |
| `XDG_STATE_HOME` | Skill installer | Global Skills CLI lockfile base (default `~/.agents`) |
| `CODEX_HOME` | Codex | User config directory (default `~/.codex`) |
| `XDG_CONFIG_HOME` | Zed, OpenCode | Base config directory when the host-specific override is unset |
| `APPDATA` | Zed (Windows) | Windows user config base for `Zed\settings.json` |
| `OPENCODE_CONFIG` | OpenCode | Custom config file path |
| `OPENCODE_CONFIG_DIR` | OpenCode | Custom global config directory |
| `OPENCODE_CONFIG_CONTENT` | OpenCode | Inline runtime config; never written, only reported |
| `OPENCODE_DISABLE_PROJECT_CONFIG` | OpenCode | Ignore the project `opencode.json` |

## Runtime configuration

| Environment variable | Default | Purpose |
| --- | --- | --- |
| `PI_WORKER_COMMAND` | `pi` | Pi executable |
| `PI_WORKER_MAX_WORKERS` | `4` | Maximum live workers |
| `PI_WORKER_RPC_TIMEOUT_MS` | `15000` | Per-RPC timeout |
| `PI_WORKER_IDLE_TIMEOUT_MS` | `600000` | Idle deadline; `0` disables it |
| `PI_WORKER_TASK_TIMEOUT_MS` | `3600000` | Activity-cycle deadline |
| `PI_WORKER_ALLOWED_ROOTS` | current directory | Path-delimited allowed roots |

No secret environment variable is required; Pi reads its own local
authentication configuration.

## MCP tools

`pi_spawn`, `pi_status`, `pi_steer`, `pi_continue`, `pi_abort`, and `pi_list`
supervise bounded local workers. Successful spawn/continuation means Pi
accepted work, not that it is correct; the supervising agent must inspect
results and integrate changes. Use `worktree` mode for isolated implementation
work.

## Model ownership and host independence

Pi owns provider authentication, available models, and its default model. The
worker runtime can validate an optional per-worker override and report the
effective model, but never configures credentials. Core runtime behavior—Pi
RPC, lifecycle, model semantics, concurrency, and permissions—is independent of
Codex, Zed, and OpenCode. Host adapters only read, merge, and remove launch
configuration.

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

## Current status and non-claims

Phases 6–8 and stage 9A are implemented in this checkout. The following are
**not** implemented and are **not** claimed:

- the npm tarball has been generated locally, but the package has not been
  published and cannot currently be installed from npm; no MCP Registry record
  has been published;
- stage 9A implements only `add skill`; the combined `setup`/`update` flows and
  `remove skill` remain deferred and report unsupported;
- the Skills CLI install is not transactional and is not rolled back;
- stage 10 tool migration has not started; the existing `pi_*` tools remain
  and migration to `task_*` is planned for that stage;
- `doctor` is read-only and does not prove that a host configuration works;
- no release or version compatibility promise.

## Repository layout and responsibilities

The repository is a single root npm package (no npm Workspaces). Layout A keeps
one root product root: CLI, MCP server, Skill, tests, documentation, and build
output all live under the root.

| Path | Responsibility |
| --- | --- |
| `bin/pi-task-exec.mjs` | Thin package launcher; only imports and calls `dist/cli/index.js`. No business implementation. |
| `cli/` | CLI parser/router, commands, host install adapters (`cli/hosts/`), installer seam and the pinned Skills CLI installer (`cli/installers/`), plan model and safety executor (`cli/plan/`), and CLI identity/IO. |
| `mcp/` | MCP server entry, tools, workers, Pi RPC, and runtime. Does not import the CLI. |
| `skills/pi-delegate/` | The `pi-delegate` delegation-policy Skill and its `references/`. Maintained by JoeyZhao in the `agent-skills` project. |
| `tests/` | Unified tests under `tests/cli/`, `tests/mcp/`, `tests/hosts/`, and `tests/skills/`, with MCP fixtures under `tests/mcp/fixtures/`. |
| `docs/architecture/` | Architecture decision record, implementation plan, and risk register for the migration. |
| `docs/release-standard-baseline.md` | Release standard baseline and distribution contract. |
| `dist/` | Generated build output: `dist/cli/index.js` (CLI) and `dist/mcp/index.js` (MCP Server). Intentionally not tracked. |
| `README.md` | This overview. |
| `LICENSE` | Root MIT license for the integrated repository. |
| `server.json` | Root MCP Registry metadata. |
| `.gitignore` | Root ignore rules. |

The root `package.json`, `package-lock.json`, and `server.json` carry the
product identity. Phase 6 CLI routing and the integrated test suite are
verified. The root-level directory refactor is implemented. Public npm
publication remains pending, and stage 12 tarball acceptance is not complete
until installation in a clean npm prefix and the full MCP stdio smoke pass.

## Development, contributing, and releases

Source mode is only for contributors. From the repository root:

```sh
npm install
npm run build        # tsc -p tsconfig.json -> dist/cli/ and dist/mcp/
npm run typecheck    # tsc --noEmit, no output
npm test             # builds dist/, then runs the tests under tests/
npm start            # node bin/pi-task-exec.mjs mcp serve
```

- `build` compiles the root TypeScript sources (`cli/**/*.ts` and
  `mcp/**/*.ts`) into the root `dist/`.
- `typecheck` runs the compiler with `--noEmit` and writes nothing.
- `test` first builds `dist/` and then runs the unified suite under `tests/`.
- `start` runs the compiled CLI `mcp serve` route through the thin
  `bin/pi-task-exec.mjs` launcher; it is the same service-start contract used by
  host configuration and the Registry entry.
- `build` clears only the repository-root `dist/` before compiling, so stale
  JavaScript, declarations, or source maps cannot survive into a package;
  `prepack` uses this same build path.

Tests import the root `dist/` through stable relative paths (for example
`../../dist/cli/...` and `../../dist/mcp/...`). The MCP stdio smoke test starts
`mcp serve` through the thin `bin/pi-task-exec.mjs` launcher.

For release-equivalent testing, use `npm pack` and execute the resulting `.tgz`
from a clean temporary directory; `npm link` is not package acceptance. The
`prepack` script rebuilds the root `dist/` so the tarball contains the thin
`bin/`, root `dist/**`, the complete `skills/pi-delegate/**`, and the required
root documents, licenses, and `server.json`. npm publication and MCP Registry
publication are separate, explicit actions and have not occurred.

## Registry metadata

The root `server.json` follows the official MCP Registry schema and declares an
npm stdio package representation whose `packageArguments` are the positional
arguments `mcp` and `serve`, matching the tested `pi-task-exec mcp serve`
contract. The package ships the MCP runtime (root `dist/**`) and the
`pi-delegate` Skill (`skills/pi-delegate/**`).

## Migration history

This checkout was assembled from two earlier sources. The historical project
names in this section are recorded only as migration provenance; they are not
current product names and must not appear in runtime code, current installation
instructions, or package metadata.

- The MCP module was migrated from the `pi-worker-mcp` project.
- The `pi-delegate` Skill is maintained by JoeyZhao in the `agent-skills`
  project.

The repository previously used a migration-transition layout that kept all CLI,
host-adapter, and MCP source and tests inside the MCP module and emitted build
output there. The approved 2026-10-09 layout A replaces that with root `cli/`,
`mcp/`, `tests/`, root `dist/`, and the thin `bin/pi-task-exec.mjs` launcher.

**Both old projects remain.** The previous repositories and their local
checkouts are not retired, renamed, or deleted. They are only to be retired as
the final migration step, after the new project is published and publicly
accepted, following the order and gates recorded in
[`docs/architecture/implementation-plan.md`](docs/architecture/implementation-plan.md).

This repository does not use the old repositories' Git history; it was
initialized fresh in this checkout.

## Licensing

The root [`LICENSE`](LICENSE) is the single MIT license for the integrated
repository and the only package license source, with copyright held by
`zguiyang`. The migration to layout A does not change the MIT terms that apply
to the MCP module code. There is no separate `NOTICE` file; none is required
for the current scope.
