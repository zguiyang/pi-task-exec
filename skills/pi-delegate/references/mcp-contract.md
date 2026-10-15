# Pi TaskExec MCP contract (v0.3.1)

This reference describes the target public interface of
`@zguiyang/pi-task-exec` v0.3.1. It is deliberately a delegation aid, not a
second implementation of the runtime.

> v0.3.1 is the current published release, so `@latest` resolves to v0.3.1 and
> the setup and launch guidance below applies to it. If you are upgrading from
> v0.2.2, refresh your installed Skill copy with `update`.

## Dependency and installation

Run the unified setup flow for the chosen Agent and scope to install both the
MCP and this Skill:

```text
npx -y @zguiyang/pi-task-exec@latest setup
```

For a direct Host configuration, the stdio launch contract is:

```text
command: npx
args:    -y @zguiyang/pi-task-exec@latest mcp serve
```

The Host starts the MCP. Do not run this launch command from the Skill. The
runtime needs Node.js >=22.20.0 and a configured local `pi` executable. Git is
not required by the runtime: the Supervisor chooses the working directory and
the MCP never creates a worktree or branch. The Skill and MCP contract are
maintained together in `zguiyang/pi-task-exec`; installing the Skill by itself
does not configure the MCP. The unified setup installs the Skill through the
pinned Skills CLI `skills@1.7.1` from the fixed source
`https://github.com/zguiyang/pi-task-exec` (`skills/pi-delegate`) at the
`v${packageVersion}` tag (currently `v0.3.1`), keeping the Skill and MCP
versions aligned.

## Delegation policy

Delegate a concrete, bounded execution task by default once its objective,
context, operating boundary, completion check, and side effects are
understood. This includes small one-file edits, read-only inspection, one
targeted test, small bug fixes, and mechanical changes as well as larger
implementation work. Task size is not an eligibility rule.

The Supervisor keeps requirement interpretation, product and architecture
decisions, task decomposition, dependency and concurrency planning, risk and
permission decisions, integration, review, and final acceptance. For a complex
goal, split work into coherent, independently verifiable atomic tasks before
calling `pi_spawn`; then choose serial or non-overlapping parallel dispatch.
Use `pi_continue` for related follow-up after review, rather than repeatedly
creating unrelated replacement workers.

Do not create a Worker for every microscopic operation when delegation supplies
no useful execution boundary. The Supervisor may directly coordinate, inspect
the workspace baseline, verify results, and perform an extremely low-cost
action where delegation plainly adds no useful boundary. Atomicity does not
authorize destructive data work, secrets or sensitive configuration handling,
production operations, irreversible changes, Git-history rewriting, or work
outside user authorization; retain those decisions and obtain any needed
approval first.

## Tools and exact inputs

| Tool | Required input | Optional input | Meaning |
| --- | --- | --- | --- |
| `pi_spawn` | `task`, absolute `cwd` | `profile`, `model`, `thinking`, `taskTimeoutMs` | Starts a bounded Worker in the supplied directory. |
| `pi_status` | `workerId` | `waitMs`, `cycleId` | Returns the current snapshot; optionally waits for a cycle boundary. |
| `pi_list` | none | none | Lists Worker snapshots, newest first. |
| `pi_continue` | `workerId`, `task` | none | Queues a follow-up into the running cycle, or starts a new cycle once settled/failed. |
| `pi_steer` | `workerId`, `task` | none | Corrects the current task of a running Worker. |
| `pi_abort` | `workerId` | none | Cancels the current running cycle only; keeps the process. |
| `pi_release` | `workerId` | none | Terminates the process and frees the live-worker slot. |

`workerId` is the UUID returned by `pi_spawn` or shown by `pi_list`.
`profile` is `inspect` (default) or `implement`. `model` is an optional
per-worker override that must resolve uniquely in the Worker's local Pi
environment. `thinking` is an optional reasoning level: `off`, `minimal`,
`low`, `medium`, `high`, `xhigh`, `max`. `taskTimeoutMs`, when needed, is an
integer from 1,000 to 86,400,000. `waitMs` is a bounded wait of at most
30,000 ms; omitting it returns immediately. `cycleId` is a positive integer
(>= 1) identifying one activity cycle. There is no `mode`, `worktree`,
`allowedWriteScope`, `sessionFile`, `sessionId`, provider field, CLI prompt
transport, or Skill-managed worker registry.

## Directory, profile, and safety

The supplied `cwd` must be an existing absolute directory inside the allowed
roots. The MCP resolves its real path and checks containment; it does not
create, clone, or remove directories, worktrees, or branches, and it never
changes the directory you passed. Explicit `PI_WORKER_ALLOWED_ROOTS` takes
precedence, including an empty value that denies all directories. Otherwise,
Host-provided MCP Roots are used when negotiated; empty, invalid, or
unavailable Roots deny Worker starts. Hosts without Roots use the MCP server's
cwd. Global installation does not grant access to all projects. The real-path
check is not an OS sandbox.

`inspect` has exactly `read`, `grep`, `find`, and `ls`. It has no `bash`, so it
cannot run tests, builds, lint, or any other shell command, even if the command
is conceptually read-only. `implement` has `read`, `edit`, `write`, `bash`,
`grep`, `find`, and `ls`; use it for shell-based verification and account for
command-generated files and side effects. Profile is selected at spawn and is
not changed by `pi_continue`.

There is no `allowedWriteScope` input: state the intended file boundary in
`task`, then inspect actual changed files, newly created files, and effects on
pre-existing user work. Task wording is not a filesystem sandbox, and an
`implement` Worker can run `bash`.

## Model and thinking

Omit `model` to inherit Pi's locally configured default. A supplied `model`
must match exactly one model available in the Worker's local Pi environment;
an unavailable or ambiguous value fails the spawn with `MODEL_NOT_AVAILABLE`
or `AMBIGUOUS_MODEL`, and a mismatch after selection fails with
`MODEL_STATE_MISMATCH`. The MCP does not configure providers or credentials.

`thinking` is validated against the active model's supported levels before
`set_thinking_level` is applied, then read back from `get_state`. An
unsupported level fails with `THINKING_LEVEL_NOT_AVAILABLE`; a rejected change
fails with `THINKING_LEVEL_SET_FAILED`; a readback mismatch fails with
`THINKING_LEVEL_MISMATCH`. Omitted `thinking` keeps Pi's default. The applied
level is reported on the snapshot as `thinkingLevel` (and `requestedThinking`
records the request).

## Activity cycles and results

A `cycleId` is a positive, monotonically increasing integer that identifies a
full Pi activity run ending at `agent_settled`. `pi_spawn` starts the first
cycle. A `pi_continue` issued while the Worker is `running` (or `starting`)
queues the follow-up into the **same** current cycle; it keeps the same
`cycleId` and does not start a run of its own. Only a `pi_continue` issued when
the Worker is already settled or cycle-failed starts a **new** cycle on the
same process. `pi_steer` likewise affects the current cycle and never starts a
new one.

The snapshot's authoritative `result` (`{ cycleId, text, truncated, chars,
completedAt, stopReason? }`) is the full final assistant message for the latest
completed cycle, built only from Pi's finalized assistant message and never
from streamed deltas, stderr, or diagnostics. It is reset when a new cycle
starts. Previous cycles remain available newest-first in the bounded `cycles`
archive (`{ cycleId, state, operation?, startedAt, endedAt, result, failure? }`),
at most `maxCycles` (default 10). Result text is capped at `maxResultChars`
(default 256000) characters; when capped, `truncated` is true and `chars`
reports the original length, so truncation is never silent.

## State, waiting, and lifecycle

Snapshots use `state`/`status`: `starting`, `running`, `settled`, `failed`,
`stalled`, `timed_out`, `aborting`, `aborted`, or `crashed`. They also include
observable fields such as `processAlive`, `pid`, `cwd`, `profile`, `cycleId`,
`result`, `cycles`, `failure`, `released`, `recentEvents`, and timing data.

`pi_spawn` and `pi_continue` success means the runtime accepted the task; it
does not mean the work is completed or correct. `settled` means only that the
current activity cycle ended. A settled Worker still occupies a live-worker
slot and can be reused by `pi_continue`.

`pi_status` returns immediately by default. Pass `waitMs` (at most 30,000) to
wait in an event-driven way until a cycle settles or fails, the process exits,
or the bounded window expires; a wait timeout does not cancel the Worker.
Passing a positive `cycleId` (>= 1) waits for that cycle's boundary even if a
newer cycle has since started, but the call always returns the **current**
snapshot, not a snapshot of the requested cycle. Read the matching entry from
the snapshot's bounded `cycles` history (or the current `result` when its
`cycleId` matches) to obtain a historical result.

`pi_abort` cancels the current running cycle only. It does not release the
process or the live-worker slot, so the Worker can be continued afterwards
while the process is still alive. A Worker with no running cycle (for example,
a completed idle cycle) is returned unchanged: abort is a no-op there and the
completed `result` is preserved. If Pi does not settle after the abort request,
abort escalates to terminating the process, after which the Worker is no longer
continuable.

`pi_release` terminates the process and frees the live-worker slot. Releasing a
settled or failed Worker preserves its authoritative `result` and `failure`
(or the latest `failure` when the cycle failed). Releasing a running Worker
cancels and terminates it. Release is idempotent; if termination cannot be
confirmed, the snapshot carries a retryable `releaseError`. Released Worker
snapshots are retained boundedly (at most `maxArchivedWorkers`, default 25).

Only a released Worker or a dead process cannot be continued. A settled,
failed, stalled, timed-out, or aborted Worker with a live, unreleased process
can still be continued. Use `pi_steer` only while a Worker is running to
correct its current task; use `pi_continue` for a related next task after a
cycle ends.

Workers launch Pi with `--no-session` and are stored only in the active MCP
Server's worker map. `workerId` is not a durable cross-restart session token:
after an MCP restart or Host reconnection, start a new Worker.

## Failure handling and supervisor acceptance

Failures are structured as `{ code, message, phase, workerId?, cycleId?, at }`
and never include credentials. `phase` distinguishes spawn, model, thinking,
prompt, follow-up, steer, runtime, abort, release, and shutdown failures. A single
model error does not decide the final outcome by itself; Pi's own retry may
recover, so the runtime judges the final result only after the terminal event
for the cycle. The MCP does not grant permissions, solve authentication, or
provide a general-purpose approval proxy. On permission, sandbox,
authentication, model, thinking, timeout, stall, crash, or scope problems,
surface the evidence to the Supervisor. Do not repeat a potentially writing
task blindly, and do not use new Workers to work around the failure.

The Supervisor independently checks source evidence for investigations and the
real diff, scope, validation results, side effects, and request satisfaction
for implementations. A Worker's textual report, accepted call, clean exit, or
`settled` status is not final acceptance.

## Invocation examples

Small, bounded execution work is eligible for delegation:

```text
pi_spawn({ task: "Read src/config.ts and report whether the timeout is parsed as milliseconds, citing the relevant lines.", cwd: "/project", profile: "inspect" })
```

Independent read-only investigations may run in parallel:

```text
pi_spawn({ task: "Inspect error handling in src/api; report cited findings only.", cwd: "/project", profile: "inspect" })
pi_spawn({ task: "Inspect current test coverage in tests/api; report gaps only.", cwd: "/project", profile: "inspect" })
```

An authorized implementation with an explicit model and reasoning level:

```text
pi_spawn({ task: "Implement the specified parser fix only in src/parser and add focused tests. Run the named test command and report changed files.", cwd: "/project", profile: "implement", model: "provider/model", thinking: "high" })
```

Reviewing the current cycle, then cancelling or releasing:

```text
pi_status({ workerId: "<uuid>", waitMs: 20000 })
pi_status({ workerId: "<uuid>", cycleId: 2 })   // wait for cycle 2; read cycles[] for its result
pi_abort({ workerId: "<uuid>" })                // cancel the running cycle, keep the process
pi_release({ workerId: "<uuid>" })              // terminate the process and free the slot
```

Follow-up after reviewing the same Worker:

```text
// While running: queued into the current cycle (same cycleId).
pi_continue({ workerId: "<uuid>", task: "Also check the retry path before you settle." })
// After settlement or a failed cycle: starts a new cycle on the same process.
pi_continue({ workerId: "<uuid>", task: "Add the missing regression case identified in review; do not broaden scope." })
```
