import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import test from "node:test";
import { PACKAGE_NAME, PRODUCT_NAME, VERSION } from "../../dist/cli/identity.js";

const repoRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

test("root package.json exposes only the pi-task-exec product identity", async () => {
  const pkg = await readJson(resolve(repoRoot, "package.json"));
  assert.equal(pkg.name, PACKAGE_NAME);
  assert.equal(pkg.name, "@zguiyang/pi-task-exec");
  assert.equal(pkg.version, "0.2.0");
  assert.equal(pkg.version, VERSION);
  assert.equal(pkg.mcpName, "io.github.zguiyang/pi-task-exec");
  assert.deepEqual(pkg.bin, { [PRODUCT_NAME]: "./bin/pi-task-exec.mjs" });
  assert.equal(pkg.scripts.start, "node bin/pi-task-exec.mjs mcp serve");
  assert.ok(pkg.files.includes("dist/**"), "npm package must ship the built MCP runtime");
  assert.ok(pkg.files.includes("skills/pi-delegate/**"), "npm package must ship the pi-delegate skill");
  assert.doesNotMatch(JSON.stringify(pkg), /pi-worker-mcp|pi_worker|pi-worker/);
});

test("server.json matches the new identity and positional mcp serve launch contract", async () => {
  const server = await readJson(resolve(repoRoot, "server.json"));
  assert.equal(server.name, "io.github.zguiyang/pi-task-exec");
  assert.equal(server.title, "Pi TaskExec");
  assert.equal(server.version, "0.2.0");
  assert.equal(server.websiteUrl, "https://github.com/zguiyang/pi-task-exec");
  assert.deepEqual(server.repository, {
    url: "https://github.com/zguiyang/pi-task-exec",
    source: "github",
  });
  assert.equal(server.packages.length, 1);
  const entry = server.packages[0];
  assert.equal(entry.registryType, "npm");
  assert.equal(entry.registryBaseUrl, "https://registry.npmjs.org");
  assert.equal(entry.identifier, PACKAGE_NAME);
  assert.equal(entry.version, server.version);
  assert.deepEqual(entry.transport, { type: "stdio" });
  assert.deepEqual(entry.packageArguments, [
    { type: "positional", value: "mcp" },
    { type: "positional", value: "serve" },
  ]);
  assert.doesNotMatch(JSON.stringify(server), /pi-worker-mcp|pi_worker|pi-worker/);
});

test("package and registry versions stay in lockstep at 0.2.0", async () => {
  const pkg = await readJson(resolve(repoRoot, "package.json"));
  const server = await readJson(resolve(repoRoot, "server.json"));
  assert.equal(pkg.version, "0.2.0");
  assert.equal(pkg.version, server.version);
  assert.equal(server.packages[0].version, server.version);
  assert.equal(pkg.mcpName, server.name);
});
