---
name: pi-delegate
description: >-
  MCP delegation policy for bounded atomic execution tasks: once a Supervisor
  can state a task's objective, relevant context, operating boundary,
  completion check, and expected side effects, delegate it to a Pi worker by
  default — investigation, implementation, testing, or mechanical work,
  regardless of task size. Keep requirements, architecture, risk decisions,
  coordination, integration, and final acceptance with the Supervisor.
license: MIT
metadata:
  short-description: Delegate bounded work through the registered pi-task-exec MCP.
  version: "5"
  updated: "2026-10-13"
---

# Pi Delegate

This is a delegation policy, not a Pi runtime. The Supervisor owns requirement
interpretation, architecture, task decomposition, authorization, integration,
review, and final acceptance. `pi-task-exec` owns Pi processes, RPC, worker IDs,
concurrency, continuation, steering, timeouts, cancellation, and resource
release.

Use the Host's already registered `pi-task-exec` tools directly. Never start
the package through a shell, install it automatically, modify MCP
configuration, change Pi credentials or defaults, or fall back to the legacy
Pi CLI runner. If the MCP tools are unavailable, report the missing dependency
and give the installation route in [the reference](references/mcp-contract.md).

## Atomic execution first

Use Pi by default for a concrete execution task once the Supervisor can state
its objective, relevant context, operating boundary, completion check, and
expected side effects. Task size is not the gate: a one-file edit, a read-only
search, a single test run, a small bug fix, or a mechanical change can each be
a valid atomic delegation. Atomic means one bounded outcome and accountable
execution, not one file or one command.

The Supervisor first understands the user request and makes any product,
architecture, risk, authorization, and dependency decisions. It then delegates
the decided execution work: investigation, file reading/search, implementation,
bug fixing, tests, builds, validation, and mechanical changes. Do not delegate
an ambiguous request, an unresolved design choice, or final acceptance.

The Supervisor may directly perform coordination, workspace-state checks,
result verification, and an extremely low-cost action where delegation is
plainly less efficient. This is a narrow efficiency exception, not a rule that
uses task size to keep execution local. Do not create a Worker for every
microscopic operation when it adds no useful execution boundary.

Before an implementation worker, record the workspace state and give it the
objective, allowed scope, constraints, expected result, and validation. A
Worker must not make product, architecture, authorization, or integration
decisions, broaden scope, commit, push, merge, reset, stash, or clean unless
the Supervisor explicitly authorizes that exact action.

## Complex work: split, dispatch, review

Never hand an ambiguous large goal to one Worker. The Supervisor clarifies the
overall objective, maps dependencies, splits it into independently verifiable
atomic tasks, and selects serial or parallel execution. Dispatch independent
tasks separately; parallel work must not overlap writes. Review each result,
then steer a running Worker or use `pi_continue` for a related follow-up that
benefits from its context. Integrate only after the Supervisor's review and
final acceptance.

Atomic tasks can span multiple files or commands when that is the smallest
coherent responsibility boundary. Do not fragment work merely to increase
Worker count, and do not force independent-looking tasks to run in parallel.

## cwd, profile, and continuation

Every `pi_spawn` requires an absolute `cwd`. The Supervisor chooses that
directory — a project root, a subdirectory, a scratch directory, or an existing
Git worktree. `pi-task-exec` only verifies that the directory exists, resolves
its real path, and checks it against the allowed roots. It never creates a
worktree, branch, or directory, never rewrites Git history, and never changes
the working directory you supplied.

`profile` defaults to `inspect` and may be `inspect` or `implement`.
`inspect` exposes only `read`, `grep`, `find`, and `ls`; it is for investigation
and cannot run `bash`, so it cannot run tests, builds, lint, or any other shell
command even when the intended command is logically read-only. Pass
`implement` explicitly for any code change or shell-based verification; its
tools include `read`, `edit`, `write`, `bash`, `grep`, `find`, and `ls`. Account
for command-generated files and other side effects before using it.

Use `pi_continue` only for a related task that stays within the existing
Worker's profile. An `inspect` Worker can continue a read-only investigation,
but cannot continue into a code change or shell-based verification: create a
new `implement` Worker instead. Continuation is not a permission upgrade.

## Model and thinking

Omit `model` unless the user or Supervisor has a concrete reason: Pi selects
its locally configured default, and the Worker must not silently change or
upgrade models. When you pass `model`, it must resolve uniquely to a model
available in the Worker's local Pi environment; an unavailable or ambiguous
value fails the spawn rather than guessing.

`thinking` is an optional per-worker reasoning level:
`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. Omit it to keep
Pi's configured default. The Worker checks the requested level against the
active model's supported levels, applies it, and reads back the effective
level before the task starts. An unsupported level, a rejected change, or a
readback mismatch fails the spawn with a structured error instead of being
silently ignored. Choose a level deliberately; do not set one by habit.

## Workflow

1. Call `pi_spawn` with a bounded `task`, absolute `cwd`, and `profile`
   (default `inspect`). Add `model`, `thinking`, and `taskTimeoutMs` only when
   they are intentional.
2. Use `pi_status` when a decision depends on progress or the terminal result.
   It returns immediately by default. Set `waitMs` (bounded, at most 30000) to
   wait event-driven for a cycle to settle or fail; a wait timeout never
   cancels the Worker. Optionally pass a positive `cycleId` (>=1) to wait for
   that cycle's boundary. The call always returns the current snapshot, which
   carries a bounded `cycles` history, so select the cycle whose `cycleId`
   matches to read a historical result; it never returns a snapshot of that
   old cycle. A successful spawn or a `settled` state is not proof that the
   result is correct.
3. Use `pi_steer` only to correct a running Worker's current task. It is not a
   follow-up and does not start a new cycle.
4. Use `pi_continue` with its `workerId` for a related follow-up. While the
   Worker is running, the follow-up is queued into the current activity cycle
   (the same `cycleId`, ending at `agent_settled`); only when the Worker is
   already settled or cycle-failed does `pi_continue` start a new activity
   cycle. Never read an old cycle's result as the current one. Use a new Worker
   for unrelated work.
5. Use `pi_abort` to cancel the current running cycle. It keeps the process
   operable, and a Worker with no running cycle is unchanged (its completed
   result is preserved), so you can `pi_continue` afterwards. Use
   `pi_release` when no further work is needed: it terminates the process and
   frees the live-worker slot while preserving a completed result or the latest
   failure. Repeated release is safe, and a failed release can be retried.
6. Call `pi_list` only to inspect the fleet or capacity. Do not build a
   mechanical list/status/list loop around routine work.

Read [the MCP contract](references/mcp-contract.md) for exact v0.3.1
parameters, state semantics, results, failures, and examples.

## Parallelism and writes

Run multiple `inspect` Workers only for genuinely independent read-only
questions. For writes, avoid overlapping paths and user changes: either give
each Worker a disjoint directory, or run the writes serially in one directory.
Choose the directory per task; there is no project-wide workspace policy in
this policy or in the MCP. There is no `allowedWriteScope` parameter. Put the
intended file boundary in the `pi_spawn.task`, then verify actual changed and
newly created files after the Worker runs. That textual scope, and the allowed
roots, are not a filesystem sandbox; `implement` also has `bash`. A failed
Worker may leave partial edits. Inspect the actual workspace before retrying
any failed or timed-out write task, and never create replacement Workers merely
to bypass a permission, sandbox, authentication, or scope failure.

Atomicity is necessary but not authorization for high-risk work. The
Supervisor retains the decision and must obtain any required user authorization
before destructive data operations, secrets or sensitive configuration work,
production operations, irreversible changes, Git-history rewriting, or action
outside the user's approved scope. Pi must not expand permissions or scope.

## Worker availability and release

Workers use `--no-session` and are held only by the current MCP Server.
`workerId` identifies that live in-memory Worker; it is not a durable session
handle and cannot be relied on after an MCP restart or Host reconnection. Use
`pi_continue` only while the same server still has a live, non-released
Worker. A settled or failed cycle does not make the Worker unusable: as long as
its process is alive and it has not been released, you can `pi_continue`,
including after `pi_abort` cancelled a running cycle. Only a released Worker
or a dead process cannot be continued; inspect the retained result and spawn a
new Worker if needed. Call `pi_release` on a Worker once related work is
complete; it preserves the outcome of a completed cycle (or the latest
failure). Release snapshots are retained boundedly (at most `maxArchivedWorkers`,
default 25).

## Results, failures, and acceptance

Each activity cycle has a positive, monotonically increasing `cycleId` and
ends at `agent_settled`. The authoritative `result` is the full final assistant
message for the latest completed cycle, independent of progress events,
streaming deltas, stderr, or diagnostics; it is reset when a new cycle starts.
Previous cycles remain in the snapshot's bounded `cycles` archive, newest
first, at most `maxCycles` (default 10). Result text is capped at
`maxResultChars` (default 256000) characters; when capped, the result's
`truncated` flag is true and `chars` reports the original length. A failure is
`{ code, message, phase, workerId?, cycleId?, at }`. A single model error does
not by itself decide the final outcome; Pi's own retry may still recover, so
judge the result only after the terminal event for the cycle.

Report unavailable models, unsupported thinking levels, permissions, sandbox
rejection, authentication failure, timeout, stall, crash, or scope conflict to
the Supervisor for a decision.

Pi output is evidence, not acceptance. For an investigation, verify key source
evidence before using its conclusions. For edits, independently inspect the
diff and scope, run or verify relevant checks, assess side effects, and confirm
the original request is met. Only the Supervisor may declare the overall task
complete.
