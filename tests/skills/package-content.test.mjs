import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const skillRoot = resolve(repoRoot, "skills/pi-delegate");

test("pi-delegate source contains its entry Skill and MCP contract reference", async () => {
  const skill = await readFile(resolve(skillRoot, "SKILL.md"), "utf8");
  const contract = await readFile(resolve(skillRoot, "references/mcp-contract.md"), "utf8");
  assert.match(skill, /^---\nname: pi-delegate\n/m);
  assert.match(skill, /references\/mcp-contract\.md/);
  assert.match(contract, /Pi TaskExec MCP contract/i);
  assert.ok(contract.trim().length > 1000);
});

test("pi-delegate describes the current tool interface and has no mode/worktree workspace policy", async () => {
  const skill = await readFile(resolve(skillRoot, "SKILL.md"), "utf8");
  const contract = await readFile(resolve(skillRoot, "references/mcp-contract.md"), "utf8");

  assert.match(skill, /v0\.3\.1/);
  assert.match(contract, /contract \(v0\.3\.1 interface\)/);

  // The old mode parameter and Git/worktree/HEAD workspace mandates must be gone from the Skill.
  assert.doesNotMatch(skill, /\bmode\b/i);
  assert.doesNotMatch(skill, /\bHEAD\b/);
  assert.doesNotMatch(skill, /worktree mode|mode.*worktree|use worktree|worktree parameter|worktree.*required/i);
  assert.doesNotMatch(contract, /`mode` is/i);
  assert.doesNotMatch(contract, /worktree mode/i);

  // The seven target tools must be documented in the contract.
  for (const tool of ["pi_spawn", "pi_status", "pi_list", "pi_continue", "pi_steer", "pi_abort", "pi_release"]) {
    assert.ok(contract.includes(tool), `contract should document ${tool}`);
  }

  // Target thinking, wait, cycle, and release semantics must be described.
  assert.match(skill, /thinking/);
  assert.match(skill, /waitMs/);
  assert.match(skill, /cycleId/);
  assert.match(skill, /pi_release/);
  assert.match(contract, /THINKING_LEVEL_NOT_AVAILABLE/);
  assert.match(contract, /authoritative/);
  assert.match(contract, /pi_release/);
});

test("pi-delegate states that a running continue stays in the same cycle", async () => {
  const skill = await readFile(resolve(skillRoot, "SKILL.md"), "utf8");
  const contract = await readFile(resolve(skillRoot, "references/mcp-contract.md"), "utf8");

  // Positive: running pi_continue queues into the current cycle; only a settled/failed continue starts a new one.
  assert.match(skill, /queued into the current activity cycle/i);
  assert.match(skill, /settled or cycle-failed does `pi_continue` start a new activity\s+cycle/i);
  assert.match(contract, /while the Worker is `running`[\s\S]{0,120}queues the follow-up into the \*\*same\*\* current cycle/i);
  assert.match(contract, /only a `pi_continue` issued when\s+the Worker is already settled or cycle-failed starts a \*\*new\*\* cycle/i);
  assert.match(contract, /same\s+`cycleId`/i);

  // Negative: the old same-cycle claim must not reappear.
  assert.doesNotMatch(skill, /queued and assigned a new cycle/i);
  assert.doesNotMatch(contract, /assigned a new `?cycleId`?/i);
  assert.doesNotMatch(contract, /when it actually executes.*new cycle/i);
  assert.doesNotMatch(skill, /running[^.]{0,60}starts a new activity cycle/i);
});

test("pi-delegate separates abort (continuable) from release (terminates) and preserves completed results", async () => {
  const skill = await readFile(resolve(skillRoot, "SKILL.md"), "utf8");
  const contract = await readFile(resolve(skillRoot, "references/mcp-contract.md"), "utf8");

  // pi_abort cancels the running cycle but keeps the process continuable, and is a no-op on a completed idle cycle.
  assert.match(skill, /`pi_abort`[^.]*cancel the current running cycle/i);
  assert.match(skill, /no running cycle is unchanged[^.]*completed\s+result is preserved/i);
  assert.match(contract, /`pi_abort` cancels the current running cycle only/i);
  assert.match(contract, /abort is a no-op there and\s+the\s+completed `result` is preserved/i);

  // pi_release terminates and frees the slot while preserving a completed result.
  assert.match(skill, /`pi_release`[^.]*terminates the process\s+and\s+frees the live-worker slot/i);
  assert.match(contract, /`pi_release` terminates the process and frees the live-worker slot/i);
  assert.match(contract, /releasing a\s+settled or failed worker preserves its authoritative `result`/i);

  // Only released/dead workers cannot be continued.
  assert.match(skill, /only a released\s+worker\s+or\s+a dead process cannot be continued/i);
  assert.match(contract, /only a released worker or a dead process cannot be continued/i);

  // Negative: old terminal/aborted-revival and abort-loses-result claims must be gone.
  assert.doesNotMatch(skill, /aborted or otherwise (terminal|non-terminal) worker cannot be revived/i);
  assert.doesNotMatch(skill, /cancellation with `pi_abort` does not/i);
  assert.doesNotMatch(contract, /aborted or otherwise released worker cannot be revived/i);
});

test("pi-delegate documents bounded cycle results and the status cycleId contract", async () => {
  const contract = await readFile(resolve(skillRoot, "references/mcp-contract.md"), "utf8");

  assert.match(contract, /maxCycles` \(default 10\)/);
  assert.match(contract, /maxArchivedWorkers`,\s+default 25/);
  assert.match(contract, /maxResultChars/);
  assert.match(contract, /default 256000/);
  assert.match(contract, /`truncated` is true and `chars`\s+reports the original length/i);
  assert.match(contract, /always returns the \*\*current\*\*\s+snapshot, not a snapshot of the requested cycle/i);
  assert.match(contract, /positive `cycleId` \(>= 1\)/i);
});

test("pi-delegate documents the unchanged published interface", async () => {
  const contract = await readFile(resolve(skillRoot, "references/mcp-contract.md"), "utf8");
  assert.doesNotMatch(contract, /tree\/v0\.3\.0/);
  assert.match(contract, /v0\.3\.1 is the current published release/i);
  assert.match(contract, /currently `v0\.3\.1`/i);
});
