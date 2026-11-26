import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ROOT, fixture, tempSparelimitHome } from "./helpers.mjs";

const home = tempSparelimitHome();
const run = (args, input = "", env = {}) => spawnSync(process.execPath, [path.join(ROOT, "sparelimit.mjs"), ...args], { input, encoding: "utf8", env: { ...process.env, SPARELIMIT_HOME: home, ...env } });

test("importing the module prints nothing and does not run the CLI", async () => {
  const r = spawnSync(process.execPath, ["-e", `import("${path.join(ROOT, "sparelimit.mjs").replace(/\\/g, "/")}").then(()=>process.exit(0))`], { encoding: "utf8" });
  assert.equal(r.stdout, "");
  assert.equal(r.status, 0);
});

test("status --json honors an explicit transcript path", () => {
  const r = run(["status", "--json", fixture("claude-code-session.jsonl")]);
  const j = JSON.parse(r.stdout);
  assert.equal(j.accumulated_cost_usd > 0, true);
  assert.equal(j.confidence, "derived");
  assert.equal(j.dedup_unique_responses, 3);
});

test("a missing explicit path fails loudly", () => {
  const r = run(["status", "--json", "/definitely/not/here.jsonl"]);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /not found/i);
});

test("statusline reads stdin and prints one line", () => {
  const r = run(["statusline"], fs.readFileSync(fixture("statusline.json"), "utf8"));
  assert.equal(r.status, 0);
  assert.match(r.stdout.trim(), /^ctx 60% · \$3\.21/);
});

test("hook exits 2 (blocks) when the snapshot says the window is full", () => {
  run(["statusline"], fs.readFileSync(fixture("statusline.json"), "utf8").replace('"used_percentage": 60', '"used_percentage": 97'));
  const sid = JSON.parse(fs.readFileSync(fixture("statusline.json"), "utf8")).session_id;
  const r = run(["hook", "pretooluse"], JSON.stringify({ session_id: sid, tool_name: "Bash", tool_input: { command: "ls" } }));
  assert.equal(r.status, 2);
  assert.match(r.stderr, /blocked/);
});

test("allow writes an override and downgrades the next block", () => {
  const sid = JSON.parse(fs.readFileSync(fixture("statusline.json"), "utf8")).session_id;
  assert.equal(run(["allow", "5"]).status, 0);
  const r = run(["hook", "pretooluse"], JSON.stringify({ session_id: sid, tool_name: "Read", tool_input: { file_path: "/x" } }));
  assert.equal(r.status, 0);
});

test("init is a dry run unless --apply is given, and never touches an unrelated HOME", () => {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "sparelimit-fakehome-"));
  const r = run(["init"], "", { HOME: fakeHome });
  assert.match(r.stdout, /Dry run/);
  assert.equal(fs.existsSync(path.join(fakeHome, ".claude", "settings.json")), false);
  const applied = run(["init", "--apply"], "", { HOME: fakeHome });
  assert.match(applied.stdout, /Wrote/);
  const settings = JSON.parse(fs.readFileSync(path.join(fakeHome, ".claude", "settings.json"), "utf8"));
  assert.ok(settings.hooks.PreToolUse && settings.statusLine);
  assert.match(run(["init", "--uninstall"], "", { HOME: fakeHome }).stdout, /Removed/);
  fs.rmSync(fakeHome, { recursive: true, force: true });
});

test("sparelimit help leads with five commands, help all lists every group, and a mistyped command says so and exits 1", () => {
  const run = (/** @type {string[]} */ ...args) => spawnSync(process.execPath, [path.join(ROOT, "sparelimit.mjs"), ...args], { encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });
  const short = run("help");
  assert.equal(short.status, 0);
  assert.match(short.stdout, /Start here/);
  assert.equal(short.stdout.split("\n").filter((l) => l.startsWith("  sparelimit ")).length, 5);
  assert.match(run("--help").stdout, /Start here/);
  assert.match(run("help", "all").stdout, /Check the proof\n.*ledger/);
  const typo = run("replya");
  assert.equal(typo.status, 1);
  assert.match(typo.stderr, /no command called "replya"/);
});

test("sparelimit act is the same as sparelimit reset: one short word to act on an alert", () => {
  const r = spawnSync(process.execPath, [path.join(ROOT, "sparelimit.mjs"), "act"], { encoding: "utf8", env: { ...process.env, HOME: fs.mkdtempSync(path.join(os.tmpdir(), "sparelimit-home-")), SPARELIMIT_HOME: fs.mkdtempSync(path.join(os.tmpdir(), "sparelimit-st-")) } });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /No active agent transcript found/, "it runs the reset path, not 'no command called act'");
});
