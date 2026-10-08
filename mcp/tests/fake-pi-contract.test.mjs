import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import readline from "node:readline";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const fakePi = fileURLToPath(new URL("./fixtures/fake-pi.mjs", import.meta.url));

async function exchange(mode, command, waitMs = 120) {
  const child = spawn(process.execPath, [fakePi], {
    env: { ...process.env, FAKE_PI_MODE: mode },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const records = [];
  const lines = readline.createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    try { records.push(JSON.parse(line)); } catch { /* ignore non-protocol output */ }
  });
  child.stdin.write(`${JSON.stringify(command)}\n`);
  await new Promise((resolve) => setTimeout(resolve, waitMs));
  child.stdin.end();
  await once(child, "exit");
  return records;
}

test("fake Pi follow_up while idle only queues and never auto-starts or settles", async () => {
  const records = await exchange("normal_follow_up", { id: "f1", type: "follow_up", message: "idle follow up" });
  assert.deepEqual(
    records.find((record) => record.type === "response" && record.id === "f1")?.data,
    { disposition: "queued" },
  );
  const queued = records.filter((record) => record.type === "queue_update");
  assert.ok(queued.some((record) => record.followUp.length === 1), "expected an idle follow_up to be queued");
  assert.equal(records.some((record) => record.type === "agent_start"), false, "idle follow_up must not start a run");
  assert.equal(records.some((record) => record.type === "agent_settled"), false, "idle follow_up must not settle");
});
