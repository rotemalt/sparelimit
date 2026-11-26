import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { ROOT } from "./helpers.mjs";
import { noLogsMessage } from "../src/emptystate.mjs";

/** A stranger with no Claude logs must be told in plain words where Sparelimit looked and what to do next, by every first command. */
const home = fs.mkdtempSync(path.join(os.tmpdir(), "sparelimit-first-"));
const run = (...args) => spawnSync(process.execPath, [path.join(ROOT, "sparelimit.mjs"), ...args], { encoding: "utf8", timeout: 60000, env: { ...process.env, HOME: home, USERPROFILE: home, SPARELIMIT_HOME: path.join(home, ".sparelimit"), SPARELIMIT_NO_CACHE: "1", SPARELIMIT_NO_REFRESH: "1", CLAUDE_CONFIG_DIR: "", CODEX_HOME: path.join(home, "no-codex"), GEMINI_CLI_HOME: path.join(home, "no-gemini") } });

for (const args of [["replay", "--all"], ["week"], ["card"], ["coach"], []]) {
  test(`sparelimit ${args.join(" ") || "(bare)"} on a machine with no logs says where it looked and what to do next`, () => {
    const r = run(...args);
    const out = r.stdout + r.stderr;
    assert.ok(r.status === 0 || r.status === 1, `exit ${r.status}`);
    assert.match(out, /found no Claude Code session logs/);
    assert.match(out, /Next: /);
    assert.doesNotMatch(out, /Pass a path|use --all/);
    assert.doesNotMatch(out, /\n\s+at .*\(.*:\d+:\d+\)/);
  });
}

test("the empty-state line names the folder it looked in, in the machine's own path style", () => {
  assert.ok(noLogsMessage({ home: "/home/dana" }).includes(path.join("/home/dana", ".claude", "projects")));
  assert.ok(noLogsMessage({ home: "C:\\Users\\dana" }).includes(".claude"));
  assert.ok(noLogsMessage().split("\n").length <= 4, "four short lines at most");
});
