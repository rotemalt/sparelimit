import test from "node:test";
import assert from "node:assert/strict";
import { buildSettingsPatch, removeSparelimit } from "../src/init.mjs";

const cmd = "/usr/bin/node /opt/sparelimit/sparelimit.mjs";

test("fresh settings get the status line and both hooks", () => {
  const { settings } = buildSettingsPatch({}, { sparelimitCmd: cmd });
  assert.match(settings.statusLine.command, /statusline/);
  assert.equal(settings.hooks.PreToolUse.length, 1);
  assert.equal(settings.hooks.UserPromptSubmit.length, 1);
});

test("an existing status line is never overwritten", () => {
  const existing = { statusLine: { type: "command", command: "my-line.sh" } };
  const { settings, notes } = buildSettingsPatch(existing, { sparelimitCmd: cmd });
  assert.equal(settings.statusLine.command, "my-line.sh");
  assert.ok(notes.some((n) => n.startsWith("SKIPPED status line")));
});

test("--chain-existing keeps the user's line (quotes included) and adds the collector", () => {
  const existing = { statusLine: { type: "command", command: "echo 'it''s'" } };
  const { settings } = buildSettingsPatch(existing, { sparelimitCmd: cmd, chainExisting: true });
  assert.match(settings.statusLine.command, /--chain=/);
  assert.ok(settings.statusLine.command.includes("it"));
});

test("other hooks are preserved and ours are not duplicated on re-run", () => {
  const existing = { hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "other.sh" }] }] }, model: "x" };
  const once = buildSettingsPatch(existing, { sparelimitCmd: cmd }).settings;
  const twice = buildSettingsPatch(once, { sparelimitCmd: cmd }).settings;
  assert.equal(twice.hooks.PreToolUse.length, 2);
  assert.equal(twice.hooks.PreToolUse[0].hooks[0].command, "other.sh");
  assert.equal(twice.model, "x");
});

test("uninstall restores the original shape", () => {
  const existing = { model: "x", hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "other.sh" }] }] } };
  const installed = buildSettingsPatch(existing, { sparelimitCmd: cmd }).settings;
  assert.deepEqual(removeSparelimit(installed), existing);
  assert.deepEqual(removeSparelimit(buildSettingsPatch({}, { sparelimitCmd: cmd }).settings), {});
});

test("pure: the input object is not mutated", () => {
  const existing = { hooks: {} };
  buildSettingsPatch(existing, { sparelimitCmd: cmd });
  assert.deepEqual(existing, { hooks: {} });
});
