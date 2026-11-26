import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ROOT } from "./helpers.mjs";

/**
 * A new user has no history. Every command added after the first release must say so in a sentence, not throw: no stack trace, and an exit
 * code of 0 (a report with nothing in it) or 1 (nothing to read), never a crash.
 */
const home = fs.mkdtempSync(path.join(os.tmpdir(), "sparelimit-empty-"));
const run = (...args) => spawnSync(process.execPath, [path.join(ROOT, "sparelimit.mjs"), ...args], { encoding: "utf8", timeout: 60000, env: { ...process.env, HOME: home, SPARELIMIT_HOME: path.join(home, ".sparelimit"), SPARELIMIT_NO_CACHE: "1", SPARELIMIT_NO_REFRESH: "1", CODEX_HOME: path.join(home, "no-codex"), GEMINI_CLI_HOME: path.join(home, "no-gemini") } });
const CRASH = /\n\s+at .*\(.*:\d+:\d+\)|TypeError|ReferenceError|SyntaxError|Cannot read properties/;

for (const args of [["history"], ["drains"], ["files"], ["efficacy"], ["quota-fit"], ["gemini"], ["cursor"], ["codex"], ["accounts"], ["clients"], ["playbooks"], ["why"], ["timeline"], ["ledger"], ["digest"], ["coach"], ["models"], ["delegate"], ["rebuild"]]) {
  test(`sparelimit ${args.join(" ")} on a machine with no history does not crash`, () => {
    const r = run(...args);
    assert.ok(r.status === 0 || r.status === 1, `exit ${r.status}: ${r.stderr.slice(0, 300)}`);
    assert.doesNotMatch(r.stdout + r.stderr, CRASH);
    assert.ok((r.stdout + r.stderr).trim().length > 0, "it says something");
  });
}

test("the JSON forms are valid JSON even when empty", () => {
  for (const args of [["quota-fit", "--json"]]) {
    const r = run(...args);
    assert.doesNotThrow(() => JSON.parse(r.stdout), args.join(" "));
  }
});

test("with corrupted state files the hooks still fail open (exit 0, nothing blocked) and the reports still run", () => {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), "sparelimit-corrupt-"));
  const vh = path.join(h, ".sparelimit");
  fs.mkdirSync(path.join(vh, "state"), { recursive: true });
  fs.mkdirSync(path.join(vh, "live"), { recursive: true });
  for (const f of ["config.json", "calibration.json", "plan-cache.json", "digest.json", "client-budgets.json", "override.json"]) fs.writeFileSync(path.join(vh, f), "{{{ not json");
  fs.writeFileSync(path.join(vh, "audit.jsonl"), 'garbage\n{"t":"2026-11-07T00:00:00Z","kind":"finding"}\n\n{"half":\n');
  fs.writeFileSync(path.join(vh, "state", "s1.json"), "");
  fs.writeFileSync(path.join(vh, "live", "s1.json"), "null");
  const env = { ...process.env, HOME: h, SPARELIMIT_HOME: vh, SPARELIMIT_NO_CACHE: "1", SPARELIMIT_NO_REFRESH: "1" };
  const hook = (event, input) => spawnSync(process.execPath, [path.join(ROOT, "sparelimit.mjs"), "hook", event], { input: JSON.stringify({ session_id: "s1", cwd: h, tool_name: "Bash", tool_input: { command: "ls" }, tool_response: { stdout: "x" }, error: "boom", ...input }), encoding: "utf8", timeout: 30000, env });
  for (const ev of ["userpromptsubmit", "pretooluse", "posttooluse", "posttoolusefailure"]) {
    const r = hook(ev, {});
    assert.equal(r.status, 0, `${ev}: exit ${r.status} ${r.stderr.slice(0, 200)}`);
    assert.doesNotMatch(r.stdout + r.stderr, CRASH, ev);
  }
  for (const args of [["history"], ["ledger"], ["efficacy"], ["playbooks"]]) {
    const r = spawnSync(process.execPath, [path.join(ROOT, "sparelimit.mjs"), ...args], { encoding: "utf8", timeout: 60000, env });
    assert.ok(r.status === 0 || r.status === 1, `${args.join(" ")}: exit ${r.status}`);
    assert.doesNotMatch(r.stdout + r.stderr, CRASH, args.join(" "));
  }
});
