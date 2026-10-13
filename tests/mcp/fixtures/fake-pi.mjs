#!/usr/bin/env node
import readline from "node:readline";
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";

const mode = process.env.FAKE_PI_MODE ?? "normal";
const models = JSON.parse(process.env.FAKE_PI_MODELS ?? '[{"provider":"provider-a","id":"foo"},{"provider":"provider-b","id":"foo"},{"provider":"provider-x","id":"X"},{"provider":"provider-y","id":"Y"}]');
if (process.env.FAKE_PI_CONTEXT_LOG) {
  appendFileSync(process.env.FAKE_PI_CONTEXT_LOG, `${JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd() })}\n`);
}
let currentModel = JSON.parse(process.env.FAKE_PI_DEFAULT_MODEL ?? '{"provider":"local","id":"default"}');
const thinkingLevels = JSON.parse(process.env.FAKE_PI_THINKING_LEVELS ?? '["off","minimal","low","medium","high"]');
let currentThinking = process.env.FAKE_PI_THINKING ?? "high";
let hasRun = false;
const followUpQueue = [];

if (mode === "stdin_closed") {
  setInterval(() => {}, 1_000);
}
if (mode === "stdout_closed") {
  process.stdout.end();
  setInterval(() => {}, 1_000);
}
if (mode === "abort_stuck" || mode === "stubborn") {
  process.on("SIGTERM", () => {});
  process.on("SIGINT", () => {});
}
if (mode === "stubborn_alive") {
  setInterval(() => {}, 1_000);
  process.on("SIGTERM", () => {});
  process.on("SIGINT", () => {});
}

function send(record) {
  process.stdout.write(`${JSON.stringify(record)}\n`);
}

function queueUpdate(steering = []) {
  send({ type: "queue_update", steering: [...steering], followUp: [...followUpQueue] });
}

function userMessage(text) {
  send({ type: "message_start", message: { role: "user", content: [{ type: "text", text }] } });
}

function assistantMessage(text, { stopReason = "stop", errorMessage, deltas = [] } = {}) {
  send({ type: "message_start", message: { role: "assistant", content: [] } });
  for (const delta of deltas) {
    // Mirrors toJsonEvent: message_update carries only assistantMessageEvent, not the message.
    send({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta } });
  }
  send({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      stopReason,
      ...(errorMessage !== undefined ? { errorMessage } : {}),
    },
  });
}

function longText() {
  const length = Number(process.env.FAKE_PI_TEXT_LENGTH ?? 50_000);
  return "x".repeat(Math.max(0, length));
}

// Real Pi drains all queued follow-ups inside one low-level run: it emits
// queue_update (with the message already removed) BEFORE the delivered
// message_start(user). There is exactly one agent_settled per run.
function finishRun() {
  while (followUpQueue.length > 0) {
    followUpQueue.shift();
    queueUpdate();
    userMessage("queued follow-up");
  }
  send({ type: "agent_end", willRetry: false, messages: [] });
  send({ type: "agent_settled", aborted: false });
}

function runPrompt(text, isFirstRun) {
  send({ type: "agent_start" });
  userMessage(text);
  if (mode === "silent" || mode === "stubborn_alive") return;
  if (mode === "stdin_closed") {
    setTimeout(() => process.stdin.destroy(), 10);
    return;
  }
  if (mode === "abort_stuck" || mode === "stubborn") return;
  if (mode === "crash_after_spawn") {
    setTimeout(() => process.exit(7), 30);
    return;
  }
  if (mode === "orphan_descendant") {
    const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    process.stderr.write(`DESCENDANT_PID=${descendant.pid}\n`);
    setTimeout(() => process.exit(0), 120);
    return;
  }
  if (mode === "tool_active") {
    send({ type: "tool_execution_start", toolCallId: "call-1", toolName: "bash", args: { command: "sleep" } });
    return;
  }
  if (mode === "forked") {
    const descendant = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    process.stderr.write(`DESCENDANT_PID=${descendant.pid}\n`);
    return;
  }
  if (mode === "steer_then_follow_up" && isFirstRun) return;
  if (mode === "deltas") {
    assistantMessage("authoritative full text", { deltas: ["streamed ", "draft ", "only"] });
    finishRun();
    return;
  }
  if (mode === "long_result") {
    assistantMessage(longText());
    finishRun();
    return;
  }
  if (mode === "agent_error_settle") {
    assistantMessage("", { stopReason: "error", errorMessage: "non-retry model failure" });
    finishRun();
    return;
  }
  if (mode === "length_stop") {
    assistantMessage("partial answer only", { stopReason: "length" });
    finishRun();
    return;
  }
  if (mode === "assistant_aborted") {
    assistantMessage("", { stopReason: "aborted" });
    finishRun();
    return;
  }
  if (mode === "secret_error") {
    assistantMessage("", { stopReason: "error", errorMessage: "auth failed for sk-ABCDEFGHIJKLMNOP" });
    finishRun();
    return;
  }
  if (mode === "secret_stderr") {
    process.stderr.write("token=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345\n");
    assistantMessage("stdout stays clean");
    finishRun();
    return;
  }
  if (mode === "retry_success") {
    assistantMessage("", { stopReason: "error", errorMessage: "transient provider error" });
    send({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 1, errorMessage: "transient provider error" });
    assistantMessage("recovered answer");
    send({ type: "auto_retry_end", success: true, attempt: 1 });
    finishRun();
    return;
  }
  if (mode === "retry_failure") {
    assistantMessage("", { stopReason: "error", errorMessage: "provider unavailable" });
    send({ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 1, errorMessage: "provider unavailable" });
    assistantMessage("", { stopReason: "error", errorMessage: "provider unavailable" });
    send({ type: "auto_retry_end", success: false, attempt: 1, finalError: "provider unavailable" });
    finishRun();
    return;
  }
  if (mode === "agent_failure") {
    send({ type: "auto_retry_end", success: false, attempt: 1, finalError: "provider unavailable" });
    finishRun();
    return;
  }
  if (mode === "follow_up_running") {
    setTimeout(() => {
      process.stderr.write("FIRST_TURN_FINISHED\n");
      finishRun();
    }, 300);
    return;
  }
  assistantMessage("safe fake task complete");
  setTimeout(finishRun, mode === "normal" || mode === "normal_follow_up" || mode === "follow_up_handled" ? 15 : 0);
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
  if (request.type === "get_available_thinking_levels") {
    const levels = mode === "thinking_no_support" ? ["off"] : thinkingLevels;
    process.stdout.write(`${JSON.stringify({ type: "response", id: request.id, success: true, data: { levels } })}\n`);
    return;
  }
  if (request.type === "set_thinking_level") {
    if (mode === "thinking_reject") {
      process.stdout.write(`${JSON.stringify({ type: "response", id: request.id, success: false, error: "Pi refused thinking level" })}\n`);
      return;
    }
    if (mode === "thinking_mismatch") {
      process.stdout.write(`${JSON.stringify({ type: "response", id: request.id, success: true })}\n`);
      return;
    }
    currentThinking = mode === "thinking_clamp" ? "low" : request.level;
    process.stdout.write(`${JSON.stringify({ type: "response", id: request.id, success: true })}\n`);
    return;
  }
  if (request.type === "get_state") {
    const model = mode === "state_mismatch" ? { provider: "local", id: "wrong" } : currentModel;
    const thinkingLevel = mode === "thinking_mismatch" ? "low" : currentThinking;
    process.stdout.write(`${JSON.stringify({ type: "response", id: request.id, success: true, data: { model, thinkingLevel } })}\n`);
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
    runPrompt(request.message, isFirstRun);
    return;
  }
  if (request.type === "steer") {
    process.stdout.write(`${JSON.stringify({ type: "response", id: request.id, success: true })}\n`);
    if (mode === "steer_then_follow_up") {
      queueUpdate([request.message]);
      userMessage(request.message);
      assistantMessage("safe fake task complete");
      setTimeout(finishRun, 10);
    }
    return;
  }
  if (request.type === "follow_up") {
    const disposition = mode === "follow_up_handled" ? "handled" : "queued";
    process.stdout.write(`${JSON.stringify({ type: "response", id: request.id, success: true, data: { disposition } })}\n`);
    if (disposition === "handled") return;
    // Pi only queues follow-ups for the active run. While idle it stores the message and emits no run events.
    followUpQueue.push(request.message);
    queueUpdate();
    return;
  }
  if (request.type === "abort" && mode === "abort_exit") {
    process.exit(0);
  }
  if (request.type === "abort" && mode !== "abort_stuck" && mode !== "stubborn" && mode !== "stubborn_alive") {
    process.stdout.write(`${JSON.stringify({ type: "response", id: request.id, success: true })}\n`);
    followUpQueue.length = 0;
    send({ type: "agent_end", willRetry: false, messages: [] });
    send({ type: "agent_settled", aborted: true });
  }
});
