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
