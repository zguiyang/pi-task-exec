import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, test } from "node:test";

import { runCli } from "../../dist/cli/commands/index.js";
import { createDefaultAdapters } from "../../dist/cli/hosts/adapters.js";
import { VERSION } from "../../dist/cli/identity.js";
import { SKILL_DEV_REF, SKILL_EXPECTED_SOURCE, SkillsCliInstaller } from "../../dist/cli/installers/skills-cli.js";

const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const roots = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture(extra = {}) {
  const root = await mkdtemp(join(tmpdir(), "pi-task-exec-unified-"));
  roots.push(root);
  const cwd = join(root, "project");
  const home = join(root, "home");
  await Promise.all([mkdir(cwd), mkdir(home)]);
  const out = [];
  const err = [];
  return {
    root, cwd, home, out: () => out.join(""), err: () => err.join(""),
    deps: {
      io: { stdout: (value) => out.push(value), stderr: (value) => err.push(value) },
      env: {}, cwd, home, platform: process.platform, packageRoot: repoRoot,
      packageVersion: VERSION, adapters: createDefaultAdapters(),
      skillInstaller: new SkillsCliInstaller(), now: () => new Date("2026-10-15T00:00:00.000Z"),
      spawn: async () => ({ code: 0, stdout: "", stderr: "" }),
      releaseTagPreflight: async () => ({ ok: true }), roots: [cwd, home], ...extra,
    },
  };
}

async function exists(path) { try { await stat(path); return true; } catch { return false; } }

test("setup accepts multiple hosts, executes without a plan prompt, and preserves unrelated config", async () => {
  const f = await fixture();
  const codexConfig = join(f.cwd, ".codex", "config.toml");
  const openCodeConfig = join(f.cwd, "opencode.json");
  await mkdir(dirname(codexConfig), { recursive: true });
  await writeFile(codexConfig, '[mcp_servers.other]\ncommand = "keep"\n');
  await writeFile(openCodeConfig, JSON.stringify({ mcp: { other: { type: "local", command: ["keep"] } } }, null, 2));

  const result = await runCli(["setup", "--target", "mcp", "--host", "codex", "--host", "opencode", "--scope", "project", "--local-dev"], f.deps);
  assert.deepEqual(result, { kind: "exit", code: 0 });
  assert.match(await readFile(codexConfig, "utf8"), /mcp_servers\.pi-task-exec/);
  assert.match(await readFile(codexConfig, "utf8"), /mcp_servers\.other/);
  const openCode = JSON.parse(await readFile(openCodeConfig, "utf8"));
  assert.ok(openCode.mcp["pi-task-exec"]);
  assert.ok(openCode.mcp.other);
  assert.match(f.out(), /codex: MCP installed/);
  assert.match(f.out(), /opencode: MCP installed/);
  assert.doesNotMatch(f.out(), /Proceed|Create \/|Existing configuration will be backed up/);

  const removed = await runCli(["uninstall", "--host", "codex", "--host", "opencode", "--scope", "project"], f.deps);
  assert.deepEqual(removed, { kind: "exit", code: 0 });
  const codexAfter = await readFile(codexConfig, "utf8");
  assert.doesNotMatch(codexAfter, /mcp_servers\.pi-task-exec/);
  assert.match(codexAfter, /mcp_servers\.other/);
  const openCodeAfter = JSON.parse(await readFile(openCodeConfig, "utf8"));
  assert.equal(openCodeAfter.mcp["pi-task-exec"], undefined);
  assert.ok(openCodeAfter.mcp.other);
  assert.match(f.out(), /Skill: kept \(shared\)/);
});

test("one multi-host setup invokes the shared Skills CLI once for every selected agent", async () => {
  const f = await fixture();
  const installDir = join(f.cwd, ".agents", "skills", "pi-delegate");
  const lockFile = join(f.cwd, "skills-lock.json");
  const calls = [];
  f.deps.skillSpawn = async (command, args) => {
    calls.push({ command, args });
    await mkdir(join(installDir, "references"), { recursive: true });
    await writeFile(join(installDir, "SKILL.md"), await readFile(join(repoRoot, "skills/pi-delegate/SKILL.md")));
    await writeFile(join(installDir, "references", "mcp-contract.md"), await readFile(join(repoRoot, "skills/pi-delegate/references/mcp-contract.md")));
    await writeFile(lockFile, `${JSON.stringify({ version: 1, skills: { "pi-delegate": { source: SKILL_EXPECTED_SOURCE, ref: SKILL_DEV_REF } } }, null, 2)}\n`);
    return { code: 0, stdout: `${JSON.stringify([{ name: "pi-delegate", status: "installed", source: SKILL_EXPECTED_SOURCE, ref: SKILL_DEV_REF, path: installDir, scope: "project" }])}\n`, stderr: "" };
  };

  const result = await runCli(["setup", "--host", "codex", "--host", "opencode", "--scope", "project", "--local-dev"], f.deps);
  assert.deepEqual(result, { kind: "exit", code: 0 });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args.slice(calls[0].args.indexOf("--agent"), calls[0].args.indexOf("--skill")), ["--agent", "codex", "opencode"]);
  assert.match(f.out(), /Skill: installed/);

  const again = await runCli(["setup", "--host", "codex", "--host", "opencode", "--scope", "project", "--local-dev"], f.deps);
  assert.equal(again.code, 0, "repeating setup is a no-op for an owned Skill at the same ref");
  assert.equal(calls.length, 1, "the shared Skill is not reinstalled on an identical setup");
});

test("one platform conflict does not block an independent selected platform", async () => {
  const f = await fixture();
  const codexConfig = join(f.cwd, ".codex", "config.toml");
  await mkdir(dirname(codexConfig), { recursive: true });
  await writeFile(codexConfig, '[mcp_servers.pi-task-exec]\ncommand = "someone-else"\nargs = []\n');

  const result = await runCli(["setup", "--target", "mcp", "--host", "codex", "--host", "opencode", "--scope", "project", "--local-dev"], f.deps);
  assert.equal(result.code, 1);
  assert.match(await readFile(codexConfig, "utf8"), /someone-else/);
  assert.ok(JSON.parse(await readFile(join(f.cwd, "opencode.json"), "utf8")).mcp["pi-task-exec"]);
  assert.match(f.out(), /codex: MCP failed/);
  assert.match(f.out(), /opencode: MCP installed/);
});

test("uninstall deletes the shared Skill only when selected and names remaining known hosts", async () => {
  const f = await fixture();
  const installed = join(f.cwd, ".agents", "skills", "pi-delegate");
  const lock = join(f.cwd, "skills-lock.json");
  await mkdir(join(installed, "references"), { recursive: true });
  await writeFile(join(installed, "SKILL.md"), "---\nname: pi-delegate\n---\n");
  await writeFile(join(installed, "references", "mcp-contract.md"), "contract\n");
  await writeFile(lock, `${JSON.stringify({ version: 1, skills: { "pi-delegate": { source: SKILL_EXPECTED_SOURCE, ref: "v0.4.0" }, other: { source: "other/repo" } } }, null, 2)}\n`);
  const setup = await runCli(["setup", "--target", "mcp", "--host", "codex", "--host", "opencode", "--scope", "project", "--local-dev"], f.deps);
  assert.equal(setup.code, 0);

  const removed = await runCli(["uninstall", "--host", "codex", "--scope", "project", "--remove-skill"], f.deps);
  assert.equal(removed.code, 0);
  assert.equal(await exists(installed), false);
  assert.equal(JSON.parse(await readFile(lock, "utf8")).skills["pi-delegate"], undefined);
  assert.ok(JSON.parse(await readFile(lock, "utf8")).skills.other);
  assert.match(f.out(), /Skill: removed/);
  assert.match(f.out(), /OpenCode/);
  assert.ok(JSON.parse(await readFile(join(f.cwd, "opencode.json"), "utf8")).mcp["pi-task-exec"]);
});

test("interactive uninstall uses choices and one Skill decision without a plan confirmation", async () => {
  const calls = [];
  const interaction = {
    async multiSelect(question) { calls.push(question); return ["codex", "zed"]; },
    async select(question) { calls.push(question); return "project"; },
    async confirm(question) { calls.push(question); return false; },
  };
  const f = await fixture({ interaction });
  const result = await runCli(["uninstall"], f.deps);
  assert.equal(result.code, 0);
  assert.equal(calls.length, 3);
  assert.match(calls[0], /Platforms/);
  assert.match(calls[1], /Scope/);
  assert.match(calls[2], /Remove shared/);
  assert.doesNotMatch(f.out(), /Proceed|plan above/);
});

test("uninstall preserves an unowned Skill while removing the selected managed MCP", async () => {
  const f = await fixture();
  const installed = join(f.cwd, ".agents", "skills", "pi-delegate");
  const lock = join(f.cwd, "skills-lock.json");
  await mkdir(installed, { recursive: true });
  await writeFile(join(installed, "SKILL.md"), "foreign content\n");
  await writeFile(lock, `${JSON.stringify({ version: 1, skills: { "pi-delegate": { source: "someone/else", ref: "v1" } } }, null, 2)}\n`);
  assert.equal((await runCli(["setup", "--target", "mcp", "--host", "opencode", "--scope", "project", "--local-dev"], f.deps)).code, 0);

  const result = await runCli(["uninstall", "--host", "opencode", "--scope", "project", "--remove-skill"], f.deps);
  assert.equal(result.code, 1);
  assert.equal(JSON.parse(await readFile(join(f.cwd, "opencode.json"), "utf8")).mcp["pi-task-exec"], undefined);
  assert.equal(await readFile(join(installed, "SKILL.md"), "utf8"), "foreign content\n");
  assert.equal(JSON.parse(await readFile(lock, "utf8")).skills["pi-delegate"].source, "someone/else");
  assert.match(f.out(), /Skill: kept/);
});

test("multi-host update replaces one owned shared Skill without another prompt and leaves a backup", async () => {
  const f = await fixture();
  const installed = join(f.cwd, ".agents", "skills", "pi-delegate");
  const lock = join(f.cwd, "skills-lock.json");
  await mkdir(join(installed, "references"), { recursive: true });
  await writeFile(join(installed, "SKILL.md"), "---\nname: pi-delegate\n---\nold content\n");
  await writeFile(join(installed, "references", "mcp-contract.md"), "old contract\n");
  await writeFile(lock, `${JSON.stringify({ version: 1, skills: { "pi-delegate": { source: SKILL_EXPECTED_SOURCE, ref: "v0.0.9" } } }, null, 2)}\n`);
  const calls = [];
  f.deps.skillSpawn = async (command, args) => {
    calls.push({ command, args });
    await writeFile(join(installed, "SKILL.md"), await readFile(join(repoRoot, "skills/pi-delegate/SKILL.md")));
    await writeFile(join(installed, "references", "mcp-contract.md"), await readFile(join(repoRoot, "skills/pi-delegate/references/mcp-contract.md")));
    await writeFile(lock, `${JSON.stringify({ version: 1, skills: { "pi-delegate": { source: SKILL_EXPECTED_SOURCE, ref: SKILL_DEV_REF } } }, null, 2)}\n`);
    return { code: 0, stdout: `${JSON.stringify([{ name: "pi-delegate", status: "installed", source: SKILL_EXPECTED_SOURCE, ref: SKILL_DEV_REF, path: installed, scope: "project" }])}\n`, stderr: "" };
  };

  const result = await runCli(["update", "--host", "codex", "--host", "opencode", "--scope", "project"], f.deps);
  assert.equal(result.code, 0);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args.slice(calls[0].args.indexOf("--agent"), calls[0].args.indexOf("--skill")), ["--agent", "codex", "opencode"]);
  assert.match(f.out(), /Skill: updated/);
  assert.doesNotMatch(f.out(), /Proceed|Replace the listed path/);
  assert.ok(await exists(join(f.cwd, ".agents", "pi-delegate.backup-2026-10-15T00-00-00-000Z")));
});
