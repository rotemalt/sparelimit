import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { handleHook } from "../src/hook.mjs";
import { snapshotPath, writeJsonAtomic, overridePath, auditPath, configPath } from "../src/state.mjs";
import { tempSparelimitHome } from "./helpers.mjs";

const NOW = 1_800_000_000_000;
const snap = (extra) => writeJsonAtomic(snapshotPath("s1"), { sessionId: "s1", receivedAtMs: NOW - 1000, ...extra });
const pre = (tool = "Bash", input = { command: "ls" }) => handleHook("pretooluse", { session_id: "s1", tool_name: tool, tool_input: input }, { now: NOW });
const prompt = () => handleHook("userpromptsubmit", { session_id: "s1" }, { now: NOW });

test("PreToolUse blocks with exit 2 and an actionable stderr when context is nearly full", () => {
  tempSparelimitHome();
  snap({ contextPct: 97 });
  const r = pre();
  assert.equal(r.exit, 2);
  assert.match(r.stderr, /blocked/);
  assert.match(r.stderr, /sparelimit reset/);
  assert.match(r.stderr, /sparelimit allow/);
});

test("UserPromptSubmit blocks with a decision, and warns via additionalContext (once)", () => {
  tempSparelimitHome();
  snap({ contextPct: 97 });
  assert.equal(JSON.parse(prompt().stdout).decision, "block");
  tempSparelimitHome();
  snap({ contextPct: 65 });
  const w = JSON.parse(prompt().stdout);
  assert.match(w.systemMessage, /^\[sparelimit\]/);
  assert.equal(prompt().stdout, "", "same warning is not repeated on the next prompt");
});

test("healthy sessions are untouched", () => {
  tempSparelimitHome();
  snap({ contextPct: 20, costUsd: 0.5 });
  assert.deepEqual(pre(), { stdout: "", stderr: "", exit: 0 });
});

test("an override downgrades the block to a pass-through", () => {
  tempSparelimitHome();
  snap({ contextPct: 99 });
  writeJsonAtomic(overridePath(), { all: NOW + 60_000 });
  assert.equal(pre().exit, 0);
});

test("8 identical consecutive tool calls trigger the loop block; a different call resets", () => {
  tempSparelimitHome();
  snap({});
  for (let i = 1; i <= 7; i++) assert.equal(pre().exit, 0, `call ${i}`);
  assert.equal(pre().exit, 2, "8th identical call");
  assert.equal(pre("Read", { file_path: "/x" }).exit, 0);
  assert.equal(pre().exit, 0, "counter restarted");
});

test("stale snapshots do not enforce quota (data older than 15 min)", () => {
  tempSparelimitHome();
  writeJsonAtomic(snapshotPath("s1"), { sessionId: "s1", receivedAtMs: NOW - 20 * 60e3, rateLimits: { fiveHour: { pct: 99, resetsAt: NOW / 1000 + 600 } } });
  assert.equal(pre().exit, 0);
});

test("user policy in config.json changes thresholds", () => {
  tempSparelimitHome();
  writeJsonAtomic(configPath(), { policy: { context: { warnPct: 10, blockPct: 20 } } });
  snap({ contextPct: 25 });
  assert.equal(pre().exit, 2);
});

test("findings are written to the audit log (feeds the savings ledger)", () => {
  tempSparelimitHome();
  snap({ contextPct: 97 });
  pre();
  const rows = fs.readFileSync(auditPath(), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(rows[0].rule, "context.window");
  assert.equal(rows[0].level, "block");
});

test("fails open: if state cannot be written, the action is allowed", () => {
  const dir = tempSparelimitHome();
  fs.rmSync(dir, { recursive: true, force: true });
  fs.writeFileSync(dir, "i am a file, not a directory"); // every mkdir under it fails
  const r = pre();
  assert.equal(r.exit, 0);
  fs.rmSync(dir);
});
