#!/usr/bin/env node
import readline from "node:readline";
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";

const mode = process.env.FAKE_PI_MODE ?? "normal";
const models = JSON.parse(process.env.FAKE_PI_MODELS ?? '[{"provider":"provider-a","id":"foo"},{"provider":"provider-b","id":"foo"},{"provider":"provider-x","id":"X"},{"provider":"provider-y","id":"Y"}]');
let currentModel = JSON.parse(process.env.FAKE_PI_DEFAULT_MODEL ?? '{"provider":"local","id":"default"}');
let hasRun = false;
const followUpQueue = [];

if (mode === "stdin_closed") {
  setInterval(() => {}, 1_000);
}
if (mode === "stdout_closed") {
  process.stdout.end();
  setInterval(() => {}, 1_000);
}
if (mode === "abort_stuck") {
  process.on("SIGTERM", () => {});
  process.on("SIGINT", () => {});
}

function send(record) {
  process.stdout.write(`${JSON.stringify(record)}\n`);
}

function queueUpdate() {
  send({ type: "queue_update", steering: [], followUp: [...followUpQueue] });
}

// A real Pi processes queued follow-ups before it can emit agent_settled. Model one-at-a-time delivery so the queue
// drains inside the same activity cycle instead of starting a new run.
function finishCycle() {
  if (followUpQueue.length > 0) {
    followUpQueue.shift();
    queueUpdate();
    send({ type: "agent_start" });
    setTimeout(finishCycle, 5);
    return;
  }
  queueUpdate();
  send({ type: "agent_settled" });
}

function startRun() {
  send({ type: "agent_start" });
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", (line) => {
  let request;
  try { request = JSON.parse(line); } catch { return; }
  if (process.env.FAKE_PI_REQUEST_LOG) appendFileSync(process.env.FAKE_PI_REQUEST_LOG, `${JSON.stringify(request)}\n`);
  if (request.type === "get_available_models") {
    process.stdout.write(`${JSON.stringify({ type: "response", id: request.id, success: true, data: { models } })}\n`);
    return;
  }
  if (request.type === "set_model") {
    if (mode === "set_model_reject") {
      process.stdout.write(`${JSON.stringify({ type: "response", id: request.id, success: false, error: "Pi refused model selection" })}\n`);
      return;
    }
    currentModel = { provider: request.provider, id: request.modelId };
    process.stdout.write(`${JSON.stringify({ type: "response", id: request.id, success: true, data: currentModel })}\n`);
    return;
  }
  if (request.type === "get_state") {
    const model = mode === "state_mismatch" ? { provider: "local", id: "wrong" } : currentModel;
    process.stdout.write(`${JSON.stringify({ type: "response", id: request.id, success: true, data: { model, thinkingLevel: "high" } })}\n`);
    return;
  }
  if (request.type === "prompt") {
    if (mode === "no_response") return;
    if (mode === "malformed") {
      process.stdout.write("{this is not json}\n");
      return;
    }
    if (mode === "malformed_response") {
      process.stdout.write(`${JSON.stringify({ type: "response", id: request.id, data: {} })}\n`);
      return;
    }
    if (mode === "crash") process.exit(23);
    const isFirstRun = !hasRun;
    // Extension commands can consume a continuation without starting agent work. The spawn prompt still runs.
    const handled = mode === "prompt_handled" || (mode === "follow_up_handled" && !isFirstRun);
    const disposition = handled ? "handled" : "accepted";
    process.stdout.write(`${JSON.stringify({ type: "response", id: request.id, success: true, data: { disposition } })}\n`);
    if (disposition === "handled") return;
    hasRun = true;
    startRun();
    if (mode === "forked") {
      const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
      process.stderr.write(`DESCENDANT_PID=${descendant.pid}\n`);
    }
    if (mode === "tool_active") {
      process.stdout.write(`${JSON.stringify({ type: "tool_execution_start", toolCallId: "call-1", toolName: "bash", args: { command: "sleep" } })}\n`);
    }
    if (mode === "agent_failure") {
      process.stdout.write(`${JSON.stringify({ type: "auto_retry_end", success: false, finalError: "provider unavailable" })}\n`);
      process.stdout.write(`${JSON.stringify({ type: "agent_settled" })}\n`);
      return;
    }
    if (mode === "stdin_closed") setTimeout(() => process.stdin.destroy(), 10);
    if (mode === "normal" || mode === "normal_follow_up" || mode === "follow_up_handled") {
      setTimeout(finishCycle, 15);
    }
    if (mode === "follow_up_running") {
      setTimeout(() => {
        process.stderr.write("FIRST_TURN_FINISHED\n");
        finishCycle();
      }, 300);
    }
    if (mode === "steer_then_follow_up" && !isFirstRun) {
      setTimeout(finishCycle, 15);
    }
    return;
  }
  if (request.type === "steer") {
    process.stdout.write(`${JSON.stringify({ type: "response", id: request.id, success: true })}\n`);
    if (mode === "steer_then_follow_up") {
      setTimeout(finishCycle, 10);
    }
    return;
  }
  if (request.type === "follow_up") {
    const disposition = mode === "follow_up_handled" ? "handled" : "queued";
    process.stdout.write(`${JSON.stringify({ type: "response", id: request.id, success: true, data: { disposition } })}\n`);
    if (disposition === "handled") return;
    // Pi only queues follow-ups for the active run. While idle it stores the message and emits no run events, so an
    // idle follow_up can never auto-start or auto-settle. The active cycle drains queued messages in finishCycle.
    followUpQueue.push(request.message);
    queueUpdate();
    return;
  }
  if (request.type === "abort" && mode === "abort_exit") {
    process.exit(0);
  }
  if (request.type === "abort" && mode !== "abort_stuck") {
    process.stdout.write(`${JSON.stringify({ type: "response", id: request.id, success: true })}\n`);
    process.stdout.write(`${JSON.stringify({ type: "agent_settled" })}\n`);
  }
});
