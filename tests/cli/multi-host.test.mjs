import assert from "node:assert/strict";
import test from "node:test";
import { helpText, parseCli } from "../../dist/cli/commands/index.js";

test("parser: repeated --host dedupes in order, add/remove stay single-host, and uninstall routes", () => {
  // Repeated --host is accepted for setup/update/uninstall, deduped while
  // preserving first-seen order, with the single-host `host` field kept as
  // the first selection for compatibility.
  const setup = parseCli(["setup", "--host", "codex", "--host", "zed", "--host", "codex", "--scope", "project"]);
  assert.equal(setup.kind, "command");
  assert.deepEqual(setup.options.hosts, ["codex", "zed"], "hosts dedupe and keep order");
  assert.equal(setup.options.host, "codex", "the first --host remains options.host");

  const single = parseCli(["add", "mcp", "--host", "codex", "--scope", "project"]);
  assert.equal(single.kind, "command");
  assert.deepEqual(single.options.hosts, ["codex"], "single --host still populates hosts");
  assert.equal(single.options.host, "codex", "single --host keeps the legacy host field");

  const none = parseCli(["setup", "--target", "skill", "--scope", "project"]);
  assert.equal(none.kind, "command");
  assert.deepEqual(none.options.hosts, [], "no --host means an empty host list");
  assert.equal(none.options.host, undefined);

  // add/remove are single-target: a second --host is an explicit error, not a
  // silent drop.
  for (const args of [
    ["add", "mcp", "--host", "codex", "--host", "zed", "--scope", "project"],
    ["remove", "mcp", "--host", "codex", "--host", "zed", "--scope", "project"],
  ]) {
    const rejected = parseCli(args);
    assert.equal(rejected.kind, "error", args.join(" "));
    assert.equal(rejected.code, "too_many_hosts", args.join(" "));
  }
  const update = parseCli(["update", "--host", "codex", "--host", "opencode", "--scope", "global"]);
  assert.equal(update.kind, "command", "update accepts repeated --host");

  // `uninstall` is a top-level command that routes to per-host MCP removal.
  const uninstall = parseCli(["uninstall", "--host", "codex", "--host", "zed", "--scope", "project", "--dry-run"]);
  assert.equal(uninstall.kind, "command");
  assert.equal(uninstall.operation, "uninstall");
  assert.equal(uninstall.target, "mcp");
  assert.deepEqual(uninstall.options.hosts, ["codex", "zed"]);
  assert.equal(uninstall.options.dryRun, true);

  // Without a TTY the selections must be explicit, mirroring `remove mcp`.
  const bare = parseCli(["uninstall"]);
  assert.equal(bare.kind, "error");
  assert.equal(bare.code, "missing_host");
  assert.match(bare.message, /uninstall requires an explicit --host/);
  const noScope = parseCli(["uninstall", "--host", "codex"]);
  assert.equal(noScope.kind, "error");
  assert.equal(noScope.code, "missing_scope");

  // An explicit interaction leaves the selections to prompts.
  const interactive = parseCli(["uninstall"], { interactive: true });
  assert.equal(interactive.kind, "command");
  assert.equal(interactive.operation, "uninstall");

  // The route refuses subcommands, component selection, and readiness flags.
  assert.equal(parseCli(["uninstall", "mcp", "--host", "codex", "--scope", "project"]).kind, "error");
  const withTarget = parseCli(["uninstall", "--target", "skill", "--host", "codex", "--scope", "project"]);
  assert.equal(withTarget.kind, "error");
  assert.equal(withTarget.code, "unexpected_option");
  const withRequire = parseCli(["uninstall", "--host", "codex", "--scope", "project", "--require-mcp"]);
  assert.equal(withRequire.kind, "error");
  assert.equal(withRequire.code, "unexpected_option");

  // The help surface documents the command and repeatable --host.
  assert.match(helpText(), /uninstall/);
  assert.match(helpText(), /Repeatable for setup\/update\/uninstall/);
});
