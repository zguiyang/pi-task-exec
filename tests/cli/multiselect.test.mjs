import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";
import { createArrowInteraction } from "../../dist/cli/interactive.js";

const ESC = String.fromCharCode(27);
const ENTER = String.fromCharCode(13);
const UP = `${ESC}[A`;
const DOWN = `${ESC}[B`;

const HOSTS = [
  { value: "codex", label: "Codex" },
  { value: "zed", label: "Zed" },
  { value: "opencode", label: "OpenCode" },
];

/**
 * Real prompt stack over a fake terminal: a PassThrough carries scripted
 * keystrokes while raw-mode calls and rendered output are recorded.
 */
function harness({ isTTY = false, columns } = {}) {
  const input = new PassThrough();
  const rawStates = [];
  input.isRaw = false;
  input.setRawMode = (value) => { input.isRaw = value; rawStates.push(value); };
  const chunks = [];
  const output = new Writable({
    write(chunk, _encoding, callback) { chunks.push(String(chunk)); callback(); },
  });
  if (isTTY) {
    output.isTTY = true;
    if (columns !== undefined) output.columns = columns;
  }
  return { input, output, interaction: createArrowInteraction({ input, output }), rawStates, out: () => chunks.join("") };
}

test("multiSelect toggles with space, moves with arrows, and submits with enter", async () => {
  const h = harness();
  const pending = h.interaction.multiSelect("Which hosts?", HOSTS, ["codex"]);
  // Codex starts selected: space deselects it, then arrow + space picks the rest.
  h.input.write(" ");
  h.input.write(DOWN);
  h.input.write(" ");
  h.input.write(DOWN);
  h.input.write(" ");
  h.input.write(ENTER);
  assert.deepEqual(await pending, ["zed", "opencode"], "returns values in choice order, without the deselected default");
  assert.match(h.out(), /Codex/, "every choice was rendered for keyboard navigation");
  assert.match(h.out(), /OpenCode/);
  assert.deepEqual(h.rawStates, [true, false], "raw mode is enabled for the prompt and restored after");
  assert.equal(h.input.isRaw, false);
  h.input.destroy();
  h.output.destroy();
});

test("multiSelect honors defaultValues and returns them when enter is pressed immediately", async () => {
  const h = harness();
  const pending = h.interaction.multiSelect("Which hosts?", HOSTS, ["opencode", "codex"]);
  h.input.write(ENTER);
  assert.deepEqual(await pending, ["codex", "opencode"], "defaults are normalized to choice order");
  h.input.destroy();
  h.output.destroy();
});

test("multiSelect allows submitting an empty selection", async () => {
  const h = harness();
  const pending = h.interaction.multiSelect("Which hosts?", HOSTS);
  h.input.write(ENTER);
  assert.deepEqual(await pending, [], "an empty submit is [], distinct from the null cancellation result");
  h.input.destroy();
  h.output.destroy();
});

test("multiSelect cancellation returns null and restores the terminal", async () => {
  const h = harness();
  const pending = h.interaction.multiSelect("Which hosts?", HOSTS, ["codex"]);
  h.input.write(ESC);
  assert.equal(await pending, null, "escape cancels with null");
  assert.deepEqual(h.rawStates, [true, false], "raw mode is restored to its prior state");
  assert.equal(h.input.isRaw, false);
  assert.ok(h.out().includes(`${ESC}[?25h`), "cursor visibility is restored");
  assert.equal(h.input.listenerCount("error"), 0, "stream error listeners are removed");
  assert.equal(h.input.listenerCount("end"), 0);
  assert.equal(h.input.listenerCount("close"), 0);
  assert.equal(process.listenerCount("SIGINT"), 0, "signal listeners are removed");
  assert.equal(process.listenerCount("SIGTERM"), 0);
  assert.equal(h.input.isPaused(), true, "the source stream returns to a paused state");
  h.input.destroy();
  h.output.destroy();
});

test("multiSelect input failures become interaction_failed and restore raw mode", async () => {
  const h = harness();
  const pending = h.interaction.multiSelect("Which hosts?", HOSTS);
  setImmediate(() => h.input.emit("error", new Error("terminal disconnected")));
  await assert.rejects(pending, (error) => {
    assert.equal(error.code, "interaction_failed");
    assert.match(error.message, /Interactive prompt failed: terminal disconnected/);
    return true;
  });
  assert.deepEqual(h.rawStates, [true, false]);
  assert.equal(h.input.isRaw, false);
  assert.equal(h.input.listenerCount("error"), 0, "no error listener outlives the prompt");
  h.input.destroy();
  h.output.destroy();
});

test("multiSelect fails before entering raw mode on a zero-width TTY", async () => {
  const h = harness({ isTTY: true, columns: 0 });
  await assert.rejects(h.interaction.multiSelect("Which hosts?", HOSTS), /nonzero width/);
  assert.deepEqual(h.rawStates, [], "the prompt never touches raw mode");
  assert.equal(h.out(), "");
  h.input.destroy();
  h.output.destroy();
});

test("multiSelect with no choices resolves null without prompting", async () => {
  const h = harness();
  assert.equal(await h.interaction.multiSelect("Which hosts?", []), null);
  assert.deepEqual(h.rawStates, []);
  assert.equal(h.out(), "");
  h.input.destroy();
  h.output.destroy();
});

test("select and confirm keep their arrow-key behavior on the same interaction", async () => {
  const h = harness();
  const selection = h.interaction.select("Which host?", HOSTS, "codex");
  h.input.write(DOWN);
  h.input.write(ENTER);
  assert.equal(await selection, "zed", "select still moves with arrows and submits with enter");

  const confirmation = h.interaction.confirm("Continue?", false);
  h.input.write(DOWN);
  h.input.write(ENTER);
  assert.equal(await confirmation, true, "confirm still defaults to No and needs an arrow to reach Yes");

  const cancelled = h.interaction.select("Which host?", HOSTS, "codex");
  h.input.write(ESC);
  assert.equal(await cancelled, null, "select still cancels to null");

  assert.deepEqual(h.rawStates, [true, false, true, false, true, false], "every prompt restores raw mode");
  assert.equal(process.listenerCount("SIGINT"), 0);
  assert.equal(process.listenerCount("SIGTERM"), 0);
  h.input.destroy();
  h.output.destroy();
});

test("multiSelect renders keyboard-only instructions", async () => {
  const h = harness();
  const pending = h.interaction.multiSelect("Which hosts?", HOSTS);
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(h.out(), /to navigate/);
  assert.match(h.out(), /Space/);
  assert.match(h.out(), /Enter/);
  h.input.write(ENTER);
  await pending;
  h.input.destroy();
  h.output.destroy();
});
