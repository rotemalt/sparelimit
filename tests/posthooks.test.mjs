import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { trimBashOutput } from "../src/trim.mjs";
import { sanitizeTrim } from "../src/config.mjs";
import { handleHook } from "../src/hook.mjs";
import { buildSettingsPatch } from "../src/init.mjs";

const cfg = { maxChars: 1000, keepHead: 100, keepTail: 100 };
const now = Date.parse("2026-11-07T12:00:00Z");

test("a long Bash output keeps its head and tail with a note; everything else in the response is kept; other cases are left alone", () => {
  const stdout = "H".repeat(100) + "m".repeat(2000) + "T".repeat(100);
  const r = trimBashOutput({ tool_name: "Bash", tool_response: { stdout, stderr: "e", interrupted: false, isImage: false, extra: 1 } }, cfg);
  assert.ok(r);
  assert.equal(r.output.stderr, "e");
  assert.equal(r.output.extra, 1);
  assert.ok(r.output.stdout.startsWith("H".repeat(100)) && r.output.stdout.endsWith("T".repeat(100)));
  assert.match(r.output.stdout, /trimmed 2,000 characters from the middle/);
  assert.equal(r.charsBefore, 2200);
  assert.ok(r.charsAfter < 400);
  for (const input of [
    { tool_name: "Read", tool_response: { stdout } },
    { tool_name: "Bash", tool_response: { stdout: "short" } },
    { tool_name: "Bash", tool_response: { stdout, interrupted: true } },
    { tool_name: "Bash", tool_response: { stdout, isImage: true } },
    { tool_name: "Bash", tool_response: { stdout: 5 } },
    { tool_name: "Bash" }
  ]) assert.equal(trimBashOutput(input, cfg), null);
});

test("trim settings are checked: off by default, numbers bounded, a cut that would keep as much as the limit falls back", () => {
  assert.deepEqual(sanitizeTrim(undefined), { enabled: false, dryRun: false, maxChars: 20000, keepHead: 4000, keepTail: 4000 });
  assert.equal(sanitizeTrim({ enabled: true, maxChars: 50000, keepHead: 1000, keepTail: 1000 }).maxChars, 50000);
  assert.equal(sanitizeTrim({ enabled: "yes" }).enabled, false);
  assert.equal(sanitizeTrim({ maxChars: 10 }).maxChars, 20000, "below the floor");
  const bad = sanitizeTrim({ maxChars: 3000, keepHead: 2000, keepTail: 2000 });
  assert.deepEqual([bad.maxChars, bad.keepHead, bad.keepTail], [20000, 4000, 4000]);
});

const setup = (config) => {
  const vh = fs.mkdtempSync(path.join(os.tmpdir(), "sparelimit-post-"));
  process.env.SPARELIMIT_HOME = vh;
  fs.writeFileSync(path.join(vh, "config.json"), JSON.stringify({ digest: { enabled: false }, ...config }));
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), "sparelimit-post-proj-"));
  const call = (event, extra) => handleHook(event, { session_id: "s1", cwd: proj, tool_name: "Bash", tool_input: { command: "npm test" }, ...extra }, { now, refresh: false, notifyFn: () => {} });
  const audit = () => (fs.existsSync(path.join(vh, "audit.jsonl")) ? fs.readFileSync(path.join(vh, "audit.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)) : []);
  return { call, audit };
};

test("failures of the same call are counted; at the third the agent is told (when the relay is on) and it is logged; a success starts over; an abort does not count", () => {
  const { call, audit } = setup({ delivery: { relay: true } });
  const fail = () => call("posttoolusefailure", { error: "Exit code 1\nboom" });
  assert.equal(fail().stdout, "");
  assert.equal(fail().stdout, "");
  const third = JSON.parse(fail().stdout);
  assert.equal(third.hookSpecificOutput.hookEventName, "PostToolUseFailure");
  assert.match(third.hookSpecificOutput.additionalContext, /failed 3 times with identical input/);
  assert.equal(audit().filter((r) => r.rule === "loop.failing_repeat").length, 1);
  assert.equal(call("posttoolusefailure", { is_interrupt: true }).stdout, "", "an abort is not the call failing");
  call("posttooluse", { tool_response: { stdout: "ok" } });
  assert.equal(fail().stdout, "", "after a success the count starts over");
});

test("with the relay off the failure is only logged; the PreToolUse rule blocks only when a block level is set", () => {
  const off = setup({});
  for (let i = 0; i < 3; i++) assert.equal(off.call("posttoolusefailure", { error: "x" }).stdout, "");
  assert.equal(off.audit().filter((r) => r.rule === "loop.failing_repeat").length, 1);
  assert.equal(off.call("pretooluse", {}).exit, 0, "no block level by default");
  const on = setup({ policy: { loop: { failBlock: 4 } } });
  for (let i = 0; i < 4; i++) on.call("posttoolusefailure", { error: "x" });
  const blocked = on.call("pretooluse", {});
  assert.equal(blocked.exit, 2);
  assert.match(blocked.stderr, /failed 4 times/);
  assert.equal(on.call("pretooluse", { tool_input: { command: "something else" } }).exit, 0, "a different call is not blocked");
});

test("trimming through PostToolUse: replaces a long Bash output when enabled, only logs on a dry run, and does nothing when off", () => {
  const stdout = "a".repeat(30000);
  const input = { tool_response: { stdout, stderr: "", interrupted: false, isImage: false } };
  const live = setup({ trim: { enabled: true } });
  const out = JSON.parse(live.call("posttooluse", input).stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, "PostToolUse");
  assert.ok(out.hookSpecificOutput.updatedToolOutput.stdout.length < 9000);
  assert.deepEqual(live.audit().filter((r) => r.kind === "trim").map((r) => [r.charsBefore, r.dryRun]), [[30000, false]]);
  const dry = setup({ trim: { enabled: true, dryRun: true } });
  assert.equal(dry.call("posttooluse", input).stdout, "");
  assert.equal(dry.audit().filter((r) => r.kind === "trim")[0].dryRun, true);
  const off = setup({});
  assert.equal(off.call("posttooluse", input).stdout, "");
  assert.equal(off.audit().length, 0);
});

test("sparelimit init adds the post-tool hooks only when asked", () => {
  const plain = buildSettingsPatch({}, { sparelimitCmd: "sparelimit" }).settings.hooks;
  assert.deepEqual(Object.keys(plain).sort(), ["PreToolUse", "UserPromptSubmit"]);
  const post = buildSettingsPatch({}, { sparelimitCmd: "sparelimit", postHooks: true }).settings.hooks;
  assert.deepEqual(Object.keys(post).sort(), ["PostToolUse", "PostToolUseFailure", "PreToolUse", "UserPromptSubmit"]);
  assert.match(post.PostToolUseFailure[0].hooks[0].command, /hook posttoolusefailure/);
});

test("end to end through the real command: Claude Code's PostToolUse payload on stdin, the replacement output on stdout, exit 0", async () => {
  const { spawnSync } = await import("node:child_process");
  const { ROOT } = await import("./helpers.mjs");
  const vh = fs.mkdtempSync(path.join(os.tmpdir(), "sparelimit-e2e-post-"));
  fs.writeFileSync(path.join(vh, "config.json"), JSON.stringify({ trim: { enabled: true } }));
  const payload = { session_id: "s", cwd: vh, hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "yes | head -50000" }, tool_response: { stdout: "y\n".repeat(30000), stderr: "", interrupted: false, isImage: false }, tool_use_id: "t1" };
  const r = spawnSync(process.execPath, [path.join(ROOT, "sparelimit.mjs"), "hook", "posttooluse"], { input: JSON.stringify(payload), encoding: "utf8", env: { ...process.env, SPARELIMIT_HOME: vh, SPARELIMIT_NO_REFRESH: "1" } });
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, "PostToolUse");
  assert.deepEqual(Object.keys(out.hookSpecificOutput.updatedToolOutput).sort(), ["interrupted", "isImage", "stderr", "stdout"], "the replacement keeps the tool's output shape");
  assert.ok(out.hookSpecificOutput.updatedToolOutput.stdout.length < 10000);
  const bad = spawnSync(process.execPath, [path.join(ROOT, "sparelimit.mjs"), "hook", "posttooluse"], { input: "not json", encoding: "utf8", env: { ...process.env, SPARELIMIT_HOME: vh } });
  assert.equal(bad.status, 0, "malformed input fails open");
  assert.equal(bad.stdout, "");
});
