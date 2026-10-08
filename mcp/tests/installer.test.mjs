import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { configured, install, uninstall } from "../dist/hosts.js";

const paths = async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-worker-mcp-installer-"));
  return { home: join(root, "home"), cwd: join(root, "project"), platform: "darwin" };
};

test("installer minimally merges, updates, and removes only pi-worker-mcp entries", async () => {
  const locations = await paths();
  const cases = [
    ["codex", "global"], ["codex", "project"],
    ["zed", "global"], ["zed", "project"],
    ["opencode", "global"], ["opencode", "project"],
  ];
  for (const [host, scope] of cases) {
    const selection = { host, scope };
    await install(selection, "0.0.9", locations);
    await install(selection, "0.1.0", locations);
    assert.equal(await configured(selection, locations), true, `${host}/${scope} should be configured`);
    const removed = await uninstall(selection, locations);
    assert.equal(removed.changed, true);
    assert.equal((await uninstall(selection, locations)).changed, false);
    assert.equal(await configured(selection, locations), false);
  }
});

test("JSON host adapters preserve unrelated MCP configuration", async () => {
  const locations = await paths();
  const selection = { host: "opencode", scope: "project" };
  const configPath = join(locations.cwd, "opencode.json");
  await mkdir(locations.cwd, { recursive: true });
  await writeFile(configPath, JSON.stringify({ mcp: { servers: { other: { type: "local", command: ["other"] } } }, setting: true }));
  await install(selection, "0.1.0", locations);
  await uninstall(selection, locations);
  const config = JSON.parse(await readFile(configPath, "utf8"));
  assert.deepEqual(config, { mcp: { servers: { other: { type: "local", command: ["other"] } } }, setting: true });
});
